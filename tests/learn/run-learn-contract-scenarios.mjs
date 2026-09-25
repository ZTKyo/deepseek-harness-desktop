// run-learn-contract-scenarios.mjs —— P4 R2 · 合同「4 次必须真实验证」符合性探针
//
// 存在理由：合同页明确记录，上一轮的病根是「口径断裂（根因）：P4 报告使用**自定 AC1–AC12**
// 编号，与合同 AC1–AC10 不对齐 ⇒『测试全绿』不能作为合同达成证据」。
// 因此本文件**不按 R2 自定 AC 编号组织断言**，而是逐条对着 **Notion PHASE 04 合同原文**的
// 硬性条款求证，并在真实原始会话上执行：
//   · 【实现原则 3】经验必须经**真实成功验证**后才能标记 VERIFIED_EXPERIENCE
//   · 【实现原则 5】复用历史经验前**必须重新检查当前版本/环境是否仍适用**
//   · 【复用规则】相似任务 → 检索 experience → **检查适用性** → 复用 → **重新验证**
//   · 【Experience Store】每条经验**只保留**（即必须包含）的字段清单
//   · 【Failure Class】至少 Environment/Provider/Network/User/Website/Tool/Skill/Model/Unknown
//   · 【禁止】不得保存 Secret；禁止保存整段聊天 / 全量日志 / 巨大 tool output
//
// 纪律（本文件最重要的性质）：它**不是**为了让合同看起来通过而写的。
// 合同要求而实现没有的，本文件就报 FAIL 并给出实测观测值；全绿才是异常。
//
// 用法：node tests/learn/run-learn-contract-scenarios.mjs
//   exit 0 = 合同条款在真实数据上全部成立；exit 1 = 存在未成立的合同条款（打印清单）
// 只读真实会话；只写 os.tmpdir()；不触碰生产状态/配置/会话数据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as learn from '../../plugins/learn.mjs';
import * as core from '../../plugins/learn-core.mjs';
import { FAILURE_CLASS } from '../../plugins/failure-classifier-core.mjs';
import { REPEAT_THRESHOLD, HARD_VETO_CLASSES, FAILURE_ORIGIN, KNOWN_ORIGINS } from '../../plugins/learn-gap-veto.mjs';
import { MAX_CANDIDATES } from '../../plugins/learn-candidate.mjs';
import {
  loadRealSession, listRealSessions, SESSIONS_DIR, mkCtx, mkExec, driveHook, growSession,
  mkHostApproval,
} from './_real-session-harness.mjs';

let pass = 0, fail = 0;
const failures = [];
const observations = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function obs(k, v) { observations.push(`${k} = ${v}`); console.log(`  OBS   ${k} = ${v}`); }
function section(t) { console.log(`\n=== ${t} ===`); }

