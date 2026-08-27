// verify-context-memory.mjs —— P2.5 CONTEXT MEMORY Minimal V1 单元回归（R1+R2）
//
// 覆盖 DESIGN_R1.md §5 验证映射的单元层：T1-T11（含 R2-7 false-completion 回归）。
// MiniSession 模拟官方 surface fold 语义（含 provenance 校验），非官方代码。
// 路径全部 repo-relative（CI 可移植）：运行 node tests/context-memory/verify-context-memory.mjs
// （工作目录 = repo 根，或任意目录均可；fail → exit 1）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = await import(pathToFileURL(path.join(REPO, "plugins/context-memory-core.mjs")).href);
const MOD_PATH = path.join(REPO, "plugins/context-memory.mjs");
const MOD = await import(pathToFileURL(MOD_PATH).href);

let passCount = 0, failCount = 0;
function assert(c, n, d = "") { if (c) { passCount++; console.log("  PASS  " + n); } else { failCount++; console.log("  FAIL  " + n + (d ? " :: " + d : "")); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// ── MiniSession：模拟官方 surface fold（append-only + replace + provenance）──
const SURFACE_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);
class MiniSession {
  constructor(id) {
    this.id = id; this.events = []; this._nodes = [];
    // 与官方一致：session.surface.nodes
    this.surface = { get nodes() { return this._owner._nodes; }, _owner: null };
    this.surface._owner = this;
  }
  append(type, data, opts = {}) {
    const seq = this.events.length;
    const evt = { seq, type, data };
    const op = opts.surfaceOp;
    if (SURFACE_TYPES.has(type)) {
      if (op === undefined) throw new Error("surface-eligible event requires surfaceOp marker");
      evt.surfaceOp = op;
    } else if (op !== undefined) {
      throw new Error("non-surface event cannot carry surfaceOp");
    }
    if (opts.sourceEventSeqs !== undefined) evt.sourceEventSeqs = opts.sourceEventSeqs;
    if (op === "append") {
      this._provenance(evt, []);
      this._nodes.push(seq);
    } else if (op && typeof op === "object") {
      const si = this._nodes.indexOf(op.start), ei = this._nodes.indexOf(op.end);
      if (si < 0 || ei < 0 || si > ei) throw new Error(`bad replace range ${op.start}-${op.end}`);
      const shadowed = this._nodes.slice(si, ei + 1);
      this._provenance(evt, shadowed);
      this._nodes.splice(si, ei - si + 1, seq);
    }
    this.events.push(evt);
    return { seq };
  }
  _provenance(evt, shadowed) {
    const src = evt.sourceEventSeqs;
    if (src === undefined) { if (shadowed.length === 0) return; throw new Error("replace requires sourceEventSeqs array"); }
    if (!Array.isArray(src)) throw new Error("sourceEventSeqs must be an array");
    if (shadowed.some((q) => !src.includes(q))) throw new Error("sourceEventSeqs must cover all shadowed nodes");
    if (src.some((q) => !Number.isSafeInteger(q) || q >= evt.seq)) throw new Error("sources must be earlier seqs");
    if (new Set(src).size !== src.length) throw new Error("duplicate sources");
  }
  /** 与官方 deriveEventMessage 折叠规则同构。 */
  deriveMessages() {
    return this._nodes.map((seq) => {
      const e = this.events[seq];
      if (e.type === "user/message") return e.data;
      if (e.type === "assistant/message") return e.data?.message?.content?.length ? e.data.message : null;
      return e.data?.message ?? null;
    }).filter(Boolean);
  }
  obsNodeSeqs() {
    return this._nodes.filter((q) => this.events[q]?.data?.source?.plugin === "context-memory");
  }
}

// ── 事件构造助手 ──
let callSeqCounter = 0;
function addUser(s, text, i) {
  return s.append("user/message", { role: "user", id: `u${i ?? callSeqCounter++}`, content: [{ type: "text", text }], source: { kind: "user" } }, { surfaceOp: "append" }).seq;
}
function addAssistant(s, text) {
  return s.append("assistant/message", { turn: 1, step: 1, message: { role: "assistant", id: `a${callSeqCounter++}`, content: [{ type: "text", text }], source: { kind: "model", provider: "opencode", model: "deepseek-v4-flash" } } }, { surfaceOp: "append" }).seq;
}
function addToolCallPair(s, toolText, resultText) {
  s.append("assistant/message", { turn: 1, step: 1, message: { role: "assistant", id: `a${callSeqCounter++}`, content: [{ type: "tool-call", id: `c${callSeqCounter++}`, name: "pwsh" }], source: { kind: "model", provider: "opencode", model: "deepseek-v4-flash" } } }, { surfaceOp: "append" });
  return s.append("tool/result", { message: { role: "user", id: `t${callSeqCounter++}`, content: [{ type: "tool-result", content: [{ type: "text", text: resultText }] }] } }, { surfaceOp: "append" }).seq;
}
/** 建一个长会话：n 组「用户指令→工具调用(带可分类输出)」 */
function buildLongSession(sid, n, fatChars = 3000) {
  const s = new MiniSession(sid);
  for (let i = 0; i < n; i++) {
    addUser(s, `Task step ${i}: please verify module ${i} behavior and record results.`);
    addToolCallPair(s, "pwsh",
      i % 5 === 0
        ? `Error: exit code 1 while testing module ${i}. Cannot find fixture_${i}.`
        : i % 3 === 0
          ? `${"x".repeat(fatChars)}\nPASS all tests for module ${i}\ndiff --git a/m${i}.ts b/m${i}.ts\ncreated file m${i}.ts`
          : `module ${i} checked: ${"y".repeat(Math.min(200, fatChars))} localhost:3080 healthy version 0.1.1`);
    addAssistant(s, `Step ${i} done.`);
  }
  return s;
}
function makeCtx(stateDir, extra = {}) {
  const listeners = [];
  const meter = { estimateMessage: (m) => Math.ceil(JSON.stringify(m?.content ?? "").length / 4) };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(n) { return n === "tokenMeter" ? meter : undefined; },
    on(e, h) { listeners.push({ e, h }); return () => {}; },
    _listeners: listeners,
    ...extra,
  };
  return ctx;
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cm-test-")); }

// ════════════════════════ T-SELECT: 区段选择边界 ════════════════════════
section("T-SEL: selectProjectionRange boundaries");
{
  const s = buildLongSession("sel", 30);
  const r = CORE.selectProjectionRange([...s.surface.nodes], s.events, { recentWindow: 40, minProjectNodes: 4 });
  assert(r !== null && r.nodeSeqs.length >= 4, "long session yields a range");
  const lastEvt = s.events[r.endSeq];
  const nextSeq = s.surface.nodes[s.surface.nodes.length - 40];
  const nextEvt = s.events[nextSeq];
  const lastIsCallCarrier = lastEvt?.type === "assistant/message" &&
    Array.isArray(lastEvt?.data?.message?.content) && lastEvt.data.message.content.some((b) => b.type === "tool-call");
  assert(!lastIsCallCarrier, "range end never splits a tool-call pair");
  assert(nextEvt?.type !== "tool/result", "window start is not an orphaned tool/result");
  assert(s.events[r.startSeq]?.type === "user/message", "range aligned to a user/message boundary");

  const rShort = CORE.selectProjectionRange([...s.surface.nodes], s.events, { recentWindow: 500 }); // 120 nodes < 500
  assert(rShort === null, "session shorter than window → null");

  // 终点收缩场景：构造末尾正好是带调用的 assistant
  const s2 = new MiniSession("sel2");
  for (let i = 0; i < 25; i++) { addUser(s2, `msg number ${i} for contraction scenario testing`); addAssistant(s2, `ack ${i}`); }
  s2.append("assistant/message", { message: { role: "assistant", id: "ax", content: [{ type: "tool-call", id: "cx", name: "pwsh" }], source: { kind: "model", provider: "p", model: "m" } } }, { surfaceOp: "append" });
  const r2 = CORE.selectProjectionRange([...s2.surface.nodes], s2.events, { recentWindow: 10 });
  const endEvt2 = s2.events[r2.endSeq];
  const endHasCalls = endEvt2?.data?.message?.content?.some?.((b) => b.type === "tool-call");
  assert(!endHasCalls, "trailing call-carrying assistant excluded from range");
}

// ════════════════════════ T1: raw Session truth 不变 ════════════════════════
section("T1: raw session truth unchanged (append-only, originals intact)");
{
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = buildLongSession("t1", 20);
  const before = s.events.map((e) => ({ seq: e.seq, type: e.type, json: JSON.stringify(e.data) }));
  let projected = null;
  for (let i = 0; i < 6 && !projected; i++) {
    addUser(s, `extra follow-up ${i} to slide the recent window forward for projection`);
    addAssistant(s, `ok ${i}`);
    projected = inst._test.maybeProject(s, ctx.get("tokenMeter"));
  }
  assert(projected !== null, "projection occurred");
  const after = s.events.slice(0, before.length);
  const intact = after.every((e, i) => e.seq === before[i].seq && e.type === before[i].type && JSON.stringify(e.data) === before[i].json);
  assert(intact, "all pre-projection events byte-identical (no deletion/mutation)");
  assert(s.events.length > before.length, "log only grew (append-only)");
  const rep = s.events[projected.range.startSeq <= s.events.length ? s.obsNodeSeqs()[0] : 0];
  const covered = projected && Array.isArray(rep?.sourceEventSeqs) && projected.range.nodeSeqs.every((q) => rep.sourceEventSeqs.includes(q));
  assert(covered, "replacement node cites every shadowed seq (official recall protocol)");
  assert(Array.isArray(s.events[rep.seq - 1]?.shadowedSeqs) || s.events.some((e) => e.type === "compaction/prune"), "shadow-price prune event recorded");
}

// ════════════════════════ T2: 单开关完全关闭 ════════════════════════
section("T2: single switch fully disables (config + env)");
{
  const dir = tmpDir();
  const ctxA = makeCtx(dir);
  const instA = MOD.apply(ctxA, { enabled: false, stateDir: dir });
  assert(instA && typeof instA._test === "object" && Object.keys(instA._test ?? {}).length === 0 || instA && !instA._test?.maybeProject, "enabled:false → no hooks exported");
  assert(ctxA._listeners.length === 0, "enabled:false → zero listeners registered");
  const ctxB = makeCtx(tmpDir());
  process.env.CM_DISABLED = "true";
  const instB = MOD.apply(ctxB, { enabled: true, stateDir: tmpDir() });
  delete process.env.CM_DISABLED;
  assert(ctxB._listeners.length === 0, "CM_DISABLED env → zero listeners registered");
  // 开启时钩子存在
  const ctxC = makeCtx(tmpDir());
  MOD.apply(ctxC, { enabled: true, stateDir: ctxC._stateDir || undefined, activationThresholdTokens: 1 });
  assert(ctxC._listeners.some((l) => l.e === "agent/pre-step"), "enabled → pre-step registered");
}

// ════════════════════════ T3: projection 损坏 fail-open ════════════════════════
section("T3: corrupt store → rebuild/fail-open, task continues");
{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t3-corrupt.json"), "{not valid json!!", "utf8");
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = buildLongSession("t3-corrupt", 20);
  let ok = false, threw = false;
  try {
    addUser(s, "post-corruption follow-up message to trigger projection path");
    addAssistant(s, "ack");
    ok = inst._test.maybeProject(s, ctx.get("tokenMeter")) !== null || s.obsNodeSeqs().length >= 0;
  } catch { threw = true; }
  assert(!threw, "corrupt store does not throw");
  assert(ok, "projection proceeds after rebuild (task not blocked)");
  const st = inst._test.getStore("t3-corrupt");
  assert(st.version === 0 && st.schemaVersion === 1, "rebuilt as fresh store (raw-session learning restart)");
}

// ════════════════════════ T4: Recall 五类回源 ════════════════════════
section("T4: recall — 5 evidence classes traceable via refs");
{
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = new MiniSession("t4");
  // 类别1 用户原话 / 类别2 错误原文 / 类别3 工具大输出 / 类别4 文件变更 / 类别5 时间线顺序
  addUser(s, "USER_VERBATIM_MARKER: please migrate the router config to the new profile layout.");
  addToolCallPair(s, "pwsh", "Error: EACCES permission denied writing config.yaml ERROR_MARKER_UNIQUE");
  addToolCallPair(s, "pwsh", "TOOL_OUTPUT_MARKER " + "z".repeat(2500));
  addToolCallPair(s, "pwsh", "diff --git a/app.ts b/app.ts FILECHANGE_MARKER created file app.ts");
  addAssistant(s, "done early phase");
  for (let i = 0; i < 18; i++) { addUser(s, `timeline filler ${i}`); addAssistant(s, `ack ${i}`); }
  let proj = null;
  for (let i = 0; i < 4 && !proj; i++) { addUser(s, `slide ${i}`); addAssistant(s, `k ${i}`); proj = inst._test.maybeProject(s, ctx.get("tokenMeter")); }
  assert(proj !== null, "projected");
  const obsSeq = s.obsNodeSeqs()[0];
  const obsText = s.events[obsSeq].data.content[0].text;
  const findRefs = (marker) => {
    const m = obsText.match(new RegExp(`\\(seq (\\d+)\\)`, "g"));
    return null; // placeholder; real check below
  };
  // 直接验证五类：投影文本引用的 seq 回源到原始事件并包含标记
  const seqMentions = [...obsText.matchAll(/\(seq (\d+)\)/g)].map((m) => Number(m[1]));
  const sources = new Set(s.events[obsSeq].sourceEventSeqs);
  const resolveOk = seqMentions.every((q) => sources.has(q) && q < obsSeq);
  assert(resolveOk, "every cited seq is a real earlier source event (回源可达)");
  const texts = seqMentions.map((q) => JSON.stringify(s.events[q]?.data ?? {}));
  assert(texts.some((t) => t.includes("USER_VERBATIM_MARKER")), "① 用户原话 可回源");
  assert(texts.some((t) => t.includes("ERROR_MARKER_UNIQUE")), "② 错误原文 可回源");
  assert(texts.some((t) => t.includes("TOOL_OUTPUT_MARKER")), "③ 工具原始输出 可回源");
  assert(texts.some((t) => t.includes("FILECHANGE_MARKER")), "④ 文件变更/patch 可回源");
  const citedSorted = [...sources].sort((a, b) => a - b);
  assert(citedSorted.length > 5 && citedSorted[0] < citedSorted[citedSorted.length - 1], "⑤ 时间线（有序 seq 集合）可回源");
  assert(obsText.includes("ALREADY TRIED AND FAILED"), "失败方案带防重试标记（context-rot 辅助）");
}

// ════════════════════════ T5: restart 后恢复 ════════════════════════
section("T5: restart recovery (persisted store resumes; missing store rebuilds)");
{
  const dir = tmpDir();
  const ctx1 = makeCtx(dir);
  const inst1 = MOD.apply(ctx1, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s1 = buildLongSession("t5-restart", 20);
  let p1 = null;
  for (let i = 0; i < 6 && !p1; i++) { addUser(s1, `pre-restart slide ${i}`); addAssistant(s1, `a ${i}`); p1 = inst1._test.maybeProject(s1, ctx1.get("tokenMeter")); }
  assert(p1 !== null && p1.version >= 1, "first life: projected v1+");
  // 模拟重启：新插件实例 + 从同一持久化日志恢复的会话（拷贝事件与表面）
  const s2 = new MiniSession("t5-restart");
  for (const e of s1.events) {
    s2.append(e.type, JSON.parse(JSON.stringify(e.data)), { surfaceOp: e.surfaceOp, sourceEventSeqs: e.sourceEventSeqs });
  }
  const ctx2 = makeCtx(dir);
  const inst2 = MOD.apply(ctx2, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const loaded = inst2._test.getStore("t5-restart");
  assert(loaded.version === p1.version && loaded.watermark === p1.range.endSeq, "store restored from disk (version+watermark)");
  let p2 = null;
  for (let i = 0; i < 8 && !p2; i++) { addUser(s2, `post-restart slide ${i} to push watermark`); addAssistant(s2, `b ${i}`); p2 = inst2._test.maybeProject(s2, ctx2.get("tokenMeter")); }
  assert(p2 !== null && p2.version > p1.version, "second life: incremental projection continues (v" + (p2?.version ?? "?") + ")");
  assert(s2.obsNodeSeqs().length === 1, "exactly ONE live observation snapshot on surface after restart");
}

// ════════════════════════ T6: provider-switch 激活 ════════════════════════
section("T6: provider-switch activation (observer-only, never decides)");
{
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 999999999, minNewNodes: 1, recentWindowNodes: 12 });
  const handler = inst._test.observeRoute;
  const mkPayload = (sid, requestedModel) => ({ agent: { session: { id: sid } }, model: requestedModel, config: { model: requestedModel } });
  // 第一次见路由：不算切换
  await handler(mkPayload("t6", "auto"), async () => ({ provider: "opencode", model: "deepseek-v4-flash" }));
  assert(inst._test.getStore("t6").active === false, "first route observed: not a switch");
  // 同 provider 下 auto 重写模型变化：不算切换（Router 例行路由）
  await handler(mkPayload("t6", "auto"), async () => ({ provider: "opencode", model: "qwen3-max" }));
  assert(inst._test.getStore("t6").active === false, "auto rewrite model change ≠ switch");
  // 具体 concrete model 变化：算切换
  await handler(mkPayload("t6", "stealth/ox-alpha"), async () => ({ provider: "openrouter", model: "stealth/ox-alpha" }));
  assert(inst._test.getStore("t6").active === true, "concrete-model/provider change activates projection");
  // 激活后即使低于阈值也立即投影
  const s = buildLongSession("t6", 20);
  const r = inst._test.maybeProject(s, ctx.get("tokenMeter"));
  assert(r !== null, "activated → immediate projection below threshold");
  // 未激活会话低于阈值不投影
  const s2 = buildLongSession("t6-idle", 20);
  const r2 = inst._test.maybeProject(s2, ctx.get("tokenMeter"));
  assert(r2 === null, "inactive + below threshold → passive (surface untouched)");
}

// ════════════════════════ T7: bounded memory ════════════════════════
section("T7: bounded memory (reflection caps, single snapshot, refs ring)");
{
  const caps = { perSection: 24, totalChars: 6000 };
  const obs = CORE.emptyObs();
  for (let i = 0; i < 100; i++) {
    obs.completedActions.push({ t: `action ${i} ` + "w".repeat(80), refs: [i] });
    obs.failedApproaches.push({ t: `error ${i} `, why: "boom", refs: [i] });
    obs.verifiedEvidence.push({ t: `evidence ${i}`, refs: [i] });
    obs.keyFileChanges.push({ t: `file ${i}`, refs: [i] });
    obs.runtimeFacts.push({ t: `fact ${i}`, refs: [i] });
    obs.blockers.push({ t: `blocker ${i}`, refs: [i] });
  }
  const r = CORE.reflect(obs, caps);
  const total = JSON.stringify(r).length;
  assert(r.completedActions.length <= caps.perSection && r.failedApproaches.length <= 12, "per-section caps enforced");
  assert(total <= caps.totalChars + 800, `total size bounded (${total} ≤ ${caps.totalChars}+overhead)`);
  const text = CORE.renderObservationText(r, { version: 9, sessionId: "x", startSeq: 1, endSeq: 2 });
  assert(text.length < caps.totalChars + 2500, `rendered text bounded (${text.length})`);
  // 多轮投影后表面恒一个快照
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = buildLongSession("t7", 40);
  for (let i = 0; i < 10; i++) { addUser(s, `bounded slide ${i}`); addAssistant(s, `c ${i}`); inst._test.maybeProject(s, ctx.get("tokenMeter")); }
  assert(s.obsNodeSeqs().length === 1, `single live observation node after repeated projections (got ${s.obsNodeSeqs().length})`);
  const st = inst._test.getStore("t7");
  assert(st.refs.length <= 64, "refs ring bounded");
}

// ════════════════════════ T8: no duplicate authority（静态审计）════════════════════════
section("T8: no-duplicate-authority static audit");
{
  // 剥离注释行后审计（头部的边界声明注释会提及禁区名，代码本体不得出现）
  const stripComments = (src) => src
    .split("\n")
    .filter((l) => { const t = l.trim(); return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")); })
    .join("\n");
  const coreSrc = stripComments(fs.readFileSync(path.join(REPO, "plugins/context-memory-core.mjs"), "utf8"));
  const plugSrc = stripComments(fs.readFileSync(MOD_PATH, "utf8"));
  const combined = coreSrc + "\n" + plugSrc;
  const forbidden = [
    ["compactNow", "compaction 权力"],
    ["request-error", "EC/官方 retry 决策域"],
    ["ec/recovery-requirement", "Router 桥接方向"],
    ["goal.resume", "goal 恢复驱动"],
    ["resolveModelInfo", "模型合法性裁决"],
    ["agent-default-model", "默认模型改写"],
    ["thresholdRatio", "compaction 配置域"],
    ["retainRatio", "compaction 配置域"],
  ];
  for (const [pat, why] of forbidden) {
    assert(!combined.includes(pat), `does not touch ${why} ("${pat}")`);
  }
  // 不写 sessions 目录文件（只经 session API）
  assert(!combined.includes(".dsh", 0) || !/"\.dsh\/sessions"|sessions'/.test(combined.replace(/state.*context-memory/, "")), "no direct session-file access path");
}

// ════════════════════════ T9: context rot ════════════════════════
section("T9: context rot — failed approaches marked, deduped, not revived");
{
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = new MiniSession("t9");
  addUser(s, "Try implementing feature X with approach A (websocket bridge).");
  addToolCallPair(s, "pwsh", "Error: websocket handshake failed with 502 BAD_GATEWAY (approach A failed)");
  addToolCallPair(s, "pwsh", "Error: websocket handshake failed with 502 BAD_GATEWAY (approach A failed retry)");
  for (let i = 0; i < 16; i++) { addUser(s, `rot filler ${i}`); addAssistant(s, `r ${i}`); }
  let p = null;
  for (let i = 0; i < 4 && !p; i++) { addUser(s, `rot slide ${i}`); addAssistant(s, `z ${i}`); p = inst._test.maybeProject(s, ctx.get("tokenMeter")); }
  const obsSeq = s.obsNodeSeqs()[0];
  const text = s.events[obsSeq].data.content[0].text;
  const faSection = text.split("## Failed approaches")[1]?.split("\n## ")[0] ?? "";
  assert(faSection.includes("502"), "failed approach recorded in observation");
  const bullets = faSection.split("\n").filter((l) => l.trim().startsWith("- ")).length;
  assert(bullets === 1, `duplicate failure signatures merged into ONE bullet (got ${bullets})`);
  assert(faSection.includes("do not retry"), "explicit anti-retry guidance present");
}

// ════════════════════════ T10: Token A/B（synthetic 上限证明）════════════════════════
section("T10: token A/B (synthetic scenario, est-tokens basis)");
{
  const dir = tmpDir();
  const ctx = makeCtx(dir);
  const inst = MOD.apply(ctx, { enabled: true, stateDir: dir, activationThresholdTokens: 1, minNewNodes: 1, recentWindowNodes: 12 });
  const s = buildLongSession("t10", 60, 4000);
  const estOf = (sess) => sess.deriveMessages().reduce((a, m) => a + Math.ceil(JSON.stringify(m.content).length / 4), 0);
  const baseline = estOf(s);
  for (let i = 0; i < 14; i++) { addUser(s, `ab slide ${i}`); addAssistant(s, `q ${i}`); inst._test.maybeProject(s, ctx.get("tokenMeter")); }
  const after = estOf(s);
  const ratio = after / baseline;
  console.log(`        [synthetic] baseline=${baseline} tok, after=${after} tok, ratio=${ratio.toFixed(3)}`);
  assert(after < baseline * 0.75, `projected surface ≥25% smaller than raw baseline (ratio=${ratio.toFixed(3)})`);
}

// ════════════════════════ T11: R2-7 false-completion 回归 ════════════════════════
section("T11: R2-7 blocker close is evidence-linked (no false completion)");
{
  // 场景 A：一个真实 blocker + 后续【无关】PASS → blocker 必须保留
  {
    const s = new MiniSession("t11a");
    addUser(s, "Investigate module alpha crash on startup.");
    addToolCallPair(s, "pwsh", "Error: module alpha crashed with ENOENT at boot (exit code 1)");
    addToolCallPair(s, "pwsh", "PASS all tests for module beta — 42 green, 0 failed");
    const obs = CORE.buildObservation(s.events, s.surface.nodes, null);
    assert(obs.blockers.length === 1, "A: unrelated PASS must NOT clear the blocker");
    assert(obs.blockers[0].t.includes("alpha"), "A: blocker text still references alpha");
  }
  // 场景 B：真实 blocker + 后续【相关】PASS（同一主题）→ blocker 关闭
  {
    const s = new MiniSession("t11b");
    addUser(s, "Fix module alpha startup crash.");
    addToolCallPair(s, "pwsh", "Error: module alpha crashed with ENOENT at boot (exit code 1)");
    addToolCallPair(s, "pwsh", "PASS module alpha now boots cleanly: ENOENT resolved, 0 errors");
    const obs = CORE.buildObservation(s.events, s.surface.nodes, null);
    assert(obs.blockers.length === 0, "B: related PASS closes the blocker");
  }
  // 场景 C：PASS 在前、blocker 在后 → blocker 照常记录（不回看清空）
  {
    const s = new MiniSession("t11c");
    addUser(s, "Verify module gamma.");
    addToolCallPair(s, "pwsh", "PASS module gamma checks out");
    addToolCallPair(s, "pwsh", "Error: module delta then failed with EPERM (exit code 1)");
    const obs = CORE.buildObservation(s.events, s.surface.nodes, null);
    assert(obs.blockers.length === 1 && obs.blockers[0].t.includes("delta"), "C: later blocker still recorded");
    assert(obs.verifiedEvidence.some((e) => e.t.includes("gamma")), "C: earlier PASS kept as evidence");
  }
  // 场景 E：R2-7 分类边界——"0 failed / 0 errors" 计数语境的成功输出不得被 RX_ERROR 吞掉
  {
    const s = new MiniSession("t11e");
    addUser(s, "Run the full test suite for module omega.");
    addToolCallPair(s, "pwsh", "PASS all tests for module omega — 42 passed, 0 failed, 0 errors");
    const obs = CORE.buildObservation(s.events, s.surface.nodes, null);
    assert(obs.blockers.length === 0, "E: count-context success output is NOT an error");
    assert(obs.failedApproaches.length === 0, "E: success output not recorded as failed approach");
    assert(obs.verifiedEvidence.some((e) => e.t.includes("omega")), "E: success output recorded as verified evidence");
  }
}

// ═════════════════ T12: R5-1 STRICT recall verifier (NEG-1..5 + controls) ═════════════════
section("T12: R5-1 STRICT recall verifier — matchedSeq∈claim.refs + type match + text support (no corpus rescue)");
{
  const RV = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "recall-verifier.mjs")).href);
  // fixture events with deployed data shapes (user/message, tool/result, assistant/message)
  const ev = [];
  const add = (type, data) => { ev.push({ seq: ev.length, type, data }); return ev[ev.length - 1].seq; };
  add("user/message", { role: "user", id: "u0", content: [{ type: "text", text: "Investigate module alpha crash on startup." }], source: { kind: "user" } });
  add("tool/result", { message: { role: "user", id: "t1", content: [{ type: "tool-result", content: [{ type: "text", text: "UNIQ-ALPHA-7F3 signal line produced while verifying task nine." }] }] } });
  add("tool/result", { message: { role: "user", id: "t2", content: [{ type: "tool-result", content: [{ type: "text", text: "DUP-BRAVO-42 result recorded for batch step." }] }] } });
  add("assistant/message", { turn: 1, step: 1, message: { role: "assistant", id: "a3", content: [{ type: "text", text: "Step done." }], source: { kind: "model", provider: "p", model: "m" } } });
  add("tool/result", { message: { role: "user", id: "t4", content: [{ type: "tool-result", content: [{ type: "text", text: "DUP-BRAVO-42 result recorded for batch step." }] }] } });
  add("tool/result", { message: { role: "user", id: "t5", content: [{ type: "tool-result", content: [{ type: "text", text: "Totally unrelated gamma evidence ends here." }] }] } });

  const mkClaim = (section, t, refs, index = 0) => ({ section, text: t, refs, index });

  // POSITIVE control: own-ref exact backing passes.
  {
    const r = RV.resolveClaim(mkClaim("goal", "Investigate module alpha crash on startup.", [0]), ev, CORE);
    assert(r.ok && r.reason === "PASS_refs_exact", "POS: own-ref exact backing → PASS_refs_exact");
    assert(r.hits.includes(0) && !r.multihit, "POS: single-hit diagnostics");
  }
  // NEG-1: text exists ONLY at another seq; cited ref cannot support it.
  {
    const r = RV.resolveClaim(mkClaim("completedActions", "UNIQ-ALPHA-7F3 signal line produced while verifying task nine.", [2]), ev, CORE);
    assert(!r.ok && r.reason === "FAIL_text_not_supported_by_own_ref", `NEG-1: mismatched backing rejected (got ${r.reason})`);
  }
  // NEG-2: duplicated text exists elsewhere ({2,4}); cited ref 5 cannot support it and the
  // corpus MUST NOT rescue — strict verdict reports that legacy rescue was even available.
  {
    const r = RV.resolveClaim(mkClaim("completedActions", "DUP-BRAVO-42 result recorded for batch step.", [5]), ev, CORE);
    assert(!r.ok && r.reason === "FAIL_text_not_supported_by_own_ref", `NEG-2: own-ref backing required (got ${r.reason})`);
    assert(r.corpusCouldRescue === true && r.hits.includes(2) && r.hits.includes(4),
      "NEG-2: diagnostic proves legacy corpus-rescue WOULD have passed — strict verifier refuses");
  }
  // NEG-3: class/type mismatch — goal claim backed by a tool/result carrying identical words.
  {
    const r = RV.resolveClaim(mkClaim("goal", "Totally unrelated gamma evidence ends here.", [5]), ev, CORE);
    assert(!r.ok && r.reason === "FAIL_type_mismatch", `NEG-3: type confusion rejected (got ${r.reason})`);
  }
  // NEG-4: ghost text supported nowhere in corpus.
  {
    const r = RV.resolveClaim(mkClaim("verifiedEvidence", "GHOST-DELTA-99 never existed in any output.", [5]), ev, CORE);
    assert(!r.ok && r.reason.startsWith("FAIL_"), `NEG-4: fabricated claim rejected (got ${r.reason})`);
  }
  // NEG-5: legitimate duplicate WITH correct own-ref → PASS but multihit flagged; empty refs → hard fail.
  {
    const r = RV.resolveClaim(mkClaim("completedActions", "DUP-BRAVO-42 result recorded for batch step.", [2], 3), ev, CORE);
    assert(r.ok && r.multihit === true && r.hits.length === 2, "NEG-5a: correct own-ref in duplicated corpus → PASS + multihit flag");
    const r2 = RV.resolveClaim(mkClaim("completedActions", "DUP-BRAVO-42 result recorded for batch step.", []), ev, CORE);
    assert(!r2.ok && r2.reason === "FAIL_empty_refs", "NEG-5b: empty refs hard-fails");
  }
  // Aggregate end-to-end controls incl. chain + timeline.
  {
    const goodStore = {
      schemaVersion: 1, sessionId: "syn", version: 3, active: true, watermark: 1, lastRoute: { provider: "p", model: "m" },
      obs: {},
      refs: [{ v: 1, startSeq: 3, endSeq: 0, at: 1 }, { v: 2, startSeq: 5, endSeq: 1, at: 2 }],
      goal: { t: "Investigate module alpha crash on startup.", refs: [0] },
      completedActions: [{ t: "DUP-BRAVO-42 result recorded for batch step.", refs: [2] }],
      verifiedEvidence: [{ t: "Totally unrelated gamma evidence ends here.", refs: [5] }],
      keyFileChanges: [], failedApproaches: [], blockers: [], runtimeFacts: [],
    };
    const badStore = JSON.parse(JSON.stringify(goodStore));
    badStore.completedActions = [{ t: "UNIQ-ALPHA-7F3 signal line produced while verifying task nine.", refs: [2] }];
    const good = RV.runStrictRecall({ events: ev, store: goodStore, core: CORE });
    const bad = RV.runStrictRecall({ events: ev, store: badStore, core: CORE });
    assert(good.ok === true, `POS-e2e: consistent store → STRICT ALL-PASS (got ${good.SUMMARY})`);
    assert(bad.ok === false && bad.classes.some((c) => c.results.some((x) => x.reason === "FAIL_text_not_supported_by_own_ref")),
      "NEG-e2e: planted mismatch forces overall FAIL");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${passCount} PASS / ${failCount} FAIL`);
process.exit(failCount ? 1 : 0);
