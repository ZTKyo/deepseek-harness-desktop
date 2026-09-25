// test-learn-core.mjs —— P4 LEARN R1 纯逻辑单测（repo 直连，无外部依赖）
//
// 覆盖 learn-core.mjs：
//   C1  emptyStore 默认形状 + schema 版本
//   C2  密钥脱敏：9 个规范家族全覆盖 + 通用形态 + 确定性（AC3）
//   C3  makeExperience 校验（缺 title/body/sourceSeqs 一律拒绝）
//   C4  propose：永远 PROPOSED（提案 ≠ 激活）+ 同证据幂等去重（AC2）
//   C5  approve：授权**只能**来自宿主人类批准事实（session 日志 approval/asked+decided）；
//       自述 approver/evidence 不再具有授权力（F1）；内容绑定 + 离线篡改结构性判废（AC2）
//   C6  状态迁移白名单：REJECTED/RETIRED 为终态，不得复活（fail-closed）
//   C7  recall：只召回 APPROVED + 确定性（同一输入同一输出）+ 回源锚点（AC4）
//   C8  validateStore：损坏/越界/坏条目 → null（fail-closed，AC5）
//   C9  promotionEligibility：资格判定不改变状态；promote 需显式证据（AC11）
//   C10 assertWriteAllowed：runtime/goals/credentials/policy 一律拒绝（AC10）
//   C11 telemetryEvent：结构化 + 脱敏 + 有界环形缓冲（AC8）
//   C12 buildLearnDigest：复用 P2.5 官方提取器；跳过插件注入消息（AC1）
//   C13 learningSignals：确定性启发式信号
//   C15 R2 对抗评审回归：锁死 5 个已实证缺陷（CJK 词边界失效 / 首个命中导致语义反转 /
//       失败-解决无配对 / harness 注入块被当学习信号 / 输入 nodeSeqs 未规范化）
//   C16 R2 STAGE 8b 覆盖缺口闭合：Layer B 跨会话全局已验证经验库（canPublish /
//       isPublishable / publishToGlobal / validateGlobalStore / publishSignature / globalRecall）。
//       来源：第二轮突变测试证明「层破除」突变（canPublish 整层放行、validateGlobalStore 直接
//       放行坏库与未验证条目）**不被任何既有套件捕获** ⇒ 该层此前无测试证据。本节逐条补齐。
//
// 注意：本文件刻意不出现任何"密钥形状"的字面量 —— 所有假密钥一律用字符串拼接
// 在运行时构造，保证仓库规范扫描器（tests/reliability/secret-scan-check.mjs）零命中。

import {
  LEARN_SCHEMA_VERSION,
  MAX_EXPERIENCES,
  MAX_TELEMETRY,
  EXPERIENCE_STATES,
  TELEMETRY_KINDS,
  PROTECTED_TARGETS,
  SECRET_PATTERNS,
  redactSecrets,
  containsSecret,
  secretFamiliesIn,
  emptyStore,
  validateStore,
  makeExperience,
  sanitizeExperience,
  propose,
  approve,
  reject,
  retire,
  canTransition,
  recall,
  recordRecall,
  isRecallable,
  tokenize,
  promotionEligibility,
  promote,
  assertWriteAllowed,
  telemetryEvent,
  appendTelemetry,
  telemetrySummary,
  buildLearnDigest,
  learningSignals,
  stableHash,
  normalizeTags,
  normalizeSourceSeqs,
  stripInjectedContent,
  SIGNAL_PATTERNS,
  P25_EXTRACTORS,
  // R2 STAGE 8b 突变测试挖出的覆盖缺口：Layer B（跨会话全局已验证经验库）此前**零覆盖**，
  // 下列符号在全部 tests/learn 套件中出现次数为 0 → 防线存在但无人证明它会开火。
  GLOBAL_STORE_KIND,
  GLOBAL_STORE_SCHEMA_VERSION,
  MAX_GLOBAL_EXPERIENCES,
  MAX_EXPERIENCE_JSON_BYTES,
  VERIFICATION_METHODS,
  emptyGlobalStore,
  isPublishable,
  canPublish,
  validateGlobalStore,
  publishSignature,
  publishToGlobal,
  globalRecall,
  applyVerification,
  normEvidence,
  // ── F1（P4 R2 外部评审）：授权来源 = 宿主人类批准事实，不再接受自述 ──
  approvalProvenance,
  validHumanApproval,
  hostApprovalRecord,
  candidateDigest,
  validateApprovalEvidence,
  HUMAN_APPROVAL_ACTOR,
  HUMAN_APPROVAL_SCHEMA,
  HUMAN_APPROVAL_CHANNEL,
  HUMAN_APPROVAL_GRANT,
  // ── F1 R1（外部评审第二轮）：授权载体 = **持久审批台账**（不再是进程内密钥）──
  HUMAN_APPROVAL_LEDGER_SCHEMA,
  createMemoryApprovalLedger,
  attachApprovalLedger,
  detachApprovalLedger,
  makeApprovalRecord,
  verifyApprovalLedgerChain,
  parseApprovalLedgerText,
  serializeApprovalRecord,
  approvalAuthorityFromLedger,
} from "../../plugins/learn-core.mjs";
// F1：宿主批准"事实"夹具（真宿主服务在 test-learn-r2-f1-*.mjs；此处只造日志事件对，
// 用于验证核心的**判定逻辑**：缺事件对/未决/未授予/工具名不符/摘要不符 …）。
import { mkTurnSession, appendHostApprovalFact, getHostSession } from "./_real-session-harness.mjs";

// ★ F1 R1：本套件使用**纯内存台账**（核心层不做文件 IO；文件台账在插件壳与插件级测试里验证）。
//   挂载为模块默认台账 ⇒ `approve()` 不传 ledger 时也走同一本台账（与生产同构）。
const LEDGER = createMemoryApprovalLedger({ getSession: getHostSession, id: "core-test-ledger" });
attachApprovalLedger(LEDGER);
/** "另一台机器/另一本台账"：内容一样，但**没有**这条批准记录 ⇒ 授权必须失效（fail-closed）。 */
const FOREIGN_LEDGER = createMemoryApprovalLedger({ getSession: getHostSession, id: "core-test-foreign-ledger" });

let __apprRefSeq = 0;
/**
 * F1 唯一夹具：让 approve() 拿到"宿主日志事实"。
 * 每个用例一个新 ref（宿主真实实现里 ref 是随机 UUID，绝不复用）——
 * 复用会让"同一 ref 被消费两次"这种真实风险在测试里隐身。
 */
function hostApprove(store, id, opts = {}) {
  const session = opts.session ?? mkTurnSession("s-" + String(id).slice(0, 12));
  const ref = opts.ref ?? `appr-${String(++__apprRefSeq).padStart(6, "0")}`;
  if (!opts.skipFact) {
    // 真实链路：发起方把**被批准内容的摘要**写进请求 reason，宿主原样落进 approval/asked。
    // 夹具照做——否则测的就不是"人类批了这份内容"，而是一个没有对象的空批准。
    const target = Array.isArray(store?.experiences) ? store.experiences.find((e) => e.id === id) : null;
    const digest = opts.digest ?? (target ? candidateDigest(target) : undefined);
    appendHostApprovalFact(session, { ref, digest, ...(opts.fact ?? {}) });
  }
  return approve(store, id, {
    evidence: opts.evidence ?? "manual review note",
    at: opts.at ?? Date.now(),
    session,
    approvalRef: ref,
    ledger: opts.ledger ?? LEDGER,
  });
}
// AC1 直证：P2.5 官方提取器本体（P4 必须复用同一实现，不得另起 parser）
import {
  messageOfEvent as p25MessageOfEvent,
  recursiveText as p25RecursiveText,
  isPluginSourced as p25IsPluginSourced,
} from "../../plugins/context-memory-core.mjs";
// R2 AC5 直证：失败分类的唯一 Authority 是 P2.6（本测试用它交叉验证关键词路径已失去该权威）
import { evaluateGapVeto } from "../../plugins/learn-gap-veto.mjs";

let pass = 0, fail = 0;
function assert(c, n, d = "") { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + " " + d); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// 假密钥一律运行时拼接（仓库内不落任何密钥形状字面量）
const FAKES = {
  notion: "ntn_" + "A1b2C3d4E5f6G7h8I9j0",
  openai: "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2",
  openrouter: "sk-or-v1-" + "a1B2c3D4e5F6g7H8i9J0",
  anthropic: "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0",
  slack: "xoxb-" + "123456789012-abcdefghijklmn",
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6",
  jwt: "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6" + "." + "eyJzdWIiOiIxMjM0NTY3ODkw" + "." + "SflKxwRJSMeKKF2QT4fwpM",
  telegram: "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
};

section("C1: emptyStore default shape");
{
  const s = emptyStore("sess-1");
  // P4 R2 CONTRACT COMPLETION：schema 由 1 升为 2 —— 新增合同【Experience Store】字段清单
  // （taskType/trigger/symptoms/applicableVersions/.../lastVerifiedAt）+ 独立 verification 记录。
  // 版本 pin 随实现更新；**旧 v1 库不自动升级**（migrateStoreV1：一律 UNVERIFIED，绝不继承"已验证"）。
  assert(LEARN_SCHEMA_VERSION === 2, "schema version is 2", `got ${LEARN_SCHEMA_VERSION}`);
  assert(s.sessionId === "sess-1", "sessionId set");
  assert(s.version === 0, "version starts at 0");
  assert(Array.isArray(s.experiences) && s.experiences.length === 0, "experiences empty array");
  assert(Array.isArray(s.telemetry) && s.telemetry.length === 0, "telemetry empty array");
  assert(emptyStore().sessionId === "unknown", "missing sessionId -> unknown");
}

section("C2: secret redaction covers all canonical families (AC3)");
{
  for (const [family, fake] of Object.entries(FAKES)) {
    const r = redactSecrets(`here is a value ${fake} inside text`);
    assert(!r.includes(fake), `${family}: raw value removed`, r.slice(0, 80));
    assert(r.includes(`[REDACTED:${family}]`) || r.includes("[REDACTED:"), `${family}: redaction token present`, r.slice(0, 80));
    assert(containsSecret(fake) === true, `${family}: containsSecret detects it`);
    assert(secretFamiliesIn(fake).includes(family), `${family}: family reported`, JSON.stringify(secretFamiliesIn(fake)));
  }
  // 通用形态
  const g1 = redactSecrets("api_key = " + "abcdef1234567890xyz");
  assert(!g1.includes("abcdef1234567890xyz"), "generic assignment redacted", g1);
  const g2 = redactSecrets("Authorization: Bearer " + "abcdef1234567890XYZ");
  assert(!g2.includes("abcdef1234567890XYZ"), "generic bearer redacted", g2);
  // 确定性 + 幂等
  const a1 = redactSecrets(`x ${FAKES.github} y`);
  const a2 = redactSecrets(`x ${FAKES.github} y`);
  assert(a1 === a2, "redaction is deterministic");
  assert(redactSecrets(a1) === a1, "redaction is idempotent (no double-token)");
  // 干净文本不受影响
  assert(redactSecrets("normal text with no secrets") === "normal text with no secrets", "clean text untouched");
  assert(containsSecret("normal text") === false, "containsSecret false on clean text");
  // 正则无跨调用状态污染（/g 复用陷阱）
  for (let i = 0; i < 3; i++) {
    assert(redactSecrets(FAKES.aws).includes("[REDACTED:aws]"), `aws redacted on repeat call #${i + 1}`);
  }
  assert(SECRET_PATTERNS.length >= 11, "pattern table includes 9 canonical families + generics", `got ${SECRET_PATTERNS.length}`);
}

