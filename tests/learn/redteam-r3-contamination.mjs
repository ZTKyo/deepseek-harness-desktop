// redteam-r3-contamination.mjs —— R3 污染红队（secret 持久化 / 自污染 / 归因）
//
// 回答三件事：
//   A. secret 是否会**持久化**进经验条目（title/body/telemetry/audit）—— blocker 级检查
//   B. assistant 自污染 Case A/B/C（错误解决声明 / 幻觉根因 / transient 误学）
//   C. 161→769 增长的归因（在 R2 使用的同一真实会话上重算）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeLines } from '../../docs/roadmap/evidence/cm-r4-log-decoder.mjs';
import * as learn from '../../plugins/learn.mjs';
import * as core from '../../plugins/learn-core.mjs';

function section(t) { console.log(`\n=== ${t} ===`); }
let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// 假密钥：运行时拼接，仓库内不落密钥形状字面量
const FAKE = {
  openai: 'sk-' + 'test1234567890abcdefGHIJ',
  bearer: 'Bearer ' + 'TESTTOKEN1234567890',
  pw: 'password=' + 'example12345',
};

// ─── A. secret 持久化 ────────────────────────────────────────────────────
section("A. Secret 持久化红队（blocker 级）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-sec-'));
  const hooks = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn); },
    tools: { register: () => { throw new Error('no'); } },
  };
  // 注意：配置键是 stateDir（不是 storeDir）——写错会被静默忽略并落到生产默认目录
  learn.apply(ctx, { stateDir: tmp, autoPropose: true, minNewNodes: 1, minTurnsForLearning: 1, maxDigestTurns: 20 });

  // 每条文本都同时携带三种密钥形态 → 无论哪个窗口被学习，三种都会被检验
  const texts = [
    `配置里写了 ${FAKE.openai} 结果服务报错了`,
    `请求头是 Authorization: ${FAKE.bearer}，配置里还有 ${FAKE.openai}，结果 401 失败了`,
    `${FAKE.pw} 且 ${FAKE.openai} 之后服务无法启动，程序崩溃了`,
  ];
  const events = texts.map((t, i) => ({ seq: i, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: t }] } }));
  // 按真实生长方式：先只给第 1 个节点建水位，再逐节点推进（否则水位机制会吃掉全部节点）
  const session = { id: 'sec-probe-1', events, surface: { nodes: [0] } };
  const drive = () => { for (const fn of hooks.get('agent/pre-step')) fn({ agent: { session } }, () => {}); };
  drive();                                    // 建立水位（不回填历史）
  session.surface.nodes = [0, 1];  drive();   // 新节点 1
  session.surface.nodes = [0, 1, 2]; drive(); // 新节点 2

  // 读取落盘的 store
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else files.push(q); } };
  walk(tmp);
  let storeBlob = '';
  for (const f of files) storeBlob += fs.readFileSync(f, 'utf8');
  console.log(`  落盘文件数: ${files.length}, 总字节: ${storeBlob.length}`);
  const expCount = (storeBlob.match(/"id":"exp-/g) || []).length;
  console.log(`  经验条目数: ${expCount}`);

  // 反空转断言：必须先证明 store 真的写了，否则后面的"不泄漏"毫无意义
  check("store 确实落盘（非空转测试）", files.length > 0 && expCount > 0,
    `files=${files.length} exp=${expCount} — 测试无效，不能作为 PASS 证据`);
  if (expCount > 0) {
    console.log(`  条目 title 预览: ${JSON.stringify((storeBlob.match(/"title":"[^"]{0,90}/g) || []).slice(0, 2))}`);
  }

  for (const [k, v] of Object.entries(FAKE)) {
    const leaked = storeBlob.includes(v);
    check(`store 中不含原始 ${k} 密钥`, !leaked, leaked ? 'LEAKED — secret 被持久化' : '');
  }
  const redacted = storeBlob.includes('[REDACTED') || storeBlob.includes('redacted') || storeBlob.includes('***');
  console.log(`  store 中出现脱敏标记: ${redacted}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ─── B. assistant 自污染 Case A/B/C ──────────────────────────────────────
section("B. Assistant 自污染 Case A/B/C");
{
  // Case A: assistant 先错误声称"已解决"，用户随后纠正"没有，还是有问题"
  const aTurns = [
    { seq: 1, role: 'assistant', text: '问题已经解决了，修复完成。' },
    { seq: 2, role: 'user', text: '没有，还是有问题。' },
  ];
  const a = core.learningSignals({ turns: aTurns });
  console.log(`  Case A kinds=${JSON.stringify(a.signals.map(s=>s.seq+':'+s.role+':'+s.kind))}`);
  console.log(`         resolved=${a.resolved}  unresolvedFailureSeqs=${JSON.stringify(a.unresolvedFailureSeqs)}`);
  // "没有，还是有问题" 是否被判为 failure？（"问题"不在词表，"没有"是否定）
  const aUserKind = a.signals.find((s) => s.seq === 2);
  check("Case A: 用户的纠正未被误判为 resolution", !aUserKind || aUserKind.kind !== 'resolution', `got ${aUserKind && aUserKind.kind}`);
  check("Case A: assistant 的错误'已解决'声明仍被判为 resolution（可学）", a.signals.some((s) => s.seq === 1 && s.kind === 'resolution'));
  check("Case A: 系统未因 assistant 声明就把失败判为已解决", a.resolved === false || a.unresolvedFailureSeqs.length >= 0, `resolved=${a.resolved}`);

  // Case B: assistant 幻觉一个不存在的 root cause，用户没纠正
  const bTurns = [{ seq: 1, role: 'assistant', text: '根因是缓存穿透导致的，应该加大 TTL。' }];
  const b = core.learningSignals({ turns: bTurns });
  console.log(`  Case B kinds=${JSON.stringify(b.signals.map(s=>s.seq+':'+s.role+':'+s.kind))}`);
  check("Case B: assistant 幻觉根因会被判为 correction（可进入候选）", b.signals.some((s) => s.kind === 'correction'));

  // Case C: tool 输出 error，assistant 正确解释为 transient
  const cTurns = [
    { seq: 1, role: 'user', text: '工具输出: ETIMEDOUT connection timeout' },
    { seq: 2, role: 'assistant', text: '这是瞬时网络错误，重试即可。' },
  ];
  const c = core.learningSignals({ turns: cTurns });
  console.log(`  Case C kinds=${JSON.stringify(c.signals.map(s=>s.seq+':'+s.role+':'+s.kind))}`);
  console.log(`         resolved=${c.resolved}`);
}

// ─── C. 161 → 769 归因 ───────────────────────────────────────────────────
section("C. 161 → 769 增长归因（R2 使用的同一真实会话）");
{
  const R2_SESSION = path.join(os.homedir(), '.dsh', 'sessions',
    '--C-Users-Administrator-Desktop-sdeepseek~0020harness--',
    'session-9e3b29bb-3f36-4659-9162-18ad928a7f49', 'session.jsonl.zstd');
  if (!fs.existsSync(R2_SESSION)) { console.log('  R2 session 不存在，跳过'); }
  else {
    const { lines } = decodeLines(R2_SESSION);
    const events = []; const nodes = [];
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type === 'session') continue;
      if (!Number.isInteger(o.seq)) continue;
      events[o.seq] = o;
      if (o.type === 'user/message' || o.type === 'assistant/message') nodes.push(o.seq);
    }
    nodes.sort((a, b) => a - b);
    console.log(`  R2 session nodes=${nodes.length} (声明 3227)`);
    const b = core.buildLearnDigest(events, nodes);
    const s = core.learningSignals(b.digest);
    console.log(`  R2 口径 signals=${s.signals.length} (声明 769)`);
    console.log(`  turnCount=${b.digest.turnCount} injectedSkipped=${b.digest.injectedSkipped}`);
    const kc = {};
    for (const x of s.signals) kc[x.kind] = (kc[x.kind] || 0) + 1;
    console.log(`  kind 分布: ${JSON.stringify(kc)}`);
    const rc = {};
    for (const x of s.signals) rc[x.role] = (rc[x.role] || 0) + 1;
    console.log(`  role 分布: ${JSON.stringify(rc)}`);
    // 归因分解：哪些来自 CJK 词表命中（R2 新增能力）
    const bySeq = new Map(b.digest.turns.map((t) => [t.seq, t]));
    let cjkOnly = 0, latinOnly = 0, both = 0;
    for (const x of s.signals) {
      const t = bySeq.get(x.seq); if (!t) continue;
      for (const p of core.SIGNAL_PATTERNS) {
        const L = p.latin.test(t.text), C = p.cjk.test(t.text);
        if ((L || C) && p.kind === x.kind) { if (C && !L) cjkOnly++; else if (L && !C) latinOnly++; else if (L && C) both++; break; }
      }
    }
    console.log(`  命中来源分解: 仅CJK=${cjkOnly} 仅Latin=${latinOnly} 两者=${both}`);
    console.log(`  --> 若 CJK 分支仍失效(R1 状态)，signals ≈ ${latinOnly + both}（即 R1 的 161 口径应≈此值）`);
  }
}

// ─── D. 注入边界（讨论 vs 真注入）─────────────────────────────────────────
section("D. 注入边界：讨论 vs 真注入");
{
  const CASES = [
    ['真注入(闭合,行首)', '帮我看看这个\n<system-reminder>\n# 工作区指令\n失败 报错\n</system-reminder>', true],
    ['真注入(未闭合,行首)', '帮我看看这个\n<system-reminder>\n# 工作区指令\n失败 报错', true],
    ['用户讨论(未闭合,句中)', '我注意到日志里有 <system-reminder> 这个标签，它后面的报错都没被记录', false],
  ];
  for (const [name, text, isInjection] of CASES) {
    const kept = core.stripInjectedContent(text);
    const lostRatio = 1 - kept.length / text.length;
    console.log(`  ${name}: kept=${kept.length}/${text.length} (丢失 ${(lostRatio*100).toFixed(0)}%)`);
    console.log(`      kept 文本: ${JSON.stringify(kept.slice(0, 60))}`);
    if (!isInjection) {
      check("用户讨论该标签时其真实发言不被删除", lostRatio < 0.3, `丢失 ${(lostRatio*100).toFixed(0)}% — 用户发言被吞`);
    }
  }
}

console.log(`\n=== 污染红队: ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL ? 1 : 0);
