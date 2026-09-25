// insert_dup_grant 的**影响面**实测：单次消费（allowed-once）能否被重复消费？
// 对比 base（合法）与 dup 案例：连发两次 publishToGlobal，看第二次是否被拒。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCore, loadShell, mkCtx, hostSessionStore } from './_vfy-lib.mjs';

const BASE = path.join(os.tmpdir(), '_vfy-p6t-base');
const CASES = path.join(os.tmpdir(), '_vfy-p6t-cases');
const FACT = '_vfy-host-fact.json';
const LEDGER = (d) => path.join(d, '_human-approvals.jsonl');
const core = await loadCore();
const { apply } = await loadShell();

async function judge(dir, label) {
  const fact = JSON.parse(fs.readFileSync(path.join(dir, FACT), 'utf8'));
  const host = hostSessionStore(fact.sid, fact.ref, fact.reason);
  const { ctx } = mkCtx({ sessions: host.sessions });
  try { await apply(ctx, { stateDir: dir }); } catch { /* ignore */ }
  const store = JSON.parse(fs.readFileSync(path.join(dir, `${fact.sid}.json`), 'utf8'));
  const exp = store.experiences[0];
  const g = core.emptyGlobalStore();
  const c1 = core.canPublish(exp);
  const p1 = c1.ok ? core.publishToGlobal(g, exp, { at: Date.now() }) : { ok: false, error: 'skipped' };
  // 第二次：全新全局库 + 同一份（已被消费的）经验
  const g2 = core.emptyGlobalStore();
  const c2 = core.canPublish(exp);
  const p2 = c2.ok ? core.publishToGlobal(g2, exp, { at: Date.now() }) : { ok: false, error: 'skipped' };
  console.log(`[${label}] ledger_records=${core.parseApprovalLedgerText(fs.readFileSync(LEDGER(dir), 'utf8')).records.length}`);
  console.log(`[${label}] canPublish_1=${JSON.stringify(c1)} publish_1=${JSON.stringify(p1.ok ?? p1.error)}`);
  console.log(`[${label}] canPublish_2=${JSON.stringify(c2)} publish_2=${JSON.stringify(p2.ok ?? p2.error)}`);
  console.log(`[${label}] IMPACT=${(p1.ok && p2.ok) ? '★ 单次消费可被重复消费（回放成功）' : '第二次被拒（单次消费成立）'}`);
}

console.log('=== base（合法台账，未篡改）===');
await judge(BASE, 'base');
console.log('=== insert_dup_grant（追加一份重复 grant 并重算链）===');
await judge(path.join(CASES, 'insert_dup_grant'), 'dup');
console.log('=== replay_drop_consume（去掉 consume）===');
await judge(path.join(CASES, 'replay_drop_consume'), 'dropped');
