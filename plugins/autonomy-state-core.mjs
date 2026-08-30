// autonomy-state-core.mjs — P3 Task Autonomy 状态纯逻辑（无外部依赖）
//
// 职责（对应 docs/roadmap/reports/PHASE_03_AUTONOMY/DESIGN_R1.md）：
//   1. EC IntentStore schema v3 的 `autonomy` 子对象：默认值 / 清洗 / 迁移（幂等、只增不清）。
//   2. 验收标准证据 upsert + verificationState 派生（Executor Claim != Verified Result：
//      只有 acceptance criteria 有证据 PASS 才可 VERIFIED）。
//   3. buildResumeProgressLine —— 恢复注入行（"从 last verified state 续跑，不重做已验证里程碑"）。
//
// 纪律：
//   - 字段白名单严格裁剪（最小 EC metadata，不形成第二状态源）；
//   - acceptanceCriteria write-once（事实源仍是 Official Goal，EC 只存派生持久化）；
//   - evidenceClass 枚举按 Goal 合同证据优先级排序（高→低）：
//     system_api > file_hash > git > browser_state > screenshot > ai_judgment；
//   - 上限与 supervisor-bridge-core 对齐（MAX_ACCEPTANCE_ITEMS=12、单条 ≤500）。
// 本模块不依赖任何 DSH 运行时，仅使用标准 JS 类型。

export const AUTONOMY_SCHEMA_VERSION = 3;
export const MAX_ACCEPTANCE_ITEMS = 12; // 与 supervisor-bridge-core.MAX_ACCEPTANCE_ITEMS 对齐
export const MAX_ACCEPTANCE_LEN = 500;  // 与 supervisor-bridge-core.validateAcceptanceCriteria 对齐
export const MAX_MILESTONES = 50;
export const MAX_STEP_LEN = 300;
export const MAX_EVIDENCE_LEN = 300;
export const MAX_CHECKPOINT_LEN = 500;
export const MAX_REMAINING_STEPS = 12;
export const MAX_ERROR_CLASS_LEN = 100;

/** 证据优先级（高→低），仅作记录/展示；判定纪律由 policy 层与工具描述约束。 */
export const EVIDENCE_CLASSES = Object.freeze([
  "system_api",
  "file_hash",
  "git",
  "browser_state",
  "screenshot",
  "ai_judgment",
]);

export const CRITERION_STATUSES = Object.freeze(["PASS", "FAIL", "UNVERIFIED"]);
export const VERIFICATION_STATES = Object.freeze(["UNVERIFIED", "PARTIAL", "VERIFIED", "FAILED"]);

/** schema v3 默认 autonomy 子对象（全部可空/空数组）。 */
export function emptyAutonomy() {
  return {
    acceptanceCriteria: null,   // string[] | null（write-once）
    criteriaEvidence: null,     // Array<{index,status,evidenceClass,evidence,at}> | null
    verifiedMilestones: [],     // Array<{at,step,evidenceClass,evidence}>
    currentStep: null,          // string | null（当前步骤 / next action）
    remainingSteps: null,       // string[] | null（必要时）
    lastProgressAt: null,       // number | null
    lastVerifiedCheckpoint: null, // string | null（恢复续跑锚点）
    verificationState: null,    // UNVERIFIED|PARTIAL|VERIFIED|FAILED|null（派生）
    lastErrorClass: null,       // string | null
  };
}

function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 校验验收标准数组（1..12 条、每条非空字符串 ≤500，超限/非法拒绝——与 bridge 语义一致）。 */
function sanitizeAcceptanceCriteria(raw) {
  if (!Array.isArray(raw)) return { error: "invalid_acceptance_criteria" };
  if (raw.length < 1 || raw.length > MAX_ACCEPTANCE_ITEMS) return { error: "invalid_acceptance_criteria" };
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") return { error: "invalid_acceptance_criteria" };
    const t = item.trim();
    if (!t || t.length > MAX_ACCEPTANCE_LEN) return { error: "invalid_acceptance_criteria" };
    out.push(t);
  }
  return { value: out };
}

