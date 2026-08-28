// P2.6 R3 — RATE_LIMIT-free retry policy 验证
// 目标：官方 dsh-llm-retry 不再同路盲重试 429/1310（默认 retryableCodes 含 RATE_LIMIT，
// 会吞掉 1310 使 EC/Router 无法看到，R2 跨池回落失效）。R3 在 settings.yaml 为 6 个
// 主用 provider 移除 RATE_LIMIT，429 全部落到 EC classifier：
//   1310 -> QUOTA_EXHAUSTED 跨池回落、1305 -> PROVIDER_OVERLOADED 有界退避、
//   裸 429 -> RATE_LIMIT 有界退避（均带退避间隔语义）。
// 本脚本验证 settings 层 + schema 层 + 既有分类回归（不依赖服务运行，纯静态）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SETTINGS = process.env.DSH_SETTINGS || path.join(os.homedir(), ".dsh", "settings.yaml");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? "  " + extra : ""}`); }
};

// ── 主用 provider 清单（R3 目标：这些必须 RATE_LIMIT-free）──
const TARGETS = ["opencode", "opencode-qwen", "opencode-free", "openrouter", "agentrouter-openai", "commandcode"];
const RETRYABLE_KEEP = ["EMPTY_RESPONSE", "SERVER", "TIMEOUT", "TRANSPORT"];

// 动态加载 js-yaml（优先 DSH_GLOBAL_ROOT（CI 用 npm root -g 注入），
// 其次 dsh 默认安装目录，最后工作区）
function loadYaml() {
  const g = process.env.DSH_GLOBAL_ROOT;
  const candidates = [
    ...(g ? [path.join(g, "js-yaml"), path.join(g, "@deepseek-ai", "dsh", "node_modules", "js-yaml")] : []),
    path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "js-yaml"),
    path.join(ROOT, "node_modules", "js-yaml"),
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error("js-yaml not found");
}

const yaml = loadYaml();
const settings = yaml.load(fs.readFileSync(SETTINGS, "utf8"));
const providers = settings?.["llm-pi-ai"]?.providers || {};
check("settings.yaml loads + llm-pi-ai.providers present", Object.keys(providers).length >= 6, `providers=${Object.keys(providers).length}`);

// ── R3-1: 每个主用 provider 都配置了 retryPolicy 且不含 RATE_LIMIT ──
for (const name of TARGETS) {
  const conf = providers[name];
  const rp = conf?.retryPolicy;
  check(`R3-1 ${name}: retryPolicy present`, !!rp && rp.mode === "normal", rp ? `mode=${rp.mode}` : "MISSING");
  if (rp) {
    const codes = Array.isArray(rp.retryableCodes) ? rp.retryableCodes : [];
    check(`R3-1 ${name}: RATE_LIMIT removed`, !codes.includes("RATE_LIMIT"), `codes=[${codes.join(",")}]`);
    check(`R3-1 ${name}: keeps ${RETRYABLE_KEEP.join("/")}`, RETRYABLE_KEEP.every((c) => codes.includes(c)), "");
    check(`R3-1 ${name}: no duplicates`, new Set(codes).size === codes.length, "");
    const b = rp.backoff || {};
    check(`R3-1 ${name}: backoff sane`, Number.isFinite(b.initialDelayMs) && Number.isFinite(b.maxDelayMs) && b.initialDelayMs <= b.maxDelayMs, `init=${b.initialDelayMs} max=${b.maxDelayMs}`);
  }
}

// ── R3-2: schema 层合法（与 dsh-llm 真实 RetryPolicySchema 一致，字段名/值范围）──
{
  const g = process.env.DSH_GLOBAL_ROOT;
  const rpSchemaPath = g
    ? path.join(g, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "types", "retry-policy.js")
    : path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-llm", "lib", "types", "retry-policy.js");
  let schemaOk = false;
  try {
    const { RetryPolicySchema } = require(rpSchemaPath);
    for (const name of TARGETS) {
      const pol = RetryPolicySchema(providers[name].retryPolicy);
      const codes = pol.retryableCodes || [];
      const ok = pol.mode === "normal" && !codes.includes("RATE_LIMIT") && codes.length > 0;
      if (!ok) throw new Error(`${name} policy invalid`);
    }
    schemaOk = true;
  } catch (e) { console.log("  schema error:", e.message); }
  check("R3-2 all target retryPolicies pass RetryPolicySchema (RATE_LIMIT-free)", schemaOk);
}

// ── R3-3: 非目标 provider 未动（缺省仍含 RATE_LIMIT → 官方默认语义保持；仅审计）──
for (const name of ["xiaomi", "agentrouter-anthropic", "bai", "empero-free", "zhipu"]) {
  const rp = providers[name]?.retryPolicy;
  check(`R3-3 ${name}: untouched (no explicit retryPolicy -> official default incl. RATE_LIMIT)`, !rp, rp ? `mode=${rp.mode}` : "default");
}

// ── R3-4: 回归 —— EC classifier 对 1310/1305/裸429 的分类语义不变（复用 failure-classifier-core）──
{
  try {
    const { classifyFailureV1, FAILURE_CLASS, TAXONOMY_VERSION } = await import(pathToFileURL(path.join(ROOT, "plugins", "failure-classifier-core.mjs")).href);
    check("R3-4 taxonomy core loads", typeof classifyFailureV1 === "function", `version=${TAXONOMY_VERSION}`);
    const glm1310 = { code: "RATE_LIMIT", message: '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-09-03 01:49:02 重置。"}' };
    const q = classifyFailureV1(glm1310, { provider: "zhipu", model: "glm-4.6", nowMs: Date.now() });
    check("R3-4 1310 -> QUOTA_EXHAUSTED (not SHORT_WINDOW_RATE_LIMIT)", q.classification === FAILURE_CLASS.QUOTA_EXHAUSTED && q.retryableSameRoute === false, `cls=${q.classification} retryable=${q.retryableSameRoute}`);
    const o = classifyFailureV1({ code: "RATE_LIMIT", message: '429: {"code":"1305","message":"服务繁忙，请稍后重试"}' }, { provider: "zhipu", model: "glm-4.6", nowMs: Date.now() });
    check("R3-4 1305 -> PROVIDER_OVERLOADED (bounded retry)", o.classification === FAILURE_CLASS.PROVIDER_OVERLOADED && o.retryableSameRoute === true, `cls=${o.classification} retryable=${o.retryableSameRoute}`);
    const r = classifyFailureV1({ code: "RATE_LIMIT", message: "429 Too Many Requests", providerRetryAfterMs: 3000 }, { nowMs: Date.now() });
    check("R3-4 bare 429 -> SHORT_WINDOW_RATE_LIMIT bounded", r.classification === FAILURE_CLASS.SHORT_WINDOW_RATE_LIMIT && r.retryableSameRoute === true && r.retryAfterMs === 3000, `cls=${r.classification} retryable=${r.retryableSameRoute} retryAfter=${r.retryAfterMs}`);
  } catch (e) {
    check("R3-4 taxonomy core loads", false, e.message);
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
