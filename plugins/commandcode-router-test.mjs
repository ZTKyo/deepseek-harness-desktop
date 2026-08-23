// commandcode-router-test.mjs —— Command Code 回落/防粘滞 确定性回归测试
//
// 为什么是确定性单测而不是只靠打真 API：
//   「一次回落后整个会话被锁死」这类 bug 必须能在每次改动后可重复地验证，
//   而真实 provider 故障无法按需复现。故对纯函数 core 注入故障做状态机验证，
//   再另外用真 API 做端到端冒烟（commandcode-smoke.mjs）。
//
// 覆盖：T5 / T6 / T7 + 防乒乓 + 「自动回落绝不改 preferredModel」不变量 + 失败分类
// 运行：node commandcode-router-test.mjs

import {
  MUSE, DEEPSEEK, AUTO,
  newState, applyTurnBoundary, applyManualSwitch, resolvePreferred,
  decideRequestModel, decideFallback, classifyFailure, snapshot,
} from './commandcode-router-core.mjs';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── 精确镜像插件 agent/request 的处理顺序（全部调用同一批 core 函数，避免逻辑漂移）──
function simulateRequest(st, { turn, intent = null, resolvedModel = null }) {
  applyTurnBoundary(st, turn, resolvedModel);
  applyManualSwitch(st, intent);
  st.preferredModel = resolvePreferred(intent, st.baselineModel);
  return decideRequestModel(st);           // { model, source }
}
// ── 镜像插件 agent/request-error ──
function simulateFailure(st, { failedModel, failure }) {
  return decideFallback({ state: st, failedModel, failure });
}

const TIMEOUT = { message: 'fetch failed: ETIMEDOUT connecting to api.commandcode.ai' };
const RATE = { message: 'Rate limit exceeded', status: 429 };
const SERVER = { message: 'upstream server_error', status: 503 };
const RETIRED = { message: 'model_not_found: model has been retired', status: 404 };
const AUTH = { message: 'authentication_error: invalid api key', status: 401 };
const BADREQ = { message: 'invalid_request_error: Invalid max_tokens value', status: 400 };
const EMPTY = { message: 'model returned an empty response (zero_tokens)' };
const ZDR422 = { message: 'cmd_zdr_no_providers: no ZDR-capable upstream', status: 422 };

// ─────────────────────────────────────────────
section('失败分类');
eq('timeout → provider', classifyFailure(TIMEOUT), 'provider');
eq('429 → provider', classifyFailure(RATE), 'provider');
eq('503 → provider', classifyFailure(SERVER), 'provider');
eq('404 retired → unavailable', classifyFailure(RETIRED), 'unavailable');
eq('422 zdr → unavailable', classifyFailure(ZDR422), 'unavailable');
eq('empty response → quality', classifyFailure(EMPTY), 'quality');
eq('401 → non-routing（换模型无意义）', classifyFailure(AUTH), 'non-routing');
eq('400 max_tokens → non-routing', classifyFailure(BADREQ), 'non-routing');

// ─────────────────────────────────────────────
section('默认主力：AUTO → DeepSeek');
{
  const st = newState();
  eq('AUTO 解析为 DeepSeek', simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO }).model, DEEPSEEK);
  eq('preferredModel = DeepSeek', st.preferredModel, DEEPSEEK);
  const st2 = newState();
  eq('无显式选择时也是 DeepSeek', simulateRequest(st2, { turn: 1, resolvedModel: DEEPSEEK }).model, DEEPSEEK);
}