section("C3: makeExperience validation");
{
  const base = { title: "t", body: "b", sourceEventSeqs: [1, 2], originSessionId: "s" };
  assert(makeExperience(base).ok === true, "valid draft accepted");
  assert(makeExperience({ ...base, title: "" }).error === "missing_title", "empty title rejected");
  assert(makeExperience({ ...base, body: "" }).error === "missing_body", "empty body rejected");
  assert(makeExperience({ ...base, sourceEventSeqs: [] }).error === "missing_source_seqs", "no provenance rejected");
  assert(makeExperience(null).error === "invalid_draft", "null draft rejected");
  const e = makeExperience(base).value;
  assert(e.state === "PROPOSED", "born PROPOSED");
  assert(e.approvedBy === null && e.approvedAt === null, "no approval trace at birth");
  assert(e.promotion === "NONE", "promotion NONE at birth");
  assert(Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length === 2, "provenance preserved");
  // 稳定 id：同一证据 → 同一 id
  assert(makeExperience(base).value.id === e.id, "stable id for identical evidence");
  assert(makeExperience({ ...base, title: "other" }).value.id !== e.id, "different title -> different id");
  // 规范化
  assert(JSON.stringify(normalizeSourceSeqs([3, 1, 3, -1, "x"])) === "[1,3]", "source seqs deduped/sorted/non-negative");
  assert(JSON.stringify(normalizeTags(["B", "a", "b", " a "])) === '["a","b"]', "tags normalized + sorted");
}

section("C4: propose is never activation (AC2)");
{
  let store = emptyStore("s1");
  const r1 = propose(store, { title: "Use pnpm not npm", body: "install failed with npm", sourceEventSeqs: [5], originSessionId: "s1", tags: ["build"] });
  assert(r1.ok === true, "propose ok");
  assert(r1.value.experiences[0].state === "PROPOSED", "stored as PROPOSED");
  assert(r1.deduped === false, "first propose not deduped");
  const r2 = propose(r1.value, { title: "Use pnpm not npm", body: "install failed with npm", sourceEventSeqs: [5], originSessionId: "s1", tags: ["build"] });
  assert(r2.deduped === true, "same evidence -> deduped");
  assert(r2.value.experiences.length === 1, "no duplicate row");
  const bad = propose(store, { title: "", body: "x", sourceEventSeqs: [1] });
  assert(bad.ok === false && bad.error === "missing_title", "invalid draft rejected at propose");
  // 提案永远不能被召回
  assert(isRecallable(r1.value.experiences[0]) === false, "PROPOSED is not recallable");
}

