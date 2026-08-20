// 验证 tool-result-pruner 的核心裁剪算法（与 dsh 源码同逻辑，验证插件效果）
// 直接实现源码中的 pruneContent 算法并验证行为
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

function codePointLength(text) { return Array.from(text).length; }

function pruneContent(blocks, config) {
  const totalChars = blocks.reduce((a, b) => a + (b.type === 'text' ? codePointLength(b.text) : 0), 0);
  if (totalChars <= config.thresholdChars) return null;
  const removedStart = config.headChars;
  const removedEnd = totalChars - config.tailChars;
  const pruned = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of blocks) {
    if (block.type !== 'text') { pruned.push(block); continue; }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : '';
    if (marker.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) throw new Error('failed to locate removed span');
  return pruned;
}

const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

// Test 1: 大输出（3 万字符）应被裁剪
const bigText = 'HEAD-START ' + 'x'.repeat(30000) + ' TAIL-END';
const pruned = pruneContent([{ type: 'text', text: bigText }], config);
const after = pruned[0].text;
console.log('=== Test 1: 大输出裁剪 ===');
console.log('before:', bigText.length, 'after:', after.length, 'reduction:', ((bigText.length - after.length) / bigText.length * 100).toFixed(1) + '%');
console.log('has marker:', after.includes(PRUNE_MARKER));
console.log('head intact:', after.startsWith('HEAD-START'));
console.log('tail intact:', after.endsWith('TAIL-END'));
const t1 = after.length < bigText.length && after.includes(PRUNE_MARKER) && after.startsWith('HEAD-START') && after.endsWith('TAIL-END');

// Test 2: 小输出不受影响
const t2 = pruneContent([{ type: 'text', text: 'short result' }], config) === null;
console.log('\n=== Test 2: 小输出不裁剪 ===');
console.log('small result untouched:', t2);

// Test 3: 幂等（已裁剪内容再裁不变）
const t3 = pruneContent(pruned, config) === null;
console.log('\n=== Test 3: 幂等性 ===');
console.log('re-prune no-op:', t3);

// Test 4: 多块混合（text + 非 text 如 tool-result 嵌套）
const nested = [
  { type: 'text', text: 'SHORT' },
  { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'y'.repeat(20000) }] }
];
const pruned4 = pruneContent(nested, config);
console.log('\n=== Test 4: 混合块 ===');
if (pruned4) {
  console.log('blocks after:', pruned4.length, '| first text:', JSON.stringify(pruned4[0].text), '| tool-result preserved as block:', pruned4[1].type === 'tool-result');
} else {
  console.log('not pruned (WRONG)');
}
const t4 = pruned4 !== null;

const pass = t1 && t2 && t3 && t4;
console.log('\nOVERALL:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
