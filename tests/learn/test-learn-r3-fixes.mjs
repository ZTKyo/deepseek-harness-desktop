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
// R2 AC5：失败分类的唯一 Authority 是 P2.6；本测试用它交叉验证关键词路径已失去该权威。
import { evaluateGapVeto } from '../../plugins/learn-gap-veto.mjs';

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
// ⛔ R2 AC5 契约变更：failure 关键词已从 SIGNAL_PATTERNS 整体删除（第二 Failure Authority
//    被移除）。原 F1/F2/F3 中所有 "文本 → failure" 断言断言的正是**已被合同禁止**的那条路径。
//    这里**不删除断言**，而是逐条改写为断言新契约（更强）：关键词路径永不声称 failure，
//    且同一输入的失败判定由 P2.6 权威给出（下方 checkP26 逐条直证）。
const checkP26 = (failure, expectCls, expectReason) => {
  const v = evaluateGapVeto(failure, { provider: 'p', model: 'm' });
  assert.equal(v.classification, expectCls, `P2.6 class mismatch for ${JSON.stringify(failure)}: got ${v.classification}`);
  assert.equal(v.vetoed, true, `P2.6 should veto gap for ${JSON.stringify(failure)}`);
  assert.equal(v.reason, expectReason, `P2.6 reason mismatch: got ${v.reason}`);
};

check('F1+ "still failing" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('the build is still failing'), 'failure'));
check('F1+ "it fails every time" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('it fails every time'), 'failure'));
check('F1- "the build passed, no failures" → 不是 failure', () => assert.notEqual(kindOf('the build passed, no failures'), 'failure'));
check('F1孪生 "failed" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('the build failed'), 'failure'));
check('F1权威 P2.6 对同一批失败文本给出分类并否决', () => {
  // 实测真值（_probe-classify.mjs）：这三条自由叙述文本 P2.6 归为 UNKNOWN_PROVIDER_FAILURE，
  // 属条件否决集 ⇒ 无能力证据时一律否决（fail-closed）。
  checkP26({ message: 'the build is still failing', code: '' }, 'UNKNOWN_PROVIDER_FAILURE', 'CONDITIONAL_VETO_NO_EVIDENCE');
  checkP26({ message: 'it fails every time', code: '' }, 'UNKNOWN_PROVIDER_FAILURE', 'CONDITIONAL_VETO_NO_EVIDENCE');
  checkP26({ message: 'the build failed', code: '' }, 'UNKNOWN_PROVIDER_FAILURE', 'CONDITIONAL_VETO_NO_EVIDENCE');
});

console.log('=== F2 CJK 覆盖补齐（真实缺口 + 回归检测）===');
check('F2+ "出错" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('这里出错了'), 'failure'));
check('F2+ "又崩了" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('改完之后又崩了'), 'failure'));
check('F2+ "不工作" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('这个模块不工作'), 'failure'));
check('F2+ "没反应" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('点了以后没反应'), 'failure'));
check('F2+ "修好了" → resolution', () => assert.equal(kindOf('这个问题修好了'), 'resolution'));
check('F2孪生 "报错"/"崩溃" 关键词不再声称 failure；"已修复" 仍是 resolution', () => {
  assert.notEqual(kindOf('这里报错了'), 'failure');
  assert.notEqual(kindOf('程序崩溃了'), 'failure');
  assert.equal(kindOf('已经修复了'), 'resolution');
});
check('F2权威 环境类中文故障由 P2.6 分类并硬否决', () => {
  // 实测真值：中文额度/过载文本走 CHINESE_QUOTA_RE / CHINESE_OVERLOAD_RE
  checkP26({ message: '使用上限' }, 'QUOTA_EXHAUSTED', 'HARD_VETO_CLASS');
  checkP26({ message: '服务繁忙' }, 'PROVIDER_OVERLOADED', 'HARD_VETO_CLASS');
  checkP26({ message: '余额不足' }, 'QUOTA_EXHAUSTED', 'HARD_VETO_CLASS');
});

console.log('=== F3 否定作用域（规范 §9：反向表述不得产生信号）===');
check('F3+ "没有报错" → 无信号', () => assert.equal(kindOf('运行了一下，没有报错'), null));
check('F3+ "not broken" → 无信号', () => assert.equal(kindOf('the module is not broken'), null));
check('F3+ "not fixed" → 不是 resolution（规范 §4）', () => assert.notEqual(kindOf('the bug is not fixed yet'), 'resolution'));
check('F3+ "no longer failing" → 无信号', () => assert.equal(kindOf('the test is no longer failing'), null));
check('F3+ "never failed" → 无信号', () => assert.equal(kindOf('this has never failed'), null));
// AC5：这几条原本断言"否定边界仍判 failure"，现在断言"关键词路径已彻底退出失败判定"
check('F3- "报错了" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('这里报错了'), 'failure'));
check('F3- "the build failed" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('the build failed'), 'failure'));
check('F3- "已经修复了" 仍是 resolution（过否定回归）', () => assert.equal(kindOf('已经修复了'), 'resolution'));
check('F3边界 否定作用域遇标点即结束（resolution 侧仍生效）', () => {
  // 否定作用域逻辑本身仍必须正确：它现在只服务于 resolution/correction
  assert.equal(kindOf('我不确定，但是修好了'), 'resolution');
  assert.notEqual(kindOf('还没修好'), 'resolution');
});
check('F3边界 "not only failed" → 关键词不再声称 failure（AC5）', () => assert.notEqual(kindOf('it not only failed but also crashed'), 'failure'));
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
check('F4 讨论文本被完整保留，且不再由关键词声称 failure（AC5）', () => {
  const kept = stripInjectedContent(DISCUSSION);
  assert.equal(kept, DISCUSSION, '讨论文本被吞：' + JSON.stringify(kept));
  const r = learningSignals({ turns: [{ seq: 1, role: 'user', text: kept }] });
  // AC5：关键词路径已退出失败判定 ⇒ 该讨论文本不再产生 failure 关键词信号
  assert.equal(r.signals.some((s) => s.kind === 'failure'), false,
    'keyword path must not claim failure (AC5)');
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
