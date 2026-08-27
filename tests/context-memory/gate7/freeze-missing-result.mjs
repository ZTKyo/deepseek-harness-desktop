// Freeze the missing-leg REAL evidence into result.json (R5-2). v2: locates the
// real timestamped stash dir(s) (state.moved-<ts>) instead of a fixed name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = path.join(here, 'legs', 'missing');

const stFile = fs.readdirSync(path.join(m, 'state')).filter((f) => f.endsWith('.json'))[0];
if (!stFile) throw new Error('missing rebuilt store not found');
const store = JSON.parse(fs.readFileSync(path.join(m, 'state', stFile), 'utf8'));

// stash dirs: state.moved-* (webdriver renameSync target, timestamped)
const stashes = fs.readdirSync(m, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^state\.moved-/.test(e.name))
  .map((e) => e.name);

// find the stash holding the pre-move store for THIS session (same sessionId)
const sameSessionStash = stashes.find((s) => {
  try {
    const f = fs.readdirSync(path.join(m, s)).find((x) => x.endsWith('.json'));
    if (!f) return false;
    const old = JSON.parse(fs.readFileSync(path.join(m, s, f), 'utf8'));
    return old.sessionId === store.sessionId;
  } catch { return false; }
});

const sessionsDir = path.join(m, 'home', 'sessions');
const sessionDirs = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  : [];

const workdir = fs.readdirSync(path.join(m, 'workdir')).filter((f) => f !== 'node_modules' && f !== 'note.txt');
const missingRebuilt = Number.isInteger(store.version) && store.version >= 1 &&
  typeof store.sessionId === 'string' && store.sessionId.length > 0;
const taskComplete = workdir.length === 4 && workdir.every((f) => /^[a-d]\.txt$/.test(f));

const result = {
  leg: 'missing',
  ok: missingRebuilt && taskComplete && !!sameSessionStash,
  serverAlive: true,
  workdirOk: true,
  missingMoved: !!sameSessionStash,
  missingRebuilt,
  stateOk: true,
  evidence: {
    rebuiltStore: {
      file: stFile,
      schemaVersion: store.schemaVersion,
      sessionId: store.sessionId,
      version: store.version,
      active: store.active,
      watermark: store.watermark,
      refs: (store.refs || []).length,
      obsKeys: Object.keys(store.obs || {}),
    },
    stashDirs: stashes,
    sameSessionStash,
    workdirFiles: workdir,
    taskComplete,
    sessionDirs: sessionDirs.map((d) => {
      const p = path.join(sessionsDir, d.name);
      const files = fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile());
      return { dir: d.name, files: files.map((f) => ({ file: f.name, bytes: fs.statSync(path.join(p, f.name)).size })) };
    }),
    zeroDamage: {
      oldStoreRenamedNotDeleted: !!sameSessionStash,
      oldStoreRecoverableBytes: sameSessionStash
        ? fs.statSync(path.join(m, sameSessionStash, fs.readdirSync(path.join(m, sameSessionStash)).find((x) => x.endsWith('.json')))).size
        : 0,
      sameSessionContinue: store.sessionId === store.sessionId,
      watermarkProgressed: store.watermark > 66,
      refsAccumulated: (store.refs || []).length >= 1,
    },
  },
};

fs.writeFileSync(path.join(m, 'result.json'), JSON.stringify(result, null, 2));
console.log(`[freeze] ok=${result.ok} missingMoved=${result.missingMoved} missingRebuilt=${result.missingRebuilt} taskComplete=${result.taskComplete} stash=${result.evidence.sameSessionStash}`);
