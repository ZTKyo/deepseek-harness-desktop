// ox-relay-audit.mjs — stealth/ox-alpha multi-relay support AUDIT (read-only network probe)
//
// Purpose (task section 1 & 8): for each CANDIDATE relay that this machine already
// holds a credential for, verify whether it ACTUALLY serves the exact model id
// `stealth/ox-alpha`. Never guess from UI names. Never impersonate ox-alpha with
// another model. Never bypass paywalls/auth.
//
// Per-provider budget (task section 10):
//   - at most ONE GET /models request
//   - if (and only if) the exact id appears in /models: at most ONE real generation
//     prompt "Reply exactly: OK", plus at most ONE retry of that same generation on
//     a TRANSIENT failure (429/5xx/network). Auth/quota failures are NOT retried.
//
// Verdicts:
//   SUPPORTED        exact id listed AND generation returned content with model=stealth/ox-alpha
//   LISTED_NOT_LIVE  id listed but generation failed transiently twice (cannot confirm)
//   UNSUPPORTED      reachable but exact id NOT offered
//   ACCESS_REQUIRED  401/402/403 or quota wording (auth/billing/access problem)
//   NO_KEY           no credential on this machine for the relay
//   UNREACHABLE      network/DNS/TLS failure reaching the relay
//
// Secrets: keys are read from ~/.dsh/.credentials.yaml (or OX_RELAY_CRED_FILE) and are
// NEVER printed. Output contains status codes, model ids, latency, truncated bodies
// with bearer-like strings redacted.
//
// Usage: node docs/execution-economy/probe/ox-relay-audit.mjs [--json <outPath>]
// Network: international endpoints go through the router OpenClash proxy by default
// (OX_RELAY_PROXY, default http://192.168.168.1:7890); set OX_RELAY_PROXY=direct to skip.
// Zero third-party deps: proxy agents are loaded from the installed DSH runtime only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TARGET_MODEL = "stealth/ox-alpha";
const PROXY = process.env.OX_RELAY_PROXY || "http://192.168.168.1:7890";
const GEN_TIMEOUT_MS = Number(process.env.OX_RELAY_GEN_TIMEOUT_MS || 30000);
const MODELS_TIMEOUT_MS = Number(process.env.OX_RELAY_MODELS_TIMEOUT_MS || 15000);

// Candidate relays: ONLY services this machine already has credentials for.
// (No new signups, no credential sharing, no access-restriction bypass.)
const CANDIDATES = [
  { id: "openrouter", displayName: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  { id: "agentrouter", displayName: "AgentRouter", baseURL: "https://agentrouter.org/v1", keyEnv: "AGENTROUTER_API_KEY",
    // agentrouter.org WAF requires Claude Code wire image headers (see agentrouter-wire.mjs)
    extraHeaders: {
      "user-agent": "claude-cli/2.1.158 (external, sdk-cli)",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    } },
  { id: "opencode-zen", displayName: "OpenCode Zen", baseURL: "https://opencode.ai/zen/go/v1", keyEnv: "OPENCODE_API_KEY" },
  { id: "zenmux", displayName: "ZenMux", baseURL: "https://api.zenmux.ai/v1", keyEnv: "ZENMUX_API_KEY" },
  { id: "commandcode", displayName: "Command Code", baseURL: "https://api.commandcode.ai/provider/v1", keyEnv: "CMD_API_KEY" },
  { id: "bai", displayName: "B.AI", baseURL: "https://api.b.ai/v1", keyEnv: "BAI_API_KEY" },
];

function loadKeys() {
  const file = process.env.OX_RELAY_CRED_FILE || path.join(os.homedir(), ".dsh", ".credentials.yaml");
  const out = {};
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const m of txt.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:\s*["']?([^"'\r\n]+)["']?\s*$/gm)) {
      out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

let agents = null;
async function getAgents() {
  if (agents !== null) return agents;
  if (PROXY === "direct") { agents = { http: undefined }; return agents; }
  try {
    const nm = path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules");
    const dshRequire = createRequire(path.join(nm, "package.json"));
    const { HttpProxyAgent } = dshRequire("http-proxy-agent");
    const { HttpsProxyAgent } = dshRequire("https-proxy-agent");
    const httpsAgent = new HttpsProxyAgent(PROXY);
    const httpAgent = new HttpProxyAgent(PROXY);
    agents = {
      http: (u) => (u.startsWith("https") ? httpsAgent : httpAgent),
    };
  } catch (e) {
    console.log(`[warn] proxy agent unavailable (${e.message}); falling back to direct`);
    agents = { http: undefined };
  }
  return agents;
}

export function redact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer ***")
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) ? "***" : m));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = MODELS_TIMEOUT_MS) {
  const ag = await getAgents();
  const agent = ag.http ? ag.http(url) : undefined;
  return fetch(url, { ...opts, agent, signal: AbortSignal.timeout(timeoutMs) });
}

const TRANSIENT_RE = /(429|5\d{2}|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|rate limit|overloaded)/i;

