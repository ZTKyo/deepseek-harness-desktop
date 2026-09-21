import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require2 = createRequire('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\js-yaml\\package.json');
const yaml = require2('js-yaml');
const doc = yaml.load(readFileSync('C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml', 'utf8'));
console.log('YAML OK, top-level entries:', doc.length);
const w = doc.filter(p => p.insert && p.insert.some(i => i.id === 'watchdog'));
console.log('watchdog registered:', w.length === 1);
if (w.length) console.log(JSON.stringify(w[0].insert.find(i => i.id === 'watchdog')));
