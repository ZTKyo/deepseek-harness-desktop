// context-memory-core.mjs —— P2.5 CONTEXT MEMORY 纯函数核心（零 IO / 零依赖）
//
// Authority 边界（P2.5 契约，见 docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/AUDIT_R1.md）：
//   - 只决定"当前这一轮模型应该看到什么上下文"（pre-compaction projection/history selection）
//   - 绝不成为第二 Task DB / Goal DB / Recovery Engine / Router / compaction authority
//   - Official Session 永不删除；一切精确内容可经 sourceEventSeqs 回源
//   - 投影缺失/损坏 → fail-open 回 raw Session
//
// 本模块全部为确定性纯函数；IO 与钩子注册在 context-memory.mjs 插件壳内。

/** 粗估 token 数（chars/4 兜底；与 dsh-context-budget.mjs 同一口径）。 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/** 从会话事件取消息对象（user/message 的 data 即消息；assistant/tool-result 在 data.message）。 */
export function messageOfEvent(event) {
  if (!event) return null;
  if (event.type === 'user/message') return event.data ?? null;
  return event.data?.message ?? null;
}

/** 递归收集文本块内容。 */
export function recursiveText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (Array.isArray(block)) return block.map(recursiveText).join('');
  if (typeof block === 'object') {
    if (typeof block.text === 'string') return block.text;
    if (Array.isArray(block.content)) return recursiveText(block.content);
  }
  return '';
}

/** 消息是否来自插件注入（投影/运行时上下文快照）——提取时跳过，防反馈回路。 */
export function isPluginSourced(message) {
  return message?.source?.kind === 'plugin';
}

/** 判断 assistant 消息是否携带 tool-call 块（决定区段边界安全性）。 */
export function hasToolCalls(message) {
  return Array.isArray(message?.content) &&
    message.content.some((b) => b?.type === 'tool-call');
}

/**
 * 在 Recent Window 之前选出可安全替换的连续表面区段。
 * 安全规则：
 *   - 区段终点不得是"带未配对 tool-call 的 assistant/message"（防止调用/结果被拆开）
 *   - 若窗口首节点是 tool/result 且其配对调用在候选区内 → 向内收缩直至干净
 *   - 区段起点对齐到第一个 user/message（干净的对话切面）
 *   - 区段长度 ≥ minProjectNodes 才值得投影（防抖动）
 * 返回 { startSeq, endSeq, nodeSeqs } 或 null。
 */
export function selectProjectionRange(surfaceNodes, events, opts = {}) {
  const recentWindow = opts.recentWindow ?? 40;
  const minProjectNodes = opts.minProjectNodes ?? 4;
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length <= recentWindow) return null;
  const region = surfaceNodes.slice(0, surfaceNodes.length - recentWindow).slice();
  // 收缩终点：保证调用/结果配对完整 ——
  //   区段末尾不得是带 tool-call 的 assistant（其结果可能落在窗口内）；
  //   窗口首节点若是 tool/result，其配对调用必在区段末尾附近，一并收缩。
  const windowStartIdx = surfaceNodes.length - recentWindow;
  for (;;) {
    if (region.length === 0) return null;
    const lastEvt = events[region[region.length - 1]];
    const nextEvt = events[surfaceNodes[windowStartIdx]];
    const lastHasCalls = lastEvt?.type === 'assistant/message' && hasToolCalls(lastEvt?.data?.message);
    const nextIsResult = nextEvt?.type === 'tool/result';
    if (!lastHasCalls && !nextIsResult) break;
    region.pop();
  }
  // 起点对齐：前进到第一个非 tool/result 且为 user/message 的节点
  let startIdx = 0;
  while (startIdx < region.length) {
    const evt = events[region[startIdx]];
    if (evt?.type === 'user/message') break;
    startIdx += 1;
  }
  const aligned = region.slice(startIdx);
  if (aligned.length < minProjectNodes) return null;
  const startSeq = aligned[0];
  const endSeq = aligned[aligned.length - 1];
  return { startSeq, endSeq, nodeSeqs: aligned.slice() };
}

/** 空 Observation 骨架。 */
export function emptyObs() {
  return {
    goal: null, // {text, refs:[seq]}
    completedActions: [],
    verifiedEvidence: [],
    keyFileChanges: [],
    failedApproaches: [],
    blockers: [],
    runtimeFacts: [],
  };
}

/** 去重签名：小写+压掉非字母数字，取前 80 字符（合并近似重复的错误/动作条目）。 */
function normKey(t, len = 80) {
  return String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, len);
}

function pushUnique(list, item, keyLen = 80) {
  const key = normKey(item.t, keyLen);
  if (!key) return false;
  if (list.some((x) => keysRelated(normKey(x.t, keyLen), key))) return false;
  list.push(item);
  return true;
}

/** 等值或前缀关系（合并近似重复签名，如同一错误的 retry 变体）。 */
function keysRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** 判断 PASS 文本是否与 blocker 文本证据相关（保守：共享 ≥2 个 >3 字符 token 或前缀关系）。 */
function isRelatedEvidence(blockerText, passText) {
  const a = normKey(blockerText), b = normKey(passText);
  if (keysRelated(a, b)) return true;
  const ta = a.split(' ').filter(w => w.length > 3);
  const tb = new Set(b.split(' ').filter(w => w.length > 3));
  let hits = 0;
  for (const w of ta) if (tb.has(w) && (++hits) >= 2) return true;
  return false;
}

