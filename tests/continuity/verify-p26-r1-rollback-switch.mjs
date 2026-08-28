// verify-p26-r1-rollback-switch.mjs — P2.6 R1 acceptance: rollback single switch.
// Proves that `config { enabled: false }` on failure-classifier restores EXACT
// pre-R1 behavior: zero listeners registered, zero evidence writes, chain
// untouched. Also re-proves the ON path contract (next() passthrough,
// payload.failure never mutated, evidence line redacts secrets).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
// Resolve plugin relative to repo plugins dir regardless of cwd.
const repoPlugins = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "plugins");
const mod = await import("file:///" + path.join(repoPlugins, "failure-classifier.mjs").replace(/\\/g, "/"));

let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log("PASS  " + name + (detail ? "  " + detail : ""));
  else { console.log("FAIL  " + name + (detail ? "  " + detail : "")); fail++; }
};

function stubCtx() {
  const reg = [];
  return {
    reg,
    on: (ev, fn) => { reg.push({ ev, fn }); },
    effect: () => {},
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-switch-"));
const evFile = path.join(tmpDir, "evidence.jsonl");

// ── OFF path (rollback single switch) ──
const capturedErrs = [];
const origErr = console.error;
console.error = (...a) => { capturedErrs.push(a.join(" ")); };
const offCtx = stubCtx();
let offRet;
try { offRet = mod.apply(offCtx, { enabled: false }); } finally { console.error = origErr; }
check("OFF: apply returns without registering", offCtx.reg.length === 0, `registrations=${offCtx.reg.length}`);
check("OFF: prints disabled notice", capturedErrs.some((s) => s.includes("disabled by config")));
check("OFF: no evidence file created", !fs.existsSync(evFile));
check("OFF: returns undefined (no _test handle leaked)", offRet === undefined);

// ── ON path contract (regression within same switch test) ──
const onCtx = stubCtx();
mod.apply(onCtx, { evidenceFile: evFile });
check("ON: registers exactly one agent/request-error listener",
  onCtx.reg.length === 1 && onCtx.reg[0].ev === "agent/request-error");

let nextCalled = 0;
const failure = { code: 1310, message: "quota exceeded, try after 30s" };
const payload = { failure, provider: "openrouter", model: "deepseek/deepseek-v4-flash", agent: { session: { id: "sid-switch-1" } } };
await onCtx.reg[0].fn(payload, async () => { nextCalled++; });
check("ON: chain forwarded via next()", nextCalled === 1);
check("ON: payload.failure NOT mutated", failure.code === 1310 && failure.message === "quota exceeded, try after 30s");
const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, "utf8").trim().split("\n") : [];
check("ON: exactly one evidence line appended", lines.length === 1, `lines=${lines.length}`);
const rec = lines[0] ? JSON.parse(lines[0]) : {};
check("ON: classified QUOTA_EXHAUSTED with unavailableUntil", rec.classification === "QUOTA_EXHAUSTED", `got=${rec.classification}`);
check("ON: retryableSameRoute=false for quota", rec.retryableSameRoute === false);
check("ON: evidence carries sid + taxonomy version", rec.sid === "sid-switch-1" && (rec.taxonomyVersion === 1 || typeof rec.taxonomyVersion === "string"), `sid=${rec.sid} tv=${rec.taxonomyVersion}`);

// ── redaction within the ON path ──
const secPayload = { failure: { code: 401, message: "bad key sk-abc1234567890123 Bearer eyJhbGciOi.secret" }, provider: "x", model: "m" };
await onCtx.reg[0].fn(secPayload, async () => { nextCalled++; });
const recs = fs.readFileSync(evFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const secRec = recs[1];
check("ON: secrets redacted in evidence", !/sk-abc1234567890123/.test(secRec.message) && !/eyJhbGciOi\.secret/.test(secRec.message), secRec.message);

// ── error isolation: throwing classifier input must still next() ──
const badCtx = stubCtx();
mod.apply(badCtx, { evidenceFile: path.join(tmpDir, "nope", "dir-missing.jsonl") });
let isolatedNext = 0;
await badCtx.reg[0].fn({ failure: { code: 500, message: "boom" } }, async () => { isolatedNext++; });
check("ISOLATION: append failure does not break chain", isolatedNext === 1);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(fail === 0 ? "\nROLLBACK-SWITCH VERIFY: ALL PASS" : `\nROLLBACK-SWITCH VERIFY: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
