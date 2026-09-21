// test-learn-r3-secrets.mjs —— P4 LEARN PRE-MERGE R-3：通用密钥脱敏加固回归锁
//
// 背景（独立 Release Gate 评审发现，PR #90）：
//   规范家族（notion/openai/openrouter/slack/github/jwt/anthropic/telegram/aws）覆盖良好，
//   但 generic-assignment 的值字符集为 [A-Za-z0-9_\-./+]{12,}（纯字母数字），
//   遇到 ! @ # $ % ^ & 等常见口令符号即断，且完全缺少
//   URI credential（postgres://user:pass@host）与 connection-string（Server=x;Password=y）模式。
//
// 本文件是**先于实现**写下的失败测试（先证旧实现失败，再改实现），
// 每个类别都配**负向孪生**：只把正向或只把反向改坏，测试就会失败。
// 目的：既防"漏脱敏导致密钥落盘"，也防"看到 password/token 就吞掉普通文档内容"。
//
// 全部用例只使用**假密钥**（P@ssw0rd!xyz / Hunter2!Long 等虚构值），不含任何真实凭据。
//
// 运行：node tests/learn/test-learn-r3-secrets.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets, containsSecret, secretFamiliesIn, SECRET_PATTERNS } from '../../plugins/learn-core.mjs';

// 仓库根（本文件位于 <root>/tests/learn/）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 通用形态族：不属于「与仓库规范扫描器平价」的范围（learn-core 自有的加固规则）
const GENERIC_FAMILIES = new Set(['uri-credential', 'generic-assignment', 'generic-bearer']);

let pass = 0; let fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

/**
 * 正向断言：文本中的 secretValue 必须**不再完整出现**，且文本确实被改写。
 * 只断言"有 token"是不够的 —— 必须断言原始值消失（这才是真正的安全属性）。
 */
function assertRedacted(text, secretValue, label) {
  const out = redactSecrets(text);
  assert.ok(!out.includes(secretValue), `${label}: 原始密钥值仍完整出现在输出中 -> ${out}`);
  assert.notEqual(out, text, `${label}: 文本未被任何规则改写`);
  assert.ok(out.includes('[REDACTED:'), `${label}: 输出中没有脱敏占位符 -> ${out}`);
  return out;
}

/** 负向断言：普通解释性文本必须**逐字节不变**（不得被过度脱敏）。 */
function assertUntouched(text, label) {
  const out = redactSecrets(text);
  assert.equal(out, text, `${label}: 普通文本被过度脱敏 -> ${out}`);
  return out;
}

console.log('=== A. Generic password assignment（口令含特殊符号）===');
check('A1 password: "P@ssw0rd!xyz"（引号 + @ !）', () => {
  assertRedacted('config dump: password: "P@ssw0rd!xyz" end', 'P@ssw0rd!xyz', 'A1');
});
check('A2 password=P@ssw0rd!xyz（无引号）', () => {
  assertRedacted('DB password=P@ssw0rd!xyz', 'P@ssw0rd!xyz', 'A2');
});
check("A3 password = 'P@ssw0rd!xyz'（单引号 + 空格）", () => {
  assertRedacted("env: password = 'P@ssw0rd!xyz'", 'P@ssw0rd!xyz', 'A3');
});
check('A4 PASSWORD=P@ssw0rd!xyz（大写键名）', () => {
  assertRedacted('PASSWORD=P@ssw0rd!xyz', 'P@ssw0rd!xyz', 'A4');
});
check('A5 passwd: p@ss#w0rd$2026（# $ 符号）', () => {
  assertRedacted('passwd: p@ss#w0rd$2026', 'p@ss#w0rd$2026', 'A5');
});
check('A6 pwd = "a%b^c&d*e(f)"（% ^ & * ( ) 符号）', () => {
  assertRedacted('pwd = "a%b^c&d*e(f)"', 'a%b^c&d*e(f)', 'A6');
});

