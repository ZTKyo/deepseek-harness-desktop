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

// ── §5 载入边界自愈（历史明文清除；补齐家族所不能覆盖的"存量"部分）──────────
// 背景实证：家族表补齐后，生产库 session-76de1ca9 的 experiences[78].body 仍带明文，
// 且运行中进程持续把内存副本回写 → 只改 makeExperience 无法让存量变干净。
const redactStore = mod.redactStore;
const sanitizeExperience = mod.sanitizeExperience;
check('§5.0 redactStore 已导出', typeof redactStore === 'function', '载入边界自愈入口缺失（存量明文无法清除）');

const STRIPE = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const GOOGLE = 'AIza' + 'A'.repeat(35);
const mkExp = (over = {}) => ({
  id: 'exp-test', state: 'PROPOSED', title: 'title', body: 'body', tags: [], sourceEventSeqs: [1],
  originSessionId: 'sess', createdAt: 1, approvedAt: null, approvedBy: null, approvalEvidence: null,
  rejectedAt: null, rejectedBy: null, rejectionReason: null, retiredAt: null,
  promotion: 'NONE', promotionEvidence: null, recallCount: 0, lastRecalledAt: null, ...over,
});
const leaked = mkExp({ title: `leak ${STRIPE}`, body: `note ${GOOGLE} tail`, tags: [`tag-${STRIPE}`] });
const clean = mkExp({ id: 'exp-clean', title: 'clean title', body: 'benign body text' });
const store = {
  schemaVersion: 2, sessionId: 'sess', version: 3,
  experiences: [leaked, clean],
  telemetry: [{ kind: 'PROPOSED', payload: { note: `leaked ${GOOGLE}` }, at: 1 }],
  updatedAt: 0,
};

const healed = redactStore(store);
check('§5.1 命中被清除', !JSON.stringify(healed.store.experiences[0]).includes(STRIPE)
  && !JSON.stringify(healed.store.experiences[0]).includes(GOOGLE), '脱敏后仍有家族值存活');
check('§5.1 占位符保留家族名', JSON.stringify(healed.store.experiences[0]).includes('[REDACTED:stripe]')
  && JSON.stringify(healed.store.experiences[0]).includes('[REDACTED:google]'), '未写入 [REDACTED:<family>] 占位符');
check('§5.1 计数覆盖条目+遥测', healed.count >= 3 && healed.entries === 1, `count=${healed.count} entries=${healed.entries}`);
check('§5.1 无命中条目零漂移（引用相同）', healed.store.experiences[1] === clean,
  '未命中条目被改写（过度改写）');
check('§5.1 结构键不变', healed.store.experiences[0].id === 'exp-test'
  && healed.store.experiences[0].state === 'PROPOSED'
  && healed.store.experiences[0].createdAt === 1
  && JSON.stringify(healed.store.experiences[0].sourceEventSeqs) === '[1]', '结构键被改写（引用/状态机被破坏）');
check('§5.1 遥测命中被清除', !JSON.stringify(healed.store.telemetry).includes(GOOGLE)
  && healed.store.telemetry[0].kind === 'PROPOSED', '遥测 payload 未脱敏或 kind 被破坏');

const healed2 = redactStore(healed.store);
check('§5.2 幂等（二次零命中且库不变）', healed2.count === 0
  && JSON.stringify(healed2.store) === JSON.stringify(healed.store),
  `二次调用 count=${healed2.count}（幂等被破坏）`);

check('§5.3 改写后仍通过 sanitizeExperience', healed.store.experiences.every((e) => !sanitizeExperience(e).error),
  '自愈产出了校验不过的记录（会让整库在下次载入被判废）');
check('§5.4 缺字段入参不抛错', redactStore({ experiences: [], telemetry: [] }).count === 0
  && redactStore(null).count === 0, '边界入参抛错');

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (failures.length) {
  console.log('--- 失败明细 ---');
  for (const f of failures) console.log('  ' + f);
}
console.log(`AC1_SECRET_FAMILIES_VERDICT=${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
