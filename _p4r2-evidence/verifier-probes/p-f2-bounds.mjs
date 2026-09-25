// F2 边界实测：LEARN_SESSION_STORE_MAX_FILES = 63 / 64 / 65 的实际行为
// 期望（阶段五规格）：63 → config validation failure（minimum supported sessionStoreMaxFiles is 64）；64/65 → accept
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShell, mkCtx, freshStateDir, say } from './_vfy-lib.mjs';

const { apply } = await loadShell();
for (const v of [63, 64, 65]) {
  const dir = freshStateDir(`vfy-f2-${v}`);
  process.env.LEARN_SESSION_STORE_MAX_FILES = String(v);
  let api = null; let thrown = null;
  const { ctx, logs } = mkCtx();
  try { api = await apply(ctx, { stateDir: dir }); } catch (e) { thrown = e?.message ?? String(e); }
  const policy = api ? api.retentionPolicy() : null;
  const validationLog = logs.filter((l) => /minimum supported|invalid|config/i.test(l));
  // 造 66 个"已关闭"会话文件 + 1 个活跃会话，看保留策略的实际保留数
  for (let i = 0; i < 66; i++) fs.writeFileSync(path.join(dir, `sess-${String(i).padStart(3, '0')}.json`), '{"schemaVersion":2,"experiences":[],"telemetry":[]}');
  let report = null;
  if (api) { api._touchActiveForTest('sess-000'); report = api.pruneSessionStore(Date.now()); }
  const files = fs.readdirSync(dir).filter((n) => /^sess-.*\.json$/.test(n)).length;
  say(JSON.stringify({
    ENV: v, apply_threw: thrown, retention_maxFiles: policy?.maxFiles ?? null,
    config_validation_log: validationLog, validation_present: validationLog.length > 0,
    scanned: report?.scanned ?? null, removed: report?.removed ?? null, kept: report?.kept ?? null,
    session_files_left: files, active_protected: files > (policy?.maxFiles ?? 0),
  }));
}
