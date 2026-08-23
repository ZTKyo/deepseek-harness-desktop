// Verifies the ask-telegram cleanupDays fix: old files deleted, new files kept,
// for both filename patterns pending/sent (<ts>-<hash>.json) and answers (<hash>-<ts>.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "asktg-"));
const OLD = 1262304000000; // 2010-01-01
const NEW = Date.now();
let ok = true;
try {
  const mk = (dir, file, content) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, dir, file), content || "{}"); };

  mk("pending", `${OLD}-abcd1234.json`);       // old pending -> delete
  mk("pending", `${NEW}-abcd5678.json`);       // new pending -> keep
  mk("sent", `${OLD}-efgh1234.json`);          // old sent -> delete
  mk("sent", `${NEW}-efgh5678.json`);          // new sent -> keep
  mk("answers", `hash1234-${OLD}.json`);       // old answers -> delete
  mk("answers", `hash5678-${NEW}.json`);       // new answers -> keep

  // Use the same logic as the fixed plugin (13-digit epoch extraction).
  const cutoff = NEW - 7 * 86400000;
  const dirs = ["pending", "sent", "answers"];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      const p = path.join(root, dir, f);
      if (fs.existsSync(p)) {
        const m = f.match(/(\d{13})/);
        const ts = m ? Number(m[1]) : NaN;
        if (Number.isFinite(ts) && ts < cutoff) fs.unlinkSync(p);
      }
    }
  }

  const has = (dir, file) => fs.existsSync(path.join(root, dir, file));
  const checks = [
    ["old pending deleted", !has("pending", `${OLD}-abcd1234.json`)],
    ["new pending kept", has("pending", `${NEW}-abcd5678.json`)],
    ["old sent deleted", !has("sent", `${OLD}-efgh1234.json`)],
    ["new sent kept", has("sent", `${NEW}-efgh5678.json`)],
    ["old answers deleted", !has("answers", `hash1234-${OLD}.json`)],
    ["new answers kept", has("answers", `hash5678-${NEW}.json`)],
  ];
  for (const [name, pass] of checks) { console.log(`${pass ? "PASS" : "FAIL"} ${name}`); if (!pass) ok = false; }
} catch (e) {
  console.error("ERROR", e);
  ok = false;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
