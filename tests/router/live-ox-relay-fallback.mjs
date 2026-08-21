// live-ox-relay-fallback.mjs — REAL end-to-end fallback proof (isolated test seam)
//
// NOT part of CI (needs real API keys + network). Committed as the live-probe tool
// for task §8/§9: prove that when relay A really fails, the plugin really sends the
// next attempt to relay B and the model stays stealth/ox-alpha, using REAL HTTP
// generations against the real relays.
//
// How it works (isolated provider test seam):
//   1. Loads the REAL host plugin (ox-relay-failover.mjs) with a mock ctx that
//      faithfully mimics the agent loop's request/request-error cycle.
//   2. The "loop" resolves the seed config through agent/request, then performs a
//      REAL chat/completions POST to the resolved relay with the real key.
//   3. On a real failure it feeds the REAL failure into agent/request-error and,
//      if the plugin returns {kind:'retry'}, loops with the armed provider.
//   4. Records plugin session events (ox-relay/failover) as runtime-event evidence.
//
// Failure injection: the trial seed provider (ox-relay-a) is pointed at a dead
// endpoint (http://127.0.0.1:9 -> connection refused = TRANSPORT), so the real
// first attempt fails deterministically WITHOUT waiting for natural 429s.
//
// Usage:
//   node tests/router/live-ox-relay-fallback.mjs            # both scenarios
//   node tests/router/live-ox-relay-fallback.mjs --trial A  # A fail -> B success
//   node tests/router/live-ox-relay-fallback.mjs --trial T1 # B success -> no fallback
// Secrets: keys read from ~/.dsh/.credentials.yaml (or OX_RELAY_CRED_FILE);
// never printed. Proxy via router OpenClash (OX_RELAY_PROXY, default
// http://192.168.168.1:7890; OX_RELAY_PROXY=direct to disable).
// Exit: 0 = scenarios PASS, 1 = any FAIL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.resolve(__dirname, "../../docs/execution-economy/plugins");
const { apply: applyPlugin } = await import("file:///" + path.join(pluginsDir, "ox-relay-failover.mjs").split("\\").join("/"));
const core = await import("file:///" + path.join(pluginsDir, "ox-relay-core.mjs").split("\\").join("/"));

const OX = "stealth/ox-alpha";
const PROXY = process.env.OX_RELAY_PROXY || "http://192.168.168.1:7890";
const GEN_TIMEOUT_MS = Number(process.env.OX_RELAY_GEN_TIMEOUT_MS || 45000);

// provider route -> real endpoint + key env (must mirror the canonical
// docs/execution-economy/config/ox-relay-providers.yaml template)
const RELAYS = {
  "ox-relay-a": { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", label: "OpenRouter" },
  "ox-relay-b": { baseURL: "https://api.commandcode.ai/provider/v1", keyEnv: "CMD_API_KEY", label: "Command Code" },
};

function loadKeys() {
  const file = process.env.OX_RELAY_CRED_FILE || path.join(os.homedir(), ".dsh", ".credentials.yaml");
  const out = {};
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const m of txt.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:\s*["']?([^"'\r\n]+)["']?\s*$/gm)) out[m[1]] = m[2].trim();
  } catch {}
  return out;
}

let proxyAgents = null;
async function getProxyAgent(url) {
  if (PROXY === "direct") return undefined;
  if (proxyAgents === null) {
    const nm = path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules");
    const req = createRequire(path.join(nm, "package.json"));
    const { HttpProxyAgent } = req("http-proxy-agent");
    const { HttpsProxyAgent } = req("https-proxy-agent");
    proxyAgents = { http: new HttpProxyAgent(PROXY), https: new HttpsProxyAgent(PROXY) };
  }
  return url.startsWith("https") ? proxyAgents.https : proxyAgents.http;
}