/** 校验单条证据记录。 */
function sanitizeCriterionResult(entry) {
  if (!isPlainObject(entry)) return { error: "invalid_criterion_result" };
  const index = entry.index;
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCEPTANCE_ITEMS) return { error: "invalid_criterion_index" };
  if (!CRITERION_STATUSES.includes(entry.status)) return { error: "invalid_criterion_status" };
  const evidenceClass = EVIDENCE_CLASSES.includes(entry.evidenceClass) ? entry.evidenceClass : null;
  if (!evidenceClass) return { error: "invalid_evidence_class" };
  const evidence = entry.status === "UNVERIFIED" ? cleanStr(entry.evidence, MAX_EVIDENCE_LEN) : cleanStr(entry.evidence, MAX_EVIDENCE_LEN);
  if (entry.status !== "UNVERIFIED" && !evidence) return { error: "missing_evidence" };
  const at = Number.isFinite(entry.at) ? entry.at : Date.now();
  return { value: { index, status: entry.status, evidenceClass, evidence, at } };
}

/**
 * 按 criterion index upsert 一条证据记录（Executor Claim != Verified Result 的落点）。
 * @returns {{ ok: boolean, value?: Array, error?: string }}
 */
export function upsertCriterionResult(list, entry) {
  const v = sanitizeCriterionResult(entry);
  if (v.error) return { ok: false, error: v.error };
  const base = Array.isArray(list) ? list.filter((e) => isPlainObject(e)) : [];
  const next = base.filter((e) => e.index !== v.value.index);
  next.push(v.value);
  next.sort((a, b) => a.index - b.index);
  return { ok: true, value: next.slice(0, MAX_ACCEPTANCE_ITEMS) };
}

/** 派生验收总体判定：全部 criteria PASS → VERIFIED；任一 FAIL → FAILED；部分 PASS → PARTIAL；其余 → UNVERIFIED；无 criteria → null。 */
export function deriveVerificationState(criteria, evidence) {
  if (!Array.isArray(criteria) || criteria.length === 0) return null;
  const byIndex = new Map();
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      if (isPlainObject(e) && Number.isInteger(e.index) && CRITERION_STATUSES.includes(e.status)) {
        byIndex.set(e.index, e.status); // upsert 语义：同 index 后写覆盖
      }
    }
  }
  let anyPass = false, anyFail = false, anyUnverified = false;
  for (let i = 0; i < criteria.length; i++) {
    const s = byIndex.get(i) || "UNVERIFIED";
    if (s === "FAIL") anyFail = true;
    else if (s === "PASS") anyPass = true;
    else anyUnverified = true;
  }
  if (anyFail) return "FAILED";
  if (anyPass && anyUnverified) return "PARTIAL";
  if (anyPass) return "VERIFIED";
  return "UNVERIFIED";
}

/**
 * 清洗并合并一个 autonomy PATCH（字段白名单 + 上限 + write-once）。
 * @param {object} raw - 部分字段 patch（未知字段丢弃）
 * @param {object} existing - 当前 autonomy（可为 null/undefined → emptyAutonomy）
 * @returns {{ ok: boolean, value?: object, errors?: string[] }}
 */
