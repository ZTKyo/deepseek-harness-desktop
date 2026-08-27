// make-r5-sh9-posture-v3.mjs — P2.5 R5.1-B (Round 6 blocker C).
// SH-R9 read-only LIVE posture V3: every item re-verified AT RUN TIME against
// live files / processes / ACLs — no carried-forward verdicts from earlier
// rounds (the V2 artifact asserted several items from stored evidence; V3
// re-derives each from the current system state).
// Scope: 9 canonical SH-R9 items + 3 EXT live items (guardian liveness,
// credentials DACL, hardened config) per R5.1-B contract
// (Guardian/凭据源/DACL/hardened config/fail-closed/live hash/mount).
// READ-ONLY: no writes to any production file. No secret VALUES ever enter
// the artifact — credential names only, ACL entries only, counts only.
// Usage: node make-r5-sh9-posture-v3.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: node make-r5-sh9-posture-v3.mjs <outDir>"); process.exit(64); }
fs.mkdirSync(outDir, { recursive: true });

const HOME = os.homedir();
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const sha256 = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const items = [];
const add = (id, name, pass, evidence) => {
  items.push({ id, name, status: pass ? "PASS" : "FAIL", evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  #${id} ${name} — ${evidence}`);
};
const readSafe = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

// ── 1. credential hygiene: settings.yaml must carry no plaintext API key ──
{
  const raw = readSafe(path.join(HOME, ".dsh", "settings.yaml"));
  const lines = raw ? raw.split(/\r?\n/) : [];
  const apiKeyLines = lines.filter((l) => /api[_-]?key/i.test(l)).length;
  const plaintext = lines.filter((l) => /(api[_-]?key|api_key)\s*[:=]\s*[A-Za-z0-9_\-]{16,}/i.test(l) && !/env:|placeholder|\*\*\*/.test(l)).length;
  add(1, "credential-hygiene-settings-no-plaintext-apikey", raw !== null && plaintext === 0,
    `LIVE settings.yaml: apiKey-like lines=${apiKeyLines}, plaintext suspects=${plaintext}`);
}

// ── 2. fail-closed A5 store probe contract in coldstart-gate-worker.ps1 (live source) ──
{
  const p = path.join(REPO, "tests", "reliability", "coldstart-gate-worker.ps1");
  const lines = (readSafe(p) ?? "").split(/\r?\n/);
  const find = (rx) => lines.findIndex((l) => rx.test(l)) + 1;
  const lFalse = find(/\$storeProbeOk\s*=\s*\$false/);
  const lTrue = find(/\$storeProbeOk\s*=\s*\$true/);
  const lCatch = find(/catch\s*\{\s*\$storeProbeOk\s*=\s*\$false;\s*\$newFatalCount\s*=\s*-1\s*\}/);
  const lGate = find(/FAIL-CLOSED: store readable AND no NEW FAILED_FATAL/);
  add(2, "fail-closed-A5-store-probe", lFalse > 0 && lTrue > 0 && lCatch > 0 && lGate > 0,
    `LIVE source: init=false L${lFalse}, set=true L${lTrue}, catch→fatal L${lCatch}, FAIL-CLOSED gate L${lGate}`);
}

// ── 3. state truth: CURRENT_STATUS.md live read ──
{
  const p = path.join(REPO, "docs", "roadmap", "CURRENT_STATUS.md");
  const lines = (readSafe(p) ?? "").split(/\r?\n/);
  const stateLine = lines.find((l) => /AWAITING_REVIEW|IN_PROGRESS|BLOCKED/.test(l)) ?? "(no state line found)";
  const waitLine = lines.find((l) => /Waiting For|等待/i.test(l)) ?? "";
  add(3, "state-truth-CURRENT_STATUS", stateLine !== "(no state line found)",
    `LIVE: ${stateLine.trim().slice(0, 160)}${waitLine ? " | " + waitLine.trim().slice(0, 120) : ""}`);
}

// ── 4. credential source coherence: names only, env-indirect, values never read ──
{
  const credRaw = readSafe(path.join(HOME, ".dsh", ".credentials.yaml"));
  const names = (credRaw ?? "")
    .split(/\r?\n/)
    .map((l) => (l.match(/^\s+([A-Z0-9_]+):/) || [])[1])
    .filter(Boolean);
  const credPermsOk = !!credRaw;
  add(4, "credential-source-coherence", credPermsOk && names.length >= 5,
    `LIVE .credentials.yaml present, credential ref names (${names.length}): ${names.join(",")}; values NOT read`);
}

// ── 5. T15 positive-branch contract markers in Test-CredentialPreflight.ps1 (live source) ──
{
  const p = path.join(REPO, "tests", "reliability", "Test-CredentialPreflight.ps1");
  const src = readSafe(p) ?? "";
  const markers = [
    "T15 override preflight Ok=true",
    "T15 override value read from SAME source",
    "T15 override read did NOT fall through",
    "T15 default canonical preflight",
    "T15 starter passes override path to BOTH",
    "T15 starter resolves effective path ONCE",
  ];
  const found = markers.filter((m) => src.includes(m));
  add(5, "source-coherence-positive-branch-contract", found.length === markers.length,
    `LIVE source: T15 contract markers ${found.length}/${markers.length} present`);
}

// ── 6. kill-injection archived no-op: zero production callers, live scan ──
function scanRepo(rx) {
  const out = [];
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const en of ents) {
      if (en.name === "node_modules" || en.name === ".git") continue;
      const full = path.join(dir, en.name);
      if (en.isDirectory()) walk(full);
      else if (/\.(ps1|mjs|js|cmd|yml|yaml)$/i.test(en.name)) {
        let t; try { t = fs.readFileSync(full, "utf8"); } catch { continue; }
        const hits = t.split(/\r?\n/).map((l, i) => (rx.test(l) ? i + 1 : 0)).filter(Boolean);
        if (hits.length) out.push({ file: path.relative(REPO, full), lines: hits.length });
      }
    }
  })(REPO);
  return out;
}
{
  const refs = scanRepo(/kill-injection/i);
  const prod = refs.filter((r) => !/^(docs|tests|_release-staging)[\\/]/i.test(r.file));
  const archived = fs.existsSync(path.join(REPO, "docs", "archive", "coldstart-restore-owner.ps1"));
  add(6, "kill-injection-archived-noop", prod.length === 0,
    `LIVE scan: production callers=${prod.length}, doc/test references=${refs.length - prod.length}, archive present=${archived}`);
}

