// cm-r4-failopen-live.mjs — P2.5 R4 REAL corrupt/missing fail-open drill on LIVE
// store BYTES (copies only; the live file itself is never modified, zero-restart).
// Arms: half-cut JSON / non-JSON text / bad schemaVersion / missing file /
// pristine control. Uses the DEPLOYED core algorithms (validateStore /
// emptyObs / buildObservation) loaded from the repo plugin source that the
// running service executes byte-identically (SHA256 verified this round).
// Usage: node cm-r4-failopen-live.mjs <live-store.json> <context-memory-core.mjs>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const [, , liveFile, coreFile] = process.argv;
if (!liveFile || !coreFile) { console.error("usage: node cm-r4-failopen-live.mjs <live-store.json> <core.mjs>"); process.exit(1); }

const origBytes = fs.readFileSync(liveFile);
const origSha = crypto.createHash("sha256").update(origBytes).digest("hex");
const origJson = JSON.parse(origBytes.toString("utf8"));

const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r4-drill-"));
const mkCopy = (name, bytes) => { const p = path.join(outdir, name); fs.writeFileSync(p, bytes); return p; };

const core = await import(pathToFileURL(path.resolve(coreFile)));

// mimic of the plugin's tolerant load path around core.validateStore
function tryLoad(p) {
  let rawOk = true, parseErr = null, schemaVerdict = null, data = null;
  try {
    const txt = fs.readFileSync(p, "utf8");
    data = JSON.parse(txt);
  } catch (e) { rawOk = false; parseErr = String(e.message).split("\n")[0]; }
  if (rawOk) {
    // deployed contract: validateStore returns the store object when valid, null when invalid
    try {
      const r = core.validateStore(data);
      schemaVerdict = r ? "ACCEPT" : "REJECT(validateStore=null)";
    } catch (e) { schemaVerdict = `THROW(${String(e.message).slice(0, 60)})`; }
  }
  const usable = rawOk && schemaVerdict === "ACCEPT";
  return { fileReadable: rawOk, parseError: parseErr, schemaVerdict, usable };
}

const origText = origBytes.toString("utf8");
const arms = {};

// A: half-cut JSON (truncated write simulation)
arms.CORRUPT_halfCut = tryLoad(mkCopy("half-cut.json", Buffer.from(origText.slice(0, Math.max(1, Math.floor(origBytes.length * 0.55))), "utf8")));
// B: non-JSON garbage
arms.CORRUPT_notJson = tryLoad(mkCopy("not-json.json", Buffer.from("<html><body>garbage</body></html>", "utf8")));
// C: authentic JSON with invalid schemaVersion
const badSchema = structuredClone(origJson); badSchema.schemaVersion = "__invalid__";
arms.CORRUPT_badSchemaVersion = tryLoad(mkCopy("bad-schema.json", Buffer.from(JSON.stringify(badSchema, null, 1), "utf8")));
// D: missing file
const missP = path.join(outdir, "never-existed.json");
try { fs.unlinkSync(missP); } catch {}
const missed = tryLoad(missP);
arms.MISSING_file = { fileReadable: missed.fileReadable, failOpenSemantics: missed.usable ? "unexpected-present" : "FRESH_LEARN_FROM_RAW_SESSION" };
// E: pristine control (same bytes round-tripped)
arms.CONTROL_pristine = tryLoad(mkCopy("pristine.json", Buffer.from(JSON.stringify(origJson, null, 1), "utf8")));

// rebuild-skeleton demonstration with deployed algorithm (no writes anywhere)
let rebuildDemo = null;
try {
  const skel = core.emptyObs();
  const rebuilt = core.buildObservation([], [], skel);
  const txt = core.renderObservationText(rebuilt, { sessionId: origJson.sessionId ?? "demo", version: 1 });
  rebuildDemo = { skeletonValid: !!rebuilt, headerRenderable: typeof txt === "string" && txt.includes("[context-memory"), headerPrefix: txt.slice(0, 60) };
} catch (e) { rebuildDemo = { error: String(e.message).slice(0, 80) }; }

const corruptionRejected = arms.CORRUPT_halfCut.usable === false &&
  arms.CORRUPT_notJson.usable === false && arms.CORRUPT_badSchemaVersion.usable === false;
const controlAccepted = arms.CONTROL_pristine.usable === true;

fs.rmSync(outdir, { recursive: true, force: true });

console.log(JSON.stringify({
  liveStoreSha256Prefix: origSha.slice(0, 16),
  storeMeta: { version: origJson.version, sessionId: String(origJson.sessionId ?? "").slice(0, 14), refCount: origJson.refs?.length ?? null },
  arms, rebuildDemo,
  cleanup: "temp copies removed",
  SUMMARY: corruptionRejected && controlAccepted
    ? "FAILOPEN DRILL PASS (corrupt×3 rejected→rebuild path; missing→fresh learn; pristine control accepted)"
    : "FAILOPEN DRILL REVIEW NEEDED",
  mutatedLiveFile: false,
}, null, 1));
process.exit(corruptionRejected && controlAccepted ? 0 : 2);
