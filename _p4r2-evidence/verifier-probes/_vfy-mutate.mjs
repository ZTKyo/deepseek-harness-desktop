// 变异工具（只作用于验证者的冻结副本，绝不触碰仓库）
import fs from 'node:fs';
const [file, from, to] = process.argv.slice(2);
let t = fs.readFileSync(file, 'utf8');
if (!t.includes(from)) { console.error(`NOT FOUND in ${file}: ${from.slice(0, 60)}`); process.exit(1); }
fs.writeFileSync(file, t.replace(from, to), 'utf8');
console.log(`mutated ${file}`);