// ─────────────────────────────────────────────
section('T5：DeepSeek 故障 → 回落 Muse；下一次正常请求自动恢复 DeepSeek（同一会话，不新建对话）');
{
  const st = newState();
  // turn 1 第一次请求 → DeepSeek
  eq('T5.1 首次使用 DeepSeek', simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO }).model, DEEPSEEK);
  // 注入 DeepSeek 故障
  const d = simulateFailure(st, { failedModel: DEEPSEEK, failure: TIMEOUT });
  check('T5.2 判定需要重试', d.retry === true);
  eq('T5.3 armed = Muse', d.armed, MUSE);
  // 重试（同一 turn 的下一个 step）
  const retry = simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  eq('T5.4 重试确实用 Muse', retry.model, MUSE);
  eq('T5.5 来源标记为 fallback', retry.source, 'fallback');
  // ★ 核心不变量：preferredModel 没被自动回落改写
  eq('T5.6 preferredModel 仍是 DeepSeek（自动回落未污染会话默认）', st.preferredModel, DEEPSEEK);
  // 下一个 turn（同一会话）→ 自动恢复 DeepSeek
  const next = simulateRequest(st, { turn: 2, intent: AUTO, resolvedModel: AUTO });
  eq('T5.7 下一次正常请求自动恢复 DeepSeek', next.model, DEEPSEEK);
  eq('T5.8 来源回到 preferred', next.source, 'preferred');
  check('T5.9 一次性回落已被清空', st.armedFallback === null);
}

// ─────────────────────────────────────────────
section('T6：手动选 Muse 为主力 + 故障 → 回落 DeepSeek；下一轮回到 Muse');
{
  const st = newState();
  eq('T6.1 手动选定 Muse', simulateRequest(st, { turn: 1, intent: MUSE, resolvedModel: MUSE }).model, MUSE);
  eq('T6.2 preferredModel = Muse', st.preferredModel, MUSE);
  const d = simulateFailure(st, { failedModel: MUSE, failure: SERVER });
  eq('T6.3 反向回落 armed = DeepSeek', d.armed, DEEPSEEK);
  eq('T6.4 重试用 DeepSeek', simulateRequest(st, { turn: 1, intent: MUSE, resolvedModel: MUSE }).model, DEEPSEEK);
  eq('T6.5 preferredModel 仍是 Muse（未被污染）', st.preferredModel, MUSE);
  eq('T6.6 下一轮回到 Muse', simulateRequest(st, { turn: 2, intent: MUSE, resolvedModel: MUSE }).model, MUSE);
}

// ─────────────────────────────────────────────
section('防乒乓：回落后的模型也失败 → 停止切换、如实报错');
{
  const st = newState();
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  const d1 = simulateFailure(st, { failedModel: DEEPSEEK, failure: TIMEOUT });
  eq('第一次回落 → Muse', d1.armed, MUSE);
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  const d2 = simulateFailure(st, { failedModel: MUSE, failure: TIMEOUT });
  check('第二次失败不再切换', d2.retry === false && d2.armed === null);
  check('明确标记 stop（交由上层报错）', d2.stop === true);
  eq('本 turn 只发生了 1 次跨模型回落', st.fallbackCount, 1);
}

// ─────────────────────────────────────────────
section('T7：同一会话内 DeepSeek → Muse → DeepSeek → Muse → DeepSeek（混合手动与回落）');
{
  const st = newState();
  const trace = [];
  // 1) AUTO → DeepSeek
  trace.push(simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO }).model);
  // 2) 手动切到 Muse
  trace.push(simulateRequest(st, { turn: 2, intent: MUSE, resolvedModel: MUSE }).model);
  // 3) 手动切回 DeepSeek
  trace.push(simulateRequest(st, { turn: 3, intent: DEEPSEEK, resolvedModel: DEEPSEEK }).model);
  // 4) DeepSeek 故障 → 自动回落 Muse（同 turn 重试）
  const df = simulateFailure(st, { failedModel: DEEPSEEK, failure: RATE });
  eq('T7.a 回落 armed = Muse', df.armed, MUSE);
  trace.push(simulateRequest(st, { turn: 3, intent: DEEPSEEK, resolvedModel: DEEPSEEK }).model);
  // 5) 下一轮：应自动回到手动选定的 DeepSeek
  trace.push(simulateRequest(st, { turn: 4, intent: DEEPSEEK, resolvedModel: DEEPSEEK }).model);

  eq('T7 轨迹 = DeepSeek→Muse→DeepSeek→Muse→DeepSeek',
    trace.join(' → '),
    [DEEPSEEK, MUSE, DEEPSEEK, MUSE, DEEPSEEK].join(' → '));
  eq('T7 结束时 preferredModel = DeepSeek', st.preferredModel, DEEPSEEK);
  check('T7 无残留一次性回落', st.armedFallback === null);
  check('T7 无残留临时主力', st.temporaryPrimary === null);
}

