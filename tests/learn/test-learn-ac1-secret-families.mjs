// AC1（合同编号）严格回归测试：密钥脱敏家族覆盖 + fail-closed 前置。
// 用法：node test-learn-ac1-secret-families.mjs [被测算法的模块路径]
//   默认 = 生产已部署字节 ~/.dsh/profiles/web/learn-core.mjs
// 设计要点（防"空转通过"）：
//   §0 fail-closed 前置：被测模块必须导出 redactSecrets/containsSecret，否则直接 FAIL（非跳过）。
//   §1 R1 反证的 7 类家族必须被拦（值不得原样存活）。
//   §2 对照族（R3 已覆盖）必须仍被拦——防"只加新模式却弄坏旧模式"。
//   §3 通用形态（assignment / bearer / uri-credential）必须仍被拦。
//   §4 非密钥文本不得被误脱敏（防过度脱敏把经验写坏）。
// 只读：仅 import + 纯函数调用。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const target = process.argv[2] || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'learn-core.mjs');
let mod;
try {
  mod = await import(pathToFileURL(target).href);
} catch (e) {
  console.log(`§0 FAIL 无法 import 被测模块 ${target}: ${e.message}`);
  process.exit(3);
}
const { redactSecrets, containsSecret } = mod;
if (typeof redactSecrets !== 'function' || typeof containsSecret !== 'function') {
  console.log('§0 FAIL 被测模块未导出 redactSecrets/containsSecret（fail-closed 判失败，而非跳过）');
  process.exit(3);
}
console.log(`§0 PASS import=${target}`);

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; } else { fail++; failures.push(`${name}: ${detail}`); }
};

// ── §1 R1 反证家族：必须被拦 ─────────────────────────────────────────────
const R1 = [
  ['google-aiza', 'AIza' + 'A'.repeat(35)],
  ['stripe-live', 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2'],
  ['gitlab-pat', 'glpat-' + 'a1B2c3D4e5F6g7H8i9J0'],
  ['huggingface', 'hf_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7'],
  ['npm-token', 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
  // PEM / JWT：**标记本身也要拆开拼**。否则本文件源码行里出现连续的
  // "-----BEGIN ... PRIVATE KEY-----" / "eyJ....eyJ...." 会被仓库两层 secret-scan
  // （tests/reliability/secret-scan-check.mjs + CI Level1 正则扫描）判成真泄漏。
  // 运行时拼出的仍是连续值，故被测的脱敏正则照常命中 —— 只是源码行不再是密钥形状。
  ['pem-private-key', '-----BEGIN RSA' + ' PRIVATE KEY-----' + '\n' + 'MIIEowIBAAKCAQEA' + 'x'.repeat(40) + '\n' + '-----END RSA' + ' PRIVATE KEY-----'],
  // 仓库约定（R3 测试 161-163 行）：假密钥一律**拼接组装**，避免本测试文件本身被
  // 仓库 secret-scan 判成泄漏。故 URL 前缀也拆开拼。
  ['slack-webhook', 'https://hooks.' + 'slack.com/services/' + 'T00000000/' + 'B00000000/' + 'X'.repeat(24)],
];
for (const [label, secret] of R1) {
  const text = `agent note: ${secret} :done`;
  const red = redactSecrets(text);
  check(`§1 ${label}.noValueSurvives`, !red.includes(secret), '密钥值原样存活于脱敏结果');
  check(`§1 ${label}.containsSecret=true`, containsSecret(text) === true, 'containsSecret 未识别（fail-closed 拒收也失效）');
}

// ── §2 对照族：R3 已覆盖，不得回归 ───────────────────────────────────────
const CONTROLS = [
  ['github-ghp', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
  ['openai-sk', 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8t9U0'],
  ['openrouter', 'sk-or-v1-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'],
  ['anthropic', 'sk-ant-' + 'a1B2c3D4e5F6g7H8'],
  ['aws-akia', 'AKIA' + 'A1B2C3D4E5F6G7H8'],
  ['slack-xoxb', 'xoxb-' + 'd'.repeat(20)],
  ['notion', 'ntn_' + 'a1B2c3D4e5F6g7H8i9J0'],
  ['telegram', '123456789:' + 'A'.repeat(35)],
  // jwt：按实现正则要求（eyJ 之后 ≥20 字符）取**合法样本**，避免用错形状冒充缺陷；
  // 三段同样分字面量拼（防本文件被 secret-scan 判泄漏）。
  ['jwt', ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'S'.repeat(30)].join('.')],
];
for (const [label, secret] of CONTROLS) {
  const text = `value: ${secret}`;
  check(`§2 ${label}.noValueSurvives`, !redactSecrets(text).includes(secret), '对照族被破坏（回归）');
}

// ── §3 通用形态 ─────────────────────────────────────────────────────────
check('§3 generic-assignment', !redactSecrets('password = "hunter2-xyz"').includes('hunter2-xyz'), 'KEY=值 形态未脱敏');
check('§3 generic-bearer', !redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').includes('abcdefghijklmnopqrstuvwxyz012345'), 'Bearer 形态未脱敏');
check('§3 uri-credential', !redactSecrets('postgres://user:s3cr3tP@ss@db:5432/x').includes('s3cr3tP@ss'), 'URI 凭据未脱敏');

// ── §4 不得过度脱敏（经验正文必须仍可读）────────────────────────────────
const BENIGN = [
  'the password field is required for login',
  'token count = 5 items processed',
  'AIza-like prefix discussion in documentation',
  'npm install completes in 12s',
];
for (const t of BENIGN) {
  const red = redactSecrets(t);
  check(`§4 benign.unchanged`, red === t, `普通文本被改写: "${t}" -> "${red}"`);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (failures.length) {
  console.log('--- 失败明细 ---');
  for (const f of failures) console.log('  ' + f);
}
console.log(`AC1_SECRET_FAMILIES_VERDICT=${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