section("C5: 授权边界 = 宿主人类批准事实（F1，AC2）");
{
  let store = emptyStore("s1");
  store = propose(store, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id = store.experiences[0].id;

  // ── 负向：任何"自述"都不构成授权（F1 的核心命题）──────────────────────────
  // 旧实现只要求调用方填 approver+evidence ⇒ "人类批准"是**自述**。现在必须证明
  // 宿主日志里真的存在这次批准；自述字段降级为纯备注。
  const selfDeclared = approve(store, id, { approver: "human", evidence: "verified by test run" });
  assert(selfDeclared.ok === false && selfDeclared.error === "approval_not_host_proven:no_session_log",
    "自述审批（无宿主事实）被拒", selfDeclared.error);
  const bogusRef = approve(store, id, { evidence: "e", session: mkTurnSession("s1"), approvalRef: "appr-does-not-exist" });
  assert(bogusRef.ok === false && bogusRef.error === "approval_not_host_proven:approval_ref_not_in_host_log",
    "不存在的 approvalRef 被拒", bogusRef.error);
  const noEvidence = approve(store, id, { approver: "human" });
  assert(noEvidence.ok === false && noEvidence.error === "approval_requires_evidence", "approval without evidence rejected");
  const secretEvidence = approve(store, id, { approver: "human", evidence: `proof ${FAKES.github}` });
  assert(secretEvidence.ok === false && secretEvidence.error === "approval_evidence_contains_secret", "secret in evidence rejected");
  const missing = approve(store, id + "nope", { approver: "human", evidence: "e" });
  assert(missing.ok === false && missing.error === "experience_not_found", "unknown id rejected");

  // ── 负向：宿主日志残缺/不符的四种形态，逐一判废 ──────────────────────────
  const onlyAsked = mkTurnSession("s1");          // 只有 asked，没有 decided（未决）
  onlyAsked.append("approval/asked", { id: "appr-onlyasked", toolName: "learn_review" });
  const r1 = approve(store, id, { evidence: "e", session: onlyAsked, approvalRef: "appr-onlyasked" });
  assert(r1.ok === false && r1.error === "approval_not_host_proven:approval_undecided",
    "未决（缺 approval/decided）被拒", r1.error);
  const wrongTool = mkTurnSession("s1");
  appendHostApprovalFact(wrongTool, { ref: "appr-wrongtool", toolName: "pwsh", digest: candidateDigest(store.experiences[0]) });
  const r2 = approve(store, id, { evidence: "e", session: wrongTool, approvalRef: "appr-wrongtool" });
  assert(r2.ok === false && r2.error === "approval_not_host_proven:approval_ref_tool_mismatch",
    "非本工具发起的批准被拒", r2.error);
  const rejected = mkTurnSession("s1");
  appendHostApprovalFact(rejected, { ref: "appr-rejected", outcome: "rejected" });
  const r3 = approve(store, id, { evidence: "e", session: rejected, approvalRef: "appr-rejected" });
  assert(r3.ok === false && r3.error === "approval_not_host_proven:approval_not_granted:rejected",
    "人类拒绝 ⇒ 绝不放行", r3.error);
  const badRef = mkTurnSession("s1");
  const r4 = approve(store, id, { evidence: "e", session: badRef, approvalRef: "short" });
  assert(r4.ok === false && r4.error === "approval_not_host_proven:invalid_approval_ref",
    "畸形 ref 被拒（结构闸门）", r4.error);

  // ── 正向：宿主事实齐全 ⇒ APPROVED，且 approvedBy 是**固定宿主标签** ────────
  const ok = hostApprove(store, id, { evidence: "ran suite: 12 PASS", at: 1000 });
  assert(ok.ok === true, "宿主事实齐全 ⇒ 批准成立", ok.error ?? "");
  const exp = ok.value.experiences[0];
  assert(exp.state === "APPROVED", "state APPROVED");
  assert(exp.approvedAt === 1000, "approvedAt recorded");
  assert(exp.approvedBy === HUMAN_APPROVAL_ACTOR, "approvedBy = 固定宿主标签（不接受调用方自由文本）", exp.approvedBy);
  assert(exp.approvalEvidence === "ran suite: 12 PASS", "evidence 仅作人类可读备注保存");
  assert(exp.approval.schema === HUMAN_APPROVAL_SCHEMA && exp.approval.channel === HUMAN_APPROVAL_CHANNEL,
    "attestation 记录 schema/channel");
  assert(exp.approval.outcome === HUMAN_APPROVAL_GRANT && exp.approval.candidateId === exp.id,
    "attestation 绑定被批准对象");
  assert(exp.approval.candidateDigest === candidateDigest(exp), "attestation 绑定内容摘要");
  assert(validHumanApproval(exp).ok === true && approvalProvenance(exp).ok === true, "live authority 通过");
  assert(isRecallable(exp) === true, "APPROVED（宿主事实）可召回");
  assert(store.experiences[0].state === "PROPOSED", "original store not mutated (immutable update)");

  // ── 攻击面 A：审批后被改写内容 ⇒ 授权失效（不能"批一个、发另一个"）─────────
  const tampered = { ...exp, body: "B-mutated-after-approval" };
  assert(candidateDigest(tampered) !== exp.approval.candidateDigest, "改写后摘要变化（绑定生效）");
  assert(validHumanApproval(tampered).reason === "approval_content_changed",
    "改写内容 ⇒ live authority 失效", validHumanApproval(tampered).reason);
  assert(isRecallable(tampered) === false, "改写后的经验不可召回");
  assert(sanitizeExperience(tampered).error === "approved_without_host_attestation:approval_content_changed",
    "改写后的经验在载入/校验边界判废", sanitizeExperience(tampered).error);

  // ── 攻击面 B：离线手写/篡改 attestation（不经 approve() 铸造）⇒ fail-closed ──
  //  F1 R1：授权载体是**持久台账里的记录**，所以"手写攻击"= 自己编一本台账 + 自己编 attestation。
  //  攻击者能算出链式摘要（算法是公开的），但编不出"与对象/内容/来源/消费标记逐字段自洽"的记录。
  {
    // ① attestation 里的台账记录 id 在台账中不存在（手写者最常见的形态）
    const ghost = { ...exp, approval: { ...exp.approval, ledgerRecordId: "hap-" + "a".repeat(16) } };
    assert(approvalProvenance(ghost).ok === true,
      "手写的记录 id 结构上合法（所以必须由台账判定兜住，结构校验不够）");
    assert(validHumanApproval(ghost).reason === "approval_ledger_record_unknown",
      "★ 指向不存在的台账记录 ⇒ 不构成授权", validHumanApproval(ghost).reason);

    // ② 自编账本：链式自洽，但记录绑的是**别的候选对象** ⇒ 逐字段对账必须拒
    const forge = createMemoryApprovalLedger({ getSession: getHostSession, id: "forged" });
    const g1 = forge.append({
      type: "grant", schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: "someone-elses-id",
      digest: exp.approval.candidateDigest, approvedAt: exp.approval.approvedAt,
      trustedSource: HUMAN_APPROVAL_CHANNEL, hostActor: HUMAN_APPROVAL_ACTOR,
      approvalRef: exp.approval.ref, hostSessionId: "s1",
    });
    forge.append({
      type: "consume", recordId: g1.record.recordId, candidateId: "someone-elses-id",
      digest: exp.approval.candidateDigest, consumedAt: exp.approval.approvedAt,
    });
    const stolen = { ...exp, approval: { ...exp.approval, ledgerRecordId: g1.record.recordId } };
    assert(verifyApprovalLedgerChain(forge.records()).ok === true,
      "自编账本的链是自洽的（链不防追加式伪造 ⇒ 必须靠逐字段对账）");
    assert(validHumanApproval(stolen, forge).reason === "approval_ledger_candidate_mismatch",
      "★ 记录绑的是别的对象 ⇒ 判废", validHumanApproval(stolen, forge).reason);

    // ③ 台账里只有 grant、没有 consume ⇒ 未被消费的批准不构成授权
    const unconsumed = createMemoryApprovalLedger({ getSession: getHostSession, id: "forged-unconsumed" });
    const g2 = unconsumed.append({
      type: "grant", schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: exp.id,
      digest: exp.approval.candidateDigest, approvedAt: exp.approval.approvedAt,
      trustedSource: HUMAN_APPROVAL_CHANNEL, hostActor: HUMAN_APPROVAL_ACTOR,
      approvalRef: exp.approval.ref, hostSessionId: "s1",
    });
    const un = { ...exp, approval: { ...exp.approval, ledgerRecordId: g2.record.recordId } };
    assert(validHumanApproval(un, unconsumed).reason === "approval_ledger_grant_not_consumed",
      "★ 只有 grant 没有 consume ⇒ 不构成授权", validHumanApproval(un, unconsumed).reason);

    // ④ 撤销 / 取代：合法批准也能被显式作废
    const revokedL = createMemoryApprovalLedger({ getSession: getHostSession, id: "forged-revoked" });
    // 复刻一条"内容/会话/ref 都对得上"的 grant：hostSessionId 必须取自**原 grant**
    // （写下它的是宿主批准那一刻的真实会话；F1 R1 起判定点会用宿主日志复核它）。
    const srcGrant = LEDGER.records().find((r) => r?.recordId === exp.approval.ledgerRecordId)?.body ?? null;
    const g3 = revokedL.append({
      type: "grant", schemaVersion: HUMAN_APPROVAL_LEDGER_SCHEMA, candidateId: exp.id,
      digest: exp.approval.candidateDigest, approvedAt: exp.approval.approvedAt,
      trustedSource: HUMAN_APPROVAL_CHANNEL, hostActor: HUMAN_APPROVAL_ACTOR,
      approvalRef: exp.approval.ref, hostSessionId: srcGrant?.hostSessionId ?? null,
    });
    revokedL.append({ type: "consume", recordId: g3.record.recordId, candidateId: exp.id, digest: exp.approval.candidateDigest, consumedAt: exp.approval.approvedAt });
    const okBefore = { ...exp, approval: { ...exp.approval, ledgerRecordId: g3.record.recordId } };
    assert(validHumanApproval(okBefore, revokedL).ok === true, "夹具自检：撤销前该记录确实构成授权");
    revokedL.append({ type: "revoke", recordId: g3.record.recordId, reason: "human revoked", revokedAt: 7000 });
    assert(validHumanApproval(okBefore, revokedL).reason === "approval_ledger_grant_revoked",
      "★ 被撤销的批准立即失效", validHumanApproval(okBefore, revokedL).reason);

    // ⑤ 断链（改写/删除历史记录）⇒ 整本台账不可信（绝不部分信任）
    const broken = forge.records().slice();
    broken[0] = { ...broken[0], chain: "0".repeat(64) };
    assert(verifyApprovalLedgerChain(broken).ok === false, "改写历史记录 ⇒ 链校验必须失败");
    const brokenLedger = createMemoryApprovalLedger({ getSession: getHostSession, id: "broken", records: broken });
    assert(validHumanApproval(stolen, brokenLedger).reason === "approval_ledger_chain_broken",
      "★ 断链台账不构成授权", validHumanApproval(stolen, brokenLedger).reason);
    assert(parseApprovalLedgerText("not json\n").ok === false, "畸形台账文本整本判废（fail-closed）");
    assert(parseApprovalLedgerText("").ok === true && parseApprovalLedgerText("").records.length === 0,
      "缺文件 ⇒ 空台账（不是错误，只是没有授权）");

    // ⑥ 结构性篡改（不依赖台账就能判的那几类）
    const forgedActor = { ...exp, approvedBy: "definitely-a-human-i-promise" };
    assert(approvalProvenance(forgedActor).reason === "approval_actor_field_mismatch",
      "手改 approvedBy ⇒ 判废", approvalProvenance(forgedActor).reason);
    const noAtt = { ...exp, approval: null };
    assert(approvalProvenance(noAtt).reason === "approval_missing_host_attestation",
      "无 attestation 的 APPROVED（历史自述记录）⇒ 结构性判废", approvalProvenance(noAtt).reason);
    assert(sanitizeExperience(noAtt).error === "approved_without_host_attestation:approval_missing_host_attestation",
      "历史自述审批记录在载入边界被判废");
    const foreignAtt = { ...exp, approval: { ...exp.approval, candidateId: "someone-elses-id" } };
    assert(approvalProvenance(foreignAtt).reason === "approval_candidate_mismatch",
      "attestation 换成别的对象 ⇒ 判废", approvalProvenance(foreignAtt).reason);
  }

  // ── 对象绑定的**边界**：只有"人类审批时看到的内容"参与绑定 ─────────────────
  // 回归护栏（钉死一个真实踩过的坑）：attestation 曾把 lastVerifiedAt / verificationEvidence
  // 也纳入摘要，于是**机器重新验证**（applyVerification 必然改写这两个字段）会反手把人类
  // 授权判废 ⇒ APPROVED 经验一被重新验证就掉授权，等于把 BLOCKER-1"审批不粘"换个入口复发。
  // 这里用官方链路正面证明：重新验证后 APPROVED 仍在、授权仍有效。
  {
    const SHA_CORE = "b".repeat(64);
    const evidenceForCore = { class: "file_hash", path: "C:/p4r2/plugin/learn-core.mjs", sha256: SHA_CORE };
    const resolversForCore = { fileHash: () => SHA_CORE };
    const rev = applyVerification({ ...store, experiences: [exp] }, exp.id, evidenceForCore, resolversForCore, 5000);
    assert(rev.ok === true, "F1 边界夹具：重新验证通过", JSON.stringify(rev.error ?? ""));
    const re = rev.experience;
    assert(re.state === "APPROVED", "★ 重新验证后仍是 APPROVED（B1：授权不被机器验证撤销）");
    assert(re.lastVerifiedAt === 5000 && re.lastVerifiedAt !== exp.lastVerifiedAt,
      "夹具确实改写了 lastVerifiedAt（否则本回归断言是空的）");
    assert(exp.approval.candidateDigest === candidateDigest(exp) && candidateDigest(re) === candidateDigest(exp),
      "★ lastVerifiedAt/verificationEvidence 不参与对象绑定（摘要不变）");
    assert(validHumanApproval(re).ok === true, "★ 重新验证后 live authority 仍成立（授权粘性）");
    const recalled = recordRecall({ ...store, experiences: [re] }, [re.id], 6000).experiences[0];
    assert(recalled.recallCount === 1, "夹具确实改写了召回计数");
    assert(validHumanApproval(recalled).ok === true, "★ 召回计数写入不影响授权（计数不参与绑定）");
  }

  // ── 攻击面 C：把一条**旧批准**（为别的内容作出的）拿来给新内容背书 ────────────
  // 宿主日志里的 asked 事件带 reason，而真实链路把被批准内容的摘要写进了 reason
  // （learn.mjs: `learn_review: approve experience <id> digest=<64hex>`）。
  // 于是"人类批的是哪份内容"由宿主日志作证 ⇒ 摘不对就是重放，必须拒。
  {
    const replay = mkTurnSession("s1");
    appendHostApprovalFact(replay, { ref: "appr-replay-1", digest: "9".repeat(64) });
    const r = approve(store, id, { evidence: "e", session: replay, approvalRef: "appr-replay-1" });
    assert(r.ok === false && r.error === "approval_not_host_proven:host_log_digest_mismatch",
      "★ 旧批准（摘要对不上）不能给新内容背书", r.error);
    const noBound = mkTurnSession("s1");
    appendHostApprovalFact(noBound, { ref: "appr-unbound-1", reason: "learn_review: approve experience x" });
    const r2 = approve(store, id, { evidence: "e", session: noBound, approvalRef: "appr-unbound-1" });
    assert(r2.ok === false && r2.error === "approval_not_host_proven:approval_reason_not_content_bound",
      "★ 没有内容摘要的宿主事实不能授权（fail-closed）", r2.error);
  }

  // ── 攻击面 D：重复批准（同一份 live 授权上再批一次）⇒ 幂等拒绝 ────────────────
  // 防止"一次批准被反复消费"，也防止把旧事实刷成新 approvedAt。
  {
    const again = hostApprove({ ...store, experiences: [exp] }, exp.id, { evidence: "e", at: 9000 });
    assert(again.ok === false && again.error === "already_human_approved",
      "★ 已有 live 授权 ⇒ 拒绝重复批准（幂等）", again.error);
  }

  // ── 跨进程重启：F1 R1 的核心修复点（§8 A/C）────────────────────────────────
  // 旧实现把授权建立在"进程内 HMAC 签章"上 ⇒ 重启后合法批准一律失效（外部评审判 FAIL）。
  // 现实现把授权建立在**落盘台账**上：
  //   ① 同一本台账重启后重新载入（JSONL 往返）⇒ 授权**必须仍然成立**（A/C 成立）；
  //   ② 台账丢了/换了一本 ⇒ 不构成授权（fail-closed，绝不降级为自述）；
  //   ③ 台账不在手上时，人类重新批准必须**有路可回**（否则经验卡死在死角）。
  const RESTARTED = createMemoryApprovalLedger({ getSession: getHostSession, id: "restarted-process-without-ledger" });
  {
    const stale = { ...exp };
    // ① 台账仍在（= 重启后重新读同一个 JSONL 文件）⇒ 授权必须活着
    const rehydrated = createMemoryApprovalLedger({ getSession: getHostSession, id: "rehydrated-from-disk",
      records: parseApprovalLedgerText(LEDGER.records().map(serializeApprovalRecord).join("")).records,
    });
    assert(rehydrated.records().length === LEDGER.records().length,
      "JSONL 往返后记录数一致（夹具自检）");
    assert(validHumanApproval(stale, rehydrated).ok === true,
      "★ F1 R1 修复点：重启后同一本台账仍能验证授权（不再「重启即失效」）");
    assert(isRecallable(stale, rehydrated) === true, "★ 重启后仍可召回（合法批准不因重启作废）");
    assert(canPublish(stale, rehydrated).reason !== "approval_ledger_record_unknown",
      "★ 重启后发布门不再因「台账找不到记录」被拒", canPublish(stale, rehydrated).reason);

    // ② 台账不在手（换了一本空台账 = 换机/台账丢失）⇒ 授权失效（fail-closed）
    assert(validHumanApproval(stale, RESTARTED).reason === "approval_ledger_record_unknown",
      "★ 拿不到台账 ⇒ 不构成授权", validHumanApproval(stale, RESTARTED).reason);
    assert(approvalProvenance(stale).ok === true,
      "此时结构性绑定仍成立（所以必须靠台账判定兜住，结构校验不够）");
    assert(isRecallable(stale, RESTARTED) === false, "★ 无台账 ⇒ 不可召回（fail-closed）");
    assert(canPublish(stale, RESTARTED).ok === false, "★ 无台账 ⇒ 不可发布到全局库");

    // ③ 内容被改写过的 APPROVED 记录**不允许**借重新批准洗白
    const tampered2 = { ...stale, body: "B-mutated-after-restart" };
    const reBad = hostApprove({ ...store, experiences: [tampered2] }, tampered2.id,
      { evidence: "e", at: 9500, ledger: RESTARTED });
    assert(reBad.ok === false && reBad.error === "approval_not_host_proven:approval_content_changed",
      "★ 内容被改写的记录不能被重新批准（不得洗白）", reBad.error);

    // ④ 正常路径：内容未变 + 一次**新的**宿主人类批准 ⇒ 重新落账，恢复可用
    const reOk = hostApprove({ ...store, experiences: [stale] }, stale.id,
      { evidence: "re-approved after restart", at: 9600, ledger: RESTARTED });
    assert(reOk.ok === true, "★ 台账不在手上时，人类重新批准可恢复授权", reOk.error ?? "");
    const reExp = reOk.value.experiences[0];
    assert(reExp.state === "APPROVED" && reExp.approvedAt === 9600, "重新批准写入新的批准时间");
    assert(reExp.approval.ref !== exp.approval.ref, "★ 重新批准产生**新**的宿主事实引用（不复用旧 ref）");
    assert(reExp.approval.ledgerRecordId !== exp.approval.ledgerRecordId,
      "★ 重新批准落的是**新**的台账记录（旧记录不被复用/覆盖）");
    assert(validHumanApproval(reExp, RESTARTED).ok === true, "★ 重新批准后 live 授权成立");
    assert(isRecallable(reExp, RESTARTED) === true, "★ 重新批准后恢复可召回");
    // 发布门：授权那一关已经打开（剩下的缺项只应是"机器验证"，而不是授权）。
    const pubAfter = canPublish(reExp, RESTARTED);
    assert(!/approval|ledger/.test(String(pubAfter.reason)), "★ 重新批准后发布门不再因授权被拒", pubAfter.reason);
    // 把机器验证补上 ⇒ 完全恢复到"可发布"（证明重启后的恢复通道是端到端可用的，不只是半开）。
    const SHA_RE = "e".repeat(64);
    const revRe = applyVerification({ ...store, experiences: [reExp] }, reExp.id,
      { class: "file_hash", path: "C:/p4r2/plugin/learn-core.mjs", sha256: SHA_RE },
      { fileHash: () => SHA_RE }, 9800);
    assert(revRe.ok === true, "重启后恢复通道：机器验证可施加", revRe.error ?? "");
    assert(canPublish(revRe.experience, RESTARTED).ok === true,
      "★ 重启后「重新批准 + 机器验证」⇒ 恢复可发布", canPublish(revRe.experience, RESTARTED).reason);
    assert(sanitizeExperience(revRe.experience).error === undefined, "重新批准后的记录仍可通过载入边界校验");
  }

  // ── 授权事实的**权威来源**：宿主会话日志 + 落盘台账，而非文件里的字段 ────────
  // 直测：同一条经验，光有"结构上像审批"的 attestation 不够——必须能在**台账里**
  // 找到那条已消费的 grant。手写文件者可以抄一份合法 attestation，但抄不出台账记录。
  {
    const noFact = { ...exp, approval: { ...exp.approval } };
    assert(approvalProvenance(noFact).ok === true,
      "手写者能完整抄出结构合法的 attestation（所以结构校验必须由台账判定兜住）");
    // 抄来的记录 id 在台账里不存在 ⇒ 不构成授权（拒绝原因必须可解释）
    const copied = { ...noFact, approval: { ...noFact.approval, ledgerRecordId: "hap-" + "f".repeat(16) } };
    assert(validHumanApproval(copied).ok === false, "★ 手写 attestation（含自算摘要）不构成授权");
    assert(validHumanApproval(copied).reason === "approval_ledger_record_unknown",
      "★ 手写 attestation 的拒绝原因可解释", validHumanApproval(copied).reason);
    // 反证：同一条经验的原件（记录确实在台账里）⇒ 判定通过 —— 证明上面拒绝的是"抄写"而不是别的原因
    assert(validHumanApproval(exp).ok === true, "夹具自检：原件（台账中有记录）判定通过");
  }

  // ── hostApprovalRecord：唯一事实判据的直测（只认宿主词表）──────────────────
  const D = "a".repeat(64);
  const sess = mkTurnSession("s1");
  appendHostApprovalFact(sess, { ref: "appr-direct-1", digest: D });
  assert(hostApprovalRecord(sess, "appr-direct-1").ok === true, "asked+decided+内容摘要 齐全 ⇒ 事实成立");
  assert(hostApprovalRecord(sess, "appr-direct-1").ref === "appr-direct-1", "事实返回 ref");
  assert(hostApprovalRecord(sess, "appr-direct-1").digest === D, "★ 事实带回人类当时被问的内容摘要");
  assert(hostApprovalRecord(null, "appr-direct-1").reason === "no_session_log", "无会话日志 ⇒ 不成立");
  assert(hostApprovalRecord({ events: [] }, "appr-direct-1").reason === "approval_ref_not_in_host_log",
    "日志里没有该 ref ⇒ 不成立");
  assert(hostApprovalRecord(sess, 12345).reason === "invalid_approval_ref", "非字符串 ref ⇒ 不成立");
  // ★ 没有内容摘要的批准 = 没有对象的批准（无法绑定"人批的是哪份内容"）⇒ 事实不成立
  const noDigest = mkTurnSession("s1");
  appendHostApprovalFact(noDigest, { ref: "appr-nodigest-1", reason: "learn_review: approve experience x" });
  assert(hostApprovalRecord(noDigest, "appr-nodigest-1").reason === "approval_reason_not_content_bound",
    "★ 宿主日志里的批准未点名内容摘要 ⇒ 事实不成立（fail-closed）",
    hostApprovalRecord(noDigest, "appr-nodigest-1").reason);
  assert(hostApprovalRecord(noDigest, "appr-nodigest-1").reason.includes("not_content_bound"),
    "该拒绝原因可解释");
}

section("C6: transition whitelist — terminal states cannot be revived");
{
  assert(canTransition("PROPOSED", "APPROVED") === true, "PROPOSED->APPROVED allowed");
  assert(canTransition("PROPOSED", "REJECTED") === true, "PROPOSED->REJECTED allowed");
  assert(canTransition("APPROVED", "RETIRED") === true, "APPROVED->RETIRED allowed");
  assert(canTransition("REJECTED", "APPROVED") === false, "REJECTED->APPROVED blocked (terminal)");
  assert(canTransition("RETIRED", "APPROVED") === false, "RETIRED->APPROVED blocked (terminal)");
  assert(canTransition("APPROVED", "REJECTED") === false, "APPROVED->REJECTED blocked");

  let store = emptyStore("s1");
  store = propose(store, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id = store.experiences[0].id;
  const rej = reject(store, id, { approver: "human", reason: "not generalizable", at: 5 });
  assert(rej.ok === true && rej.value.experiences[0].state === "REJECTED", "reject works");
  const revive = approve(rej.value, id, { approver: "human", evidence: "e" });
  assert(revive.ok === false && revive.error.startsWith("illegal_transition"), "cannot approve a REJECTED entry", revive.error);
  const rejNoReason = reject(store, id, { approver: "human" });
  assert(rejNoReason.ok === false && rejNoReason.error === "rejection_requires_reason", "rejection requires reason");
  // 幂等 propose 不得复活 REJECTED
  const rePropose = propose(rej.value, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" });
  assert(rePropose.deduped === true && rePropose.experience.state === "REJECTED", "re-propose does not revive REJECTED");
  // RETIRED
  let s2 = emptyStore("s1");
  s2 = propose(s2, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id2 = s2.experiences[0].id;
  s2 = hostApprove(s2, id2, { evidence: "e" }).value;
  const ret = retire(s2, id2, { at: 9 });
  assert(ret.ok === true && ret.value.experiences[0].state === "RETIRED", "retire works");
  assert(isRecallable(ret.value.experiences[0]) === false, "RETIRED not recallable");
}

section("C7: deterministic recall from APPROVED only (AC4)");
{
  let store = emptyStore("s1");
  const mk = (t, b, seq, tags) => propose(store, { title: t, body: b, sourceEventSeqs: [seq], originSessionId: "s1", tags }).value;
  store = mk("Use pnpm for install", "npm install failed with peer dependency error", 1, ["build"]);
  store = mk("Increase timeout on slow networks", "network request timed out at 30s", 2, ["network"]);
  store = mk("Unapproved idea", "should never be recalled", 3, ["build"]);
  // 只批准前两条
  store = hostApprove(store, store.experiences[0].id, { evidence: "e1", at: 1 }).value;
  store = hostApprove(store, store.experiences[1].id, { evidence: "e2", at: 2 }).value;

  const r = recall(store, "npm install failed");
  assert(r.ok === true, "recall ok");
  assert(r.items.length === 1, "only approved+scoring item returned", `got ${r.items.length}`);
  assert(r.items[0].title === "Use pnpm for install", "correct item recalled");
  assert(r.excluded === 1, "unapproved entry excluded", `excluded=${r.excluded}`);
  assert(Array.isArray(r.items[0].sourceEventSeqs) && r.items[0].sourceEventSeqs[0] === 1, "provenance returned for re-sourcing");
  assert(r.items[0].approvedBy === HUMAN_APPROVAL_ACTOR, "approver surfaced（固定宿主标签）");

  // 未批准条目永不出现在任何查询结果里
  for (const q of ["Unapproved idea", "never be recalled", "idea"]) {
    const rr = recall(store, q);
    assert(rr.items.every((i) => i.title !== "Unapproved idea"), `unapproved never recalled (q="${q}")`);
  }

  // 确定性：同输入同输出（含排序）
  const A = JSON.stringify(recall(store, "network timeout install build"));
  const B = JSON.stringify(recall(store, "network timeout install build"));
  assert(A === B, "recall is deterministic across calls");
  const sorted = recall(store, "network timeout install build", { limit: 10 });
  const ids = sorted.items.map((i) => i.id);
  const reSorted = recall(store, "network timeout install build", { limit: 10 }).items.map((i) => i.id);
  assert(JSON.stringify(ids) === JSON.stringify(reSorted), "recall ordering stable");

  // 空查询 / 无命中
  assert(recall(store, "").items.length === 0, "empty query -> no items");
  assert(recall(store, "zzzzzznomatch").items.length === 0, "no match -> no items");
  assert(recall(store, "npm", { limit: 1 }).items.length === 1, "limit respected");
  assert(recall(store, "npm", { limit: 999 }).items.length <= 20, "limit clamped to MAX_RECALL_LIMIT");

  // recordRecall
  const after = recordRecall(store, [store.experiences[0].id], 777);
  assert(after.experiences[0].recallCount === 1 && after.experiences[0].lastRecalledAt === 777, "recall recorded");
  assert(store.experiences[0].recallCount === 0, "recordRecall immutable");

  // tokenize determinism
  assert(JSON.stringify(tokenize("Npm INSTALL failed")) === JSON.stringify(tokenize("Npm INSTALL failed")), "tokenize deterministic");
}

section("C8: validateStore is fail-closed (AC5)");
{
  const good = emptyStore("s1");
  assert(validateStore(good) !== null, "empty store valid");
  assert(validateStore(null) === null, "null -> null");
  assert(validateStore([]) === null, "array -> null");
  assert(validateStore({ ...good, schemaVersion: 99 }) === null, "wrong schemaVersion -> null");
  assert(validateStore({ ...good, sessionId: "" }) === null, "empty sessionId -> null");
  assert(validateStore({ ...good, version: -1 }) === null, "negative version -> null");
  assert(validateStore({ ...good, version: 1.5 }) === null, "non-integer version -> null");
  assert(validateStore({ ...good, experiences: "nope" }) === null, "non-array experiences -> null");
  assert(validateStore({ ...good, telemetry: "nope" }) === null, "non-array telemetry -> null");
  const huge = { ...good, experiences: new Array(MAX_EXPERIENCES + 1).fill(good.experiences[0]) };
  assert(validateStore(huge) === null, "over-limit experiences -> null");
  const hugeT = { ...good, telemetry: new Array(MAX_TELEMETRY + 1).fill({ kind: "PROPOSED", at: 0 }) };
  assert(validateStore(hugeT) === null, "over-limit telemetry -> null");
  // 单条坏 → 整库判废（不部分信任）
  let s = emptyStore("s1");
  s = propose(s, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  assert(validateStore(s) !== null, "store with one valid experience valid");
  const corrupted = { ...s, experiences: [{ ...s.experiences[0], state: "BOGUS" }] };
  assert(validateStore(corrupted) === null, "one bad entry invalidates whole store (no partial trust)");
  const corrupted2 = { ...s, experiences: [{ ...s.experiences[0], body: "" }] };
  assert(validateStore(corrupted2) === null, "empty body invalidates store");
  const badTelemetry = { ...s, telemetry: [{ kind: "NOT_A_KIND", at: 0 }] };
  assert(validateStore(badTelemetry) === null, "unknown telemetry kind invalidates store");

  // 结构不变量：APPROVED 必须带审批人与证据
  const approvedNoApprover = { ...s.experiences[0], state: "APPROVED", approvedBy: null, approvedAt: 1 };
  assert(sanitizeExperience(approvedNoApprover).error === "approved_without_approver", "APPROVED without approver rejected");
  const approvedNoEvidence = { ...s.experiences[0], state: "APPROVED", approvedBy: "h", approvalEvidence: null };
  assert(sanitizeExperience(approvedNoEvidence).error === "approved_without_evidence", "APPROVED without evidence rejected");
  const proposedWithApproval = { ...s.experiences[0], state: "PROPOSED", approvedBy: "h", approvedAt: 1 };
  assert(sanitizeExperience(proposedWithApproval).error === "proposed_with_approval_trace", "PROPOSED with approval trace rejected");
  // PROPOSED 携带晋升痕迹：由更早的 proposed_with_promotion 守卫拦下（fail-closed，先命中者为准）
  const proposedPromoted = { ...s.experiences[0], promotion: "PROMOTED", promotionEvidence: "e" };
  assert(sanitizeExperience(proposedPromoted).error === "proposed_with_promotion", "PROPOSED carrying promotion rejected");
  // promoted_without_approval 的真实可达路径：终态条目携带 PROMOTED
  const rejectedPromoted = { ...s.experiences[0], state: "REJECTED", rejectedBy: "h", rejectionReason: "r", promotion: "PROMOTED", promotionEvidence: "e" };
  assert(sanitizeExperience(rejectedPromoted).error === "promoted_without_approval", "PROMOTED while not APPROVED rejected");
  const retiredPromoted = { ...s.experiences[0], state: "RETIRED", promotion: "PROMOTED", promotionEvidence: "e" };
  assert(sanitizeExperience(retiredPromoted).error === "promoted_without_approval", "PROMOTED while RETIRED rejected");
  // 注意（F1）：该夹具必须先满足"宿主事实齐全的 APPROVED"，否则会被 attestation 闸门
  // 先拦下（approved_without_host_attestation），断言就测不到 promoted_without_evidence
  // 这条不变量——fail-closed 的判废顺序是"先命中者为准"，测试必须按真实可达路径构造。
  const approvedFix = hostApprove(s, s.experiences[0].id, { evidence: "e", at: 1 });
  assert(approvedFix.ok === true, "C8 fixture: host-proven APPROVED", approvedFix.error ?? "");
  const promotedNoEvidence = { ...approvedFix.experience, promotion: "PROMOTED", promotionEvidence: null };
  assert(sanitizeExperience(promotedNoEvidence).error === "promoted_without_evidence", "PROMOTED without evidence rejected");
}

section("C9: promotion eligibility vs promotion (AC11)");
{
  let store = emptyStore("s1");
  store = propose(store, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id = store.experiences[0].id;
  const e0 = promotionEligibility(store.experiences[0]);
  assert(e0.eligible === false && e0.state === "NONE", "PROPOSED not eligible", JSON.stringify(e0));
  store = hostApprove(store, id, { evidence: "e", at: 1 }).value;
  const e1 = promotionEligibility(store.experiences[0]);
  assert(e1.eligible === false && e1.reason === "never_recalled", "approved but never recalled -> blocked", JSON.stringify(e1));
  // 资格判定不改变状态
  assert(store.experiences[0].promotion === "NONE", "eligibility check does not mutate state");
  store = recordRecall(store, [id], 2);
  const e2 = promotionEligibility(store.experiences[0]);
  assert(e2.eligible === true && e2.state === "ELIGIBLE", "approved + recalled -> eligible", JSON.stringify(e2));
  // ELIGIBLE ≠ PROMOTED：状态未被自动改变
  assert(store.experiences[0].promotion === "NONE", "eligible is NOT auto-promoted");
  // 晋升必须显式 + 带证据
  const noEv = promote(store, id, {});
  assert(noEv.ok === false && noEv.error === "promotion_requires_evidence", "promotion without evidence rejected");
  const secEv = promote(store, id, { evidence: `x ${FAKES.aws}` });
  assert(secEv.ok === false && secEv.error === "promotion_evidence_contains_secret", "secret in promotion evidence rejected");
  const ok = promote(store, id, { evidence: "used in 3 real tasks" });
  assert(ok.ok === true && ok.value.experiences[0].promotion === "PROMOTED", "explicit promotion works");
  assert(promotionEligibility(ok.value.experiences[0]).reason === "already_promoted", "already-promoted reported");
  // 不可晋升者拒绝
  let s2 = emptyStore("s1");
  s2 = propose(s2, { title: "T2", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const p2 = promote(s2, s2.experiences[0].id, { evidence: "e" });
  assert(p2.ok === false && p2.error.startsWith("not_eligible"), "cannot promote unapproved", p2.error);
}

section("C10: write boundary protects runtime state/goals/credentials/policy (AC10)");
{
  for (const t of PROTECTED_TARGETS) {
    const r = assertWriteAllowed(t);
    assert(r.allowed === false, `protected target blocked: ${t}`, JSON.stringify(r));
  }
  // 变体/子路径也必须被拦
  for (const t of ["runtime-state.json", "GOAL-STORE", "my-credentials.yaml", "agent/policy.yml", "settings.yaml", "profiles/web/x"]) {
    assert(assertWriteAllowed(t).allowed === false, `protected variant blocked: ${t}`);
  }
  // 白名单内允许
  assert(assertWriteAllowed("experience-store").allowed === true, "experience-store allowed");
  assert(assertWriteAllowed("telemetry").allowed === true, "telemetry allowed");
  assert(assertWriteAllowed("audit-log").allowed === true, "audit-log allowed");
  // 白名单外拒绝
  assert(assertWriteAllowed("random-file").allowed === false, "non-whitelisted target blocked");
  assert(assertWriteAllowed("").allowed === false, "empty target blocked");
  assert(assertWriteAllowed(null).allowed === false, "null target blocked");
}

section("C11: telemetry is structured, redacted, bounded (AC8)");
{
  const bad = telemetryEvent("NOPE", {});
  assert(bad.ok === false && bad.error === "invalid_telemetry_kind", "unknown kind rejected");
  const ev = telemetryEvent("PROPOSED", { experienceId: "exp-1", detail: `learned from ${FAKES.notion}`, count: 2 }, 42);
  assert(ev.ok === true, "valid event built");
  assert(ev.value.kind === "PROPOSED" && ev.value.at === 42, "kind + timestamp");
  assert(!String(ev.value.detail).includes(FAKES.notion), "telemetry detail redacted");
  assert(ev.value.count === 2, "count preserved");
  // 有界
  let store = emptyStore("s1");
  for (let i = 0; i < MAX_TELEMETRY + 25; i++) {
    store = appendTelemetry(store, telemetryEvent("RECALLED", { count: i }, i).value);
  }
  assert(store.telemetry.length === MAX_TELEMETRY, "telemetry ring buffer bounded", `got ${store.telemetry.length}`);
  assert(store.telemetry[store.telemetry.length - 1].count === MAX_TELEMETRY + 24, "newest kept");
  assert(validateStore(store) !== null, "bounded store still valid");
  // 非法事件被忽略
  const before = store.telemetry.length;
  store = appendTelemetry(store, { kind: "BOGUS" });
  assert(store.telemetry.length === before, "invalid telemetry ignored");
  // 摘要
  const sum = telemetrySummary(store);
  assert(sum.total === MAX_TELEMETRY && sum.counts.RECALLED === MAX_TELEMETRY, "summary counts");
  assert(sum.experiences === 0 && sum.promoted === 0, "summary experience counts");
  for (const k of TELEMETRY_KINDS) assert(sum.counts[k] !== undefined, `summary includes kind ${k}`);
  for (const s of EXPERIENCE_STATES) assert(sum.byState[s] !== undefined, `summary includes state ${s}`);
}

section("C12: buildLearnDigest reuses P2.5 official extractors (AC1)");
{
  // AC1 直证之一：默认提取器就是 P2.5 的导入本体（同一函数引用，不是"等价实现"）
  assert(P25_EXTRACTORS.messageOfEvent === p25MessageOfEvent, "default messageOfEvent IS P2.5's (identity)");
  assert(P25_EXTRACTORS.recursiveText === p25RecursiveText, "default recursiveText IS P2.5's (identity)");
  assert(P25_EXTRACTORS.isPluginSourced === p25IsPluginSourced, "default isPluginSourced IS P2.5's (identity)");
  assert(Object.isFrozen(P25_EXTRACTORS), "P25_EXTRACTORS is frozen (cannot be swapped at runtime)");

  // 单测注入用的等价提取器（签名与 P2.5 完全一致）
  const messageOfEvent = (e) => (e.type === "user/message" ? (e.data ?? null) : (e.data?.message ?? null));
  const recursiveText = (b) => {
    if (b == null) return "";
    if (typeof b === "string") return b;
    if (Array.isArray(b)) return b.map(recursiveText).join("");
    if (typeof b === "object") {
      if (typeof b.text === "string") return b.text;
      if (Array.isArray(b.content)) return recursiveText(b.content);
    }
    return "";
  };
  const isPluginSourced = (m) => m?.source?.kind === "plugin";
  const EX = { messageOfEvent, recursiveText, isPluginSourced };
  const events = [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "npm install failed with EPEER" }] } },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "switch to pnpm instead" }] } } },
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "now it works" }] } },
    { type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: "ok" }] } } },
    { type: "user/message", data: { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "INJECTED PROJECTION" }] } },
  ];
  const nodes = [0, 1, 2, 3, 4];
  const r = buildLearnDigest(events, nodes, EX);
  assert(r.ok === true, "digest built");
  assert(r.digest.turnCount === 4, "4 real turns extracted (plugin-injected skipped)", `got ${r.digest.turnCount}`);
  assert(r.digest.turns.every((t) => !t.text.includes("INJECTED PROJECTION")), "plugin-sourced projection skipped (no feedback loop)");
  assert(r.digest.sourceEventSeqs.join(",") === "0,1,2,3", "provenance seqs recorded", r.digest.sourceEventSeqs.join(","));
  assert(r.digest.turns[0].role === "user" && r.digest.turns[1].role === "assistant", "roles derived");
  assert(r.digest.firstSeq === 0 && r.digest.lastSeq === 3, "bounds derived");

  // AC1 直证之二：默认路径（不传 extractors）与 P2.5 官方实现行为逐字一致
  const rDefault = buildLearnDigest(events, nodes);
  assert(rDefault.ok === true, "default-path digest built");
  assert(JSON.stringify(rDefault.digest) === JSON.stringify(r.digest), "default path identical to P2.5-extractor path");
  // 直接与 P2.5 原始函数对照（不经 P4 任何包装）
  const manual = nodes
    .map((s) => events[s])
    .filter((e) => e && !p25IsPluginSourced(p25MessageOfEvent(e)))
    .map((e) => p25RecursiveText(p25MessageOfEvent(e).content ?? p25MessageOfEvent(e)))
    .filter(Boolean);
  assert(manual.join("|") === rDefault.digest.turns.map((t) => t.text).join("|"), "text extraction byte-identical to P2.5 official path");

  // 脱敏发生在摘要里
  const rSecret = buildLearnDigest([{ type: "user/message", data: { role: "user", content: [{ type: "text", text: `key ${FAKES.openai}` }] } }], [0], EX);
  assert(!rSecret.digest.turns[0].text.includes(FAKES.openai), "digest text redacted");
  // fail-closed 入参
  assert(buildLearnDigest(null, [], EX).ok === false, "null events rejected");
  assert(buildLearnDigest([], null, EX).ok === false, "null nodes rejected");
  assert(buildLearnDigest([], [], {}).error === "missing_official_extractors", "missing official extractors rejected (no second parser)");
  assert(buildLearnDigest([], [], null).error === "missing_official_extractors", "null extractors rejected");
  assert(buildLearnDigest([], [], { messageOfEvent, recursiveText }).error === "missing_official_extractors", "partial extractors rejected");
  // 越界 seq 安全跳过
  const rBad = buildLearnDigest(events, [0, 999, -3, "x"], EX);
  assert(rBad.ok === true && rBad.digest.turnCount === 1, "out-of-range seqs skipped safely", `got ${rBad.digest.turnCount}`);
}

