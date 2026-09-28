// learn-candidate.mjs —— P4 R2 STAGE 6-7：Autonomous Research（有界）+ Candidate Lifecycle
//
// ─────────────────────────────────────────────────────────────────────────────
// Authority 边界（合同 §七/§八/§十四 + AC6/AC7/AC8/AC9）：
//
//   **本模块不执行任何真实的 git / CI / 部署动作。** 它只是一个
//   「策略 + 状态机」：决定该做什么、能不能前进、以及**该委托给哪个既有系统**。
//
//   为什么必须这样（AC6 逐字）：「Candidate 复用现有 CI/Transaction，
//   **不造第二套 promotion engine**」。任务书 §29 进一步列出禁止项：
//   second CI｜second deployment system｜second promotion engine｜second Transaction｜
//   second Git state machine。故本模块的 STAGE_DELEGATION 把每个阶段**显式绑定**
//   到既有系统；本模块自己绝不 spawn 进程、绝不写 .git、绝不调用 workflow。
//
//   **Experience 与 Candidate 分层（合同 §十四）**：
//     Experience = 已真实成功并**验证过**的解决经验（learn-core.mjs 的 authority）
//     Candidate  = 可能需要形成 Rule/Skill/Plugin 的**重复能力缺口**（本模块的 authority）
//   两者**不是一回事，不得混用同一 authority** ⇒ 故本模块用**独立 store**
//   （独立文件、独立 schema 版本、独立 fail-closed 校验），且**绝不**写入
//   learn-core 的 experience store。它们**共用**的只有遥测原语
//   （telemetryEvent/appendTelemetry）——那是同一份实现，不是第二套。
//
//   AC8：**无常驻 daemon**。本模块零定时器、零事件循环、零后台任务；每次调用都是
//         由 agent 回合驱动的纯函数式状态推进。研究次数**有界**（MAX_RESEARCH_ATTEMPTS）。
//   AC9：候选数**有界**（MAX_CANDIDATES），且**默认不产生任何插件**——只有走完
//         RULE→…→NEW_PLUGIN 阶梯且被判定必须新插件时才走到 NEW_PLUGIN。
// ─────────────────────────────────────────────────────────────────────────────

import {
  isPlainObject,
  redactSecrets,
  containsSecret,
  stableHash,
  telemetryEvent,
  appendTelemetry,
  MAX_TELEMETRY,
  MAX_EVIDENCE_LEN,
  MAX_REASON_LEN,
} from './learn-core.mjs';

/** 候选库 schema 版本（与 LEARN_SCHEMA_VERSION 独立演进，两者互不影响）。 */
export const CANDIDATE_SCHEMA_VERSION = 1;

/** AC9：候选数上限（有界，防无界增长）。 */
export const MAX_CANDIDATES = 50;

/** 最小失败记录上限（有界；只留最小信息，不长期挂载）。 */
export const MAX_MINIMAL_FAILURES = 100;

/**
 * 候选类型阶梯（合同 §七逐字）：**Rule > extend existing Skill > new Skill > new Plugin**。
 * 数组顺序即优先级顺序 —— 永远优先选**代价最低**的形态。
 */
export const CANDIDATE_KINDS = Object.freeze(['RULE', 'EXTEND_SKILL', 'NEW_SKILL', 'NEW_PLUGIN']);

/**
 * 候选生命周期（合同 §八逐字）：
 *   Candidate → isolated tests → regression/holdout → canary → PASS promote / FAIL reject
 */
export const CANDIDATE_STATES = Object.freeze([
  'PROPOSED', 'ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY', 'PROMOTED', 'REJECTED',
]);

/** 允许的状态迁移。PROMOTED / REJECTED 为终态（不可复活）。 */
export const CANDIDATE_TRANSITIONS = Object.freeze({
  PROPOSED: Object.freeze(['ISOLATED_TESTS', 'REJECTED']),
  ISOLATED_TESTS: Object.freeze(['REGRESSION_HOLDOUT', 'REJECTED']),
  REGRESSION_HOLDOUT: Object.freeze(['CANARY', 'REJECTED']),
  CANARY: Object.freeze(['PROMOTED', 'REJECTED']),
  PROMOTED: Object.freeze([]),
  REJECTED: Object.freeze([]),
});

/** 需要「通过证据」才能进入的阶段（缺证据一律 fail-closed 拒绝前进）。 */
export const EVIDENCE_REQUIRED_STATES = Object.freeze([
  'ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY', 'PROMOTED',
]);

/**
 * AC6：阶段 → **既有系统** 的显式委托表。
 *
 * 本模块不实现这些能力，只声明「该阶段必须由哪个既有系统执行」。
 * 任何试图在本模块内新建 CI/事务/canary 引擎的做法都违反 AC6。
 */
export const STAGE_DELEGATION = Object.freeze({
  ISOLATED_TESTS: Object.freeze({
    // Tier-0 事实修正（2026-09-29）：learn 套件的**实际承载**是 ci-level2.yml 的
    // 「P4 LEARN R2 contract-closure gates (CI-safe subset)」步骤（14 套件 + plugin-contract），
    // 原值 ci-level1.yml 是纸上权威（该层只有静态门，不跑 tests\learn\）。真实收据的
    // `ci.system` 亦为 ci-level2.yml（见 AC6 真 E2E 报告），此处对齐真实承载。
    file: '.github/workflows/ci-level2.yml',
    system: 'CI 四层（既有）',
    entry: 'learn 门 = ci-level2.yml「P4 LEARN R2 contract-closure gates」步骤；其余层 ci-level1/3/4',
    note: 'isolated tests 走既有四层 CI；禁建第二套 CI',
  }),
  REGRESSION_HOLDOUT: Object.freeze({
    file: 'dsh-transaction.ps1',
    system: 'dsh-transaction.ps1（既有变更事务）',
    entry: 'Invoke-DshTransaction / Test-DshTransactionCommitReady',
    note: 'regression/holdout 走既有事务的 VERIFY 语义；禁建第二套 Transaction',
  }),
  CANARY: Object.freeze({
    file: 'dsh-reliability-lab.ps1',
    system: 'dsh-reliability-lab.ps1（既有可靠性实验台）',
    entry: 'Reliability Lab',
    note: 'canary 走既有实验台；禁建第二套 canary 引擎',
  }),
  PROMOTED: Object.freeze({
    file: 'dsh-plugin-transaction.ps1',
    system: 'dsh-plugin-transaction.ps1（既有插件事务）',
    entry: 'CHECKPOINT → APPLY → VERIFY(YAML+readiness) → 失败 ROLLBACK',
    note: '真正落地走既有插件事务；禁建第二套 deployment system',
  }),
});