console.log('=== B. Generic token assignment（含特殊符号）===');
check('B1 token = "a!b@c#d$e%f^g&h"', () => {
  assertRedacted('header: token = "a!b@c#d$e%f^g&h"', 'a!b@c#d$e%f^g&h', 'B1');
});
check('B2 api_token=a!b@c#d$e%f^g&h（无引号）', () => {
  assertRedacted('api_token=a!b@c#d$e%f^g&h', 'a!b@c#d$e%f^g&h', 'B2');
});
check('B3 access_token = "x!y@z#1$2%3^4&5"', () => {
  assertRedacted('access_token = "x!y@z#1$2%3^4&5"', 'x!y@z#1$2%3^4&5', 'B3');
});
check('B4 client_secret="s!e@c#r$e%t^&*"', () => {
  assertRedacted('client_secret="s!e@c#r$e%t^&*"', 's!e@c#r$e%t^&*', 'B4');
});

console.log('=== C. URI credentials（含 @ 既在口令内又是分隔符）===');
check('C1 postgres://user:s3cr3tP@ss@host/db（口令内含 @ —— 关键用例）', () => {
  const out = assertRedacted('DSN is postgres://user:s3cr3tP@ss@host/db here', 's3cr3tP@ss', 'C1');
  // 不得只截到第一个 @ 而把 "ss@host" 泄漏出去
  assert.ok(!out.includes('ss@host'), `C1: 口令尾部泄漏（只截到第一个 @）-> ${out}`);
});
check('C2 mysql://root:P@ss!123@db.internal:3306/app', () => {
  const out = assertRedacted('mysql://root:P@ss!123@db.internal:3306/app', 'P@ss!123', 'C2');
  assert.ok(!out.includes('P@ss'), `C2: 口令泄漏 -> ${out}`);
});
check('C3 mongodb://admin:s3cr3t@mongo.local:27017', () => {
  assertRedacted('mongodb://admin:s3cr3t@mongo.local:27017', 's3cr3t', 'C3');
});
check('C4 redis://default:hunter2@cache.local:6379', () => {
  assertRedacted('redis://default:hunter2@cache.local:6379', 'hunter2', 'C4');
});
check('C5 postgresql://token_only@host/db（无冒号，整段 userinfo 即凭据）', () => {
  const out = assertRedacted('postgresql://s3cr3tTokenValue@host/db', 's3cr3tTokenValue', 'C5');
  assert.ok(out.includes('host'), `C5: 过度脱敏，连 host 都丢了 -> ${out}`);
});
check('C6 保留诊断上下文：scheme 与 host 仍可读', () => {
  const out = redactSecrets('postgres://user:s3cr3tP@ss@host/db');
  assert.ok(out.includes('postgres://'), `C6: scheme 被吞 -> ${out}`);
  assert.ok(out.includes('host'), `C6: host 被吞 -> ${out}`);
});
check('C7 保留 "@" 分隔符（输出可自证 userinfo 位置）', () => {
  const out = redactSecrets('postgres://user:s3cr3tP@ss@host/db');
  assert.ok(out.includes(']@host'), `C7: "@" 分隔符被吞 -> ${out}`);
  assert.equal(out, 'postgres://[REDACTED:uri-credential]@host/db', `C7: 输出形状不符 -> ${out}`);
});
check('C8 无口令的 user@host（如 ssh）也被处理且 host 保留', () => {
  const out = redactSecrets('clone via ssh://git@github.com/org/repo.git');
  assert.ok(!out.includes('git@github.com'), `C8: userinfo 泄漏 -> ${out}`);
  assert.ok(out.includes('github.com'), `C8: host 被吞 -> ${out}`);
});
check('C9 URI 脱敏幂等（二次脱敏不产生双重 token）', () => {
  const once = redactSecrets('postgres://user:s3cr3tP@ss@host/db');
  assert.equal(redactSecrets(once), once, `C9: 不幂等 -> ${redactSecrets(once)}`);
});

