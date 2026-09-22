// test-learn-plugin-contract.mjs —— P4 LEARN 插件「宿主契约」回归锁
//
// 为什么需要这个套件（真实缺陷，非假想）：
//   origin/main 的 plugins/learn.mjs 只导出了 name / apply，**缺少
//   `export const inject = ['tools']`**。Cordis 宿主只有在插件声明 inject 后才会在
//   ctx 上注入对应服务；learn.mjs 在 apply() 里访问 ctx.tools（注册 5 个 learn_* 工具），
//   因此缺失该声明时**第一次访问 ctx.tools 就会 abort host boot**——即
//   「canonical main 当前状态部署即崩溃」。生产环境跑的是未合并的 3 行热修
//   （22655 B 版），main 是 22460 B 版 ⇒ **main ≠ deployed**。
//
// 本套件的作用：
//   1) 锁死「插件必须声明 inject=['tools']」这一宿主契约（修复前必 FAIL）；
//   2) 锁死 name / apply 的对外形状（防止修 inject 时误伤）；
//   3) 用**源码静态检查 + 动态 import 双重证据**，避免只改注释就能骗过测试。
//
// 修复前行为（已实证）：node tests/learn/test-learn-plugin-contract.mjs → exit 1
// 修复后行为（已实证）：node tests/learn/test-learn-plugin-contract.mjs → exit 0
//
// 运行：node tests/learn/test-learn-plugin-contract.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = join(HERE, '..', '..', 'plugins', 'learn.mjs');
// Windows 上 import() 只接受 file:// URL，绝对路径会被当成 'c:' 协议而报错。
const PLUGIN_URL = pathToFileURL(PLUGIN_PATH).href;

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

const SRC = readFileSync(PLUGIN_PATH, 'utf8');

// ── 1. 源码静态层：inject 声明必须真实存在且是模块顶层 export ────────────────
console.log('=== 1. 源码静态检查：宿主契约 inject 声明 ===');

check('C1 inject 以模块顶层 export const 声明（修复前必 FAIL）', () => {
  // 只认「行首（可含缩进）export const inject = [...]」这种真实声明，
  // 不接受注释里提到 inject 的字样。
  const m = SRC.match(/^\s*export\s+const\s+inject\s*=\s*(\[[^\]]*\])\s*;/m);
  assert.ok(m, '未找到顶层 `export const inject = [...]` 声明 ⇒ 宿主不会注入 ctx.tools ⇒ host boot abort');
  const arr = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(Array.isArray(arr), 'inject 必须解析为数组');
  assert.ok(arr.includes('tools'), "inject 必须包含 'tools'（learn.mjs 在 apply() 里注册 ctx.tools 工具）");
});

check('C2 inject 声明出现在 apply 之前（顺序契约）', () => {
  const injectIdx = SRC.search(/^\s*export\s+const\s+inject\s*=/m);
  const applyIdx = SRC.search(/^\s*export\s+function\s+apply\s*\(/m);
  assert.ok(injectIdx >= 0, 'inject 未声明');
  assert.ok(applyIdx >= 0, 'apply 未声明');
  assert.ok(injectIdx < applyIdx, 'inject 应声明在 apply 之前（与生产版一致）');
});

check('C3 name / apply 仍在（防止修 inject 时误删导出）', () => {
  assert.match(SRC, /^\s*export\s+const\s+name\s*=\s*'learn'\s*;/m, "缺少 export const name = 'learn'");
  assert.match(SRC, /^\s*export\s+function\s+apply\s*\(/m, '缺少 export function apply');
});

check('C4 apply() 确实使用 ctx.tools（证明 inject 是必需而非装饰）', () => {
  assert.ok(/ctx\.tools/.test(SRC), 'learn.mjs 未访问 ctx.tools ⇒ 若真如此，inject 契约需重新评估');
});

// ── 2. 动态 import 层：运行时真实导出形状 ────────────────────────────────────
console.log('=== 2. 动态 import：运行时导出形状 ===');

const mod = await import(PLUGIN_URL).catch((e) => {
  fail++; failures.push('C5 动态 import 失败 :: ' + e.message);
  console.log('  FAIL  C5 动态 import plugins/learn.mjs — ' + e.message);
  return null;
});

if (mod) {
  await checkAsync('C5 运行时 inject 存在且含 tools（修复前必 FAIL）', () => {
    assert.notEqual(mod.inject, undefined, 'module.inject === undefined ⇒ 宿主不会注入 tools 服务');
    assert.ok(Array.isArray(mod.inject), 'module.inject 必须是数组，实际 = ' + typeof mod.inject);
    assert.ok(mod.inject.includes('tools'), "module.inject 必须包含 'tools'，实际 = " + JSON.stringify(mod.inject));
  });

  await checkAsync("C6 运行时 name === 'learn'", () => {
    assert.equal(mod.name, 'learn');
  });

  await checkAsync('C7 运行时 apply 是函数且 arity >= 1', () => {
    assert.equal(typeof mod.apply, 'function');
    assert.ok(mod.apply.length >= 1, 'apply 应至少接收 ctx 参数');
  });

  await checkAsync('C8 运行时导出集合与静态检查一致（无隐藏导出面变化）', () => {
    const keys = Object.keys(mod).sort();
    // 允许集合随实现演进，但 inject 必须在其中。
    assert.ok(keys.includes('inject'), '运行时导出缺 inject，实际 = ' + keys.join(','));
    assert.ok(keys.includes('name'), '运行时导出缺 name');
    assert.ok(keys.includes('apply'), '运行时导出缺 apply');
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
console.log('=== 汇总 ===');
console.log('  PASS = ' + pass + '  FAIL = ' + fail);
if (fail) {
  console.log('  失败项：');
  for (const f of failures) console.log('    - ' + f);
  console.log('  ⇒ LEARN plugin host-contract gate FAILED');
  process.exit(1);
}
console.log('  PASS LEARN plugin host-contract gate');
process.exit(0);