section("C13: learning signals are deterministic (R2 AC5: failure authority moved to P2.6)");
{
  // ⛔ R2 AC5 契约变更：failure 关键词已从 SIGNAL_PATTERNS **整体删除**（第二 Failure
  //    Authority 被移除）。因此 "the build failed" 在本轮**不再**产生任何关键词信号。
  //    这不是能力回退，而是刻意的边界收紧：失败证据只能来自 P2.6 分类结果（下方 s2 验证）。
  const digest = { turns: [{ seq: 1, role: "user", text: "the build failed" }, { seq: 2, role: "assistant", text: "use pnpm instead" }, { seq: 3, role: "user", text: "fixed now" }] };
  const s = learningSignals(digest);
  assert(s.hasSignal === true, "signals detected");
  assert(s.signals.length === 2, "two signals (failure keyword removed by R2 AC5)", `got ${s.signals.length}`);
  assert(s.signals[0].kind === "correction" && s.signals[1].kind === "resolution", "kinds classified",
    JSON.stringify(s.signals.map((x) => x.kind)));
  // 关键词路径**永不**声称 failure
  assert(s.kinds.includes("failure") === false, "keyword path never claims failure (R2 AC5)",
    JSON.stringify(s.kinds));
  assert(s.failureSeqs.length === 0, "no failure evidence without P2.6 injection");

  // 失败证据只能由调用方从 P2.6 Authority 注入
  const s2 = learningSignals(digest, {
    classifiedFailures: [{ seq: 1, classification: "NETWORK_TIMEOUT_5XX", vetoed: true, vetoReason: "HARD_VETO_CLASS" }],
  });
  assert(s2.failureSeqs.join(",") === "1", "failure evidence comes from P2.6 injection", JSON.stringify(s2.failureSeqs));
  assert(s2.vetoedFailureSeqs.join(",") === "1", "vetoed failure surfaced", JSON.stringify(s2.vetoedFailureSeqs));
  assert(s2.vetoedCount === 1, "vetoedCount reflects vetoed failures", String(s2.vetoedCount));
  // 注入的失败落在 resolution(seq 3) 之前 ⇒ 被判为已解决
  assert(s2.resolved === true, "injected failure before resolution -> resolved", `resolved=${s2.resolved}`);

  assert(JSON.stringify(learningSignals(digest)) === JSON.stringify(s), "signals deterministic");
  assert(learningSignals(null).hasSignal === false, "null digest safe");
  assert(learningSignals({ turns: [] }).hasSignal === false, "empty turns -> no signal");
}

