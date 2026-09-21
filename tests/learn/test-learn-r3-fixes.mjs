// test-learn-r3-fixes.mjs —— P4 LEARN R3 最小修复的回归锁
//
// 每个修复都配**正反孪生对**：只把正向或只把反向改坏，测试就会失败。
// 目的：防止"为修误报把真实信号也修没了"（过否定）或"为修漏检把否定又算成信号"。
//
// 覆盖：
//   F1 latin failure 补 failing/fails/fail        （规范 §4 "still failing" → failure）
//   F2 CJK 覆盖补 出错/修好了/不工作/没反应/崩了   （含回归检测 "又崩了"）
//   F3 否定作用域                                  （规范 §9 反向表述不得产生信号）
//   F4 注入剥离收紧到"标签独占一行"                 （规范 §4 区分注入 vs 讨论）
//
// 运行：node tests/learn/test-learn-r3-fixes.mjs

import assert from 'node:assert/strict';

import { learningSignals, stripInjectedContent, isNegated } from '../../plugins/learn-core.mjs';

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

/** 取单轮文本的信号 kind（无信号返回 null）。 */
const kindOf = (text, role = 'user') => {
  const r = learningSignals({ turns: [{ seq: 1, role, text }] });
  return r.signals.length ? r.signals[0].kind : null;
};

console.log('=== F1 latin failure 形态补齐（规范 §4）===');
check('F1+ "still failing" → failure（原实现漏检）', () => assert.equal(kindOf('the build is still failing'), 'failure'));
check('F1+ "it fails every time" → failure', () => assert.equal(kindOf('it fails every time'), 'failure'));
check('F1- "the build passed, no failures" → 不是 failure', () => assert.notEqual(kindOf('the build passed, no failures'), 'failure'));
check('F1孪生 "failed" 仍是 failure（回归）', () => assert.equal(kindOf('the build failed'), 'failure'));

console.log('=== F2 CJK 覆盖补齐（真实缺口 + 回归检测）===');
check('F2+ "出错" → failure', () => assert.equal(kindOf('这里出错了'), 'failure'));
check('F2+ "又崩了" → failure（规范 §6 回归检测）', () => assert.equal(kindOf('改完之后又崩了'), 'failure'));
check('F2+ "不工作" → failure', () => assert.equal(kindOf('这个模块不工作'), 'failure'));
check('F2+ "没反应" → failure', () => assert.equal(kindOf('点了以后没反应'), 'failure'));
check('F2+ "修好了" → resolution', () => assert.equal(kindOf('这个问题修好了'), 'resolution'));
check('F2孪生 "报错"/"崩溃"/"已修复" 仍是原语义（回归）', () => {
  assert.equal(kindOf('这里报错了'), 'failure');
  assert.equal(kindOf('程序崩溃了'), 'failure');
  assert.equal(kindOf('已经修复了'), 'resolution');
});

console.log('=== F3 否定作用域（规范 §9：反向表述不得产生信号）===');
check('F3+ "没有报错" → 无信号', () => assert.equal(kindOf('运行了一下，没有报错'), null));
check('F3+ "not broken" → 无信号', () => assert.equal(kindOf('the module is not broken'), null));
check('F3+ "not fixed" → 不是 resolution（规范 §4）', () => assert.notEqual(kindOf('the bug is not fixed yet'), 'resolution'));
check('F3+ "no longer failing" → 无信号', () => assert.equal(kindOf('the test is no longer failing'), null));
check('F3+ "never failed" → 无信号', () => assert.equal(kindOf('this has never failed'), null));
check('F3- "报错了" 仍是 failure（过否定回归）', () => assert.equal(kindOf('这里报错了'), 'failure'));
check('F3- "the build failed" 仍是 failure（过否定回归）', () => assert.equal(kindOf('the build failed'), 'failure'));
check('F3- "已经修复了" 仍是 resolution（过否定回归）', () => assert.equal(kindOf('已经修复了'), 'resolution'));
check('F3边界 否定作用域遇标点即结束："我不确定，但是报错了" → failure', () => assert.equal(kindOf('我不确定，但是报错了'), 'failure'));
check('F3边界 "没有报错，但崩溃了" → failure（否定不吞掉整句）', () => assert.equal(kindOf('没有报错，但崩溃了'), 'failure'));
check('F3边界 "not only failed" → failure（only 例外）', () => assert.equal(kindOf('it not only failed but also crashed'), 'failure'));
check('F3边界 "还没修好" → 不是 resolution', () => assert.notEqual(kindOf('还没修好'), 'resolution'));
check('F3单元 isNegated 直接行为', () => {
  assert.equal(isNegated('没有报错', 2, true), true);
  assert.equal(isNegated('这里报错了', 2, true), false);
  assert.equal(isNegated('the module is not broken', 18, false), true);
  assert.equal(isNegated('the build failed', 10, false), false);
});

console.log('=== F4 注入剥离：区分"真注入"与"讨论标签"（规范 §4）===');
const REAL_INJECTION = '帮我看看这个\n<system-reminder>\nThe following workspace instructions may be relevant\n失败 报错 崩溃\n</system-reminder>';
const REAL_INJECTION_OPEN = '帮我看看这个\n<system-reminder>\nThe following workspace instructions may be relevant\n失败 报错 崩溃';
const DISCUSSION = '我注意到日志里有 <system-reminder> 这个标签，它后面的报错都没被记录，帮我查一下';
const DISCUSSION_CODE = '代码里 INJECTION_RX = /<system-reminder>|<system_warning>| 这样写的';

check('F4 真注入（闭合）被剥掉，真人发言保留', () => {
  const out = stripInjectedContent(REAL_INJECTION);
  assert.equal(out, '帮我看看这个');
});
check('F4 真注入（未闭合，行首+独占行）被剥掉，真人发言保留', () => {
  const out = stripInjectedContent(REAL_INJECTION_OPEN);
  assert.equal(out, '帮我看看这个');
});
check('F4- 用户讨论该标签时其真实发言不被删除（原实现丢失 81%）', () => {
  const out = stripInjectedContent(DISCUSSION);
  assert.equal(out, DISCUSSION, '讨论文本被吞：' + JSON.stringify(out));
});
check('F4- 引用形态的标签不被吞', () => {
  const out = stripInjectedContent(DISCUSSION_CODE);
  assert.equal(out, DISCUSSION_CODE, '引用文本被吞：' + JSON.stringify(out));
});
check('F4 讨论文本里的失败信号仍能被学到', () => {
  const r = learningSignals({ turns: [{ seq: 1, role: 'user', text: stripInjectedContent(DISCUSSION) }] });
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].kind, 'failure');
});
check('F4 R2 既有锁定用例仍成立（回归）', () => {
  // R2 test-learn-core.mjs 第 533/534 行的两个用例
  const a = '<system-reminder>the word error appears in injected text</system-reminder>';
  assert.equal(stripInjectedContent(a), '');
  const b = 'real question<system-reminder>injected tail</system-reminder>';
  assert.equal(stripInjectedContent(b), 'real question');
});

console.log('');
console.log('=== R3 最小修复回归: ' + pass + ' PASS / ' + fail + ' FAIL ===');
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
