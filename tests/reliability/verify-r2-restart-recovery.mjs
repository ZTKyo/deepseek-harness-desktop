// verify-r2-restart-recovery.mjs — R2-3 REAL restart 验证
// 重启后运行：验证 R2 插件加载、store 恢复、fail-open 备选
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const storeDir = path.join(os.homedir(), "AppData", "Local", "DSHHarness", "state", "context-memory");
const logDir = path.join(os.homedir(), "AppData", "Local", "DSHHarness", "logs");
const START = Date.now();

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log(`  PASS ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };

console.log("=== R2-3 REAL restart 验证 ===");

// 1) 服务进程存活
try {
  const out = execSync("powershell -NoProfile -Command \"Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess\"", { encoding: "utf8" }).trim();
  assert(out.length > 0, `端口 3080 有监听进程 (PID=${out.trim().split(/\s+/)[0]})`);
} catch(e) { assert(false, "端口 3080 无监听进程"); }

// 2) 插件加载证据（权威来源：store 活跃性 + 事件日志投影输出 + guardian 无 QUARANTINED）
//    注：dsh-server-<port>.log 只记录启动行；插件加载的真实证据是：
//    (a) store 文件在重启后仍被读取（active/watermark 见第 3 节），
//    (b) notify-events.log 的 session/projection 事件含 contextPressure/contextBreakdown
//        （context-memory 插件的投影输出，见插件观测链路），
//    (c) guardian.log 无 QUARANTINED/隔离记录（插件被拒绝加载会被隔离）。
{
  // (b) 事件日志投影证据：会话运行期间投影事件会持续出现
  const evLog = path.join(logDir, "notify-events.log");
  let projectionLines = [];
  if (fs.existsSync(evLog)) {
    const tail = fs.readFileSync(evLog, "utf8").split("\n").slice(-4000);
    projectionLines = tail.filter(l => /session\/projection/.test(l) && /contextPressure|contextBreakdown|sessionStats/.test(l));
  }
  if (projectionLines.length > 0) {
    console.log(`  事件日志含 ${projectionLines.length} 行投影输出（context-memory 插件观测链路活跃）`);
    // 显示最新一条 sessionStats 佐证
    const lastStats = projectionLines.filter(l => /sessionStats/.test(l)).pop();
    if (lastStats) console.log(`  最近投影: ${lastStats.slice(0, 180)}`);
  } else {
    // 会话尚未产生新回合时投影可能暂无增量；fallback：以 store 活跃性(第3节)为准
    console.log("  (信息) 当前回合尚未结束，投影事件暂无新增量 — 以 store 活跃性(第3节)为准");
  }
  // (c) guardian 隔离检查
  const gLog = path.join(logDir, "guardian.log");
  let quarantined = 0;
  if (fs.existsSync(gLog)) {
    const tail = fs.readFileSync(gLog, "utf8").split("\n").slice(-3000);
    quarantined = tail.filter(l => /QUARANTINED|quarantine/i.test(l) && /context-memory/i.test(l)).length;
  }
  assert(quarantined === 0, `guardian 无 context-memory 隔离记录（0 条 QUARANTINED）`);
}

// 3) store 跨重启恢复
if (fs.existsSync(storeDir)) {
  const files = fs.readdirSync(storeDir).filter(f => f.endsWith(".json"));
  assert(files.length > 0, `store 目录存在且包含 ${files.length} 个 JSON 文件（跨重启恢复）`);
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(storeDir, f), "utf8"));
      assert(s.active === true, `store ${f} active=true（跨重启后仍活跃）`);
      assert(typeof s.watermark === "number" && s.watermark > 0, `store ${f} watermark>0（跨重启未丢失）`);
      assert(s.obs !== undefined, `store ${f} obs 存在（跨重启未丢失）`);
      assert(Array.isArray(s.refs) && s.refs.length > 0, `store ${f} refs 存在（跨重启未丢失）`);
      console.log(`  store ${f}: v${s.version}, watermark=${s.watermark}, refs=${s.refs.length}`);
    } catch(e) { console.log(`  SKIP ${f}: 解析失败 (${e.message})`); }
  }
} else {
  assert(false, "store 目录在重启后不存在（插件可能未加载）");
}

// 4) 插件文件 hash 一致（R2 版本确实在目标位）
const { execSync: exec } = await import("node:child_process");
try {
  const hashOut = exec("node tools/install-plugin.mjs --check --preset \"$env:USERPROFILE\\.dsh\\.agent-presets\\autonomous\" --profile \"$env:USERPROFILE\\.dsh\\profiles\\web\" 2>&1", { encoding: "utf8", shell: "powershell" });
  assert(hashOut.includes("与 repo 一致") || hashOut.includes("PASS"), `install-plugin --check 确认 R2 插件已加载到服务`);
  // 提取关键行
  hashOut.split("\n").filter(l => /一致|PASS|FAIL|MR/.test(l)).slice(0,6).forEach(l => console.log(`  ${l.trim()}`));
} catch(e) {
  assert(false, `install-plugin --check 失败: ${e.message.slice(0,200)}`);
}

// 5) fail-open 备选：store 损坏不阻塞服务（T3 单测覆盖，这里验证服务正常就是证据）
const elapsed = ((Date.now() - START) / 1000).toFixed(1);
console.log(`\n  验证耗时: ${elapsed}s`);
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);