export function sanitizeAutonomy(raw, existing) {
  const cur = isPlainObject(existing) ? { ...emptyAutonomy(), ...existing } : emptyAutonomy();
  const errors = [];
  const out = { ...cur };
  if (!isPlainObject(raw)) return { ok: true, value: out, errors };

  // acceptanceCriteria —— write-once：已有非空值时拒绝覆盖。
  if (raw.acceptanceCriteria !== undefined) {
    if (Array.isArray(cur.acceptanceCriteria) && cur.acceptanceCriteria.length > 0) {
      errors.push("immutable_acceptance_criteria");
    } else {
      const ac = sanitizeAcceptanceCriteria(raw.acceptanceCriteria);
      if (ac.error) errors.push(ac.error);
      else out.acceptanceCriteria = ac.value;
    }
  }

  // criteriaEvidence —— 整表替换（须全部合法；常规写入走 upsertCriterionResult）。
  if (raw.criteriaEvidence !== undefined) {
    if (raw.criteriaEvidence === null) {
      out.criteriaEvidence = null;
    } else if (Array.isArray(raw.criteriaEvidence)) {
      const merged = [];
      let bad = false;
      for (const e of raw.criteriaEvidence) {
        const v = sanitizeCriterionResult(e);
        if (v.error) { errors.push(v.error); bad = true; break; }
        merged.push(v.value);
      }
      if (!bad) {
        merged.sort((a, b) => a.index - b.index);
        out.criteriaEvidence = merged.slice(0, MAX_ACCEPTANCE_ITEMS);
      }
    } else {
      errors.push("invalid_criteria_evidence");
    }
  }

  // verifiedMilestones —— 整表替换；上限 FIFO（保留最新 50 条）。
  if (raw.verifiedMilestones !== undefined) {
    if (raw.verifiedMilestones === null) {
      out.verifiedMilestones = [];
    } else if (Array.isArray(raw.verifiedMilestones)) {
      const list = [];
      let bad = false;
      for (const m of raw.verifiedMilestones) {
        if (!isPlainObject(m)) { errors.push("invalid_milestone"); bad = true; break; }
        const step = cleanStr(m.step, MAX_STEP_LEN);
        const evidenceClass = EVIDENCE_CLASSES.includes(m.evidenceClass) ? m.evidenceClass : null;
        const evidence = cleanStr(m.evidence, MAX_EVIDENCE_LEN);
        if (!step || !evidenceClass) { errors.push("invalid_milestone"); bad = true; break; }
        list.push({ at: Number.isFinite(m.at) ? m.at : Date.now(), step, evidenceClass, evidence });
      }
      if (!bad) out.verifiedMilestones = list.slice(-MAX_MILESTONES);
    } else {
      errors.push("invalid_milestones");
    }
  }

  if (raw.currentStep !== undefined) out.currentStep = raw.currentStep === null ? null : cleanStr(raw.currentStep, MAX_STEP_LEN);
  if (raw.remainingSteps !== undefined) {
    if (raw.remainingSteps === null) out.remainingSteps = null;
    else if (Array.isArray(raw.remainingSteps)) {
      const steps = raw.remainingSteps
        .map((s) => cleanStr(s, MAX_STEP_LEN))
        .filter((s) => s !== null)
        .slice(0, MAX_REMAINING_STEPS);
      out.remainingSteps = steps.length > 0 ? steps : null;
    } else errors.push("invalid_remaining_steps");
  }
  if (raw.lastProgressAt !== undefined) out.lastProgressAt = Number.isFinite(raw.lastProgressAt) ? raw.lastProgressAt : null;
  if (raw.lastVerifiedCheckpoint !== undefined) out.lastVerifiedCheckpoint = raw.lastVerifiedCheckpoint === null ? null : cleanStr(raw.lastVerifiedCheckpoint, MAX_CHECKPOINT_LEN);
  if (raw.verificationState !== undefined) out.verificationState = VERIFICATION_STATES.includes(raw.verificationState) ? raw.verificationState : null;
  if (raw.lastErrorClass !== undefined) out.lastErrorClass = raw.lastErrorClass === null ? null : cleanStr(raw.lastErrorClass, MAX_ERROR_CLASS_LEN);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out, errors };
}

/**
 * 构建恢复注入行（EC resume 消息附加段）。空状态返回 null（不注入，行为与历史一致）。
 * @param {object|null} a - autonomy 子对象
 * @returns {string|null}
 */