section("C14: stableHash determinism");
{
  assert(stableHash("abc") === stableHash("abc"), "hash deterministic");
  assert(stableHash("abc") !== stableHash("abd"), "hash distinguishes input");
  assert(/^[0-9a-f]{8}$/.test(stableHash("x")), "hash format is 8 hex chars");
}

section("C15: R2 adversarial-review regressions (proven defects, locked)");
{
  // AC1 纪律：仍然复用 P2.5 官方提取器本体（不另起 parser）
  const X = { messageOfEvent: p25MessageOfEvent, recursiveText: p25RecursiveText, isPluginSourced: p25IsPluginSourced };
  const turnsOf = (arr) => ({ turns: arr.map((t, i) => ({ seq: t.seq ?? i, role: t.role ?? "user", text: t.text })) });
  const kindOf = (text) => {
    const s = learningSignals(turnsOf([{ text }]));
    return s.hasSignal ? s.signals[0].kind : null;
  };

  // (1) R2 AC5 契约变更：CJK 失败关键词**已从关键词路径整体删除**。
  //     旧断言（"报错"→failure）断言的是**已被合同禁止的第二 Failure Authority**，
  //     因此这里不是删除断言，而是**改写为断言新契约（更强）**：
  //       ① 关键词路径永不产出 failure（防止有人把关键词表加回来）；
  //       ② 同一输入的失败判定由 P2.6 权威给出，且环境类故障被否决。
  for (const t of ["报错", "失败了", "这里报错了", "程序崩溃了", "无法启动", "配置错误"]) {
    assert(kindOf(t) !== "failure", `R2 AC5: keyword path no longer claims failure: ${t}`, `got ${kindOf(t)}`);
  }
  // ② P2.6 权威接管：真实 provider 故障形态必须被正确分类**并被否决**。
  //    输入形态严格遵循 P2.6 契约 {message, code, status}（不是自由中文叙述）；
  //    期望值取自实测（_probe-classify.mjs 探针输出），非猜测。
  for (const [label, failure, expectCls, expectReason] of [
    ["econnreset", { message: "socket hang up", code: "ECONNRESET" }, "NETWORK_TIMEOUT_5XX", "HARD_VETO_CLASS"],
    ["502", { status: 502, message: "bad gateway" }, "NETWORK_TIMEOUT_5XX", "HARD_VETO_CLASS"],
    ["429", { status: 429, message: "too many requests" }, "SHORT_WINDOW_RATE_LIMIT", "HARD_VETO_CLASS"],
    ["quota", { message: "insufficient quota" }, "QUOTA_EXHAUSTED", "HARD_VETO_CLASS"],
    ["401", { status: 401, message: "invalid api key" }, "AUTH_PERMISSION_FAILURE", "HARD_VETO_CLASS"],
    ["model-route", { message: "model not found" }, "MODEL_ROUTE_UNAVAILABLE", "HARD_VETO_CLASS"],
    ["CN quota", { message: "使用上限" }, "QUOTA_EXHAUSTED", "HARD_VETO_CLASS"],
    ["CN overload", { message: "服务繁忙" }, "PROVIDER_OVERLOADED", "HARD_VETO_CLASS"],
    ["ctx-limit", { message: "maximum context length exceeded" }, "CONTEXT_LIMIT", "HARD_VETO_CLASS"],
    ["protocol", { message: "reasoning_content must be passed back to the API" }, "PROTOCOL_MISMATCH", "CONDITIONAL_VETO_NO_EVIDENCE"],
    ["no-object (fail-closed)", null, "UNKNOWN_PROVIDER_FAILURE", "CONDITIONAL_VETO_NO_EVIDENCE"],
  ]) {
    const v = evaluateGapVeto(failure, { provider: "p", model: "m" });
    assert(v.classification === expectCls, `P2.6 authority classifies: ${label}`, `got ${v.classification}`);
    assert(v.vetoed === true, `P2.6 authority vetoes gap: ${label}`, `vetoed=${v.vetoed}`);
    assert(v.reason === expectReason, `P2.6 veto reason: ${label}`, `got ${v.reason}`);
  }
  for (const t of ["已修复", "问题解决了", "测试通过", "跑通了", "搞定了"]) {
    assert(kindOf(t) === "resolution", `CJK resolution keyword detected: ${t}`, `got ${kindOf(t)}`);
  }
  for (const t of ["应该改成这样", "请纠正这个说法"]) {
    assert(kindOf(t) === "correction", `CJK correction keyword detected: ${t}`, `got ${kindOf(t)}`);
  }

  // (2) 首个命中缺陷：failure 曾排在模式表首位且 `break` ⇒ "已经解决"的发言被判成 failure
  //     （语义反转）。R2 下 failure 已不在表内，resolution 仍是首位；此处断言
  //     "resolution 在同一轮内胜出" 仍然成立（这是 R2 之前就修好的语义强度顺序）。
  assert(kindOf("fixed the error") === "resolution", "resolution outranks failure in the same turn",
    `got ${kindOf("fixed the error")}`);
  assert(kindOf("resolved the failure") === "resolution", "resolved+noun stays resolution");
  assert(kindOf("the crash was fixed") === "resolution", "fixed outranks crash");
  assert(SIGNAL_PATTERNS[0].kind === "resolution" && SIGNAL_PATTERNS[SIGNAL_PATTERNS.length - 1].kind === "correction",
    "pattern table is resolution-first and contains no failure kind (R2 AC5)",
    SIGNAL_PATTERNS.map((p) => p.kind).join(","));
  assert(SIGNAL_PATTERNS.some((p) => p.kind === "failure") === false,
    "★ SIGNAL_PATTERNS contains NO failure kind (single Failure Authority = P2.6)");

  // (3) 失败-解决配对：R1 只罗列命中的关键词，从不判断失败是否被后续发言解决。
  //     R2：失败证据由 P2.6 注入，配对逻辑保持。
  const paired = learningSignals(turnsOf([{ seq: 10, text: "the build failed" }, { seq: 11, role: "assistant", text: "fixed now" }]), {
    classifiedFailures: [{ seq: 10, classification: "NETWORK_TIMEOUT_5XX", vetoed: true }],
  });
  assert(paired.resolved === true, "failure followed by a later resolution -> resolved", `resolved=${paired.resolved}`);
  assert(paired.unresolvedFailureSeqs.length === 0, "no open gap when resolved");
  const lone = learningSignals(turnsOf([{ seq: 10, text: "the build failed" }]), {
    classifiedFailures: [{ seq: 10, classification: "NETWORK_TIMEOUT_5XX", vetoed: true }],
  });
  assert(lone.resolved === false, "lone failure -> not resolved");
  assert(lone.unresolvedFailureSeqs.length === 1 && lone.unresolvedFailureSeqs[0] === 10,
    "lone failure reported as an open gap", JSON.stringify(lone.unresolvedFailureSeqs));
  // 未注入 P2.6 证据时**绝不**声称失败（fail-closed 的另一面：没有权威证据就没有失败）
  assert(learningSignals(turnsOf([{ seq: 10, text: "the build failed" }])).failureSeqs.length === 0,
    "no P2.6 evidence -> no failure claimed (fail-closed)");
  const late = learningSignals(turnsOf([{ seq: 10, role: "assistant", text: "fixed now" }, { seq: 11, text: "it failed again" }]), {
    classifiedFailures: [{ seq: 11, classification: "NETWORK_TIMEOUT_5XX", vetoed: true }],
  });
  assert(late.resolved === false, "a resolution BEFORE the failure does not resolve it (seq order matters)");
  assert(late.unresolvedFailureSeqs.join(",") === "11", "the later failure is the open gap",
    late.unresolvedFailureSeqs.join(","));
  assert(Array.isArray(lone.kinds) && lone.kinds.length === 0,
    "kinds summary exposes only narrative signals (failure kind removed by R2 AC5)",
    JSON.stringify(lone.kinds));

  // (4) 注入块曾被当成学习信号（真实会话实测：27 个信号里 4 个来自 <system-reminder> 注入块，
  //     标题就是注入文本本身）。isPluginSourced 只覆盖部分事件 ⇒ 增加内容级防御。
  //
  //     R3 对抗评审修正：R2 的 "unterminated" 断言写的是
  //       stripInjectedContent("keep me<system-reminder>unterminated tail") === "keep me"
  //     —— 它把**缺陷行为锁进了测试**。原正则 /<system-reminder>[\s\S]*$/i 在任意位置命中即吞到结尾，
  //     实测会吃掉真人发言：用户只是讨论这个标签时（"我注意到日志里有 <system-reminder> 这个标签，
  //     它后面的报错都没被记录"）81% 文本被删。已收紧为"标签独占一行"（真注入块的排版形态），
  //     实证见 docs/roadmap/evidence/P4_LEARN_R3_INJECTION_POSITIONS.txt：
  //     真注入 720 次全部 = 行首且独占一行；引用/讨论 1454 次全部 = 行中且标签后跟行内文字。
  //     故此处把断言升级为 R3 规格（真注入仍被剥、讨论不再被吞），并保留"行中注入尾巴"用例
  //     作为**反向锁**：它现在必须被保留（因为那正是用户讨论该标签的形态）。
  assert(stripInjectedContent("<system-reminder>noise</system-reminder>real words") === "real words",
    "closed injected block stripped, real speech kept");
  assert(stripInjectedContent("keep me\n<system-reminder>\nunterminated tail") === "keep me",
    "unterminated injected block stripped (truncated logs, tag alone on its line)");
  assert(stripInjectedContent("keep me<system-reminder>unterminated tail") === "keep me<system-reminder>unterminated tail",
    "R3 reverse lock: an inline tag is a discussion/quote, its text must survive");
  const discuss = "我注意到日志里有 <system-reminder> 这个标签，它后面的报错都没被记录";
  assert(stripInjectedContent(discuss) === discuss,
    "R3: a user discussing the tag keeps their whole sentence", JSON.stringify(stripInjectedContent(discuss)));
  assert(stripInjectedContent("<system-reminder>only noise</system-reminder>") === "",
    "injection-only turn becomes empty");
  assert(stripInjectedContent("plain text") === "plain text", "plain text untouched");
  assert(stripInjectedContent("") === "" && stripInjectedContent(null) === "", "empty/null safe");

  const evInj = [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "<system-reminder>the word error appears in injected text</system-reminder>" }] } },
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "real question<system-reminder>injected tail</system-reminder>" }] } },
  ];
  const injDigest = buildLearnDigest(evInj, [0, 1], X);
  assert(injDigest.digest.turnCount === 1, "injection-only turn excluded from digest", `got ${injDigest.digest.turnCount}`);
  assert(injDigest.digest.injectedSkipped === 1, "injectedSkipped counted", `got ${injDigest.digest.injectedSkipped}`);
  assert(injDigest.digest.turns[0].text === "real question", "real speech survives stripping");
  assert(learningSignals(injDigest.digest).hasSignal === false,
    "harness-injected reminder text no longer produces a learning signal");

  // (5) 输入规范化：重复/乱序 nodeSeqs 曾被原样采信 —— 重复会放大计数与回源锚点，
  //     乱序会让信号顺序随调用方漂移（破坏"同一输入同一输出"的确定性契约）。
  const ev2 = [
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: "it failed" }] } },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "fixed now" }] } } },
  ];
  const dup = buildLearnDigest(ev2, [0, 0, 0, 1], X);
  assert(dup.digest.turnCount === 2, "duplicate nodeSeqs deduplicated", `got ${dup.digest.turnCount}`);
  assert(dup.digest.sourceEventSeqs.join(",") === "0,1", "sourceEventSeqs unique + ascending",
    dup.digest.sourceEventSeqs.join(","));
  const rev = buildLearnDigest(ev2, [1, 0], X);
  assert(rev.digest.turns.map((t) => t.seq).join(",") === "0,1", "out-of-order nodeSeqs canonicalized",
    rev.digest.turns.map((t) => t.seq).join(","));
  assert(JSON.stringify(learningSignals(rev.digest).signals) === JSON.stringify(learningSignals(dup.digest).signals),
    "signals are independent of caller-supplied ordering");
  // R2 AC5：失败证据来自 P2.6 注入；规范化后配对逻辑仍成立
  assert(learningSignals(dup.digest, { classifiedFailures: [{ seq: 0, classification: "NETWORK_TIMEOUT_5XX", vetoed: true }] }).resolved === true,
    "canonicalized digest still pairs injected failure->resolution");

  // (6) 能力不回退 + R2 AC5 边界。原断言要求**全部** 15 个 R1 关键词仍被识别，
  //     其中 6 个是 failure 词（已被合同禁止作为关键词权威）。现拆成两组，各自断言：
  //       (a) 叙述词（correction/resolution）必须**全部**仍被识别 —— 防"修中文丢英文"的隐性回退；
  //       (b) 失败词必须**全部不再**产生关键词信号 —— 防第二 Failure Authority 被加回来。
  const R1_LATIN_NARRATIVE = [
    "instead", "rather than", "should be", "actually", "correction",
    "fixed", "resolved", "works now", "passing",
  ];
  for (const w of R1_LATIN_NARRATIVE) {
    const got = kindOf(`this sentence mentions ${w} somewhere`);
    assert(got !== null, `R1 latin narrative keyword still detected: "${w}"`, `got ${got}`);
  }
  const R1_LATIN_FAILURE = ["error", "failed", "failure", "exception", "crash", "rejected"];
  for (const w of R1_LATIN_FAILURE) {
    const got = kindOf(`this sentence mentions ${w} somewhere`);
    assert(got !== "failure", `R2 AC5: latin failure keyword "${w}" no longer claims failure`, `got ${got}`);
  }
  assert(SIGNAL_PATTERNS.every((p) => p.latin instanceof RegExp && p.cjk instanceof RegExp),
    "every pattern carries both a latin and a cjk regex");
}

