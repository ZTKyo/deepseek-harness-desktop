// 只读取证：从生产经验库（%LOCALAPPDATA%\DSHHarness\state\learn\<sid>.json）抽出
// AC2 研究腿闭环的原始记录（腿自身 + 对偶遥测 + 两条对照经验）。
// 严格只读：仅 fs.readFileSync，不写任何 store 文件（AGENTS.md：storages/state 只能通过 GUI/API 写）。
// 用法：node _ac2-store-extract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SID = 'session-76de1ca9-0a7a-4ad4-97b1-750a3dabbaf8';
const store = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'DSHHarness', 'state', 'learn', `${SID}.json`);

const raw = fs.readFileSync(store, 'utf8');
const j = JSON.parse(raw);

const out = {
  storePath: store,
  storeBytes: Buffer.byteLength(raw, 'utf8'),
  readAt: new Date().toISOString(),
  schemaVersion: j.schemaVersion ?? null,
  updatedAt: j.updatedAt ?? null,
  evidence: {},
};

// 1) 研究腿自身：openedAt / fulfilledAt / fulfilledBy（时间序硬约束的两个端点）
out.evidence.researchLegs = (j.researchLegs ?? j.legs ?? []).map((l) => ({
  legId: l.legId, subjectKey: l.subjectKey, subject: l.subject, source: l.source,
  candidateKind: l.candidateKind, attemptsUsed: l.attemptsUsed, maxAttempts: l.maxAttempts,
  exhausted: l.exhausted, openedAt: l.openedAt, fulfilledAt: l.fulfilledAt ?? null,
  fulfilledBy: l.fulfilledBy ?? null, persistence: l.persistence ?? null,
}));

// 2) 对偶遥测：开腿 / 闭环 / 验证成功 / 验证失败
const KINDS = new Set(['EXPERIENCE_LOOKUP_MISS', 'RESEARCH_FULFILLED', 'VERIFIED', 'VERIFICATION_FAILED', 'RESEARCH_REQUESTED']);
const tel = (j.telemetry?.events ?? j.telemetry ?? []);
out.evidence.telemetry = (Array.isArray(tel) ? tel : []).filter((e) => KINDS.has(e.kind)).map((e) => ({
  kind: e.kind, at: e.at, experienceId: e.experienceId ?? null, detail: e.detail ?? null,
}));

// 3) 两条对照经验：自动路径（应 VERIFIED）vs 宿主 learn_propose 工具路径（应 UNVERIFIED）
const pick = (id) => {
  const e = (j.experiences ?? []).find((x) => x.id === id);
  if (!e) return null;
  return {
    id: e.id, state: e.state, createdAt: e.createdAt,
    taskType: e.taskType ?? null,
    title: String(e.title ?? '').slice(0, 160),
    verification: e.verification ?? null,
    evidenceClass: e.verificationEvidence?.class ?? null,
    evidenceWindow: e.verificationEvidence?.window ?? null,
    evidenceSessionId: e.verificationEvidence?.sessionId ?? null,
    sourceEventSeqs: e.sourceEventSeqs ?? null,
    originSessionId: e.originSessionId ?? null,
  };
};
out.evidence.contrast = {
  autoPath_verified: pick('exp-e84b6350'),
  hostToolPropose_unverified: pick('exp-a35e8739'),
};

// 4) 全局库：验证通过但未获真人批准 ⇒ 必须不得发布（B1 不变量）
const g = (() => {
  try {
    const gp = path.join(path.dirname(store), '_global-verified.json');
    const gj = JSON.parse(fs.readFileSync(gp, 'utf8'));
    return { path: gp, version: gj.version ?? null, updatedAt: gj.updatedAt ?? null, count: gj.count ?? (gj.experiences ?? []).length,
      ids: (gj.experiences ?? []).map((x) => ({ id: x.id, state: x.state, verificationMethod: x.verificationMethod ?? null })),
      telemetry: (gj.telemetry?.events ?? gj.telemetry ?? []).filter?.((e) => ['GLOBAL_PUBLISHED', 'GLOBAL_PUBLISH_DENIED'].includes(e.kind)).map?.((e) => ({ kind: e.kind, at: e.at, experienceId: e.experienceId ?? null, reason: e.reason ?? null, detail: e.detail ?? null })) ?? [],
    };
  } catch (e) { return { error: String(e.message || e) }; }
})();
out.evidence.globalStore = g;

const text = JSON.stringify(out, null, 2);
// 由 node 自己写 sidecar：避免 PowerShell Tee-Object 的 UTF-16 编码把 JSON 弄坏
fs.writeFileSync(new URL('./AC2_STORE_RAW.json', import.meta.url), text, 'utf8');
console.log(text);