console.log('=== D. Connection strings（; 为字段分隔符）===');
check('D1 Server=x;Password=Hunter2!Long', () => {
  assertRedacted('Server=x;Password=Hunter2!Long', 'Hunter2!Long', 'D1');
});
check('D2 User Id=test;Password=P@ss!123;', () => {
  assertRedacted('User Id=test;Password=P@ss!123;', 'P@ss!123', 'D2');
});
check('D3 Data Source=db;Uid=sa;Pwd=H@rd!Pass;', () => {
  assertRedacted('Data Source=db;Uid=sa;Pwd=H@rd!Pass;', 'H@rd!Pass', 'D3');
});
check('D4 不吞掉非敏感字段（Server=/Uid= 保持可读）', () => {
  const out = redactSecrets('Server=sql01;Uid=sa;Password=Hunter2!Long;');
  assert.ok(out.includes('Server=sql01'), `D4: 非敏感字段 Server 被吞 -> ${out}`);
  assert.ok(out.includes('Uid=sa'), `D4: 非敏感字段 Uid 被吞 -> ${out}`);
});

console.log('=== E. 负向孪生：普通解释性文本必须逐字节不变 ===');
check('E1 "the password field is required"', () => assertUntouched('the password field is required', 'E1'));
check('E2 search for "password"', () => assertUntouched('search for "password"', 'E2'));
check('E3 token count = 5', () => assertUntouched('token count = 5', 'E3'));
check('E4 password policy requires 12 characters', () => assertUntouched('password policy requires 12 characters', 'E4'));
check('E5 中文解释：密码字段是必填项', () => assertUntouched('密码字段是必填项，长度至少 12 位', 'E5'));
check('E6 文档标题：Secret Management Overview', () => assertUntouched('Secret Management Overview', 'E6'));
check('E7 普通 URL 无 userinfo 不得被改写', () => assertUntouched('see https://example.com/docs/password-policy', 'E7'));
check('E8 普通 URL 带路径 @（非 userinfo）不得被改写', () => assertUntouched('see https://example.com/@username/profile', 'E8'));
check('E9 空值/短值不得触发', () => assertUntouched('password = ""', 'E9'));
check('E10 纯说明句：token 由服务端签发', () => assertUntouched('token 由服务端签发，客户端只保存引用', 'E10'));
check('E11 "the token was rejected by the server"', () => assertUntouched('the token was rejected by the server', 'E11'));
check('E12 代码引用：password 变量名讨论', () => assertUntouched('the password variable is read from the env', 'E12'));

console.log('=== F. 既有规范家族零回归（9/9）===');
// 假密钥一律**拼接组装**（仓库既有约定，见 tests/reliability/secret-scan-check.mjs 的
// CI_MOCK_LITERALS 注释）：源码里不得出现密钥形态的字面量，否则仓库级扫描闸
// （CI "Static + secret + syntax gate" 的第二层 node secret-scan-check）会把本测试文件
// 自身判成泄漏 → 整条 CI 红。**不加路径豁免**：豁免会削弱这道真实安全闸。
// （R-10：G4 曾把该值写成字面量，导致 PR #90 CI 红，此处为根因修复。）
const FAKE_NOTION = 'ntn_' + 'A1b2C3d4E5f6G7h8I9j0';

