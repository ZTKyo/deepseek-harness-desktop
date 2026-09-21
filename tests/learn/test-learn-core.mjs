// test-learn-core.mjs —— P4 LEARN R1 纯逻辑单测（repo 直连，无外部依赖）
//
// 覆盖 learn-core.mjs：
//   C1  emptyStore 默认形状 + schema 版本
//   C2  密钥脱敏：9 个规范家族全覆盖 + 通用形态 + 确定性（AC3）
//   C3  makeExperience 校验（缺 title/body/sourceSeqs 一律拒绝）
//   C4  propose：永远 PROPOSED（提案 ≠ 激活）+ 同证据幂等去重（AC2）
//   C5  approve：必须带审批人 + 证据；缺任一项拒绝（人工审批边界，AC2）
//   C6  状态迁移白名单：REJECTED/RETIRED 为终态，不得复活（fail-closed）
//   C7  recall：只召回 APPROVED + 确定性（同一输入同一输出）+ 回源锚点（AC4）
//   C8  validateStore：损坏/越界/坏条目 → null（fail-closed，AC5）
//   C9  promotionEligibility：资格判定不改变状态；promote 需显式证据（AC11）
//   C10 assertWriteAllowed：runtime/goals/credentials/policy 一律拒绝（AC10）
//   C11 telemetryEvent：结构化 + 脱敏 + 有界环形缓冲（AC8）
//   C12 buildLearnDigest：复用 P2.5 官方提取器；跳过插件注入消息（AC1）
//   C13 learningSignals：确定性启发式信号
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
  P25_EXTRACTORS,
} from "../../plugins/learn-core.mjs";
// AC1 直证：P2.5 官方提取器本体（P4 必须复用同一实现，不得另起 parser）
import {
  messageOfEvent as p25MessageOfEvent,
  recursiveText as p25RecursiveText,
  isPluginSourced as p25IsPluginSourced,
} from "../../plugins/context-memory-core.mjs";

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
  assert(LEARN_SCHEMA_VERSION === 1, "schema version is 1", `got ${LEARN_SCHEMA_VERSION}`);
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

section("C5: approval boundary requires approver + evidence (AC2)");
{
  let store = emptyStore("s1");
  store = propose(store, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id = store.experiences[0].id;
  const noApprover = approve(store, id, { evidence: "verified by test run" });
  assert(noApprover.ok === false && noApprover.error === "approval_requires_approver", "approval without approver rejected");
  const noEvidence = approve(store, id, { approver: "human" });
  assert(noEvidence.ok === false && noEvidence.error === "approval_requires_evidence", "approval without evidence rejected");
  const secretEvidence = approve(store, id, { approver: "human", evidence: `proof ${FAKES.github}` });
  assert(secretEvidence.ok === false && secretEvidence.error === "approval_evidence_contains_secret", "secret in evidence rejected");
  const missing = approve(store, id + "nope", { approver: "human", evidence: "e" });
  assert(missing.ok === false && missing.error === "experience_not_found", "unknown id rejected");
  const ok = approve(store, id, { approver: "human-operator", evidence: "ran suite: 12 PASS", at: 1000 });
  assert(ok.ok === true, "valid approval accepted");
  assert(ok.value.experiences[0].state === "APPROVED", "state APPROVED");
  assert(ok.value.experiences[0].approvedBy === "human-operator", "approver recorded");
  assert(ok.value.experiences[0].approvedAt === 1000, "approvedAt recorded");
  assert(isRecallable(ok.value.experiences[0]) === true, "APPROVED is recallable");
  // 不可变：原 store 未被就地修改
  assert(store.experiences[0].state === "PROPOSED", "original store not mutated (immutable update)");
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
  s2 = approve(s2, id2, { approver: "h", evidence: "e" }).value;
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
  store = approve(store, store.experiences[0].id, { approver: "h", evidence: "e1", at: 1 }).value;
  store = approve(store, store.experiences[1].id, { approver: "h", evidence: "e2", at: 2 }).value;

  const r = recall(store, "npm install failed");
  assert(r.ok === true, "recall ok");
  assert(r.items.length === 1, "only approved+scoring item returned", `got ${r.items.length}`);
  assert(r.items[0].title === "Use pnpm for install", "correct item recalled");
  assert(r.excluded === 1, "unapproved entry excluded", `excluded=${r.excluded}`);
  assert(Array.isArray(r.items[0].sourceEventSeqs) && r.items[0].sourceEventSeqs[0] === 1, "provenance returned for re-sourcing");
  assert(r.items[0].approvedBy === "h", "approver surfaced");

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
  const promotedNoEvidence = { ...s.experiences[0], state: "APPROVED", approvedBy: "h", approvalEvidence: "e", promotion: "PROMOTED", promotionEvidence: null };
  assert(sanitizeExperience(promotedNoEvidence).error === "promoted_without_evidence", "PROMOTED without evidence rejected");
}

section("C9: promotion eligibility vs promotion (AC11)");
{
  let store = emptyStore("s1");
  store = propose(store, { title: "T", body: "B", sourceEventSeqs: [1], originSessionId: "s1" }).value;
  const id = store.experiences[0].id;
  const e0 = promotionEligibility(store.experiences[0]);
  assert(e0.eligible === false && e0.state === "NONE", "PROPOSED not eligible", JSON.stringify(e0));
  store = approve(store, id, { approver: "h", evidence: "e", at: 1 }).value;
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

section("C13: learning signals are deterministic");
{
  const digest = { turns: [{ seq: 1, role: "user", text: "the build failed" }, { seq: 2, role: "assistant", text: "use pnpm instead" }, { seq: 3, role: "user", text: "fixed now" }] };
  const s = learningSignals(digest);
  assert(s.hasSignal === true, "signals detected");
  assert(s.signals.length === 3, "three signals", `got ${s.signals.length}`);
  assert(s.signals[0].kind === "failure" && s.signals[1].kind === "correction" && s.signals[2].kind === "resolution", "kinds classified");
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

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