const RX_ERROR = /\b(error|failed|failure|exception|traceback|enoent|eacces|eperm|exit code[: ]+\d+|cannot find|denied|timeout(?:d)?\b)/i;
const RX_PASS = /\b(pass(?:ed)?|success(?:ful)?|verified|all tests?\b|✅)\b/i;
// R2-7 分层分类：工具输出通常以结果词开头，先看开头信号词再全局匹配，
// 避免 "PASS ... 0 failed / 0 errors" 这类带否定计数语境的成功输出被 RX_ERROR 误吞。
const RX_ERROR_LEAD = /^\s*(error|fail(?:ed|ure)?|exception|traceback|enoent|eacces|eperm|cannot find|denied|fatal)\b/i;
const RX_PASS_LEAD = /^\s*(pass(?:ed|ing)?|ok\b|success|verified|✅|all tests? (?:pass|ok))\b/i;
const RX_FILEWRITE = /(^|\n)(diff --git|\+\+\+ |created |created\b|updated |modified |written|saved to )/i;
const RX_RUNTIME = /(localhost|127\.0\.0\.1):\d+|(?:^|\s)version[:= ]\S+/i;

/**
 * 把一段旧表面事件增量投影为结构化 Observation（合并进 prevObs，幂等）。
 * 启发式、保守、有上限 —— 投影只是辅助层，Recent Window 保留原始细节。
 */
export function buildObservation(events, nodeSeqs, prevObs) {
  const obs = prevObs ?? emptyObs();
  for (const seq of nodeSeqs) {
    const evt = events[seq];
    if (!evt) continue;
    const msg = messageOfEvent(evt);
    if (!msg) continue;
    if (isPluginSourced(msg)) continue; // 跳过注入快照（含自身旧投影）
    const text = recursiveText(msg.content).trim();
    if (!text) continue;
    if (evt.type === 'user/message') {
      // 当前 Goal：以最新的实质性用户指令为准（≥40 字符）
      if (text.length >= 40) obs.goal = { t: ellipsize(text, 400), refs: [seq] };
      continue;
    }
    if (evt.type === 'tool/result') {
      const sample = ellipsize(text, 240);
      const ref = seq;
      if (RX_ERROR_LEAD.test(text) || (!RX_PASS_LEAD.test(text) && RX_ERROR.test(text))) {
        pushUnique(obs.failedApproaches, { t: sample, why: firstMatchLine(text, RX_ERROR), refs: [ref] });
        obs.blockers = [{ t: sample, refs: [ref] }]; // 最新错误即当前 blocker 候选
        continue;
      }
      if (RX_PASS_LEAD.test(text) || RX_PASS.test(text)) {
        pushUnique(obs.verifiedEvidence, { t: sample, refs: [ref] });
        // R2-7：只有 PASS 与当前 blocker 证据相关时才保守关闭 blocker；
        // 无关的后续 PASS（如另一模块测试成功）不得清空未解决 blocker（防 false completion）。
        const cur = obs.blockers[obs.blockers.length - 1];
        if (cur && isRelatedEvidence(cur.t, text)) obs.blockers = [];
        pushUnique(obs.completedActions, { t: sample, refs: [ref] });
        continue;
      }
      if (RX_FILEWRITE.test(text)) {
        pushUnique(obs.keyFileChanges, { t: sample, refs: [ref] });
        pushUnique(obs.completedActions, { t: sample, refs: [ref] });
        continue;
      }
      if (RX_RUNTIME.test(text)) {
        pushUnique(obs.runtimeFacts, { t: firstMatchLine(text, RX_RUNTIME), refs: [ref] });
      }
      // 其余工具输出：有实质内容则记为已完成动作的低优先样本
      if (text.length >= 60) pushUnique(obs.completedActions, { t: sample, refs: [ref] });
    }
    // assistant/message 叙述不进入投影（避免膨胀与自证）
  }
  return obs;
}