function redact(t) { return String(t ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "***").replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer ***"); }

// real chat/completions call (with ONE transport retry to absorb proxy flakiness —
// budget: 1 normal request + 1 retry per provider, task §10)
async function realGeneration(providerId, keys) {
  const r = RELAYS[providerId];
  if (!r) return { ok: false, failure: { code: "UNKNOWN_MODEL", message: `no route for ${providerId}` } };
  const key = keys[r.keyEnv];
  if (!key) return { ok: false, failure: { code: "MISSING_CREDENTIAL", message: `missing ${r.keyEnv}` } };
  const url = r.baseURL.replace(/\/$/, "") + "/chat/completions";
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: OX, messages: [{ role: "user", content: "Reply exactly: OK" }], max_tokens: 512 }),
        signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
        // alternate transport on retry (proxy <-> direct) to absorb relay/proxy flakiness
        agent: attempt === 1 ? await getProxyAgent(url) : undefined,
      });
      const text = await res.text();
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const code = core.classifyFailure({ message: `${res.status}: ${text.slice(0, 200)}` });
        last = { ok: false, httpStatus: res.status, latencyMs, attempt, failure: { code, message: `${res.status} ${redact(text).slice(0, 200)}` } };
        // only transient HTTP failures get the one retry
        if (code === "RATE_LIMIT" || code === "SERVER" || code === "TIMEOUT") continue;
        return last;
      }
      let respModel = null, content = null;
      try { const j = JSON.parse(text); respModel = j?.model ?? null; content = j?.choices?.[0]?.message?.content ?? null; } catch {}
      return { ok: true, httpStatus: 200, latencyMs, attempt, respModel, contentSnippet: redact(String(content ?? "")).slice(0, 60) };
    } catch (e) {
      const msg = String(e?.message || e || "fetch failed");
      last = { ok: false, latencyMs: Date.now() - t0, attempt, failure: { code: core.classifyFailure({ message: msg }), message: redact(msg).slice(0, 200) } };
      // network-level failure -> one retry via alternate transport
    }
  }
  return last;
}

// mock ctx (same shape as unit tests)
function makeHarness(chainEnv) {
  const handlers = {}; const effects = [];
  const ctx = { on(e, cb) { handlers[e] = cb; }, effect(fn) { effects.push(fn); }, logger: { info() {}, warn() {} }, effects };
  const session = { id: "live-seam", events: [], append(type, data) { this.events.push({ type, data }); } };
  const agent = { session };
  const saved = process.env.OX_RELAY_CHAIN;
  if (chainEnv !== undefined) process.env.OX_RELAY_CHAIN = chainEnv; else delete process.env.OX_RELAY_CHAIN;
  const plugin = applyPlugin(ctx, {});
  if (chainEnv !== undefined) process.env.OX_RELAY_CHAIN = saved;
  return { ctx, plugin, agent, handlers, effects, session };
}
function cleanupHarness(h) { for (const fn of h.effects) { const d = fn(); if (typeof d === "function") d(); } }

// faithful agent-loop simulation: request -> real gen -> request-error -> retry/next
async function runTurn(h, seedProvider, keys) {
  const reqHandler = h.handlers["agent/request"];
  const errHandler = h.handlers["agent/request-error"];
  const attempts = [];
  let turn = 1, step = 1;
  for (let i = 0; i < 6; i++) { // bounded loop guard
    const seed = { provider: seedProvider, model: OX };
    const config = await reqHandler({ agent: h.agent, turn, step }, async () => ({ ...seed }));
    const provider = config.provider;
    const gen = await realGeneration(provider, keys);
    attempts.push({ attempt: attempts.length + 1, provider, model: config.model, gen: { ...gen } });
    if (gen.ok) {
      // record success; stop
      return { ok: true, attempts, finalProvider: provider, respModel: gen.respModel };
    }
    // real failure -> request-error
    let action;
    try {
      action = await errHandler({ agent: h.agent, turn, step, provider, failure: gen.failure }, async () => undefined);
    } catch (e) {
      return { ok: false, attempts, error: e, message: e?.message };
    }
    if (!action || action.kind !== "retry") {
      return { ok: false, attempts, error: null, message: `loop ended without retry (action=${JSON.stringify(action)})` };
    }
    step++;
  }
  return { ok: false, attempts, error: null, message: "loop guard hit (too many attempts)" };
}