// ─────────────────────────────────────────────
section('手动切换清除陈旧自动回落状态（原 bug：手动切回去会报错）');
{
  const st = newState();
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  simulateFailure(st, { failedModel: DEEPSEEK, failure: RETIRED });   // unavailable → 设临时主力
  check('unavailable 会设置 temporaryPrimary', st.temporaryPrimary === MUSE);
  eq('preferredModel 依然是 DeepSeek', st.preferredModel, DEEPSEEK);
  // 用户在同一会话里手动切到 Muse 再切回 DeepSeek
  simulateRequest(st, { turn: 2, intent: MUSE, resolvedModel: MUSE });
  const back = simulateRequest(st, { turn: 3, intent: DEEPSEEK, resolvedModel: DEEPSEEK });
  eq('手动切回 DeepSeek 生效（未被临时主力锁死）', back.model, DEEPSEEK);
  check('陈旧 temporaryPrimary 已被手动切换清除', st.temporaryPrimary === null);
}

// ─────────────────────────────────────────────
section('「模型真不可用」：临时主力生效，但新任务重新优先 DeepSeek');
{
  const st = newState();
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  simulateFailure(st, { failedModel: DEEPSEEK, failure: ZDR422 });
  eq('临时主力 = Muse', st.temporaryPrimary, MUSE);
  eq('preferredModel 未改（关键）', st.preferredModel, DEEPSEEK);
  eq('同 turn 重试用 Muse', simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO }).model, MUSE);
  eq('新任务重新优先 DeepSeek', simulateRequest(st, { turn: 2, intent: AUTO, resolvedModel: AUTO }).model, DEEPSEEK);
}

// ─────────────────────────────────────────────
section('质量失败：先 1 次同模型自我纠正，再跨模型');
{
  const st = newState();
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  const d1 = simulateFailure(st, { failedModel: DEEPSEEK, failure: EMPTY });
  check('第一次质量失败 → 同模型自我纠正（不换模型）', d1.retry === true && d1.armed === null);
  eq('自我纠正仍用 DeepSeek', simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO }).model, DEEPSEEK);
  const d2 = simulateFailure(st, { failedModel: DEEPSEEK, failure: EMPTY });
  eq('第二次质量失败 → 跨模型回落 Muse', d2.armed, MUSE);
}

// ─────────────────────────────────────────────
section('不该介入的失败：401 / 400 不触发跨模型切换');
{
  const st = newState();
  simulateRequest(st, { turn: 1, intent: AUTO, resolvedModel: AUTO });
  const a = simulateFailure(st, { failedModel: DEEPSEEK, failure: AUTH });
  check('401 不回落', a.retry === false && a.armed === null);
  const b = simulateFailure(st, { failedModel: DEEPSEEK, failure: BADREQ });
  check('400 不回落', b.retry === false && b.armed === null);
  eq('preferredModel 未动', st.preferredModel, DEEPSEEK);
  eq('未消耗回落额度', st.fallbackCount, 0);
}

// ─────────────────────────────────────────────
section('粘滞压力测试：连续 30 个 turn 都注入故障，preferredModel 必须永不漂移');
{
  const st = newState();
  let drifted = null;
  for (let t = 1; t <= 30; t++) {
    const first = simulateRequest(st, { turn: t, intent: AUTO, resolvedModel: AUTO });
    if (first.model !== DEEPSEEK) { drifted = `turn ${t}: 首个请求用了 ${first.model}`; break; }
    simulateFailure(st, { failedModel: DEEPSEEK, failure: TIMEOUT });
    simulateRequest(st, { turn: t, intent: AUTO, resolvedModel: AUTO });   // 回落到 Muse
    if (st.preferredModel !== DEEPSEEK) { drifted = `turn ${t}: preferredModel 变成 ${st.preferredModel}`; break; }
  }
  check('30 轮反复回落后每个新 turn 仍从 DeepSeek 起步、preferredModel 无漂移', drifted === null, drifted ?? '');
}

// ─────────────────────────────────────────────
console.log('\n' + '─'.repeat(64));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL GREEN');