function ellipsize(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function firstMatchLine(text, rx) {
  const line = String(text).split('\n').find((l) => rx.test(l));
  return ellipsize(line ?? '', 160);
}

/**
 * Reflection：有界去重/归纳。确定性；输出永远受 caps 约束（bounded memory）。
 * caps: { perSection=24, totalChars=6000, failedKeep=12 }
 */
export function reflect(obs, caps = {}) {
  const perSection = caps.perSection ?? 24;
  const totalChars = caps.totalChars ?? 6000;
  const failedKeep = caps.failedKeep ?? 12;
  const out = {
    goal: obs.goal ?? null,
    completedActions: dedupeTail(obs.completedActions, perSection),
    verifiedEvidence: dedupeTail(obs.verifiedEvidence, perSection),
    keyFileChanges: dedupeTail(obs.keyFileChanges, perSection),
    // 失败方案：保留最近 N 条并标注"已判定失败"；重复签名合并
    failedApproaches: dedupeTail(obs.failedApproaches, failedKeep),
    blockers: dedupeTail(obs.blockers, 3),
    runtimeFacts: dedupeTail(obs.runtimeFacts, 8),
  };
  // 总量收敛：超预算时从低价值段开始丢最旧条目
  let budget = totalChars;
  const sections = ['runtimeFacts', 'keyFileChanges', 'completedActions', 'verifiedEvidence', 'failedApproaches'];
  const size = (o) => JSON.stringify(o).length;
  budget -= size(out.goal ?? {});
  for (const sec of sections) {
    const list = out[sec];
    while (list.length > 0 && budget - list.reduce((a, x) => a + size(x), 0) < 0) {
      list.shift(); // 丢最旧
    }
    budget -= list.reduce((a, x) => a + size(x), 0);
  }
  return out;
}

function dedupeTail(list, cap) {
  const seen = [];
  const out = [];
  for (let i = (list ?? []).length - 1; i >= 0 && out.length < cap; i -= 1) {
    const key = normKey(list[i]?.t);
    if (!key || seen.some((k) => keysRelated(k, key))) continue;
    seen.push(key);
    out.unshift(list[i]);
  }
  return out;
}

/** 渲染注入文本（模型可见）。含版本、sessionId、回源指引；不含任何 secret 形态字段。 */
export function renderObservationText(obs, meta = {}) {
  const L = [];
  L.push(`[context-memory observation v${meta.version ?? 1}] sessionId=${meta.sessionId ?? '?'}` +
    ` sourceRange=seq${meta.startSeq ?? '?'}-${meta.endSeq ?? '?'} (older history projected)` +
    `${meta.switchActivated ? ' [activated by provider/model switch]' : ''}`);
  L.push('Exact originals remain in the append-only session log. To recall precise text ' +
    '(error, tool output, patch, user wording, timeline), cite the seq shown next to any item.');
  const g = obs.goal;
  if (g) L.push(`\n## Current goal\n- ${g.t} (seq ${g.refs?.[0] ?? '?'})`);
  if (obs.completedActions.length) {
    L.push(`\n## Completed actions / progress`);
    for (const x of tailSlice(obs.completedActions)) L.push(`- ${x.t} (seq ${x.refs?.[0] ?? '?'})`);
  }
  if (obs.verifiedEvidence.length) {
    L.push(`\n## Verified evidence`);
    for (const x of tailSlice(obs.verifiedEvidence)) L.push(`- ${x.t} (seq ${x.refs?.[0] ?? '?'})`);
  }
  if (obs.keyFileChanges.length) {
    L.push(`\n## Key file changes`);
    for (const x of tailSlice(obs.keyFileChanges)) L.push(`- ${x.t} (seq ${x.refs?.[0] ?? '?'})`);
  }
  if (obs.failedApproaches.length) {
    L.push(`\n## Failed approaches / errors — ALREADY TRIED AND FAILED; do not retry without NEW evidence`);
    for (const x of tailSlice(obs.failedApproaches)) {
      L.push(`- ${x.t}${x.why ? ` [why: ${x.why}]` : ''} (seq ${x.refs?.[0] ?? '?'})`);
    }
  }
  if (obs.blockers?.length) {
    L.push(`\n## Open blockers`);
    for (const x of obs.blockers) L.push(`- ${x.t} (seq ${x.refs?.[0] ?? '?'})`);
  }
  if (obs.runtimeFacts.length) {
    L.push(`\n## Runtime facts`);
    for (const x of tailSlice(obs.runtimeFacts)) L.push(`- ${x.t} (seq ${x.refs?.[0] ?? '?'})`);
  }
  return L.join('\n');
}

function tailSlice(list) {
  const n = list.length;
  return n <= 10 ? list : list.slice(n - 10);
}

/** 切换判据：provider 变化，或 model 变化且请求不是 auto 模式（常规 auto 重写≠切换）。 */
export function detectSwitch(prevRoute, nextRoute, requestedMode) {
  if (!prevRoute || !nextRoute) return false;
  if (!prevRoute.provider || !nextRoute.provider) return false;
  if (String(prevRoute.provider) !== String(nextRoute.provider)) return true;
  if (String(prevRoute.model) !== String(nextRoute.model) && requestedMode !== 'auto') return true;
  return false;
}

/** 从请求侧 model 字段推导请求模式（auto / 具体 id）；容忍缺失。 */
export function deriveRequestedModeSafe(requestedModel) {
  const m = String(requestedModel ?? '').trim();
  if (m === '' || m === 'auto') return 'auto';
  return m;
}

/** store 结构校验；损坏返回 null（调用方走 fail-open 重建）。 */
export function validateStore(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.schemaVersion !== 1) return null;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
    if (!Number.isSafeInteger(raw.version) || raw.version < 0) return null;
    if (typeof raw.active !== 'boolean') return null;
    if (!Number.isSafeInteger(raw.watermark) || raw.watermark < 0) return null;
    if (!raw.obs || typeof raw.obs !== 'object') return null;
    if (!Array.isArray(raw.refs)) return null;
    return raw;
  } catch {
    return null;
  }
}
