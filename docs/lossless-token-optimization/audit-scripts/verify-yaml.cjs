// 验证 dsh 预设组合 YAML（使用与 cordis-plugin-include 相同的 entryListSchema 构造）
const yaml = require(process.env.USERPROFILE + '/.dsh/profiles/node_modules/js-yaml');
const fs = require('fs');

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (d) => {
    try { return Function('process', 'return (' + d + ')')(process); } catch { return d; }
  },
  predicate: () => false,
  represent: () => '',
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);

const targets = process.argv.slice(2);
for (const p of targets) {
  try {
    const doc = yaml.load(fs.readFileSync(p, 'utf8'), { schema });
    console.log('YAML OK:', p, '| top rows:', doc.length);
    if (p.includes('autonomous')) {
      const g = doc.find(r => r.id === 'compaction');
      console.log('  compaction group:', g.config.map(c => c.id).join(', '));
    }
  } catch (e) {
    console.error('YAML FAIL:', p, '->', e.message.split('\n')[0]);
    process.exit(1);
  }
}