const CANON = [
  ['notion', FAKE_NOTION],
  ['openai', 'sk-' + 'B'.repeat(24)],
  ['openrouter', 'sk-or-v1-' + 'a'.repeat(24)],
  ['anthropic', 'sk-ant-' + 'C'.repeat(20)],
  ['slack', 'xoxb-' + 'd'.repeat(20)],
  ['github', 'ghp_' + 'E'.repeat(24)],
  ['jwt', 'eyJ' + 'f'.repeat(22) + '.' + 'g'.repeat(12) + '.' + 'h'.repeat(12)],
  ['telegram', '123456789:' + 'i'.repeat(35)],
  ['aws', 'AKIA' + 'J'.repeat(16)],
];
for (const [fam, val] of CANON) {
  check(`F ${fam}: 规范家族仍被脱敏且 token 正确`, () => {
    const out = redactSecrets(`prefix ${val} suffix`);
    assert.ok(!out.includes(val), `F ${fam}: 值泄漏 -> ${out}`);
    assert.ok(out.includes(`[REDACTED:${fam}]`), `F ${fam}: token 不正确 -> ${out}`);
    assert.ok(containsSecret(`prefix ${val} suffix`), `F ${fam}: containsSecret 漏检`);
    assert.ok(secretFamiliesIn(`prefix ${val} suffix`).includes(fam), `F ${fam}: secretFamiliesIn 漏检`);
  });
}
check('F10 纯字母数字口令（原有能力）仍被脱敏', () => {
  assertRedacted('password=abcdefghijklmnop', 'abcdefghijklmnop', 'F10');
});
check('F11 Bearer token 仍被脱敏', () => {
  assertRedacted('Authorization: Bearer abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx', 'F11');
});
check('F12 旧 token 名（[REDACTED:xxx]）不得被二次脱敏', () => {
  const once = redactSecrets('password: "P@ssw0rd!xyz"');
  assert.equal(redactSecrets(once), once, `F12: 脱敏不幂等 -> ${redactSecrets(once)}`);
});

console.log('=== G. 确定性与非字符串安全 ===');
check('G1 确定性：同一输入 5 次结果完全一致', () => {
  const t = 'postgres://user:s3cr3tP@ss@host/db; password: "P@ssw0rd!xyz"; token = "a!b@c#d$e%f^g&h"';
  const first = redactSecrets(t);
  for (let i = 0; i < 5; i++) assert.equal(redactSecrets(t), first, 'G1: 结果不确定');
});
check('G2 连续调用不因 /g lastIndex 污染（交替调用 3 轮）', () => {
  const t = 'password: "P@ssw0rd!xyz"';
  const a = redactSecrets(t);
  for (let i = 0; i < 3; i++) { redactSecrets('sk-' + 'Z'.repeat(24)); assert.equal(redactSecrets(t), a, 'G2: 跨调用状态污染'); }
});
check('G3 非字符串输入不抛异常', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '');
  assert.equal(containsSecret(null), false);
  assert.equal(containsSecret(123), false);
});
check('G4 混合文本：所有类别同时出现且全部脱敏', () => {
  const t = 'dsn postgres://user:s3cr3tP@ss@host/db\npassword: "P@ssw0rd!xyz"\ntoken = "a!b@c#d$e%f^g&h"\nServer=x;Password=Hunter2!Long\nkey ' + FAKE_NOTION;
  const out = redactSecrets(t);
  for (const v of ['s3cr3tP@ss', 'P@ssw0rd!xyz', 'a!b@c#d$e%f^g&h', 'Hunter2!Long', FAKE_NOTION]) {
    assert.ok(!out.includes(v), `G4: 混合文本中 ${v} 泄漏 -> ${out}`);
  }
});

console.log('=== H. 真实 learning pipeline 持久化：假密钥不得落盘（AC3）===');
// 只测 sanitizer 函数是不够的：必须走**真实插件壳**（plugins/learn.mjs 的 apply()），
// 让假密钥经过 digest → signal → candidate → title/body/evidence → 落盘 JSON 全链路，
// 断言最终**持久化文件字节**中不含完整原始密钥。
// 注意：H2/H5 是 fail-closed 的 —— 若前置（真产出候选且已落盘）不成立，它们**必须失败**，
// 否则"产物里没有密钥"会变成空洞通过（产物为空时当然不含密钥），那是比没有测试更糟的假绿。
const FAKE_PW = 'P@ssw0rd!xyz';
const FAKE_TOK = 'a!b@c#d$e%f^g&h';
const FAKE_DSN = 's3cr3tP@ss';

