// model-selection-guard-test.mjs — 模型选择守卫回归测试（纯函数，零 API 请求）
//
// 运行：node model-selection-guard-test.mjs
// 覆盖：回归矩阵 Case 1-7 + 状态完整性不变量 1-5
// 方法：mock resolveModelInfo（内存注册表），调用 decideRoute 纯函数验证。

import { validateSelection, decideRoute } from 'file:///C:/Users/Administrator/.dsh/profiles/web/model-selection-guard-core.mjs';

// ── 内存 mock 注册表（模拟真实 Registry：settings.yaml 的 llm-pi-ai.providers）──
// bai:     deepseek-v4-flash, deepseek-v4-flash-vision-exp
// openrouter: stealth/ox-alpha, deepseek/deepseek-v4-flash-0731, qwen/qwen3.7-flash
// opencode: deepseek-v4-flash-vision-exp, deepseek-v4-flash
const REGISTRY = {
  bai: new Set(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']),
  openrouter: new Set(['stealth/ox-alpha', 'deepseek/deepseek-v4-flash-0731', 'qwen/qwen3.7-flash']),
  opencode: new Set(['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash']),
  commandcode: new Set(['meta/muse-spark-1.2-contributor', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-vision-exp']),
};

/** mock resolveModelInfo：命中返回 info，未命中抛 UNKNOWN_MODEL（与 pi-ai modelOf 一致）。 */
async function mockResolveModelInfo(provider, model) {
  const set = REGISTRY[provider];
  if (set && set.has(model)) {
    return { provider, id: model, name: model, inputModalities: ['text'] };
  }
  const err = new Error(`pi-ai provider "${provider}" has no configured model "${model}"`);
  err.code = 'UNKNOWN_MODEL';
  throw err;
}

// ── 测试记录 ──
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; results.push(`PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { failed++; results.push(`FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

// 默认选择：settings agent-default-model（当前 = bai/deepseek-v4-flash）
const DEFAULT = { provider: 'bai', model: 'deepseek-v4-flash' };
// 静默 logger
const logger = { warn: () => {}, error: () => {}, info: () => {} };

// ══════════════════════════════════════════════════════════════
// 回归矩阵
// ══════════════════════════════════════════════════════════════

// Case 1: bai + deepseek-v4-flash-vision-exp → PASS（Registry 注册）
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'bai', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Case1 bai+vision-exp 合法 passthrough', action === 'passthrough' && config.provider === 'bai' && config.model === 'deepseek-v4-flash-vision-exp');
}

// Case 2: openrouter + stealth/ox-alpha → PASS
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'stealth/ox-alpha' }, DEFAULT, logger);
  check('Case2 openrouter+ox-alpha 合法 passthrough', action === 'passthrough' && config.model === 'stealth/ox-alpha');
}

// Case 3: openrouter + deepseek-v4-flash-vision-exp → REJECT，旧状态不变
{
  const { config, action, reason } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Case3 非法 pair 被拒绝', action === 'replaced');
  check('Case3 回退到合法 default', config.provider === 'bai' && config.model === 'deepseek-v4-flash');
  check('Case3 保留 reason 诊断', typeof reason === 'string' && reason.includes('invalid selection'));
}

// Case 4: 原 bai+vision-exp，切换 Ox Alpha → 直接成为 openrouter+stealth/ox-alpha，无中间态
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'stealth/ox-alpha' }, DEFAULT, logger);
  check('Case4 切换 Ox Alpha 原子成对', action === 'passthrough' && config.provider === 'openrouter' && config.model === 'stealth/ox-alpha');
}

// Case 5: 原 openrouter+ox-alpha，切换 DeepSeek Vision → 必须进入真正注册的 Provider（bai/opencode）
// 模拟 UI 提交 (opencode, deepseek-v4-flash-vision-exp)（正确注册的 provider）
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'opencode', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Case5 vision-exp 在 opencode 合法', action === 'passthrough' && config.provider === 'opencode');
}
// 若 UI 错误提交 (openrouter, vision-exp) → 拒绝回退，不留 openrouter
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Case5 错误提交 openrouter+vision-exp 不留残留', action === 'replaced' && config.provider !== 'openrouter');
}