// ═══════════════════════════════════════════════════════════════════════════
// C16: Layer B —— 跨会话「全局已验证经验库」写保护（STAGE 8b 覆盖缺口闭合）
//
// 证据来源：stage8b-mutation-round2.mjs（层破除突变）——
//   M3b 让 canPublish 整层返回 ok:true  ⇒ 未 VERIFIED 的经验可进全局库（行为确实被破坏）
//   M5b 让 validateGlobalStore 直接放行 ⇒ 坏库/含未验证条目的库被接受（行为确实被破坏）
// 两者当时**无任何套件变红**。本节让这两条突变立即变红（STAGE 8c 复核）。
//
// 夹具纪律：一切"合法可发布经验"必须由官方链路产出（makeExperience → approve →
// applyVerification），不得手搓——手搓夹具会把"实现能造出什么"与"测试以为能造出什么"
// 悄悄解耦，那正是本次缺口的成因。
// ═══════════════════════════════════════════════════════════════════════════
section("C16: Layer B 跨会话全局已验证经验库 —— 发布闸门与 fail-closed 校验");
{
  const SHA = "a".repeat(64);
  const evidence = { class: "file_hash", path: "C:/p4r2/plugin/learn-core.mjs", sha256: SHA };
  const resolvers = { fileHash: () => SHA };

  // ── 官方链路造一条真正可发布的经验 ──────────────────────────────────────
  const draft = makeExperience({
    title: "GameStateGuard cache leak fix",
    body: "reset the singleton cache between sessions to stop stale recall",
    sourceEventSeqs: [11, 12],
    originSessionId: "sess-layerB",
  });
  assert(draft.ok === true, "C16 fixture: draft created");
  const store0 = { ...emptyStore("sess-layerB"), experiences: [draft.value] };
  assert(canPublish(draft.value).reason === "proposed_never_published",
    "C16: 刚出生的提案不可发布（提案 ≠ 已验证）", canPublish(draft.value).reason);

  const ap = hostApprove(store0, draft.value.id, { evidence: "manual review note", at: 1000 });
  assert(ap.ok === true, "C16 fixture: approved", ap.error ?? "");
  const store1 = ap.value;
  // 审批本身不等于机器验证（合同【实现原则 3】：没有真实成功证据 ⇒ 永不 VERIFIED）
  assert(canPublish(ap.experience).reason === "not_verified:UNVERIFIED",
    "C16: 人工批准但未经机器验证 ⇒ 仍不可发布", canPublish(ap.experience).reason);

  const av = applyVerification(store1, draft.value.id, evidence, resolvers, 2000);
  assert(av.ok === true, "C16 fixture: machine verification passed", JSON.stringify(av.error ?? ""));
  const verified = av.experience;
  // ★ B1：审批是**粘性**的——已 APPROVED 的经验重新验证通过时保持 APPROVED，绝不降级为
  //   VERIFIED_EXPERIENCE。旧断言期望 "VERIFIED_EXPERIENCE"，恰好锁死了 BLOCKER-1 的根因
  //   （授权位被重新验证擦掉 ⇒ "APPROVED + VERIFIED" 无法共存 ⇒ 闸门退化为只看 VERIFIED）。
  assert(verified.state === "APPROVED" && verified.verification.status === "VERIFIED",
    "C16 fixture: state/verification advanced（审批粘性：APPROVED 不被重新验证撤销）",
    `state=${verified.state} vstatus=${verified.verification.status}`);
  assert(verified.lastVerifiedAt === 2000, "C16 fixture: lastVerifiedAt stamped", `got ${verified.lastVerifiedAt}`);
  assert(normEvidence(evidence) !== null, "C16 fixture: evidence is machine-checkable");

  // ── 夹具工厂：每条"合法可发布经验"都必须**各自**走完 人类批准 → 机器验证 ─────────
  // F1 的对象绑定（attestation 绑定 id + 内容摘要）意味着：拿一条已批准记录的副本改内容/
  // 改 id 再发布，等于"批一个、发另一个"，现在会被 approval_content_changed 拦下。
  // 因此凡是要发布的不同内容，必须各自取得一次宿主人类批准事实——这正是夹具纪律的延伸：
  // 手搓/复制夹具会把"实现允许什么"与"测试以为允许什么"悄悄解耦。
  const publishable = (opts = {}) => {
    const d = makeExperience({
      title: opts.title ?? "Another verified lesson",
      body: opts.body ?? "a distinct lesson body for layer B",
      sourceEventSeqs: opts.sourceEventSeqs ?? [21, 22],
      originSessionId: "sess-layerB",
    });
    assert(d.ok === true, "C16 fixture(publishable): draft created", JSON.stringify(d.error ?? ""));
    const exp = opts.id ? { ...d.value, id: opts.id } : d.value;
    const s0 = { ...emptyStore("sess-layerB"), experiences: [exp] };
    const a = hostApprove(s0, exp.id, { evidence: "manual review note", at: 1000 });
    assert(a.ok === true, "C16 fixture(publishable): approved", a.error ?? "");
    const v = applyVerification(a.value, exp.id, evidence, resolvers, opts.lastVerifiedAt ?? 2000);
    assert(v.ok === true, "C16 fixture(publishable): machine verification passed", JSON.stringify(v.error ?? ""));
    return v.experience;
  };

  // (1) 发布闸门：正向 + 逐条负向原因（"为什么被拒"必须可解释，不留静默死路径）
  assert(canPublish(verified).ok === true, "C16: 已验证经验可发布", canPublish(verified).reason);
  assert(canPublish(verified).reason === "verified_approvable_experience", "C16: 正向原因可解释");
  assert(canPublish({ ...verified, state: "APPROVED" }).ok === true, "C16: APPROVED + VERIFIED 同样可发布");
  assert(canPublish({ ...verified, state: "REJECTED" }).reason === "rejected_never_published", "C16: 被驳回不可发布");
  assert(canPublish({ ...verified, state: "RETIRED" }).reason === "retired_never_published", "C16: 已退役不可发布");
  assert(canPublish(null).reason === "invalid_experience", "C16: 非对象不可发布（fail-closed）");
  assert(canPublish({ ...verified, verification: null }).reason === "not_verified:missing",
    "C16: 缺验证记录不可发布", canPublish({ ...verified, verification: null }).reason);
  assert(canPublish({ ...verified, verification: { ...verified.verification, status: "UNVERIFIED" } }).reason === "not_verified:UNVERIFIED",
    "C16: 未验证状态不可发布");
  assert(canPublish({ ...verified, verification: { ...verified.verification, method: "ai_judgment" } }).reason === "method_not_machine_checkable",
    "C16: 非机器可校验方法不可发布（模型判断不算证据）");
  assert(VERIFICATION_METHODS.includes("ai_judgment") === false, "C16: ai_judgment 不在机器可校验方法白名单");
  assert(canPublish({ ...verified, verification: { ...verified.verification, evidence: null } }).reason === "no_evidence_record",
    "C16: 无证据记录不可发布");
  assert(canPublish({ ...verified, lastVerifiedAt: 0 }).reason === "no_last_verified_at", "C16: 无验证时间戳不可发布");
  assert(canPublish({ ...verified, sourceEventSeqs: [] }).reason === "no_provenance_anchors", "C16: 无回源锚点不可发布");
  assert(canPublish({ ...verified, body: verified.body + " " + FAKES.openai }).reason === "contains_secret",
    "C16: 含密钥的经验不可发布（密钥红线）");
  assert(canPublish({ ...verified, body: "x".repeat(MAX_EXPERIENCE_JSON_BYTES + 100) }).reason === "record_too_large",
    "C16: 超界记录不可发布（有界性）");

  // (2) 单条可发布性判定（publish 与 validate 共用的唯一入口）
  assert(isPublishable(verified) === true, "C16: isPublishable 正向");
  assert(isPublishable(null) === false && isPublishable("x") === false && isPublishable({}) === false,
    "C16: isPublishable 对非对象/空对象 fail-closed");
  assert(isPublishable({ ...verified, state: "PROPOSED" }) === false, "C16: PROPOSED 不可发布");
  assert(isPublishable({ ...verified, verification: { ...verified.verification, status: "UNVERIFIED" } }) === false,
    "C16: 未验证不可发布");
  assert(isPublishable({ ...verified, lastVerifiedAt: null }) === false, "C16: 无时间戳不可发布");
  assert(isPublishable({ ...verified, sourceEventSeqs: [] }) === false, "C16: 无锚点不可发布");
  assert(isPublishable({ ...verified, verification: { ...verified.verification, method: "ai_judgment" } }) === false,
    "C16: 非机器可校验方法不可发布");

  // (3) 发布：确定性 + 幂等 + 去重 + 反陈旧覆盖 + 有界 + 产物可被校验器接受
  const g0 = emptyGlobalStore();
  assert(g0.schemaVersion === GLOBAL_STORE_SCHEMA_VERSION && g0.kind === GLOBAL_STORE_KIND && g0.version === 0,
    "C16: emptyGlobalStore 形状/版本正确");
  assert(Array.isArray(g0.experiences) && g0.experiences.length === 0 && Array.isArray(g0.telemetry),
    "C16: emptyGlobalStore 空数组字段");
  assert(emptyGlobalStore(1234).updatedAt === 1234, "C16: emptyGlobalStore 接受显式时间戳");

  const p1 = publishToGlobal(g0, verified, { at: 5000 });
  assert(p1.ok === true && p1.published === true, "C16: 已验证经验成功发布");
  assert(p1.value.version === 1 && p1.value.updatedAt === 5000, "C16: 发布后版本号 +1 且时间戳写入");
  assert(p1.value.experiences.length === 1 && p1.value.experiences[0].id === verified.id, "C16: 条目落入全局库");
  // ★ 端到端闭环：发布产物必须能通过全局库校验器（写路径与读路径同构，不得各说各话）
  assert(validateGlobalStore(p1.value) !== null, "C16: 发布产物可被 validateGlobalStore 接受（写/读同构）");

  const idem = publishToGlobal(p1.value, verified, { at: 6000 });
  assert(idem.ok === true && idem.idempotent === true && idem.value.version === 1,
    "C16: 重复发布同一条经验 ⇒ 幂等（不涨版本）");

  // "更新覆盖"：同一条经验被**重新验证**（内容不变 ⇒ 摘要不变 ⇒ 授权仍成立，只有
  // lastVerifiedAt 变晚）⇒ 覆盖旧条目、版本 +1。内容若变了，那就是**另一条**经验
  // （id 不同、须另行取得人类批准）——这正是对象绑定要保证的"批一个只能发一个"。
  const newer = {
    ...verified,
    lastVerifiedAt: 3000,
    verification: { ...verified.verification, lastReverifiedAt: 3000, reverifyCount: 2 },
  };
  const upd = publishToGlobal(p1.value, newer, { at: 7000 });
  assert(upd.ok === true && upd.updated === true && upd.value.version === 2,
    "C16: 更新版本覆盖（新时间戳更晚）", JSON.stringify(upd.reason ?? `updated=${upd.updated}`));

  // 反陈旧覆盖：lastVerifiedAt **不在**对象绑定内（机器重新验证会改写它），所以可以原地降档。
  const stale = publishToGlobal(upd.value, { ...newer, lastVerifiedAt: 2500 }, { at: 8000 });
  assert(stale.ok === false && stale.reason === "stale_overwrite_denied",
    "C16: 反陈旧覆盖：旧时间戳不得回退全局库", JSON.stringify(stale.reason ?? ""));
  assert(stale.value.version === 2, "C16: 被拒的发布不改变全局库版本");

  // 去重按发布签名（taskType|title|successfulMethod）：同标题但不同 id ⇒ 视为同义条目
  const dedup = publishToGlobal(upd.value, publishable({ title: verified.title, id: "another-id", lastVerifiedAt: 3000 }), { at: 9000 });
  assert(dedup.ok === true && dedup.deduplicated === true,
    "C16: 同义条目按签名去重（不被同义条目淹没）", JSON.stringify(dedup.reason ?? ""));
  assert(dedup.value.experiences.length === 1, "C16: 去重后条目数不变");

  const unverifiedPublish = publishToGlobal(upd.value, ap.experience, { at: 10000 });
  assert(unverifiedPublish.ok === false && unverifiedPublish.reason === "not_verified:UNVERIFIED",
    "C16: 未验证经验发布被拒且原因可解释");
  assert(unverifiedPublish.value.version === 2, "C16: 被拒发布不改动全局库");
  const proposedPublish = publishToGlobal(upd.value, draft.value, { at: 10000 });
  assert(proposedPublish.ok === false && proposedPublish.reason === "proposed_never_published",
    "C16: 提案发布被拒（提案 ≠ 激活）");

  assert(publishToGlobal(null, verified, { at: 1 }).ok === true, "C16: 畸形全局库入参 ⇒ 重建空库而非崩溃");
  assert(publishToGlobal(null, verified, { at: 1 }).value.kind === GLOBAL_STORE_KIND, "C16: 重建的是合法全局库");

  // 排序：最近验证的排最前（跨会话复用时优先最新）
  const second = publishable({ title: "Another verified lesson", id: "exp-second", lastVerifiedAt: 4000 });
  const p2 = publishToGlobal(p1.value, second, { at: 11000 });
  assert(p2.value.experiences.length === 2 && p2.value.experiences[0].id === "exp-second",
    "C16: 全局库按 lastVerifiedAt 降序（最新在前）");

  // 有界：满库拒绝（构造 500 条**签名各不相同**的合法条目，否则会先被去重拦下）
  const many = [];
  for (let i = 0; i < MAX_GLOBAL_EXPERIENCES; i++) {
    many.push({ ...verified, id: `bulk-${i}`, title: `Bulk lesson ${i}` });
  }
  const full = { ...emptyGlobalStore(1), version: 1, experiences: many };
  const fullRes = publishToGlobal(full, verified, { at: 12000 });
  assert(fullRes.ok === false && fullRes.reason === "global_store_full", "C16: 全局库有界（满库拒绝新条目）",
    JSON.stringify(fullRes.reason));

  // 签名：确定性 + 结构性（同内容同签名；无对象返回空串）
  assert(publishSignature(verified) === publishSignature({ ...verified }), "C16: 发布签名确定性");
  assert(publishSignature(verified) !== publishSignature({ ...verified, title: verified.title + " v2" }),
    "C16: 标题不同 ⇒ 签名不同");
  assert(publishSignature(null) === "" && publishSignature("x") === "", "C16: 非对象签名空串");

  // (4) 全局库校验：fail-closed（一个坏条目 ⇒ 整库判废，绝不"部分信任"）
  const good = p1.value;
  assert(validateGlobalStore(good) !== null, "C16: 合法全局库通过校验");
  assert(validateGlobalStore(good) === good, "C16: 校验通过时原样返回（不静默改写）");
  for (const [name, bad] of [
    ["null", null], ["数组", []], ["字符串", "x"], ["空对象", {}],
    ["schemaVersion 不符", { ...good, schemaVersion: 999 }],
    ["kind 不符", { ...good, kind: "wrong-kind" }],
    ["version 非法", { ...good, version: -1 }],
    ["experiences 非数组", { ...good, experiences: "x" }],
    ["telemetry 非数组", { ...good, telemetry: "x" }],
    ["experiences 超界", { ...good, experiences: many.concat(many) }],
  ]) {
    assert(validateGlobalStore(bad) === null, `C16: 全局库校验 fail-closed —— ${name}`);
  }
  assert(validateGlobalStore({ ...good, experiences: [{ ...verified, state: "PROPOSED" }] }) === null,
    "C16: ★ 含未验证/提案条目的全局库整体判废（跨会话污染防线）");
  assert(validateGlobalStore({ ...good, experiences: [{ ...verified, body: "" }] }) === null,
    "C16: 含结构坏条目的全局库整体判废");
  assert(validateGlobalStore({ ...good, experiences: [verified, verified] }) === null,
    "C16: 重复 id 的全局库整体判废");
  assert(validateGlobalStore({ ...good, experiences: [{ ...verified, body: "x".repeat(MAX_EXPERIENCE_JSON_BYTES + 100) }] }) === null,
    "C16: 含超界条目的全局库整体判废");
  assert(validateGlobalStore({ ...good, experiences: [{ ...verified, body: verified.body + " " + FAKES.aws }] }) === null,
    "C16: 含密钥条目的全局库整体判废（密钥红线在全局库同样成立）");
  assert(validateGlobalStore({ ...good, telemetry: [{ kind: "not_a_kind" }] }) === null,
    "C16: 遥测类型不在白名单 ⇒ 整库判废");
  assert(validateGlobalStore({ ...good, telemetry: [{ kind: TELEMETRY_KINDS[0] }] }) !== null,
    "C16: 合法遥测类型通过");
  assert(validateGlobalStore(validated => validated) === null, "C16: 函数等非对象入参 fail-closed");

  // (5) 全局召回入口（Layer B 读路径）：不得崩、不得静默丢条目
  assert(globalRecall(null, "cache").ok === true, "C16: 无全局库时召回仍可用");
  assert(globalRecall(good, "").reason === "empty_query", "C16: 空查询 ⇒ empty_query（不噪声召回）");
  const gq = globalRecall(good, "verified lesson cache", { now: 3000, env: { runtime: "dsh" } });
  assert(gq.ok === true, "C16: 全局召回返回结构化结果");
  assert(gq.items.some((i) => i.id === verified.id) || (Array.isArray(gq.blocked) && gq.blocked.some((b) => b.id === verified.id)),
    "C16: 全局条目要么进入可复用结果、要么被适用性检查留痕（绝不静默消失）",
    `items=${gq.items.length} blocked=${(gq.blocked ?? []).length}`);
  // 召回结果是一个**投影视图**（不是经验对象本身）——它必须自带回源锚点与验证状态，
  // 否则复用方无法回溯原始会话、也无法判断"这条到底验没验过"。
  assert(gq.items.every((i) => typeof i.id === "string" && i.id
    && Array.isArray(i.sourceEventSeqs) && i.sourceEventSeqs.length > 0
    && typeof i.scope === "string"),
    "C16: 召回条目自带 id/scope/回源锚点", JSON.stringify(gq.items[0] ?? null).slice(0, 120));
  assert(gq.items.every((i) => i.scope !== "global" || i.verificationStatus === "VERIFIED"),
    "C16: ★ 跨会话（global）召回条目必然处于已验证状态（Layer B 只含已验证经验）",
    JSON.stringify(gq.items.map((i) => [i.scope, i.verificationStatus])));
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