const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-r3-secrets-'));
{
  const learn = await import('../../plugins/learn.mjs');
  const hooks = new Map();
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
    tools: { register: () => { throw new Error('ctx.tools.register must not be used in repo tests'); } },
  };
  const SID = 'r3-secrets-' + Date.now();
  const api = learn.apply(ctx, { stateDir: tmpState, minNewNodes: 2, minTurnsForLearning: 2, maxDigestTurns: 40 });

  // 官方会话事件形状**按角色不同**（本机 harness 实测，非猜测）：
  //   user/message      → data 本身就是 message 对象：{content:[...], source:{kind:'user'}}
  //   assistant/message → message 嵌在 data.message 下：{turn,step,message:{role,content}}
  // P2.5 官方提取器 messageOfEvent 对 assistant 只读 data.message，
  // 用扁平形状造 assistant 事件会返回 null → 该轮被静默丢弃（digest.turnCount 偏小）。
  const mk = (seq, role, text) => {
    const content = [{ type: 'text', text }];
    return role === 'user'
      ? { type: 'user/message', seq, time: 1700000000000 + seq, data: { content, source: { kind: 'user' } } }
      : { type: 'assistant/message', seq, time: 1700000000000 + seq, data: { turn: 1, step: seq, message: { role: 'assistant', content } } };
  };
  const events = [];
  const nodes = [];
  const add = (role, text) => { const seq = nodes.length + 1; events[seq] = mk(seq, role, text); nodes.push(seq); };
  // seq 1-2 只用于建立水位（不含密钥）；真正触发学习的窗口是 seq 3-4
  add('user', 'let us look at the deploy pipeline for the app service');
  add('assistant', 'Sure — which stage is giving trouble?');
  add('user', 'the deploy failed again, I had to paste the dsn postgres://user:' + FAKE_DSN
    + '@db.internal:5432/app by hand, and it also printed password: "' + FAKE_PW
    + '" and token = "' + FAKE_TOK + '" in the same trace');
  add('assistant', 'Both values should be rotated; I will redact them from now on.');

  const drive = async (n) => {
    const fns = hooks.get('agent/pre-step') ?? [];
    for (const fn of fns) {
      if (typeof fn !== 'function') continue;
      await fn({ agent: { session: { id: SID, events, surface: { nodes: nodes.slice(0, n) } } } }, () => {});
    }
  };
  await drive(2);        // 阶段 1：只建立水位（首次进入不回填历史）
  await drive(4);        // 阶段 2：一次性带来 2 个新节点（满足 minNewNodes=2）→ 触发自动候选

  const store = api.getStore(SID);
  const storePath = api.storePath(SID);
  const onDisk = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : '';
  const preOk = store.experiences.length >= 1 && onDisk.length > 0;
  const blob = JSON.stringify(store) + '\n' + onDisk;

  check('H0 真实插件壳产出候选且已落盘（后续断言的前提）', () => {
    assert.ok(store.experiences.length >= 1,
      `experiences=${store.experiences.length}; logs=${logs.slice(-3).join(' | ')}`);
    assert.ok(onDisk.length > 0, `持久化文件为空或不存在: ${storePath}`);
  });

  for (const [label, secret] of [['password', FAKE_PW], ['token', FAKE_TOK], ['URI 口令', FAKE_DSN]]) {
    check(`H2 假密钥不得出现在 signal/candidate/title/evidence/落盘 JSON 中：${label}`, () => {
      assert.ok(preOk, 'H0 前置未成立 → 本断言无意义，按 fail-closed 判失败（不虚过）');
      assert.ok(!blob.includes(secret), `${label}: 原始密钥出现在持久化产物中`);
    });
  }
  check('H3 持久化产物中确实出现了脱敏占位符（证明是脱敏而非整段丢弃）', () => {
    assert.ok(preOk, 'H0 前置未成立 → 本断言无意义，按 fail-closed 判失败（不虚过）');
    assert.ok(/\[REDACTED:/.test(blob), '落盘产物中没有任何脱敏标记');
  });
  check('H4 非敏感上下文仍保留（未整段删掉用户发言）', () => {
    assert.ok(preOk, 'H0 前置未成立 → 本断言无意义，按 fail-closed 判失败（不虚过）');
    assert.ok(blob.includes('deploy failed again'), 'H4: 正常发言被整段删除');
    assert.ok(blob.includes('db.internal'), 'H4: 诊断上下文（host）被删除');
  });
  check('H5 candidate 的 title/body/evidence 中同样不含原始密钥', () => {
    assert.ok(preOk, 'H0 前置未成立 → 本断言无意义，按 fail-closed 判失败（不虚过）');
    for (const e of store.experiences) {
      const s = JSON.stringify({ t: e.title, b: e.body, ev: e.approvalEvidence });
      assert.ok(!s.includes(FAKE_PW) && !s.includes(FAKE_TOK) && !s.includes(FAKE_DSN),
        `candidate 泄漏: ${s.slice(0, 200)}`);
    }
  });
}
fs.rmSync(tmpState, { recursive: true, force: true });