// Case 6: 历史 session header 非法 pair（openrouter+vision-exp）恢复 → 拒绝继续使用
{
  const { config, action } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Case6 历史非法 pair 恢复时被替换', action === 'replaced');
  check('Case6 回退为合法 default', config.provider === 'bai' && config.model === 'deepseek-v4-flash');
}

// Case 7: 完全不存在模型 openrouter+definitely-not-a-model → 明确失败/拒绝，session 状态不变
{
  const { config, action, reason } = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'definitely-not-a-model' }, DEFAULT, logger);
  check('Case7 不存在模型被拒绝', action === 'replaced' || action === 'failed');
  if (action === 'replaced') {
    check('Case7 回退合法 default', config.provider === 'bai' && config.model === 'deepseek-v4-flash');
  } else {
    check('Case7 failed 时保留原 config 让上层报错', config.model === 'definitely-not-a-model');
  }
  check('Case7 有诊断 reason', typeof reason === 'string');
}

// ══════════════════════════════════════════════════════════════
// 状态完整性不变量
// ══════════════════════════════════════════════════════════════

// Invariant 1: 任何进入 Agent 请求的 pair 必须在 Registry 有效
// （decideRoute 返回的 config 必须通过 resolveModelInfo 验证）
{
  const cases = [
    { provider: 'bai', model: 'deepseek-v4-flash' },
    { provider: 'openrouter', model: 'stealth/ox-alpha' },
    { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
  ];
  let allValid = true;
  for (const c of cases) {
    const v = await validateSelection(mockResolveModelInfo, c.provider, c.model);
    if (!v.valid) allValid = false;
  }
  check('Invariant1 合法 pair 全部通过验证', allValid);
}

// Invariant 2: provider/model 作为整体更新（decideRoute 输出要么原样、要么整体替换）
{
  const r = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Invariant2 整体替换（非单字段）', r.action === 'replaced' && r.config.provider === 'bai' && r.config.model === 'deepseek-v4-flash');
}

// Invariant 3: 非法 pair 不写入 session current/picked（守卫层只替换 config，不写状态）
// 说明：decideRoute 是纯函数，不接触 session 状态；写状态由 selectModel RPC 负责（其已原子验证）。
// 此处验证守卫的替换输出不保留非法 model。
{
  const r = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, DEFAULT, logger);
  check('Invariant3 替换后不含非法 model', r.config.model !== 'deepseek-v4-flash-vision-exp');
}

// Invariant 4: 历史非法 pair 不重新进入 Agent Request（Case6 已覆盖，此处再验 openrouter 前缀模型不受影响）
{
  const r = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' }, DEFAULT, logger);
  check('Invariant4 合法 openrouter+deepseek/xxx 放行（无前缀猜测）', r.action === 'passthrough' && r.config.model === 'deepseek/deepseek-v4-flash-0731');
}

// Invariant 5: Router 只对合法初始 ModelSelection 工作（守卫在 router 之前校验最终 pair）
// 验证 openrouter + qwen/qwen3.7-flash（router 会改写的合法输入）也放行
{
  const r = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'qwen/qwen3.7-flash' }, DEFAULT, logger);
  check('Invariant5 合法 openrouter+qwen 放行', r.action === 'passthrough');
}

// ══════════════════════════════════════════════════════════════
// 附加：default 本身非法时 fail-loud（不静默猜模型）
{
  const badDefault = { provider: 'openrouter', model: 'not-registered-either' };
  const r = await decideRoute(mockResolveModelInfo, { provider: 'openrouter', model: 'deepseek-v4-flash-vision-exp' }, badDefault, logger);
  check('Aux  default 非法时 failed（fail-loud）', r.action === 'failed');
  check('Aux  failed 时保留原 config', r.config.model === 'deepseek-v4-flash-vision-exp');
}

// 附加：缺 provider/model → passthrough 由上层报错
{
  const r = await decideRoute(mockResolveModelInfo, { provider: '', model: '' }, DEFAULT, logger);
  check('Aux  缺 pair passthrough', r.action === 'passthrough');
}

// ── 汇总 ──
console.log('\n=== MODEL-SELECTION-GUARD REGRESSION ===');
for (const r of results) console.log(r);
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);