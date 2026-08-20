// tool-output-offload.mjs —— 大工具输出独立裁剪（LOSSLESS Token 优化，2026-08-20）
//
// 问题（双根因，实测确认）：
//   1) dsh 的 tool-result-pruner 只在 compaction 压力触发时运行（compactIfNeeded 内部），
//      普通任务永远达不到 compaction 阈值 → 大 tool 输出全程驻留上下文。
//   2) 框架 pruner 的 measureContent 只统计顶层 type==='text' 块，而真实 tool/result
//      的 content 是嵌套 {type:'tool-result', content:[{type:'text'}]} → 测量恒为 0，
//      即使触发也永不裁剪（实测 5 万字符输出测出 0 字符）。
//   实测：Muse 会话中 24 个 >8192 字符的 tool 输出（共 ~50 万字符）全部未被裁剪，
//          每次模型调用都重发，缓存击穿时单次 inputTokens 高达 24 万。
//
// 方案：本插件挂 agent/pre-step（与 compaction-basic 同一点），每个 step 前：
//   - 用【递归测量】找出 surface 上超阈值的 tool/result；
//   - 用【递归裁剪】把超大 text 块裁为 head + marker + tail；
//   - 按 dsh 官方 shadow-price 协议落地：先 append compaction/prune（记录
//     shadowedSeqs/shadowedTokenCount），再 append tool/result 替换节点
//     （surfaceOp replace，sourceEventSeqs 指向原 seq）——与 dsh-compaction-tool-result-pruner
//     的 pruneSession 完全同构，兼容所有回放/校验/投影逻辑。
//
// 无损保证：
//   - 原始 tool/result 事件仍在 append-only session log（sourceEventSeqs 可回源）；
//   - 模型仍可见 head(4096) + tail(1024) + 明确 marker，需要时可重新读取源文件；
//   - 不删除任何信息，不改 pruner 阈值/头尾配置（沿用 8192/4096/1024）。
//
// 风险：低 —— 复用 dsh 官方协议（shadow price + surface replace），只改测量/裁剪深度；
//   与 compaction 调用天然幂等（已裁内容不再裁）；服务不可用时静默跳过。

export const name = 'tool-output-offload';

// 与 dsh-compaction-tool-result-pruner 相同的默认预算
const THRESHOLD_CHARS = 8192;
const HEAD_CHARS = 4096;
const TAIL_CHARS = 1024;
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

// 递归测量文本字符数（修正框架只测顶层 text 的 bug）
function recursiveChars(block) {
  if (block == null) return 0;
  if (typeof block === 'string') return block.length;
  if (Array.isArray(block)) return block.reduce((a, b) => a + recursiveChars(b), 0);
  if (typeof block === 'object') {
    if (typeof block.text === 'string') return block.text.length;
    if (Array.isArray(block.content)) return block.content.reduce((a, b) => a + recursiveChars(b), 0);
  }
  return 0;
}

// 递归裁剪：把单个 text 块裁为 head+marker+tail；非 text 结构递归进入 content
function recursivePrune(block, state) {
  if (block == null) return block;
  if (typeof block === 'string') return block;
  if (Array.isArray(block)) return block.map((b) => recursivePrune(b, state));
  if (typeof block === 'object') {
    // text 块：若累计字符位置落在 [head, total-tail) 区间且未插入 marker → 裁剪
    if (typeof block.text === 'string') {
      const points = Array.from(block.text);
      const blockStart = state.consumed;
      const blockEnd = blockStart + points.length;
      const headEnd = Math.min(points.length, Math.max(0, state.removedStart - blockStart));
      const tailStart = Math.min(points.length, Math.max(0, state.removedEnd - blockStart));
      const marker = blockStart < state.removedEnd && blockEnd > state.removedStart && !state.markerInserted ? PRUNE_MARKER : '';
      if (marker.length > 0) state.markerInserted = true;
      state.consumed = blockEnd;
      const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
      return { ...block, text };
    }
    if (Array.isArray(block.content)) {
      const content = block.content.map((b) => recursivePrune(b, state));
      return { ...block, content };
    }
    return block;
  }
  return block;
}

// 单条 tool/result 消息的递归测量
function messageChars(message) {
  if (!message || !Array.isArray(message.content)) return 0;
  return message.content.reduce((a, b) => a + recursiveChars(b), 0);
}

// 对一条消息做递归裁剪；返回裁剪后的消息，未超阈值返回 null
function pruneMessage(message) {
  const total = messageChars(message);
  if (total <= THRESHOLD_CHARS) return null;
  const state = { removedStart: HEAD_CHARS, removedEnd: total - TAIL_CHARS, consumed: 0, markerInserted: false };
  const content = message.content.map((b) => recursivePrune(b, state));
  if (!state.markerInserted) return null; // 找不到可裁 span（理论上不会发生）
  const afterChars = messageChars({ content });
  if (afterChars >= total) return null; // 未变小
  return { ...message, content };
}

export function apply(ctx) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (signal.aborted) return next();
    try {
      const session = agent?.session;
      if (!session || typeof session.append !== 'function' || typeof session.surface?.nodes === 'undefined') return next();
      const meter = ctx.get('tokenMeter');
      const surfaceNodes = [...session.surface.nodes];
      let prunedCount = 0;
      let charsRemoved = 0;
      for (const seq of surfaceNodes) {
        const event = session.events[seq];
        if (event?.type !== 'tool/result') continue;
        const message = event.data?.message;
        if (!message) continue;
        const total = messageChars(message);
        if (total <= THRESHOLD_CHARS) continue;
        // 已裁剪过的（含 marker）跳过 —— 幂等
        if (JSON.stringify(message).includes(PRUNE_MARKER)) continue;
        const pruned = pruneMessage(message);
        if (!pruned) continue;
        // 计算 token 影响（与框架 pruner 相同的 shadow-price 协议）
        const shadowedTokenCount = typeof meter?.estimateMessage === 'function' ? meter.estimateMessage(event.data.message) : undefined;
        // 1) 先 append compaction/prune shadow 事件
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          ...shadowedTokenCount === undefined ? {} : { shadowedTokenCount }
        });
        // 2) 再 append tool/result 替换节点（surface replace，只改 content）
        session.append('tool/result', {
          ...event.data,
          message: pruned
        }, {
          surfaceOp: { op: 'replace', start: seq, end: seq },
          sourceEventSeqs: [seq]
        });
        prunedCount += 1;
        charsRemoved += total - messageChars(pruned);
      }
      if (prunedCount > 0) {
        try {
          ctx.logger?.info?.(`[tool-output-offload] pruned ${prunedCount} oversized tool result(s), removed ~${charsRemoved} chars`);
        } catch {}
      }
    } catch (error) {
      try {
        ctx.logger?.debug?.('[tool-output-offload] prune skipped: ' + String(error?.message ?? error));
      } catch {}
    }
    return next();
  });
}