/**
 * AC8 / 合同「无限重试 ❌」：自主研究次数上限。
 * 达到上限后必须停止并记 RESEARCH_BOUNDED_EXHAUSTED，**不得**自行加次数。
 */
export const MAX_RESEARCH_ATTEMPTS = 3;

/**
 * Stable 标记（AC7）。命中即视为「稳定产物」，候选**不得直接覆盖**。
 * 与 learn-core 的 PROTECTED_TARGETS 同一纪律：前缀/包含式匹配，防路径变体绕过。
 */
export const STABLE_MARKERS = Object.freeze([
  'stable', 'production', 'prod', 'release', 'lastgood', 'last-good', 'verified-lastgood',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 0.6 AC6：候选晋升的**真实收据门**（Git / CI / Transaction 三腿）
//
// A10 的 AC6 缺口原话："Candidate 生命周期有对象和测试，但未证明真正走 existing Git /
// existing CI / existing Transaction"。根因是**晋升路径上没有真实系统的收据**：
// `promoteCandidate` 只检查阶段证据字符串 + 人工批准，任何字符串都能自证。
//
// 本节把"真走既有系统"从条款变成**可机校事实**：
//   - 三腿收据必须来自**既有**系统（PROMOTION_RECEIPT_SYSTEMS 是白名单，
//     不在白名单 = 第二套 CI / 第二套 Transaction ⇒ 一律拒绝）；
//   - 三腿必须**互相一致**（同一条候选分支、同一个 commit、同一个 label）；
//   - 收据缺一腿即拒绝（fail-closed），且**拒绝也留痕**（CANDIDATE_PROMOTION_DENIED）。
//
// 纪律：本模块**只读收据文本、绝不执行任何命令**（无子进程、无网络、无 IO、无定时器）——
// 收据由既有系统自己产出（CI 运行结果 / git 对象 / dsh-transaction.ps1 的 journal），
// 本模块只做**校验与门禁**。这既满足 AC6「复用」，也不违反 AC8「不新增引擎/常驻进程」。
// ─────────────────────────────────────────────────────────────────────────────

/** 晋升所需的**全部**三腿（缺一不可）。 */
export const PROMOTION_RECEIPT_LEGS = Object.freeze(['git', 'ci', 'transaction']);

/**
 * 收据的**唯一**合法来源（白名单）。写死既有系统标识符：
 * 任何其它来源名（自造 CI runner / 自造 promotion DB / 自造 transaction）都会被拒。
 */
export const PROMOTION_RECEIPT_SYSTEMS = Object.freeze({
  git: Object.freeze(['git']),
  ci: Object.freeze(['ci-level1.yml', 'ci-level2.yml', 'ci-level3.yml', 'ci-level4.yml']),
  transaction: Object.freeze(['dsh-transaction.ps1']),
});

/**
 * 既有变更事务的「成功终态」（复用其语义，不另造状态机）。
 *
 * 逐字对齐 `dsh-transaction.ps1` 的真实口径（读源码核实，非猜测）：
 *   - 状态机 PREPARE→CHECKPOINT→APPLY→BOOT→VERIFY→STABILIZE→COMMIT；
 *   - 只有 `Test-DshTransactionCommitReady` 通过（full COMMIT_READY）才 `$finalState = 'COMMITTED'`；
 *   - 其它终态 `ROLLED_BACK` / `BOOT_FAILED` / `SAFE_MODE` / `FAILED` / `FAILED(dry)` **一律不合格**；
 *   - `-DryRun` 走的是 `FAILED(dry)` 分支 ⇒ **dry-run 收据永远无法冒充真实事务**（天然 fail-closed）。
 * 这正是契约「api_ready alone is NOT a commit signal」的现有实现，本模块只**消费**它。
 */
export const PROMOTION_TRANSACTION_FINAL_STATE = 'COMMITTED';

/** 真实提交事务在该引擎 journal 里必须同时满足的伴随字段（faultClass/rollbackResult 见 COMMIT 记录）。 */
export const PROMOTION_TRANSACTION_FAULT_CLASS = 'none';
export const PROMOTION_TRANSACTION_ROLLBACK_RESULT = 'none';
/** VERIFY 阶段必须来自该引擎自己的 commit gate（`COMMIT_READY` / `COMMIT_READY(shallow)`）。 */
export const PROMOTION_TRANSACTION_VERIFY_PREFIX = 'COMMIT_READY';

/** 候选隔离分支的确定性前缀（candidate/<id>）：同一条候选永远同一个分支名。 */
export const CANDIDATE_BRANCH_PREFIX = 'candidate/';

/** git 对象名（40 位小写十六进制 sha1 / sha256 截断口径同一校验）。 */
const GIT_OBJECT_RE = /^[0-9a-f]{40}$/;

/**
 * 事务 label 必须**文件系统安全**：dsh-transaction.ps1 把 label 拼进 transactionId，
 * 而 transactionId 是 checkpoint 的目录名（Windows 目录名禁用 `: * ? " < > |`）。
 * 不安全 = 真实事务永远 checkpoint 失败 = 真实晋升不可能，故在门口就拒。
 */
const TX_LABEL_SAFE_RE = /^[A-Za-z0-9._-]{1,96}$/;

/** 确定性分支名：candidate/<candidateId>。 */
export function candidateBranchName(candidateId) {
  const id = cleanStr(candidateId, 64);
  return id ? `${CANDIDATE_BRANCH_PREFIX}${id}` : '';
}

/**
 * 确定性事务 label：candidate-<candidateId>（喂给既有 dsh-transaction.ps1 的 -Label）。
 *
 * 为什么不是 `candidate:<id>`：引擎把 label 直接拼进 transactionId，而 transactionId 又是
 * checkpoint 的**目录名**（New-DshTransactionCheckpoint → Get-DshTxCheckpointDir）。
 * Windows 目录名不允许 `:`，真实端到端跑出来就是
 * "New-Item : The given path's format is not supported"——即带 `:` 的 label 永远无法 checkpoint，
 * 真实晋升根本走不通。故本口径必须**文件系统安全**（[A-Za-z0-9._-]）。
 */
export function candidateTransactionLabel(candidateId) {
  const id = cleanStr(candidateId, 64);
  return id ? `candidate-${id}` : '';
}

/**
 * 把三腿收据压成**有界、脱敏、可审计**的摘要（只留机校标量，绝不入库存原文）。
 * @returns {{git:object, ci:object, transaction:object}|null}
 */
export function receiptSummaryOf(receipts) {
  if (!isPlainObject(receipts)) return null;
  const g = isPlainObject(receipts.git) ? receipts.git : null;
  const c = isPlainObject(receipts.ci) ? receipts.ci : null;
  const t = isPlainObject(receipts.transaction) ? receipts.transaction : null;
  if (!g || !c || !t) return null;
  return {
    git: {
      system: cleanStr(g.system, 40),
      branch: cleanStr(g.branch, 120),
      commitSha: cleanStr(g.commitSha, 64),
      worktreePath: redactSecrets(cleanStr(g.worktreePath, 300)),
      isolated: g.isolated === true,
    },
    ci: {
      system: cleanStr(c.system, 60),
      job: cleanStr(c.job, 120),
      headSha: cleanStr(c.headSha, 64),
      conclusion: cleanStr(c.conclusion, 40),
      runUrl: redactSecrets(cleanStr(c.runUrl, 300)),
    },
    transaction: {
      system: cleanStr(t.system, 60),
      label: cleanStr(t.label, 120),
      transactionId: cleanStr(t.transactionId, 160),
      finalState: cleanStr(t.finalState, 40),
      verifyResult: cleanStr(t.verifyResult, 60),
      faultClass: cleanStr(t.faultClass, 40),
      rollbackResult: cleanStr(t.rollbackResult, 40),
      journalPath: redactSecrets(cleanStr(t.journalPath, 300)),
    },
  };
}

/**
 * AC6 收据门：校验候选晋升是否**真走既有 Git / CI / Transaction**。
 *
 * fail-closed：结构缺失、来源白名单外、三腿不一致、含密钥、非隔离分支 —— 任一即拒绝。
 * 纯函数（无 IO / 无子进程 / 无网络），可在任何环境确定性复算。
 *
 * @param {object} candidate - 候选对象（只用到 id）
 * @param {object} receipts  - 三腿收据（由既有系统产出）
 * @returns {{ok:true, receipts:object, summary:object}
 *          |{ok:false, error:string, leg?:string, missing?:string[], detail?:string}}
 */
export function verifyPromotionReceipts(candidate, receipts) {
  if (!isPlainObject(candidate) || typeof candidate.id !== 'string' || !candidate.id) {
    return { ok: false, error: 'invalid_candidate' };
  }
  if (!isPlainObject(receipts)) {
    return { ok: false, error: 'promotion_receipts_missing', missing: [...PROMOTION_RECEIPT_LEGS] };
  }
  // ① 密钥红线：收据里出现任何密钥形状的值 ⇒ 一律拒绝（绝不入库/入库即脱敏）
  for (const leg of PROMOTION_RECEIPT_LEGS) {
    const r = receipts[leg];
    if (!isPlainObject(r)) continue;
    for (const v of Object.values(r)) {
      if (typeof v === 'string' && containsSecret(v)) {
        return { ok: false, error: 'promotion_receipt_contains_secret', leg };
      }
    }
  }
  // ② 三腿齐备
  const missing = PROMOTION_RECEIPT_LEGS.filter((leg) => !isPlainObject(receipts[leg]));
  if (missing.length > 0) return { ok: false, error: 'promotion_receipts_missing', missing };

  const expectBranch = candidateBranchName(candidate.id);
  const expectLabel = candidateTransactionLabel(candidate.id);
  const s = receiptSummaryOf(receipts);

  // ③ 事务 label 必须文件系统安全（否则真实事务在 checkpoint 阶段必炸）
  if (!TX_LABEL_SAFE_RE.test(expectLabel)) {
    return { ok: false, error: 'promotion_label_not_filesystem_safe', leg: 'transaction', detail: `label=${expectLabel || '(empty)'}` };
  }

  // ③ git 腿：既有 git 的隔离分支 + 40 位对象名（证明有真实隔离分支/工作树）
  if (!PROMOTION_RECEIPT_SYSTEMS.git.includes(s.git.system)) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'git', detail: `system=${s.git.system || '(empty)'}` };
  }
  if (s.git.branch !== expectBranch) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'git', detail: `branch=${s.git.branch || '(empty)'} expected=${expectBranch}` };
  }
  if (!GIT_OBJECT_RE.test(s.git.commitSha)) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'git', detail: 'commitSha_not_a_git_object' };
  }
  if (!s.git.worktreePath) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'git', detail: 'worktreePath_empty' };
  }
  if (s.git.isolated !== true) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'git', detail: 'worktree_not_isolated' };
  }

  // ④ CI 腿：既有四层 CI 之一、成功、且跑的就是**同一个 commit**（防"旧绿报告顶新代码"）
  if (!PROMOTION_RECEIPT_SYSTEMS.ci.includes(s.ci.system)) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'ci', detail: `system=${s.ci.system || '(empty)'}` };
  }
  if (s.ci.conclusion !== 'success') {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'ci', detail: `conclusion=${s.ci.conclusion || '(empty)'}` };
  }
  if (!s.ci.job) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'ci', detail: 'job_empty' };
  }
  if (s.ci.headSha !== s.git.commitSha) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'ci', detail: 'ci_headSha_mismatch_git_commitSha' };
  }

  // ⑤ transaction 腿：既有 dsh-transaction.ps1 的**真实提交**记录
  //    （COMMITTED + faultClass/rollbackResult=none + VERIFY 来自它自己的 COMMIT_READY gate）
  if (!PROMOTION_RECEIPT_SYSTEMS.transaction.includes(s.transaction.system)) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `system=${s.transaction.system || '(empty)'}` };
  }
  if (s.transaction.label !== expectLabel) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `label=${s.transaction.label || '(empty)'} expected=${expectLabel}` };
  }
  if (s.transaction.finalState !== PROMOTION_TRANSACTION_FINAL_STATE) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `finalState=${s.transaction.finalState || '(empty)'} expected=${PROMOTION_TRANSACTION_FINAL_STATE}` };
  }
  if (s.transaction.faultClass !== PROMOTION_TRANSACTION_FAULT_CLASS) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `faultClass=${s.transaction.faultClass || '(empty)'}` };
  }
  if (s.transaction.rollbackResult !== PROMOTION_TRANSACTION_ROLLBACK_RESULT) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `rollbackResult=${s.transaction.rollbackResult || '(empty)'}` };
  }
  if (!String(s.transaction.verifyResult).startsWith(PROMOTION_TRANSACTION_VERIFY_PREFIX)) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: `verifyResult=${s.transaction.verifyResult || '(empty)'}` };
  }
  if (!s.transaction.transactionId) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: 'transactionId_empty' };
  }
  if (!s.transaction.journalPath) {
    return { ok: false, error: 'promotion_receipt_invalid', leg: 'transaction', detail: 'journalPath_empty' };
  }

  return { ok: true, receipts, summary: s };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 纯工具（无副作用）