export function buildResumeProgressLine(a) {
  if (!isPlainObject(a)) return null;
  const parts = [];
  if (a.currentStep) parts.push(`current step "${a.currentStep}"`);
  const ms = Array.isArray(a.verifiedMilestones) ? a.verifiedMilestones : [];
  if (ms.length > 0) {
    const last = ms[ms.length - 1];
    parts.push(`milestones verified: ${ms.length}${last && last.step ? ` (last "${last.step}")` : ""}`);
  }
  if (Array.isArray(a.acceptanceCriteria) && a.acceptanceCriteria.length > 0) {
    const ev = Array.isArray(a.criteriaEvidence) ? a.criteriaEvidence : [];
    const pass = ev.filter((e) => e && e.status === "PASS").length;
    parts.push(`acceptance ${pass}/${a.acceptanceCriteria.length} PASS`);
  }
  if (a.lastVerifiedCheckpoint) parts.push(`last verified checkpoint: "${a.lastVerifiedCheckpoint}"`);
  if (parts.length === 0) return null;
  const tail = (ms.length > 0 || a.lastVerifiedCheckpoint)
    ? " Continue from the last verified state; do not redo verified milestones."
    : ".";
  return `Verified progress: ${parts.join("; ")}${tail}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// P3 AUTONOMY R1 Correction（外审 Round 1 blocker, AC5 deterministic verifier）：
// 高可信 evidenceClass（file_hash / system_api）不得仅凭模型自述字符串升级
// PASS/VERIFIED。PASS 前必须由宿主执行独立 deterministic 复核；无法复核一律
// fail-closed（UNVERIFIED、不计 PASS、不建里程碑、不写 checkpoint）。
// evidenceClass 记录语义随之收紧：一条 status=PASS 且 evidenceClass=file_hash/
// system_api 的记录 ⇒ 宿主复核已成功（证据文本带 HOST-VERIFIED 前缀）；
// 模型自称该 class 拿不到对应信任级别。
// 本节仍保持"纯逻辑 + io 注入"，不引入 DSH 运行时依赖。
// ═══════════════════════════════════════════════════════════════════════════

/** 声称宿主可确定性复核的证据类别（证据优先级最高的两档）。 */
export const HOST_VERIFIABLE_CLASSES = Object.freeze(["system_api", "file_hash"]);

/** 证据机器可校验规范说明（工具描述/错误提示共用，保持单一来源）。 */
export function describeEvidenceSpec() {
  return "file_hash spec: 'file:<absolute-path>|sha256:<64-hex>|<optional note>'; " +
    "system_api spec: 'api:port=<n>|path=</api/...>|expectStatus=<code>[|expectContains=<substr>]|<optional note>' (loopback 127.0.0.1 only)";
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** 解析 file_hash 证据规范 → {ok,value:{path,sha256,note}} | {ok:false,reason}。 */
export function parseFileHashEvidence(evidence) {
  if (typeof evidence !== "string") return { ok: false, reason: "format_invalid:not_a_string" };
  const t = evidence.trim();
  if (!t.startsWith("file:")) return { ok: false, reason: "format_invalid:missing_file_prefix" };
  const segments = t.slice(5).split("|");
  const p = (segments[0] ?? "").trim();
  if (!p) return { ok: false, reason: "format_invalid:path_missing" };
  if (!ABSOLUTE_PATH.test(p)) return { ok: false, reason: "format_invalid:path_not_absolute" };
  const hashSeg = (segments[1] ?? "").trim();
  const m = hashSeg.match(/^sha256:([0-9a-fA-F]{64})$/);
  if (!m) return { ok: false, reason: "format_invalid:sha256_segment_missing_or_invalid" };
  const note = segments.slice(2).join("|").trim();
  return { ok: true, value: { path: p, sha256: m[1].toLowerCase(), note: note || null } };
}

/** 解析 system_api 证据规范 → {ok,value:{port,path,expectStatus,expectContains,note}} | {ok:false,reason}。 */
export function parseSystemApiEvidence(evidence) {
  if (typeof evidence !== "string") return { ok: false, reason: "format_invalid:not_a_string" };
  const t = evidence.trim();
  if (!t.startsWith("api:")) return { ok: false, reason: "format_invalid:missing_api_prefix" };
  const segments = t.slice(4).split("|");
  const kv = {};
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq < 1) {
      // 无 "=" 的段 = 自由文本 note（首个生效；出现第二个 → 拒绝，保持规范确定性）。
      if (kv.note === undefined) { kv.note = s; continue; }
      return { ok: false, reason: `format_invalid:unexpected_segment:${s.slice(0, 30)}` };
    }
    kv[s.slice(0, eq).trim().toLowerCase()] = s.slice(eq + 1).trim();
  }
  const port = Number(kv.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "format_invalid:port" };
  if (!kv.path || !kv.path.startsWith("/")) return { ok: false, reason: "format_invalid:path" };
  const expectStatus = Number(kv.expectstatus);
  if (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) return { ok: false, reason: "format_invalid:expect_status" };
  const expectContains = kv.expectcontains && kv.expectcontains.length > 0 ? kv.expectcontains : null;
  const note = kv.note ?? null;
  // 安全边界：宿主固定只打 127.0.0.1 回环，host/port 之外的目标在规范里不存在。
  return { ok: true, value: { port, path: kv.path, expectStatus, expectContains, note } };
}

/**
 * 宿主侧独立 deterministic 复核。io 可注入（测试）；缺省用 node:crypto/node:fs/promises
 * 与全局 fetch（system_api 仅回环 127.0.0.1，POST，3s 超时）。
 * @returns {Promise<{verified: boolean, reason: string|null, detail: string|null}>}
 */
export async function hostVerifyEvidence(evidenceClass, evidence, io = null) {
  if (!HOST_VERIFIABLE_CLASSES.includes(evidenceClass)) {
    return { verified: false, reason: "class_not_host_verifiable", detail: null };
  }
  const d = io ?? await defaultHostIo();
  if (evidenceClass === "file_hash") {
    const p = parseFileHashEvidence(evidence);
    if (!p.ok) return { verified: false, reason: p.reason, detail: null };
    let data;
    try {
      data = await d.readFile(p.value.path);
    } catch (e) {
      const code = e && typeof e === "object" ? e.code : undefined;
      return { verified: false, reason: code === "ENOENT" ? "file_missing" : "read_error", detail: String(code ?? e?.message ?? e).slice(0, 80) };
    }
    const actual = String(await d.sha256Hex(data)).toLowerCase();
    if (actual !== p.value.sha256) {
      return { verified: false, reason: "hash_mismatch", detail: `expected=${p.value.sha256} actual=${actual}` };
    }
    return { verified: true, reason: null, detail: `sha256=${actual} host-verified` };
  }
  // system_api：仅回环；任何解析外目标不可表达（parse 已把 host 固定为 127.0.0.1）。
  const p = parseSystemApiEvidence(evidence);
  if (!p.ok) return { verified: false, reason: p.reason, detail: null };
  const url = `http://127.0.0.1:${p.value.port}${p.value.path}`;
  let res;
  try {
    res = await d.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    const code = e && typeof e === "object" ? (e.cause?.code ?? e.name) : undefined;
    return { verified: false, reason: "request_failed", detail: String(code ?? e?.message ?? e).slice(0, 80) };
  }
  if (res.status !== p.value.expectStatus) {
    return { verified: false, reason: "status_mismatch", detail: `expected=${p.value.expectStatus} actual=${res.status}` };
  }
  if (p.value.expectContains !== null) {
    let body = "";
    try { body = await res.text(); } catch { /* body unreadable → contains check fails */ }
    if (!body.includes(p.value.expectContains)) {
      return { verified: false, reason: "contains_mismatch", detail: `expectContains=${JSON.stringify(p.value.expectContains).slice(0, 60)}` };
    }
  }
  return { verified: true, reason: null, detail: `${res.status} ${url} host-verified` };
}

async function defaultHostIo() {
  const [crypto, fsp] = await Promise.all([import("node:crypto"), import("node:fs/promises")]);
  return {
    readFile: (p) => fsp.readFile(p),
    sha256Hex: (data) => crypto.createHash("sha256").update(data).digest("hex"),
    fetchImpl: (url, opts) => fetch(url, opts),
  };
}