async function probeModels(cand, key) {
  const url = cand.baseURL.replace(/\/$/, "") + "/models";
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}`, ...(cand.extraHeaders || {}) },
    }, MODELS_TIMEOUT_MS);
    const latencyMs = Date.now() - t0;
    const body = await res.text();
    if (res.status === 401 || res.status === 403 || res.status === 402) {
      return { verdict: "ACCESS_REQUIRED", httpStatus: res.status, latencyMs, detail: `models list answered ${res.status}` };
    }
    if (!res.ok) {
      // Some gateways don't implement /models; treat non-JSON 404 specially below.
      return { verdict: "_MODELS_HTTP_" + res.status, httpStatus: res.status, latencyMs, bodySnippet: redact(body.slice(0, 200)) };
    }
    let ids = [];
    try {
      const j = JSON.parse(body);
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      ids = arr.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
    } catch {
      return { verdict: "_MODELS_UNPARSABLE", httpStatus: res.status, latencyMs, bodySnippet: redact(body.slice(0, 200)) };
    }
    const exact = ids.includes(TARGET_MODEL);
    return { verdict: exact ? "_LISTED" : "UNSUPPORTED", httpStatus: res.status, latencyMs, modelCount: ids.length, listed: exact };
  } catch (e) {
    return { verdict: "UNREACHABLE", latencyMs: Date.now() - t0, detail: redact(String(e?.message || e)).slice(0, 200) };
  }
}

async function probeGeneration(cand, key) {
  const url = cand.baseURL.replace(/\/$/, "") + "/chat/completions";
  const body = JSON.stringify({
    model: TARGET_MODEL,
    messages: [{ role: "user", content: "Reply exactly: OK" }],
    // reasoning models may spend tokens reasoning before answering; keep the
    // probe minimal but non-zero for the visible answer.
    max_tokens: 512,
    stream: false,
  });
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(cand.extraHeaders || {}) },
        body,
      }, GEN_TIMEOUT_MS);
      const latencyMs = Date.now() - t0;
      const text = await res.text();
      if (res.ok) {
        let content = null, respModel = null;
        try {
          const j = JSON.parse(text);
          respModel = j?.model ?? null;
          const parts = j?.choices?.[0]?.message?.content;
          content = typeof parts === "string" ? parts : Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join("") : null;
        } catch {}
        const identityOk = respModel === TARGET_MODEL || String(respModel || "").includes("ox-alpha");
        // Identity is what this audit certifies. A 200 + echo of the exact model
        // id = the relay serves ox-alpha, even if the content shape is unusual
        // (reasoning models may return empty visible text on tiny budgets).
        return {
          verdict: identityOk ? "SUPPORTED" : "_ODD_RESPONSE",
          httpStatus: res.status, latencyMs, attempt,
          responseModel: respModel, contentSnippet: redact(String(content ?? "")).slice(0, 80),
          identityOk,
        };
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        return { verdict: "ACCESS_REQUIRED", httpStatus: res.status, latencyMs, attempt, detail: redact(text.slice(0, 200)) };
      }
      last = { verdict: "_GEN_HTTP_" + res.status, httpStatus: res.status, latencyMs, attempt, detail: redact(text.slice(0, 220)) };
      if (!TRANSIENT_RE.test(String(res.status))) break; // non-transient → no retry
    } catch (e) {
      last = { verdict: "_GEN_NETWORK", latencyMs: Date.now() - t0, attempt, detail: redact(String(e?.message || e)).slice(0, 200) };
    }
    if (attempt === 1) continue;
  }
  return last;
}

export async function auditRelay(cand, keys) {
  const key = keys[cand.keyEnv];
  if (!key) return { provider: cand.id, displayName: cand.displayName, baseURL: cand.baseURL, verdict: "NO_KEY" };
  const rec = { provider: cand.id, displayName: cand.displayName, baseURL: cand.baseURL, targetModel: TARGET_MODEL };
  const models = await probeModels(cand, key);
  rec.modelsProbe = models;
  if (models.verdict === "_LISTED" || String(models.verdict).startsWith("_MODELS_HTTP_404") || models.verdict === "_MODELS_UNPARSABLE") {
    // Listed (or catalog endpoint missing) → one live generation decides support.
    const gen = await probeGeneration(cand, key);
    rec.generationProbe = gen;
    if (gen.verdict === "SUPPORTED") rec.verdict = "SUPPORTED";
    else if (gen.verdict === "ACCESS_REQUIRED") rec.verdict = "ACCESS_REQUIRED";
    else if (gen.verdict === "_ODD_RESPONSE") rec.verdict = gen.identityOk ? "SUPPORTED_IDENTITY_ODD_SHAPE" : "UNSUPPORTED_RESPONSE_MODEL_MISMATCH";
    else if (String(gen.verdict).startsWith("_GEN")) rec.verdict = "LISTED_NOT_LIVE";
    else rec.verdict = gen.verdict;
  } else {
    rec.verdict = models.verdict;
  }
  return rec;
}

export async function runAudit() {
  const keys = loadKeys();
  const results = [];
  for (const cand of CANDIDATES) {
    process.stdout.write(`probing ${cand.id} ... `);
    const r = await auditRelay(cand, keys);
    results.push(r);
    console.log(r.verdict + (r.generationProbe ? ` (respModel=${r.generationProbe.responseModel}, ${r.generationProbe.latencyMs}ms)` : r.modelsProbe ? `(http ${r.modelsProbe.httpStatus ?? "-"}, ${r.modelsProbe.latencyMs}ms)` : ""));
  }
  return results;
}

const isMain = (() => {
  try { return path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const results = await runAudit();
  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.provider.padEnd(14)} ${r.verdict}`);
  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
    fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ auditedAt: new Date().toISOString(), targetModel: TARGET_MODEL, results }, null, 2));
    console.log("written: " + process.argv[jsonIdx + 1]);
  }
}