// ─────────────────────────────────────────────────────────────────────────────

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

/** 确定性候选 id：由 dedupKey 派生，同一 gap 永远得到同一 id（幂等）。 */
export function candidateIdOf(dedupKey) {
  const k = typeof dedupKey === 'string' ? dedupKey.trim() : '';
  if (!k) return '';
  return `cand_${stableHash(k).slice(0, 16)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. STAGE 6：Autonomous Research（有界、无常驻 daemon）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 选候选形态（合同 §七阶梯）。**永远选代价最低且够用的形态。**
 *
 * @param {object} ctx
 * @param {boolean} [ctx.ruleExpressible]        - 该缺口能否用声明式规则表达
 * @param {string}  [ctx.existingSkill]          - 已有的、覆盖该领域的 skill 标识
 * @param {boolean} [ctx.requiresRuntimeCapability] - 是否必须新增运行时能力（超出 skill 能表达的范围）
 * @returns {{kind:string, reason:string}}
 */
export function chooseCandidateKind(ctx = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  // ① 能用规则表达 → RULE（最轻，优先）
  if (c.ruleExpressible === true) {
    return { kind: 'RULE', reason: 'rule_expressible' };
  }
  // ② 已有 skill 覆盖该领域 → 扩展它，不新建
  const skill = cleanStr(c.existingSkill, 200);
  if (skill) {
    return { kind: 'EXTEND_SKILL', reason: `existing_skill:${skill}` };
  }
  // ③ 需要的是"做法"而非"新运行时能力" → 新 Skill
  if (c.requiresRuntimeCapability !== true) {
    return { kind: 'NEW_SKILL', reason: 'no_existing_skill_capability_is_procedural' };
  }
  // ④ 兜底：确实需要新运行时能力 → 新 Plugin（最重，最后手段）
  return { kind: 'NEW_PLUGIN', reason: 'requires_new_runtime_capability' };
}

/**
 * 生成**有界**研究计划。纯描述，不执行任何动作、不起任何后台任务（AC8）。
 *
 * @param {object} gap - qualifyGap() 的合格输出
 * @param {object} [opts] - {ruleExpressible, existingSkill, requiresRuntimeCapability, maxAttempts}
 * @returns {{ok:boolean, error?:string, plan?:object}}
 */
export function researchPlan(gap, opts = {}) {
  if (!isPlainObject(gap) || gap.qualified !== true) {
    return { ok: false, error: 'gap_not_qualified' };
  }
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : MAX_RESEARCH_ATTEMPTS;
  const choice = chooseCandidateKind(opts);
  return {
    ok: true,
    plan: {
      dedupKey: gap.dedupKey,
      taskType: gap.taskType,
      normalizedSignature: gap.normalizedSignature,
      classification: gap.classification,
      observationCount: gap.count,
      kind: choice.kind,
      kindReason: choice.reason,
      maxAttempts,                    // 有界（AC8 / 禁无限重试）
      attemptsUsed: 0,
      daemon: false,                  // 显式声明：无常驻守护进程
      delegatesTo: STAGE_DELEGATION.ISOLATED_TESTS.system,
    },
  };
}

/**
 * AC2 风险分级标志（确定性、保守）：命中任一 ⇒ HIGH。
 * 保守方向的理由：AC2 只授权"**低风险**陌生任务"自主研究；把不确定的文本判为 HIGH 只会
 * 让动作多经一次人工门，不会造成越权，故宁可误判为高。
 */
export const RESEARCH_HIGH_RISK_MARKERS = Object.freeze([
  // 不可逆删除 / 磁盘
  'rm -rf', 'del /f', 'rd /s', 'format ', 'diskpart', 'mkfs', '删除全部', '全部删除', '删除所有', '清空',
  // 数据库破坏性语句
  'drop table', 'drop database', 'truncate table', 'migration', '迁移生产',
  // 系统 / 权限 / 启动
  'registry', 'regedit', '注册表', 'firewall', '防火墙', 'runas', 'sudo', '提权', 'administrator',
  '开机自启', 'autostart', 'windows service', '系统服务',
  // 凭据 / 密钥
  'credential', 'credentials', '凭据', 'api key', 'apikey', 'api_key', 'password', '密码',
  'private key', '私钥', 'secret', 'token',
  // 金钱 / 账号
  'payment', '付款', '转账', '充值', 'subscri', '订阅', '账单', 'billing',
  // 生产环境 / 远端不可逆
  // 注意：这里**刻意不写** `git` + `push` 这两个词组成的字面量 —— `test-learn-candidate.mjs`
  // 的 B3 静态锁用该组合禁止本模块出现任何 git 执行痕迹（禁第二套引擎）。该锁是**安全护栏**，
  // 只能遵守、不能放宽；而"普通推送"本就不属于不可逆类，真正不可逆的是强推/硬重置 ⇒ 用
  // 'force push' / '--force' / 'reset --hard' / '强制推送' / '硬重置' 覆盖，语义等价、覆盖率不减。
  'production', '生产环境', '线上环境', 'force push', '--force', 'reset --hard', '强制推送', '硬重置',
]);

/**
 * AC2：把任务文本分成 LOW / HIGH（纯函数：无 IO、无状态、无网络）。
 * LOW ⇒ 可**自主研究**；HIGH ⇒ 仍可研究，但研究得出的**动作**必须走人工门（见 learn.mjs 的 directive）。
 *
 * @param {string} text - 任务文本 / 查询
 * @returns {{riskClass:'LOW'|'HIGH', matched: string|null}}
 */
export function classifyResearchRisk(text) {
  const t = typeof text === 'string' ? text.toLowerCase() : '';
  if (!t) return { riskClass: 'LOW', matched: null };
  for (const m of RESEARCH_HIGH_RISK_MARKERS) {
    if (t.includes(m)) return { riskClass: 'HIGH', matched: m };
  }
  return { riskClass: 'LOW', matched: null };
}

/**
 * 记录一次研究尝试。**超过上限一律拒绝**，并给出需记遥测的信号。
 *
 * @param {object} candidate
 * @param {object} attempt - { at:number, outcome:'PROGRESS'|'NO_PROGRESS'|'FOUND', detail?:string }
 * @returns {{ok:boolean, error?:string, candidate?:object, exhausted?:boolean}}
 */
export function recordResearchAttempt(candidate, attempt = {}) {
  if (!isPlainObject(candidate)) return { ok: false, error: 'invalid_candidate' };
  const cap = Number.isInteger(candidate.maxAttempts) && candidate.maxAttempts > 0
    ? candidate.maxAttempts
    : MAX_RESEARCH_ATTEMPTS;
  const used = Number.isInteger(candidate.attemptsUsed) ? candidate.attemptsUsed : 0;
  if (used >= cap) {
    // 达上限：不再尝试（禁无限重试），调用方必须据此停止
    return { ok: false, error: 'research_bounded_exhausted', exhausted: true, candidate };
  }
  const a = isPlainObject(attempt) ? attempt : {};
  const outcome = ['PROGRESS', 'NO_PROGRESS', 'FOUND'].includes(a.outcome) ? a.outcome : 'NO_PROGRESS';
  const entry = {
    at: Number.isSafeInteger(a.at) ? a.at : 0,
    outcome,
    detail: redactSecrets(cleanStr(a.detail, 300)),
  };
  const next = {
    ...candidate,
    attemptsUsed: used + 1,
    researchLog: [...(Array.isArray(candidate.researchLog) ? candidate.researchLog : []), entry].slice(-cap),
    exhausted: used + 1 >= cap,
  };
  return { ok: true, candidate: next, exhausted: next.exhausted };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. STAGE 7：Candidate 建模与 fail-closed 校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由**合格 gap** 构造候选。未经 qualifyGap 的缺口**一律拒绝**（AC5 闸门不可绕过）。
 *
 * @param {object} gap - qualifyGap() 输出（必须 qualified === true）
 * @param {object} opts - { at, ruleExpressible, existingSkill, requiresRuntimeCapability, evidence }
 * @returns {{ok:boolean, error?:string, candidate?:object}}
 */
export function makeCandidate(gap, opts = {}) {
  if (!isPlainObject(gap) || gap.qualified !== true) {
    return { ok: false, error: 'gap_not_qualified' };
  }
  const id = candidateIdOf(gap.dedupKey);
  if (!id) return { ok: false, error: 'missing_dedup_key' };
  const choice = chooseCandidateKind(opts);
  const at = Number.isSafeInteger(opts.at) ? opts.at : 0;
  const candidate = {
    id,
    kind: choice.kind,
    kindReason: choice.reason,
    state: 'PROPOSED',
    dedupKey: gap.dedupKey,
    taskType: cleanStr(gap.taskType, 200),
    normalizedSignature: cleanStr(gap.normalizedSignature, 300),
    classification: cleanStr(gap.classification, 100),
    observationCount: Number.isInteger(gap.count) ? gap.count : 0,
    createdAt: at,
    updatedAt: at,
    stageEvidence: {},                 // 阶段 → 证据（每步必须有）
    maxAttempts: MAX_RESEARCH_ATTEMPTS,
    attemptsUsed: 0,
    researchLog: [],
    exhausted: false,
    approval: null,                    // 人工批准（PROMOTED 必需）
    promotionEvidence: null,
  };
  return { ok: true, candidate };
}

/** 逐字段净化（脱敏 + 截断）。任何含 secret 的候选判废（AC1 同纪律）。 */
export function sanitizeCandidate(raw) {
  try {
    if (!isPlainObject(raw)) return { error: 'not_object' };
    if (typeof raw.id !== 'string' || !raw.id) return { error: 'bad_id' };
    if (!CANDIDATE_KINDS.includes(raw.kind)) return { error: 'bad_kind' };
    if (!CANDIDATE_STATES.includes(raw.state)) return { error: 'bad_state' };
    if (typeof raw.dedupKey !== 'string' || !raw.dedupKey) return { error: 'bad_dedup_key' };
    if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) return { error: 'bad_created_at' };
    if (!Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) return { error: 'bad_updated_at' };

    const out = {
      id: raw.id.slice(0, 64),
      kind: raw.kind,
      kindReason: cleanStr(raw.kindReason, 200),
      state: raw.state,
      dedupKey: cleanStr(raw.dedupKey, 300),
      taskType: cleanStr(raw.taskType, 200),
      normalizedSignature: cleanStr(raw.normalizedSignature, 300),
      classification: cleanStr(raw.classification, 100),
      observationCount: Number.isInteger(raw.observationCount) ? raw.observationCount : 0,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      stageEvidence: {},
      maxAttempts: Number.isInteger(raw.maxAttempts) && raw.maxAttempts > 0 ? raw.maxAttempts : MAX_RESEARCH_ATTEMPTS,
      attemptsUsed: Number.isInteger(raw.attemptsUsed) && raw.attemptsUsed >= 0 ? raw.attemptsUsed : 0,
      researchLog: [],
      exhausted: raw.exhausted === true,
      approval: null,
      promotionEvidence: null,
    };

    // stageEvidence：只保留已知阶段，值脱敏+截断
    if (isPlainObject(raw.stageEvidence)) {
      for (const st of CANDIDATE_STATES) {
        const v = raw.stageEvidence[st];
        if (typeof v !== 'string' || !v) continue;
        if (containsSecret(v)) return { error: 'stage_evidence_contains_secret' };
        out.stageEvidence[st] = redactSecrets(v).slice(0, MAX_EVIDENCE_LEN);
      }
    }

    // researchLog：有界 + 脱敏
    if (Array.isArray(raw.researchLog)) {
      out.researchLog = raw.researchLog
        .filter((e) => isPlainObject(e))
        .map((e) => ({
          at: Number.isSafeInteger(e.at) ? e.at : 0,
          outcome: ['PROGRESS', 'NO_PROGRESS', 'FOUND'].includes(e.outcome) ? e.outcome : 'NO_PROGRESS',
          detail: redactSecrets(cleanStr(e.detail, 300)),
        }))
        .slice(-out.maxAttempts);
    }

    // approval / promotionEvidence
    if (isPlainObject(raw.approval)) {
      const by = cleanStr(raw.approval.by, 200);
      const ev = cleanStr(raw.approval.evidence, MAX_EVIDENCE_LEN);
      if (ev && containsSecret(ev)) return { error: 'approval_contains_secret' };
      out.approval = { by, evidence: ev ? redactSecrets(ev) : '', at: Number.isSafeInteger(raw.approval.at) ? raw.approval.at : 0 };
    }
    if (typeof raw.promotionEvidence === 'string' && raw.promotionEvidence) {
      if (containsSecret(raw.promotionEvidence)) return { error: 'promotion_evidence_contains_secret' };
      out.promotionEvidence = redactSecrets(cleanStr(raw.promotionEvidence, MAX_EVIDENCE_LEN));
    }

    // AC6：晋升收据**摘要**（只保留机校标量；收据原文一律不入库）
    if (isPlainObject(raw.promotionReceipts)) {
      const summary = receiptSummaryOf(raw.promotionReceipts);
      if (!summary) return { error: 'bad_promotion_receipts' };
      for (const leg of PROMOTION_RECEIPT_LEGS) {
        for (const v of Object.values(summary[leg])) {
          if (typeof v === 'string' && containsSecret(v)) return { error: 'promotion_receipts_contains_secret' };
        }
      }
      out.promotionReceipts = summary;
    }

    return { value: out };
  } catch {
    return { error: 'sanitize_threw' };
  }
}

export function emptyCandidateStore(sessionId) {
  return {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : 'unknown',
    version: 0,
    candidates: [],
    minimalFailures: [],
    telemetry: [],
    updatedAt: 0,
  };
}

/** fail-closed 校验：任何一条坏了整个 store 判废（绝不部分信任）。 */
export function validateCandidateStore(raw) {
  try {
    if (!isPlainObject(raw)) return null;
    if (raw.schemaVersion !== CANDIDATE_SCHEMA_VERSION) return null;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
    if (!Number.isSafeInteger(raw.version) || raw.version < 0) return null;
    if (!Array.isArray(raw.candidates)) return null;
    if (raw.candidates.length > MAX_CANDIDATES) return null;
    if (!Array.isArray(raw.minimalFailures)) return null;
    if (raw.minimalFailures.length > MAX_MINIMAL_FAILURES) return null;
    if (!Array.isArray(raw.telemetry)) return null;
    if (raw.telemetry.length > MAX_TELEMETRY) return null;
    for (const c of raw.candidates) {
      if (sanitizeCandidate(c).error) return null;
    }
    for (const f of raw.minimalFailures) {
      if (!isPlainObject(f) || typeof f.candidateId !== 'string') return null;
    }
    for (const t of raw.telemetry) {
      if (!isPlainObject(t) || typeof t.kind !== 'string') return null;
    }
    return raw;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 不可变写入（有界 + 保留刚写入的这条，不静默丢失）
// ─────────────────────────────────────────────────────────────────────────────

const byCreatedThenId = (a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function withCandidate(store, cand) {
  const next = store.candidates.filter((c) => c.id !== cand.id);
  next.push(cand);
  next.sort(byCreatedThenId);
  let kept = next.slice(-MAX_CANDIDATES);
  // 与 learn-core 同一纪律：容量淘汰必须保留**刚写入的这条**，否则"写成功但库里没有"
  if (kept.length >= MAX_CANDIDATES && !kept.some((c) => c.id === cand.id)) {
    kept = next.slice(-(MAX_CANDIDATES - 1)).concat(cand).sort(byCreatedThenId);
  }
  return { ...store, candidates: kept };
}

function withTelemetry(store, kind, payload, at) {
  const ev = telemetryEvent(kind, payload, at);
  if (!ev.ok) return store;
  return appendTelemetry(store, ev.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 候选生命周期操作
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由合格 gap 建立候选。幂等：同 dedupKey 已存在则返回原候选（不重复建、不复活终态）。
 */
export function proposeCandidate(store, gap, opts = {}) {
  if (!isPlainObject(store) || !Array.isArray(store.candidates)) {
    return { ok: false, error: 'invalid_store' };
  }
  const made = makeCandidate(gap, opts);
  if (!made.ok) return made;
  const at = Number.isSafeInteger(opts.at) ? opts.at : 0;

  const existing = store.candidates.find((c) => c.id === made.candidate.id);
  if (existing) {
    // 幂等：不复活 REJECTED / PROMOTED
    return { ok: true, value: store, candidate: existing, deduped: true };
  }

  let next = withCandidate(store, made.candidate);
  next = withTelemetry(next, 'CANDIDATE_PROPOSED', {
    experienceId: made.candidate.id,
    detail: `kind=${made.candidate.kind} taskType=${made.candidate.taskType} sig=${made.candidate.normalizedSignature}`,
    count: made.candidate.observationCount,
    reason: made.candidate.kindReason,
  }, at);
  next = { ...next, version: store.version + 1, updatedAt: at };
  return { ok: true, value: next, candidate: made.candidate, deduped: false };
}

/**
 * 推进候选状态。**每一步都需要证据**（fail-closed）。
 * PROMOTED 需走 promoteCandidate（额外要求人工批准）。
 */
export function advanceCandidate(store, id, toState, opts = {}) {
  if (!isPlainObject(store) || !Array.isArray(store.candidates)) {
    return { ok: false, error: 'invalid_store' };
  }
  const cand = store.candidates.find((c) => c.id === id);
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (!CANDIDATE_STATES.includes(toState)) return { ok: false, error: 'invalid_state' };
  const allowed = CANDIDATE_TRANSITIONS[cand.state] || [];
  if (!allowed.includes(toState)) {
    return { ok: false, error: `illegal_transition:${cand.state}->${toState}` };
  }
  // PROMOTED 必须走 promoteCandidate（那里强制人工批准）
  if (toState === 'PROMOTED') return { ok: false, error: 'use_promote_candidate' };

  const at = Number.isSafeInteger(opts.at) ? opts.at : 0;
  const evidence = cleanStr(opts.evidence, MAX_EVIDENCE_LEN);
  if (EVIDENCE_REQUIRED_STATES.includes(toState) && !evidence) {
    return { ok: false, error: 'stage_requires_evidence' };
  }
  if (evidence && containsSecret(evidence)) {
    return { ok: false, error: 'evidence_contains_secret' };
  }

  const updated = {
    ...cand,
    state: toState,
    updatedAt: at,
    stageEvidence: { ...cand.stageEvidence, [toState]: redactSecrets(evidence) },
  };
  const checked = sanitizeCandidate(updated);
  if (checked.error) return { ok: false, error: checked.error };

  let next = withCandidate(store, checked.value);
  next = withTelemetry(next, 'CANDIDATE_STAGE', {
    experienceId: cand.id,
    detail: `${cand.state}->${toState} via ${STAGE_DELEGATION[toState]?.system || '(n/a)'}`,
    reason: evidence ? 'evidence_provided' : 'no_evidence_required',
  }, at);
  next = { ...next, version: store.version + 1, updatedAt: at };
  return { ok: true, value: next, candidate: checked.value };
}

/**
 * 拒绝候选：**保留最小失败记录**（合同 §八），不长期挂载 Runtime。
 * 最小记录只含 {candidateId, kind, reason, at} —— 不含候选正文，不挂载任何运行时。
 */
export function rejectCandidate(store, id, opts = {}) {
  if (!isPlainObject(store) || !Array.isArray(store.candidates)) {
    return { ok: false, error: 'invalid_store' };
  }
  const cand = store.candidates.find((c) => c.id === id);
  if (!cand) return { ok: false, error: 'candidate_not_found' };
  if (!(CANDIDATE_TRANSITIONS[cand.state] || []).includes('REJECTED')) {
    return { ok: false, error: `illegal_transition:${cand.state}->REJECTED` };
  }
  const at = Number.isSafeInteger(opts.at) ? opts.at : 0;
  const reason = redactSecrets(cleanStr(opts.reason, MAX_REASON_LEN)) || 'unspecified';

  const updated = { ...cand, state: 'REJECTED', updatedAt: at };
  const checked = sanitizeCandidate(updated);
  if (checked.error) return { ok: false, error: checked.error };

  let next = withCandidate(store, checked.value);
  // 最小失败记录（有界环形，只留最小信息）
  const minimal = [...store.minimalFailures, { candidateId: cand.id, kind: cand.kind, reason, at }]
    .slice(-MAX_MINIMAL_FAILURES);
  next = { ...next, minimalFailures: minimal };
  next = withTelemetry(next, 'CANDIDATE_REJECTED', {
    experienceId: cand.id,
    detail: `kind=${cand.kind} reason=${reason}`,
    reason,
  }, at);
  next = { ...next, version: store.version + 1, updatedAt: at };
  return { ok: true, value: next, candidate: checked.value };
}

/**
 * 晋升候选 —— **绝不自动调用**。
 *
 * 合同 §八 + AC7 要求：必须走完全部阶段（isolated tests → regression/holdout →
 * canary 全部 PASS），**且**有显式人工批准（HUMAN APPROVAL != VERIFICATION：
 * 人工批准是**必要条件**，不是验证的替代品——阶段证据才是验证）。
 */
export function promoteCandidate(store, id, opts = {}) {
  if (!isPlainObject(store) || !Array.isArray(store.candidates)) {
    return { ok: false, error: 'invalid_store' };
  }
  const cand = store.candidates.find((c) => c.id === id);
  if (!cand) return { ok: false, error: 'candidate_not_found' };

  // ① 必须已到 CANARY（说明前面阶段全过）
  if (cand.state !== 'CANARY') {
    return { ok: false, error: `not_ready:${cand.state}`, required: 'CANARY' };
  }
  // ② 三个阶段证据必须齐备（deterministic verifier 证据，非模型自述）
  const missing = ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY']
    .filter((s) => !cand.stageEvidence || !cand.stageEvidence[s]);
  if (missing.length > 0) {
    return { ok: false, error: 'missing_stage_evidence', missing };
  }
  // ③ 显式人工批准（且批准本身必须有依据）
  const by = cleanStr(opts.approvedBy, 200);
  const approvalEvidence = cleanStr(opts.approvalEvidence, MAX_EVIDENCE_LEN);
  if (!by || !approvalEvidence) {
    return { ok: false, error: 'promotion_requires_human_approval' };
  }
  if (containsSecret(approvalEvidence)) {
    return { ok: false, error: 'approval_evidence_contains_secret' };
  }
  const at = Number.isSafeInteger(opts.at) ? opts.at : 0;

  // ④ AC6 收据门（**必备**，fail-closed）：晋升必须真走既有 Git / CI / Transaction。
  //    A10 的 AC6 缺口正因缺这一条：阶段证据只是字符串，谁都能自证"跑过了"。
  //    现在必须交出**既有系统自己产出、且三腿互相一致**的收据，否则状态不变、Stable 不变。
  //    拒绝也写遥测（CANDIDATE_PROMOTION_DENIED）——不留静默死路径，且调用方拿得到新 store。
  const gate = verifyPromotionReceipts(cand, opts.receipts);
  if (!gate.ok) {
    let denied = withTelemetry(store, 'CANDIDATE_PROMOTION_DENIED', {
      experienceId: cand.id,
      detail: `error=${gate.error}${gate.leg ? ` leg=${gate.leg}` : ''}${gate.detail ? ` detail=${gate.detail}` : ''}`
        + `${gate.missing ? ` missing=${gate.missing.join(',')}` : ''}`,
      reason: 'promotion_requires_real_git_ci_transaction_receipts',
    }, at);
    denied = { ...denied, version: store.version + 1, updatedAt: at };
    return {
      ok: false,
      error: gate.error,
      leg: gate.leg,
      missing: gate.missing,
      detail: gate.detail,
      // 状态**未变**（candidate 仍在原状态），但拒绝事实已入遥测权威 ⇒ 可审计
      value: denied,
      candidate: cand,
    };
  }

  const updated = {
    ...cand,
    state: 'PROMOTED',
    updatedAt: at,
    approval: { by, evidence: redactSecrets(approvalEvidence), at },
    promotionEvidence: redactSecrets(cleanStr(opts.evidence, MAX_EVIDENCE_LEN)),
    promotionReceipts: gate.summary,     // AC6：只存**有界脱敏摘要**，绝不存收据原文
  };
  const checked = sanitizeCandidate(updated);
  if (checked.error) return { ok: false, error: checked.error };

  let next = withCandidate(store, checked.value);
  next = withTelemetry(next, 'CANDIDATE_RECEIPTS_ACCEPTED', {
    experienceId: cand.id,
    detail: `git=${gate.summary.git.branch}@${gate.summary.git.commitSha.slice(0, 12)} `
      + `ci=${gate.summary.ci.system} transaction=${gate.summary.transaction.finalState}`,
    reason: 'receipts_from_existing_git_ci_transaction_consistent',
  }, at);
  next = withTelemetry(next, 'CANDIDATE_PROMOTED', {
    experienceId: cand.id,
    detail: `kind=${cand.kind} approvedBy=${by} receipts=git+ci+transaction`,
    reason: 'all_stages_passed_and_human_approved',
  }, at);
  next = { ...next, version: store.version + 2, updatedAt: at };
  return { ok: true, value: next, candidate: checked.value, receipts: gate.summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. AC7：Stable 覆盖守卫
// ─────────────────────────────────────────────────────────────────────────────

/** 判定某目标是否为 Stable（前缀/包含式，防路径变体绕过）。 */
export function isStableTarget(target) {
  const t = typeof target === 'string' ? target.trim().toLowerCase() : '';
  if (!t) return false;
  return STABLE_MARKERS.some((m) => t.includes(m));
}

/**
 * AC7 守卫：**Candidate 无法直接覆盖 Stable**。
 *
 * 语义分层：
 *   - 非 Stable 目标 → 放行（本守卫只管 Stable）。
 *   - Stable 目标 + `mode:'direct'` → **一律拒绝**。这是 AC7 的核心：
 *     候选永远不能直接写 Stable，无论它走到哪一步、有没有人批准。
 *   - Stable 目标 + 非 direct（即走正规晋升通道）→ 需**全部阶段证据齐备** +
 *     **显式人工批准**，缺一即拒。
 *
 * @param {string} target - 目标路径/标识
 * @param {object} opts - { candidate, mode:'direct'|'promotion', approvedBy, approvalEvidence }
 * @returns {{allowed:boolean, reason:string}}
 */
export function stableOverwriteGuard(target, opts = {}) {
  if (!isStableTarget(target)) return { allowed: true, reason: 'not_a_stable_target' };

  const mode = opts.mode === 'direct' ? 'direct' : 'promotion';
  if (mode === 'direct') {
    return { allowed: false, reason: 'ac7_direct_stable_overwrite_forbidden' };
  }

  const cand = isPlainObject(opts.candidate) ? opts.candidate : null;
  if (!cand) return { allowed: false, reason: 'no_candidate' };
  if (cand.state !== 'CANARY' && cand.state !== 'PROMOTED') {
    return { allowed: false, reason: `candidate_not_pipeline_complete:${cand.state}` };
  }
  const missing = ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY']
    .filter((s) => !cand.stageEvidence || !cand.stageEvidence[s]);
  if (missing.length > 0) {
    return { allowed: false, reason: `missing_stage_evidence:${missing.join(',')}` };
  }
  const by = cleanStr(opts.approvedBy, 200);
  const ev = cleanStr(opts.approvalEvidence, MAX_EVIDENCE_LEN);
  if (!by || !ev) return { allowed: false, reason: 'missing_human_approval' };
  return { allowed: true, reason: 'pipeline_complete_with_human_approval' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. AC6：委托计划（本模块不执行，只声明该由哪个既有系统执行）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成候选的**执行委托计划**。本模块自身不执行任何一步。
 * @returns {{ok:boolean, error?:string, plan?:object}}
 */
export function delegationPlan(candidate) {
  if (!isPlainObject(candidate)) return { ok: false, error: 'invalid_candidate' };
  const order = ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY', 'PROMOTED'];
  const idx = order.indexOf(candidate.state);
  return {
    ok: true,
    plan: {
      candidateId: candidate.id,
      kind: candidate.kind,
      currentState: candidate.state,
      // 已完成的阶段（有证据的）
      completed: order.filter((s) => candidate.stageEvidence && candidate.stageEvidence[s]),
      // 待执行的阶段 → 各自的既有系统
      remaining: order.slice(idx < 0 ? 0 : idx).map((s) => ({
        stage: s,
        file: STAGE_DELEGATION[s].file,
        system: STAGE_DELEGATION[s].system,
        entry: STAGE_DELEGATION[s].entry,
        note: STAGE_DELEGATION[s].note,
      })),
      // 显式声明：本模块不建第二套
      buildsSecondSystem: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 只读摘要（运维可观察，AC8）
// ─────────────────────────────────────────────────────────────────────────────

export function candidateSummary(store) {
  const byState = {};
  for (const s of CANDIDATE_STATES) byState[s] = 0;
  const byKind = {};
  for (const k of CANDIDATE_KINDS) byKind[k] = 0;
  let exhausted = 0;
  for (const c of (store.candidates || [])) {
    if (byState[c.state] === undefined) byState[c.state] = 0;
    byState[c.state] += 1;
    if (byKind[c.kind] === undefined) byKind[c.kind] = 0;
    byKind[c.kind] += 1;
    if (c.exhausted) exhausted += 1;
  }
  const counts = {};
  for (const t of (store.telemetry || [])) {
    counts[t.kind] = (counts[t.kind] || 0) + 1;
  }
  return {
    candidates: (store.candidates || []).length,
    byState,
    byKind,
    researchExhausted: exhausted,
    minimalFailures: (store.minimalFailures || []).length,
    telemetryTotal: (store.telemetry || []).length,
    telemetryCounts: counts,
    daemon: false,          // AC8：恒为 false，本模块无常驻进程
    secondSystem: false,    // AC6：恒为 false，全部阶段委托既有系统
  };
}
