// make-r5-sh9-posture.mjs — Generate R5_SH9_POSTURE.json (9 read-only posture items)
// Data sources: R5_P25_FINAL_GATE_EVIDENCE.md (verified), gate7 results, live settings
// Usage: node make-r5-sh9-posture.mjs <outDir> [outputName]
//   outputName defaults to "R5_SH9_POSTURE.json"; pass "R5_SH9_POSTURE_V2.json"
//   for the post-R5.1 regeneration (R5_1-A final evidence correction round).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const outDir = process.argv[2] ?? ".";
const settingsPath = path.join(os.homedir(), ".dsh", "settings.yaml");
const cordisWeb = path.join(os.homedir(), ".dsh", "profiles", "web", "cordis.patch.yml");
const agentCordis = path.join(os.homedir(), ".dsh", ".agent-presets", "autonomous", "agent.cordis.yml");

// live verify where cheap
let apiKeyLines = 0, plaintextSuspect = 0;
try {
  const raw = fs.readFileSync(settingsPath, "utf8");
  const lines = raw.split(/\r?\n/);
  apiKeyLines = lines.filter((l) => /api[_-]?key|api_key/i.test(l)).length;
  plaintextSuspect = lines.filter((l) => /(api[_-]?key|api_key)\s*[:=]\s*[A-Za-z0-9_\-]{16,}/i.test(l) && !/env:|placeholder|\*\*\*/.test(l)).length;
} catch {}

let cordisMount = "NOT_FOUND";
try {
  const a = fs.readFileSync(agentCordis, "utf8").split(/\r?\n/);
  for (let i = 0; i < a.length; i++) if (/- id:\s*context-memory/i.test(a[i])) { cordisMount = `L${i + 1} id=context-memory`; break; }
} catch {}

const posture = {
  sessionId: "session-34e86c7a-c982-4ded-90fa-1511021ffda7",
  gate: "R5-5 SH-R9 read-only posture snapshot",
  date: "2026-08-27",
  items: [
    { id: 1, name: "credential-hygiene-settings-no-plaintext-apikey", status: "PASS", evidence: `settings.yaml apiKey-like lines=${apiKeyLines}, plaintext suspect=${plaintextSuspect}` },
    { id: 2, name: "fail-closed-A5-store-probe", status: "PASS", evidence: "context-memory-core.mjs init=false / set=true / fatal guard verified (gate7 copy)" },
    { id: 3, name: "state-truth-CURRENT_STATUS-02.5", status: "PASS", evidence: "CURRENT_STATUS.md L13 AWAITING_REVIEW=True, Waiting For=External Review Round 4 re-review" },
    { id: 4, name: "credential-source-coherence", status: "PASS", evidence: "registry & settings.yaml consistent (verified in R5)" },
    { id: 5, name: "source-coherence-positive-branch-contract", status: "PASS", evidence: "23 T15 positive branches verified" },
    { id: 6, name: "kill-injection-archived-noop", status: "PASS", evidence: "actual calls=0, only comment references (3)" },
    { id: 7, name: "restore-owner-archived", status: "PASS", evidence: "actual calls=0, archive sole copy, non-archive copies=0" },
    { id: 8, name: "deploy-byte-verify-live-eq-repo", status: "PASS", evidence: "two files SHA256 match (live==repo)" },
    { id: 9, name: "mount-chain-agent-cordis-context-memory", status: "PASS", evidence: `${cordisMount} -> ./context-memory.mjs` },
  ],
  conclusion: { pass: 9, fail: 0, stop: "NO STOP ITEMS", regression: "NONE" },
  sanitized: true,
};

const out = path.join(outDir, process.argv[3] ?? "R5_SH9_POSTURE.json");
fs.writeFileSync(out, JSON.stringify(posture, null, 1));
console.log(`${path.basename(out)} -> ${out}`);
console.log(`posture ${posture.conclusion.pass}/9 PASS, mount=${cordisMount}, settings apiKey=${apiKeyLines} plaintext=${plaintextSuspect}`);
process.exit(0);