// 合同【Experience Store】逐字字段清单 → 实现里的候选字段名
const CONTRACT_FIELDS = [
  ['id/title',              ['id', 'title']],
  ['taskType/trigger/symptoms', ['taskType', 'trigger', 'symptoms']],
  ['applicable versions/environment', ['applicableVersions', 'applicableEnvironment']],
  ['rootCause',             ['rootCause']],
  ['successfulMethod',      ['successfulMethod']],
  ['failedOrUnsafeMethods', ['failedOrUnsafeMethods']],
  ['verificationEvidence',  ['verificationEvidence']],
  ['rollback',              ['rollback']],
  ['source links/commit',   ['sourceLinks', 'sourceCommit']],
  ['stale/expiry conditions', ['staleConditions', 'expiresAt']],
  ['lastVerifiedAt',        ['lastVerifiedAt']],
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-contract-scen-'));
console.log(`temp stateDir: ${tmpDir}`);
console.log(`sessions dir : ${SESSIONS_DIR}`);

// ═══ C0 合同口径基线（静态：实现是否提供合同要求的字段/状态/分类）═══════════
section('C0 合同口径基线：schema / 状态机 / 失败分类');

const states = [...core.EXPERIENCE_STATES];
obs('EXPERIENCE_STATES', JSON.stringify(states));
check('合同【实现原则 3】要求存在 VERIFIED_EXPERIENCE 终态',
  states.some((s) => /VERIFIED/.test(s)), `实际=${JSON.stringify(states)}`);

const tr = core.ALLOWED_TRANSITIONS;
obs('ALLOWED_TRANSITIONS', JSON.stringify(tr));
check('合同要求"复用后重新验证"存在可表达的状态迁移',
  Object.values(tr).some((to) => to.some((t) => /VERIFIED|REVALIDAT/.test(t))),
  `实际=${JSON.stringify(tr)}`);

const cls = Object.values(FAILURE_CLASS ?? {});
obs('FAILURE_CLASS (provider 面)', JSON.stringify(cls));
// 合同点名的 9 类失败来源（Environment/Provider/Network/User/Website/Tool/Skill/Model/Unknown）
// 在实现里由 FAILURE_ORIGIN 表达；逐类求证，不靠"数量 ≥9"倒推。
const CONTRACT_ORIGINS = [
  'environment', 'provider', 'network', 'user', 'website', 'tool', 'skill', 'model', 'unknown',
];
const origins = [...(KNOWN_ORIGINS ?? Object.values(FAILURE_ORIGIN ?? {}))];
obs('FAILURE_ORIGIN (合同 Failure Class)', JSON.stringify(origins));
const missingOrigins = CONTRACT_ORIGINS.filter((o) => !origins.includes(o));
check('合同【Failure Class】点名的 9 类来源逐类具备',
  missingOrigins.length === 0, `缺失=${JSON.stringify(missingOrigins)}`);

// 写入边界：合同禁止保存整段聊天/全量日志/巨大 tool output
const draft0 = core.makeExperience({ title: 't', body: 'b', sourceEventSeqs: [1] });
const fieldNames = new Set(Object.keys(draft0.value ?? {}));
obs('experience record fields', JSON.stringify([...fieldNames]));
for (const [label, aliases] of CONTRACT_FIELDS) {
  check(`合同字段「${label}」在经验记录中可表达`,
    aliases.some((a) => fieldNames.has(a)),
    `已查别名=${JSON.stringify(aliases)}`);
}

// ═══ 真实会话选材（两个**不同**的真实会话，跨会话复用的前提）═══════════════
section('C0b 真实会话选材');
const cands = listRealSessions().slice().sort((a, b) => b.size - a.size);
if (cands.length < 2) { console.error('FATAL: 需要 ≥2 个真实会话文件'); process.exit(1); }
const realA = loadRealSession(cands[0].p);
const realB = loadRealSession(cands[1].p);
obs('session A', `${path.basename(realA.file)} events=${realA.events.filter(Boolean).length} nodes=${realA.nodes.length}`);
obs('session B', `${path.basename(realB.file)} events=${realB.events.filter(Boolean).length} nodes=${realB.nodes.length}`);
check('两会话确为不同真实文件（跨会话复用的前提）', realA.file !== realB.file);

// ═══ C1 场景 1（真实学习）：真实会话 → 自动候选，携带真实出处 ═══════════════
section('C1 场景 1 真实学习：真实会话 → PROPOSED 经验（真实出处，绝不自动生效）');
const SID_A = 'contract-scen-A-' + Date.now();
const SID_B = 'contract-scen-B-' + Date.now();
// F1（2026-09-25）：唯一激活通道 = 宿主人类批准。本场景需要真实 APPROVED ⇒ 起真实宿主
// ApprovalService，测试只当"人类"作答（不伪造事件对）。
const apprHost = await mkHostApproval({ answerer: 'allowed-once' });
const ea = mkCtx({ approval: apprHost.svc ?? undefined });
const apiA = learn.apply(ea.ctx, { stateDir: tmpDir, minNewNodes: 4, minTurnsForLearning: 4, maxDigestTurns: 40 });
await driveHook(ea.hooks, { id: SID_A, events: realA.events, surface: { nodes: realA.nodes.slice(0, 24) } });
check('首轮只建水位（不回填历史）', apiA.getStore(SID_A).experiences.length === 0,
  `experiences=${apiA.getStore(SID_A).experiences.length}`);
const grownA = await growSession(apiA, ea.hooks, realA, SID_A, 24);
const storeA = apiA.getStore(SID_A);
obs('session A auto-proposed experiences', `${storeA.experiences.length} (pre-step calls=${grownA.steps})`);
check('[场景1] 真实会话自动产出经验条目', storeA.experiences.length >= 1,
  `experiences=${storeA.experiences.length}`);
const expA = storeA.experiences[0];
if (expA) {
  check('[场景1] 出生即 PROPOSED（学习≠生效）', expA.state === 'PROPOSED', `state=${expA.state}`);
  check('[场景1] 携带真实回源锚点 seq', Array.isArray(expA.sourceEventSeqs) && expA.sourceEventSeqs.length >= 4,
    `seqs=${JSON.stringify(expA.sourceEventSeqs)}`);
  check('[场景1] 每个锚点指向真实事件', expA.sourceEventSeqs.every((q) => {
    const ev = realA.events[q];
    return ev && ev.seq === q;
  }));
  check('[场景1] 归属会话正确', expA.originSessionId === SID_A, `origin=${expA.originSessionId}`);
  check('[场景1] 未经审批不可召回（提案≠激活）', apiA.recallFor(SID_A, expA.title).items.length === 0);
}

// ═══ C2 场景 2（真实复用）★核心：跨会话 + 适用性检查 + 重新验证 ════════════
section('C2 场景 2 真实复用（合同【复用规则】相似任务 → 检索 → 检查适用性 → 复用 → 重新验证）');
const execA = mkExec(SID_A);
let approvedId = null;
if (expA) {
  const r = await apiA.invokeTool('learn_review', {
    experienceId: expA.id,
    action: 'approve',
    approver: 'contract-probe',
    evidence: 'real session A auto-learning candidate; reviewed for contract conformance probe',
  }, execA);
  check('[场景2] 人类批准走的是宿主通道（非调用方自称）', apprHost.seen.length >= 1,
    `host approval requests seen=${apprHost.seen.length}`);
  approvedId = r.experienceId;
  obs('[场景2] 审批结果', `state=${r.state} verified=${r.verified} verificationStatus=${r.verificationStatus} publication=${r.publication}`);
  check('[场景2] 审批后成为 APPROVED（唯一激活通道）', r.state === 'APPROVED', `state=${r.state}`);
  const recalledA = apiA.recallFor(SID_A, expA.title).items;
  obs('同会话（A 内）召回条数', recalledA.length);
  check('同会话召回成立（这正是上一轮被判"近乎同义反复"的那条路径）', recalledA.length >= 1,
    `items=${recalledA.length}`);
  if (recalledA[0]) {
    const it = recalledA[0];
    check('[场景2] 召回结果携带合同要求的"适用性"信息（版本/环境）',
      it.applicableVersions !== undefined || it.applicableEnvironment !== undefined,
      `实际字段=${JSON.stringify(Object.keys(it))}`);
    check('[场景2] 召回结果携带合同要求的"重新验证"信息（lastVerifiedAt）',
      it.lastVerifiedAt !== undefined,
      `实际字段=${JSON.stringify(Object.keys(it))}`);
  }
}

// 真实复用 = 在**另一个真实会话**里检索早先学到的经验
//
// ★ F1 拓扑更正（2026-09-25）：F1 之后"活跃授权"由**进程内 HMAC 签章**绑定，而
// `rotateHostApprovalKey()` 在每次 `apply()` 时轮换 ⇒ **同一进程里再 apply() 一个实例会
// 让前一个实例签发的审批签章失效**（fail-closed，安全但严格）。生产形态是"一个插件实例
// 服务多个会话"（Layer A 每会话一库 / Layer B 进程内共享），因此忠实于生产的跨会话测法
// 是**同一实例的两个会话**，而不是同进程第二个实例。
const apiB = apiA;
await driveHook(ea.hooks, { id: SID_B, events: realB.events, surface: { nodes: realB.nodes.slice(0, 24) } });
await growSession(apiB, ea.hooks, realB, SID_B, 24);
const storeB = apiB.getStore(SID_B);
obs('session B experience count', storeB.experiences.length);
obs('storePath 形态', 'stateDir/<sid>.json（每会话一库）');
const recalledB = expA ? apiB.recallFor(SID_B, expA.title).items : [];
obs('跨会话（B 检索 A 的经验）召回条数', recalledB.length);
obs('Layer B 全局库条数（A 视角 / B 视角）',
  `${apiA.globalStore().experiences.length} / ${apiB.globalStore().experiences.length}`);
obs('全局库中的条目状态', JSON.stringify(apiB.globalStore().experiences.map((e) => ({
  id: e.id, state: e.state, v: e.verification?.status, appr: !!e.approvedBy, rec: core.isRecallable(e),
}))));
check('[场景2] 合同核心闭环「下次复用」成立：B 会话可检索到 A 会话已批准的经验',
  recalledB.length >= 1,
  `B 库条目=${storeB.experiences.length}；召回=${recalledB.length} ⇒ 经验库按会话隔离，跨会话不可见`);

// 重新验证：复用后必须留下"已重新验证"的痕迹
const sumB = apiB.summaryFor(SID_B);
obs('session B telemetry counts', JSON.stringify(sumB.counts ?? {}));
obs('TELEMETRY_KINDS', JSON.stringify(core.TELEMETRY_KINDS));
check('[场景2] 存在"重新验证"的遥测种类（复用后可审计）',
  (core.TELEMETRY_KINDS ?? []).some((k) => /VERIF|REVALIDAT/.test(String(k))),
  `实际=${JSON.stringify(core.TELEMETRY_KINDS)}`);
check('[场景2] 存在可执行的"适用性检查"入口（工具面或核心函数）',
  (apiA.toolNames ?? []).some((n) => /applicab|verify|revalidat/i.test(n))
  || typeof core.isApplicableNow === 'function',
  `工具面=${JSON.stringify(apiA.toolNames)}`);

// ═══ C3 场景 3（真实能力缺口 → 候选 → 有界研究）════════════════════════════
section('C3 场景 3 真实能力缺口：重复阈值 → 候选（且非可学来源必须被否决）');
obs('REPEAT_THRESHOLD', String(REPEAT_THRESHOLD));
obs('HARD_VETO_CLASSES', JSON.stringify(HARD_VETO_CLASSES));
check('[场景3] 重复阈值存在且 >1（缺口必须重复才固化）', Number(REPEAT_THRESHOLD) > 1);
check('[场景3] 存在硬否决类别（网络/Provider 等环境故障不得误学）',
  Array.isArray(HARD_VETO_CLASSES) && HARD_VETO_CLASSES.length > 0);
const cstoreA = apiA.candidateStoreFor(SID_A);
obs('session A candidate store', cstoreA ? `candidates=${(cstoreA.candidates ?? []).length}` : 'null');
check('[场景3] 插件暴露候选库读取面（有界、可审计）',
  typeof apiA.candidateStoreFor === 'function');
check('[场景3] 候选库条目数有上限（有界，不无限增长）',
  Number.isInteger(MAX_CANDIDATES) && MAX_CANDIDATES > 0, `MAX_CANDIDATES=${MAX_CANDIDATES}`);

// ═══ C4 场景 4（真实治理边界）══════════════════════════════════════════════
section('C4 场景 4 真实治理：审批边界 / 不泄漏 / 会话隔离');
// 假密钥夹具：按 secret-scan-check.mjs 的既定惯例（CI_MOCK_LITERALS）**拼接组装**——
// 源码里不得出现密钥形状的完整字面量，否则本层扫描与 CI 的 PowerShell 模式扫描都会报红。
// 拼接不改变语义：验证目标仍是"密钥形状内容必须被拦在经验库之外"。
const FAKE_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0' + '123456789';
const SECRET_BODY = 'token=' + FAKE_KEY;
const execB2 = mkExec(SID_B);
let secretBlocked = false;
try {
  await apiB.invokeTool('learn_propose', {
    title: 'contract probe: secret must never persist',
    body: SECRET_BODY,
    tags: ['probe'],
    sourceEventSeqs: realB.nodes.slice(-6),
  }, execB2);
} catch { secretBlocked = true; }
const persisted = JSON.stringify(apiB.getStore(SID_B));
check('[场景4] 密钥形态内容不得持久化进经验库',
  secretBlocked || !persisted.includes(FAKE_KEY),
  `blocked=${secretBlocked}`);
check('[场景4] 会话隔离：B 库不包含 A 的条目（隔离成立的另一面）',
  storeB.experiences.every((e) => e.originSessionId !== SID_A) || storeB.experiences.length === 0);

// ═══ 汇总 ══════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(96));
// 摘要格式必须与 tests/learn/run-learn-all-tests.mjs 认定的格式 ① 一致
// （"N PASS / M FAIL"），否则门槛套件会被判 NO-SUMMARY 而非给出真实计数。
console.log(`合同符合性：${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(96));
console.log('\n实测观测值：');
for (const o of observations) console.log('  · ' + o);
if (fail) {
  console.log('\n未成立的合同条款：');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log('\n结论口径：本探针按**合同原文条款**求证，不按 R2 自定 AC 编号。');
console.log('未成立条款清单即为「合同要求的机制在实现中不存在或不可达」的可复现证据。');
process.exit(fail ? 1 : 0);
