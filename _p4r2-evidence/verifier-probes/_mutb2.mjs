import fs from 'node:fs';
const f = process.argv[2];
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const i = lines.findIndex((l) => l.includes('if (view.consumes.length === 0)'));
if (i < 0) { console.log('MUT_B2_TARGET_MISSING'); process.exit(1); }
const j = lines.findIndex((l, k) => k > i && l.includes("approval_ledger_consumed_by_other"));
if (j < 0) { console.log('MUT_B2_TAIL_MISSING'); process.exit(1); }
// 删到闭合大括号那一行
let end = j; while (end < lines.length && lines[end].trim() !== '}') end++;
lines.splice(i, end - i + 1, '  // MUT-B2: consume enforcement removed entirely');
fs.writeFileSync(f, lines.join('\n'), 'utf8');
console.log(`MUT-B2 applied: removed lines ${i + 1}..${end + 1}`);