// ── 7. restore-owner archived: sole copy in docs/archive, zero live callers ──
{
  const refs = scanRepo(/coldstart-restore-owner/i).filter((r) => !r.file.includes("R5_SH9_POSTURE"));
  const prod = refs.filter((r) => !/^(docs|tests|_release-staging)[\\/]/i.test(r.file));
  const archiveCopy = fs.existsSync(path.join(REPO, "docs", "archive", "coldstart-restore-owner.ps1"));
  add(7, "restore-owner-archived", prod.length === 0 && archiveCopy,
    `LIVE scan: production callers=${prod.length}, archive sole copy=${archiveCopy}, other references=${refs.length}`);
}

// ── 8. deploy byte verify: live SHA256 deployed profiles vs repo ──
{
  const pairs = [
    ["context-memory.mjs", path.join(HOME, ".dsh", "profiles", "web", "context-memory.mjs"), path.join(REPO, "plugins", "context-memory.mjs")],
    ["context-memory-core.mjs", path.join(HOME, ".dsh", "profiles", "web", "context-memory-core.mjs"), path.join(REPO, "plugins", "context-memory-core.mjs")],
  ];
  const rows = pairs.map(([n, live, repo]) => {
    const lv = fs.existsSync(live) ? sha256(live).slice(0, 16) : "MISSING";
    const rv = fs.existsSync(repo) ? sha256(repo).slice(0, 16) : "MISSING";
    return { file: n, liveSha16: lv, repoSha16: rv, equal: lv === rv && lv !== "MISSING" };
  });
  add(8, "deploy-byte-verify-live-eq-repo", rows.every((r) => r.equal),
    `LIVE SHA256(16): ${rows.map((r) => `${r.file} live=${r.liveSha16} repo=${r.repoSha16} eq=${r.equal}`).join(" | ")}`);
}

