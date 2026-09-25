import fs from 'node:fs';
const p = process.argv[2];
const lines = fs.readFileSync(p, 'utf8').split('\n');
const s0 = lines.findIndex(l => l.includes('approval_ledger_grant_not_consumed'));
const e0 = lines.findIndex(l => l.includes('approval_ledger_consumed_by_other'));
if (s0 < 0 || e0 < 0) { console.log('ANCHOR_MISSING ' + s0 + ' ' + e0); process.exit(2); }
const s = s0 - 1;
let e = e0; while (e < lines.length && !lines[e].trim().startsWith('}')) e++;
const removed = lines.splice(s, e - s + 1);
fs.writeFileSync(p, lines.join('\n'));
console.log('MUTATED removed=' + removed.length + ' lines, range=' + (s + 1) + '-' + (s + removed.length));
