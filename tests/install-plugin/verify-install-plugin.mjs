// verify-install-plugin.mjs —— P2.5 R2-2 install-plugin 回归测试
//
// 覆盖 R2-2 的三个改造点：
//   T1 原子写（tmp+rename）：同步后目标位 hash == 源 hash，且无 .tmp-* 残留
//   T2 自动 hash 校验：--check 无 --plugin 时自动发现挂载引用，旧版目标位 → FAIL
//   T3 preflight 集成：restart-dsh-server-delayed.ps1 -PreflightOnly 通过
//
// 可移植性：用临时目录做 preset/profile（--preset/--profile 覆盖），不触碰真实
// 挂载位（~/.dsh/*）。repo 根自动定位。运行：node tests/install-plugin/verify-install-plugin.mjs
// fail → exit 1（CI 可用）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = path.join(REPO, "tools", "install-plugin.mjs");
const PLUGIN_SRC = path.join(REPO, "plugins", "context-memory.mjs");
const RESTART_SCRIPT = path.join(REPO, "restart-dsh-server-delayed.ps1");

let passCount = 0, failCount = 0;
function assert(c, n, d = "") { if (c) { passCount++; console.log("  PASS  " + n); } else { failCount++; console.log("  FAIL  " + n + (d ? " :: " + d : "")); } }
function section(t) { console.log(`\n=== ${t} ===`); }

function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function runTool(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, text: (r.stdout || "") + (r.stderr || "") };
}
function listTmpResidue(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

function makeTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ip-r2-2-"));
  const preset = path.join(base, "preset");
  const profile = path.join(base, "profile");
  fs.mkdirSync(preset); fs.mkdirSync(profile);
  // preset 配置挂载 ./context-memory.mjs；profile 配置挂载 ./context-memory.mjs + ./tool-output-offload.mjs
  fs.writeFileSync(path.join(preset, "agent.cordis.yml"),
    `agent:\n  plugins:\n    - name: './context-memory.mjs'\n`, "utf8");
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"),
    `plugins:\n  - name: './context-memory.mjs'\n  - name: './tool-output-offload.mjs'\n`, "utf8");
  return { base, preset, profile };
}

// 同步两个配置挂载到的插件（与 makeTempDirs 的挂载一致，保证 --check 全绿）
const SYNC_ARGS = ["--plugin", "context-memory", "--plugin", "tool-output-offload"];

// 前置：源文件必须真实存在（否则测试无意义）
if (!fs.existsSync(PLUGIN_SRC)) {
  console.error(`FAIL 前置：repo 源 plugins/context-memory.mjs 不存在（${PLUGIN_SRC}）`);
  process.exit(1);
}

// ── T1 原子写：同步后 hash 一致 + 无 tmp 残留 ──────────────────────────────────
section("T1 原子写（tmp+rename）");
{
  const d = makeTempDirs();
  try {
    const r = runTool([...SYNC_ARGS, "--preset", d.preset, "--profile", d.profile]);
    assert(r.code === 0, "T1.1 同步命令退出码 0", `got ${r.code}: ${r.text.slice(-200)}`);
    const srcHash = sha(PLUGIN_SRC);
    const presetHash = sha(path.join(d.preset, "context-memory.mjs"));
    const profileHash = sha(path.join(d.profile, "context-memory.mjs"));
    assert(presetHash === srcHash, "T1.2 preset 目标位 hash 与源一致", `${presetHash} vs ${srcHash}`);
    assert(profileHash === srcHash, "T1.3 profile 目标位 hash 与源一致", `${profileHash} vs ${srcHash}`);
    assert(listTmpResidue(d.preset).length === 0, "T1.4 preset 无 .tmp-* 残留", `found: ${listTmpResidue(d.preset).join(",")}`);
    assert(listTmpResidue(d.profile).length === 0, "T1.5 profile 无 .tmp-* 残留", `found: ${listTmpResidue(d.profile).join(",")}`);
  } finally { fs.rmSync(d.base, { recursive: true, force: true }); }
}

// ── T2 自动 hash 校验：旧版目标位 → FAIL；同步后 → PASS ───────────────────────
section("T2 自动 hash 校验（--check 无 --plugin）");
{
  const d = makeTempDirs();
  try {
    // 先正常同步，再篡改 preset 目标位为旧内容
    let r = runTool([...SYNC_ARGS, "--preset", d.preset, "--profile", d.profile]);
    assert(r.code === 0, "T2.1 预同步成功", `got ${r.code}: ${r.text.slice(-200)}`);
    fs.writeFileSync(path.join(d.preset, "context-memory.mjs"), "// OLD STALE CONTENT\n", "utf8");
    // --check 不带 --plugin：应自动发现挂载引用并发现 preset 不一致 → FAIL
    r = runTool(["--check", "--preset", d.preset, "--profile", d.profile]);
    assert(r.code === 1, "T2.2 旧版目标位时 --check 退出码 1", `got ${r.code}`);
    assert(r.text.includes("校验和不一致"), "T2.3 输出包含 '校验和不一致'", r.text.slice(-400));
    assert(r.text.includes("自动发现源文件"), "T2.4 输出包含 '自动发现源文件'（无 --plugin 也校验 hash）", r.text.slice(0, 400));
    // 重新同步 → --check 通过
    r = runTool([...SYNC_ARGS, "--preset", d.preset, "--profile", d.profile]);
    assert(r.code === 0, "T2.5 重新同步成功");
    r = runTool(["--check", "--preset", d.preset, "--profile", d.profile]);
    assert(r.code === 0, "T2.6 同步后 --check 退出码 0", `got ${r.code}`);
    assert(r.text.includes("结果: PASS"), "T2.7 输出包含 '结果: PASS'");
  } finally { fs.rmSync(d.base, { recursive: true, force: true }); }
}

// ── T3 preflight 集成：restart-dsh-server-delayed.ps1 -PreflightOnly 通过 ────
section("T3 preflight 集成（restart 脚本）");
if (fs.existsSync(RESTART_SCRIPT)) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESTART_SCRIPT, "-PreflightOnly"],
    { cwd: REPO, encoding: "utf8", timeout: 120000 });
  const text = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, "T3.1 preflight 退出码 0", `got ${r.status}; out=${text.slice(-300)}`);
  assert(/PREFLIGHT PASS/.test(text), "T3.2 输出包含 'PREFLIGHT PASS'", text.slice(-300));
  // R2-2: install-plugin 校验行写进 restart 日志文件（Write-Log 不写 stdout）
  const logPath = path.join(process.env.LOCALAPPDATA || "", "DSHHarness", "logs", "restart-apply-patch.log");
  let logText = "";
  if (fs.existsSync(logPath)) logText = fs.readFileSync(logPath, "utf8");
  assert(logText.includes("install-plugin --check PASS"), "T3.3 日志包含 install-plugin --check PASS（已集成）",
    `log=${logPath} 最后 300 字符: ${logText.slice(-300)}`);
} else {
  console.log("  SKIP  restart 脚本不存在（非本机/CI 未部署），跳过 T3");
}

console.log(`\n结果: ${failCount === 0 ? "PASS" : "FAIL"}（${passCount} 通过，${failCount} 失败）`);
process.exit(failCount === 0 ? 0 : 1);