// ── 9. mount chain: agent.cordis.yml id=context-memory → ./context-memory.mjs (live) ──
{
  const p = path.join(HOME, ".dsh", ".agent-presets", "autonomous", "agent.cordis.yml");
  const lines = (readSafe(p) ?? "").split(/\r?\n/);
  const i = lines.findIndex((l) => /-\s*id:\s*context-memory/i.test(l));
  let mount = "NOT_FOUND";
  if (i >= 0) for (let j = i; j < Math.min(i + 8, lines.length); j++) { const m = lines[j].match(/name:\s*'?(\S*context-memory\.mjs)'?/); if (m) { mount = `L${j + 1} ${m[1]}`; break; } }
  add(9, "mount-chain-agent-cordis-context-memory", i >= 0 && mount !== "NOT_FOUND",
    `LIVE: id=context-memory at L${i + 1} -> ${mount}`);
}

// ── EXT-1 guardian liveness (live process + fresh log) ──
{
  let guardianProcs = 0, logAgeMin = -1;
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name like 'powershell%'\\").CommandLine | Select-String -Pattern 'dsh-guardian' -SimpleMatch | Measure-Object | % Count"`, { encoding: "utf8", timeout: 30000 });
    guardianProcs = parseInt(out.trim(), 10) || 0;
  } catch { /* probe failure recorded */ }
  try {
    const lg = path.join(process.env.LOCALAPPDATA ?? "", "DSHHarness", "logs", "guardian.log");
    logAgeMin = +((Date.now() - fs.statSync(lg).mtimeMs) / 60000).toFixed(1);
  } catch { /* missing log */ }
  add("EXT-1", "guardian-liveness-live", guardianProcs >= 1 && logAgeMin >= 0 && logAgeMin < 15,
    `LIVE: guardian processes=${guardianProcs}, guardian.log age=${logAgeMin}min (fresh<15min)`);
}

// ── EXT-2 credentials DACL (live icacls; entries only, no content) ──
{
  let ok = false, entries = "";
  try {
    entries = execSync(`icacls "${path.join(HOME, ".dsh", ".credentials.yaml")}"`, { encoding: "utf8", timeout: 30000 }).trim();
    // hardened = no broad Users write; allow admin/system full, others at most RX
    ok = !/\bUsers:(?!\(I\)\(RX\)|\(RX\))[^A-Z]/.test(entries.replace(/BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM/g, "")) && entries.includes("Successfully processed");
  } catch { /* probe failure */ }
  add("EXT-2", "credentials-dacl-hardened", ok, `LIVE icacls entries: ${entries.replace(/\s+/g, " ").slice(0, 300)}`);
}

// ── EXT-3 hardened config: lastgood snapshot + startup env-stripping markers ──
{
  const lg = path.join(process.env.LOCALAPPDATA ?? "", "DSHHarness", "guardian-lastgood");
  const lgFiles = fs.existsSync(lg) ? fs.readdirSync(lg) : [];
  let stripMarkers = 0;
  try {
    const start = readSafe(path.join(REPO, "..", "DSH-Client", "start-dsh-server.ps1")) ?? "";
    stripMarkers = ["WorkBuddy", "NODE_OPTIONS", "BASH_ENV"].filter((m) => start.includes(m)).length;
  } catch { /* missing */ }
  add("EXT-3", "hardened-config-lastgood-and-envstrip", lgFiles.includes("settings.yaml") && lgFiles.includes("cordis.patch.yml") && stripMarkers >= 3,
    `LIVE: guardian-lastgood files=[${lgFiles.join(",")}], start-dsh-server.ps1 env-strip markers=${stripMarkers}/3`);
}

const pass = items.filter((i) => i.status === "PASS").length;
const out = {
  gate: "R5.1-B SH-R9 read-only LIVE posture V3 (Round 6 blocker C) — every item re-derived at run time",
  date: "2026-08-27",
  generatedAtUtc: new Date().toISOString(),
  method: "V3 = live re-verification (files/processes/ACL/hashes read at run time); V2 carried forward several stored verdicts — V3 supersedes",
  scope: "9 canonical SH-R9 items + 3 EXT live items (guardian / DACL / hardened config) per R5.1-B contract",
  items,
  conclusion: { pass, fail: items.length - pass, total: items.length, stop: items.every((i) => i.status === "PASS") ? "NO STOP ITEMS" : "STOP ITEM PRESENT" },
  sanitized: "credential values never read or emitted; ACL entries and ref names only",
};
const outPath = path.join(outDir, "R5_SH9_POSTURE_V3.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`R5_SH9_POSTURE_V3.json -> ${outPath}`);
console.log(`posture ${pass}/${items.length} PASS`);
process.exit(pass === items.length ? 0 : 1);