function failEvents(h) { return h.session.events.filter((e) => e.type === "ox-relay/failover"); }

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log("PASS  " + name + (detail ? "  " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
}

const keys = loadKeys();
const hasKeys = RELAYS["ox-relay-a"].keyEnv && keys[RELAYS["ox-relay-a"].keyEnv] && RELAYS["ox-relay-b"].keyEnv && keys[RELAYS["ox-relay-b"].keyEnv];
if (!hasKeys) {
  console.log("SKIP: missing OPENROUTER_API_KEY or CMD_API_KEY in credentials — live proof requires real keys.");
  console.log("Deterministic T1-T9 unit tests remain the CI gate.");
  process.exit(0);
}

const trial = process.argv.find((a) => a.startsWith("--trial"));

// ============ TRIAL B: A (broken) fail -> B (real) success ============
if (!trial || trial === "--trial A") {
  console.log("");
  console.log("== LIVE TRIAL: A (injected dead endpoint) -> real fallback to B ==");
  // isolated provider test seam: point ox-relay-a at a dead port (deterministic TRANSPORT)
  const savedA = RELAYS["ox-relay-a"].baseURL;
  RELAYS["ox-relay-a"].baseURL = "http://127.0.0.1:9"; // connection refused
  const h = makeHarness("ox-relay-a,ox-relay-b");
  const out = await runTurn(h, "ox-relay-a", keys);
  RELAYS["ox-relay-a"].baseURL = savedA;
  cleanupHarness(h);

  check("attempt1 provider = ox-relay-a (failed)", out.attempts?.[0]?.provider === "ox-relay-a" && !out.attempts[0].gen.ok, JSON.stringify(out.attempts?.[0]?.gen?.failure?.code ?? null));
  check("attempt1 failure_kind = TRANSPORT", out.attempts?.[0]?.gen?.failure?.code === "TRANSPORT", out.attempts?.[0]?.gen?.failure?.message?.slice(0, 80));
  check("attempt2 provider = ox-relay-b (real)", out.attempts?.[1]?.provider === "ox-relay-b");
  check("attempt2 succeeded", out.ok && out.finalProvider === "ox-relay-b", `respModel=${out.respModel}`);
  check("final model stays stealth/ox-alpha", out.attempts?.every((a) => a.model === OX), JSON.stringify(out.attempts?.map((a) => a.model)));
  check("final provider served ox-alpha (identity)", out.respModel === OX || String(out.respModel || "").includes("ox-alpha"), `respModel=${out.respModel}`);
  const evs = failEvents(h);
  check("runtime events: attempt1 record with next_provider=ox-relay-b", evs.some((e) => e.data.attempt === 1 && e.data.failure_kind === "TRANSPORT" && e.data.next_provider === "ox-relay-b"), JSON.stringify(evs.map((e) => e.data)));
  check("runtime events: attempt2 record with provider=ox-relay-b", evs.some((e) => e.data.attempt === 2 && e.data.provider === "ox-relay-b"));
  const lat1 = out.attempts?.[0]?.gen?.latencyMs; const lat2 = out.attempts?.[1]?.gen?.latencyMs;
  console.log(`  latency: A-fail=${lat1}ms, B-gen=${lat2}ms`);
}

// ============ TRIAL T1: B (real) success -> no fallback ============
if (!trial || trial === "--trial T1") {
  console.log("");
  console.log("== LIVE TRIAL T1: healthy relay completes with NO fallback ==");
  const h = makeHarness("ox-relay-a,ox-relay-b");
  const out = await runTurn(h, "ox-relay-b", keys);
  cleanupHarness(h);
  check("single attempt only (no fallback)", out.attempts?.length === 1, `attempts=${out.attempts?.length}`);
  check("attempt1 succeeded on B", out.ok && out.finalProvider === "ox-relay-b", `respModel=${out.respModel}`);
  check("model stays stealth/ox-alpha", out.attempts?.[0]?.model === OX);
  check("no failure events recorded (no fallback attempted)", failEvents(h).filter((e) => e.data.failure_kind).length === 0);
  console.log(`  latency: B-gen=${out.attempts?.[0]?.gen?.latencyMs}ms`);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