// ─────────────────────────────────────────────────────────────────────────────
// I. 家族名平价（与仓库规范扫描器 tests/reliability/secret-scan-check.mjs 对齐）
//    learn-core.mjs 第 85-88 行的注释声明「families 名称与 secret-scan-check.mjs 保持一致」。
//    该声明原先**没有任何测试守住**（独立 Release Gate 评审记录项 R-4：注释引用了仓库中
//    不存在的 test-learn-no-secrets.mjs）。本节把该声明变成可执行断言：两边的规范家族名
//    集合必须完全相等（双向包含、顺序无关），扫描器新增家族而 learn-core 未跟随时即失败。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== I. 家族名平价（secret-scan-check.mjs）===');

const SCANNER = path.join(ROOT, 'tests', 'reliability', 'secret-scan-check.mjs');

check('I1 仓库规范扫描器存在且可读', () => {
  assert.ok(fs.existsSync(SCANNER), `未找到规范扫描器: ${SCANNER}`);
});

const scannerSrc = fs.existsSync(SCANNER) ? fs.readFileSync(SCANNER, 'utf8') : '';
const patStart = scannerSrc.indexOf('const PATTERNS = [');
const patEnd = patStart >= 0 ? scannerSrc.indexOf('];', patStart) : -1;
const patBlock = patStart >= 0 && patEnd > patStart ? scannerSrc.slice(patStart, patEnd) : '';
const scannerNames = [...patBlock.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]).sort();
const oursNames = SECRET_PATTERNS.map((p) => p.name);
const canonicalOurs = oursNames.filter((n) => !GENERIC_FAMILIES.has(n)).sort();

check(`I2 扫描器家族名解析成功（解析出 ${scannerNames.length} 个）`, () => {
  assert.ok(scannerNames.length >= 9, `只解析出 ${scannerNames.length} 个家族名 —— 解析逻辑可能已失效`);
});

check('I3 规范家族名集合与扫描器完全平价（双向包含，顺序无关）', () => {
  const missing = scannerNames.filter((n) => !canonicalOurs.includes(n));
  const extra = canonicalOurs.filter((n) => !scannerNames.includes(n));
  assert.deepEqual(missing, [], `learn-core 缺少扫描器已覆盖的家族: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `learn-core 多出未与扫描器对齐的家族: ${extra.join(', ')}`);
});

check('I4 三个通用形态族仍在（脱敏加固不被本次平价重构误删）', () => {
  for (const g of GENERIC_FAMILIES) assert.ok(oursNames.includes(g), `通用族缺失: ${g}`);
});

console.log(`\n=== R-3 通用密钥脱敏加固回归: ${pass} PASS / ${fail} FAIL ===`);
if (failures.length) { console.log('\n失败明细:'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
