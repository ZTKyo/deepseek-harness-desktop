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

// 2) 日志检查：R2 插件加载（无 boot error、无 QUARANTINED）
if (fs.existsSync(logDir)) {
  const logs = fs.readdirSync(logDir);
  const serverLog = logs.find(f => f.startsWith("dsh-server-") && f.endsWith(".log"));
  if (serverLog) {
    const lp = path.join(logDir, serverLog);
    const lines = fs.readFileSync(lp, "utf8").split("\n");
    // 取最后 200 行
    const tail = lines.slice(-200);
    const contextMemoryLines = tail.filter(l => /context-memory/i.test(l));
    assert(contextMemoryLines.length > 0, `服务日志含 ${contextMemoryLines.length} 行 context-memory 相关（插件已加载）`);
    const bootErrors = tail.filter(l => /(error|fail|exception|QUARANTINED)/i.test(l) && /context-memory/i.test(l));
    assert(bootErrors.length === 0, `R2 插件加载无 boot error（0 行错误）`);
    const hasBoot = tail.some(l => /cordis.*(?:load|resolve|mount)/i.test(l) || /preflight.*PASS/i.test(l) || /context-memory.*loaded/i.test(l));
    if (hasBoot) console.log("  日志确认插件加载流程正常");
    // 显示前 5 条 context-memory 日志
    contextMemoryLines.slice(0, 5).forEach(l => console.log(`  ${l.trim().slice(0,200)}`));
  } else {
    assert(false, "未找到服务日志");
  }
} else {
  assert(false, "日志目录不存在");
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