// test-learn-ac6-e2e-mutex.mjs —— AC6 重 E2E 的**并发互斥**专项门（真缺陷回归修复，2026-09-29）
//
// 缺陷（实测，非假想；证据见 %TEMP%\ac6-real-e2e-* 两份 report 对照）：
//   `candidate/<candidateId>` 是确定性分支名，而 `_wt-ac6` / `_wt-ci` / `_p4r2-inject-fix`
//   等所有 worktree **共享同一 refs 命名空间**。两次重 E2E 一旦时间重叠，后者就撞上前者已建的分支：
//     171553 报告 failures[0] = "git worktree add -b candidate/cand_d9b6ae32 ... fatal: a branch
//     named 'candidate/cand_d9b6ae32' already exists"，同一份 report 的 cleanup 却写
//     "branch -D candidate/cand_d9b6ae32 failed: branch not found" —— 自相矛盾 ⇒ 唯一解释是并发，
//   那 8 个 FAIL 是**并发测量伪影**，不是产品缺陷（串行时稳定 24/24）。
//
// 本门锁死的契约：
//   M1 锁落在**共享 git 目录**（跨 worktree 可见），不是本 worktree 私有目录
//   M2 已持有 → 第二次取锁必须被拒（held），不得静默并行
//   M3 持锁时真跑 E2E ⇒ **exit 3 快速失败**、stdout 明确报"另一个 AC6 运行持有锁"、
//      且 **git 零副作用**（无新 worktree / 无新分支 / HEAD 不变 / 无新临时残骸目录）
//   M4 释放后可再取（锁不是一次性的；不会自我死锁）
//   M5 不误删他人锁（owner.json 记的 pid 非本进程时，release 必须拒绝，锁目录仍在）
//   M6 陈旧锁（>20 分钟）可被抢占（避免进程被强杀后永久死锁）；未过期则不许抢
//   M7 全流程跑完：锁目录不存在、git 状态与本门开始前逐字一致（零泄漏）
//
// 纪律：只读 git（除建/删锁目录本身）；不触碰其他 worktree；不 push；不重启服务。
// 运行：node tests/learn/test-learn-ac6-e2e-mutex.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LOCK_NAME, DEFAULT_STALE_MS, sharedGitDir, lockDirFor, readLockOwner, acquireAc6Lock, releaseAc6Lock }
  from './ac6-e2e-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const E2E = path.join(HERE, 'test-learn-ac6-real-promotion-e2e.mjs');

let pass = 0; let fail = 0; const failures = [];
function check(name, fn) {
  try { const v = fn(); pass += 1; console.log(`  PASS  ${name}${v === undefined ? '' : ` — ${v}`}`); return v; }
  catch (e) { fail += 1; failures.push(`${name} :: ${e.message}`); console.log(`  FAIL  ${name}\n        ${e.message}`); return null; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}
const tempRoots = () => {
  try { return fs.readdirSync(os.tmpdir()).filter((f) => /^ac6-real-e2e-\d{14}$/.test(f)).sort(); } catch { return []; }
};
const gitState = () => ({
  head: git(['rev-parse', 'HEAD']),
  worktrees: git(['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).sort(),
  candidateBranches: git(['branch', '--list', 'candidate/*', '--format=%(refname:short)']).split(/\r?\n/).filter(Boolean).sort(),
});

console.log('=== AC6 重 E2E 并发互斥专项门 ===');
console.log(`仓库 : ${REPO}`);
const COMMON = sharedGitDir(REPO);
const LOCK_DIR = lockDirFor(REPO);
console.log(`共享 git 目录（全 worktree 共同 refs 空间）: ${COMMON}`);
console.log(`锁目录: ${LOCK_DIR}`);
console.log('');

const before = gitState();
const rootsBefore = tempRoots();
let heldByUs = false;
try {
  // ── M1 锁位置：必须在共享 git 目录下（否则其他 worktree 根本看不见，等于没锁）──────
  check('M1 锁目录位于共享 git 目录（跨 worktree 可见，而非本 worktree 私有）', () => {
    assertEq(path.dirname(LOCK_DIR), COMMON, 'lock parent dir');
    assertEq(path.basename(LOCK_DIR), LOCK_NAME, 'lock dir name');
    assert(/[\\/]\.git$/.test(COMMON), `共享 git 目录不像 .git: ${COMMON}`);
    assert(fs.existsSync(COMMON), 'shared git dir missing');
    return COMMON;
  });

  // ── M2 首次取锁成功 + 第二次必须被拒 ──────────────────────────────────────────
  check('M2 首次取锁成功，且锁内记录了本进程 pid（可诊断"谁在跑"）', () => {
    const a = acquireAc6Lock({ repo: REPO });
    assert(a.ok === true, `first acquire failed: ${JSON.stringify(a)}`);
    heldByUs = true;
    const owner = readLockOwner(LOCK_DIR);
    assertEq(Number(owner?.pid), process.pid, 'owner pid');
    assert(typeof owner?.startedAt === 'string' && owner.startedAt.length > 0, 'owner.startedAt missing');
    return `pid=${process.pid} startedAt=${owner.startedAt}`;
  });
  check('M2 已持有 → 第二次取锁被拒（held，绝不静默并行）', () => {
    const b = acquireAc6Lock({ repo: REPO });
    assertEq(b.ok, false, 'second acquire unexpectedly succeeded');
    assertEq(b.reason, 'held', 'reason');
    assertEq(Number(b.owner?.pid), process.pid, 'reported owner pid');
    assert(b.ageMs >= 0 && b.ageMs <= DEFAULT_STALE_MS, `ageMs out of range: ${b.ageMs}`);
    return `held by pid=${b.owner.pid}, age=${Math.round(b.ageMs / 1000)}s`;
  });

  // ── M3 持锁时真跑 E2E：快速失败 + git 零副作用（核心：不让并发变成 8 条假失败）───
  const c0 = Date.now();
  const child = spawnSync(process.execPath, [E2E], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  const elapsedMs = Date.now() - c0;
  const out = `${child.stdout || ''}${child.stderr || ''}`;
  check('M3 持锁时真跑 E2E → exit 3 快速失败（不是 1：不是缺陷；不是 2：不是环境不满足）', () => {
    assert(child.error === undefined, `spawn failed/timeout: ${child.error?.message}`);
    assertEq(child.status, 3, `exit code (out tail: ${out.slice(-400)})`);
    assert(elapsedMs < 20_000, `too slow: ${elapsedMs}ms（快速失败应是秒级，不该跑完整个 E2E）`);
    return `exit=3, ${elapsedMs}ms`;
  });
  check('M3 stdout 明确报"另一个 AC6 运行持有锁"并给出锁目录/持有者', () => {
    assert(/BLOCKED/.test(out), 'no BLOCKED marker in output');
    assert(/持有锁/.test(out), 'no "持有锁" wording');
    assert(out.includes(LOCK_DIR), 'lock dir not printed');
    assert(out.includes(String(process.pid)), 'holder pid not printed');
    return 'blocked 原因/锁目录/持有者 pid 均已打印';
  });
  check('M3 git 零副作用：无新 worktree / 无新分支 / HEAD 不变 / 无新临时残骸目录', () => {
    const after = gitState();
    assertEq(after.head, before.head, 'HEAD changed');
    assertEq(after.worktrees.join('|'), before.worktrees.join('|'), 'worktree list changed');
    assertEq(after.candidateBranches.join('|'), before.candidateBranches.join('|'), 'candidate/* branches changed');
    const newRoots = tempRoots().filter((r) => !rootsBefore.includes(r));
    assertEq(newRoots.length, 0, 'new temp corpses: ' + newRoots.join(', '));
    return `无新 worktree/分支/残骸，HEAD=${after.head.slice(0, 12)}`;
  });
  check('M3 阻塞留痕：写入 blocked 报告（含锁持有者与理由），路径可从 stdout 复算', () => {
    const m = out.match(/报告\s*:\s*(.+\.json)\s*$/m);
    assert(m, 'blocked report path not printed');
    const p = m[1].trim();
    assert(fs.existsSync(p), `blocked report missing: ${p}`);
    const rep = JSON.parse(fs.readFileSync(p, 'utf8'));
    assertEq(rep.blocked, true, 'blocked flag');
    assertEq(rep.reason, 'another_ac6_run_holds_lock', 'reason');
    assertEq(Number(rep.lockOwner?.pid), process.pid, 'reported lockOwner pid');
    // 短名 8.3（ADMINI~1）/ 大小写差异会让朴素比较误判 → 归一后再比归档目录
    const norm = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
    assertEq(norm(path.dirname(p)), norm(path.join(os.tmpdir(), 'ac6-real-e2e-reports')), 'blocked report 归档目录');
    return p;
  });

  // ── M4 释放后可再取（不自我死锁；锁不是一次性）────────────────────────────────
  check('M4 释放后可再取 + 释放是幂等的（锁非一次性，也不会自我死锁）', () => {
    const rel = releaseAc6Lock(LOCK_DIR);
    assertEq(rel.released, true, `release failed: ${JSON.stringify(rel)}`);
    heldByUs = false;
    assert(!fs.existsSync(LOCK_DIR), 'lock dir still present after release');
    const again = acquireAc6Lock({ repo: REPO });
    assert(again.ok === true, `re-acquire failed: ${JSON.stringify(again)}`);
    heldByUs = true;
    releaseAc6Lock(LOCK_DIR);
    heldByUs = false;
    assert(!fs.existsSync(LOCK_DIR), 'lock dir still present after second release');
    return 'release → re-acquire → release 全通';
  });

  // ── M5 不误删他人锁（抢占竞态里的安全阀）─────────────────────────────────────
  check('M5 非持有者不得释放他人锁（owner.pid 非本进程 → 拒绝且锁目录仍在）', () => {
    fs.mkdirSync(LOCK_DIR);
    const foreign = { pid: 999_999, startedAtEpoch: Date.now(), startedAt: new Date().toISOString(), host: 'foreign' };
    fs.writeFileSync(path.join(LOCK_DIR, 'owner.json'), JSON.stringify(foreign), 'utf8');
    const rel = releaseAc6Lock(LOCK_DIR);
    assertEq(rel.released, false, 'must refuse to release a foreign lock');
    assertEq(rel.reason, 'not_owner', 'reason');
    assert(fs.existsSync(LOCK_DIR), 'foreign lock was deleted (dangerous!)');
    // 真实弃锁：他人持有且未过期 → 取锁也必须被拒（不许抢活锁）
    const grab = acquireAc6Lock({ repo: REPO });
    assertEq(grab.ok, false, 'must not steal a live foreign lock');
    assertEq(grab.reason, 'held', 'reason');
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });   // 清掉本测试自己造的假锁
    assert(!fs.existsSync(LOCK_DIR), 'fake lock cleanup failed');
    return '他人锁：release 拒绝 + acquire 被拒 + 假锁已清';
  });

  // ── M6 陈旧锁可抢占（防"上次被强杀 → 永久死锁"）；未过期不可抢 ─────────────────
  check('M6 陈旧锁（>20 分钟）可被抢占，并留下前持有者信息；未过期锁不许抢', () => {
    const now = Date.now();
    fs.mkdirSync(LOCK_DIR);
    const stale = { pid: 999_998, startedAtEpoch: now - DEFAULT_STALE_MS - 60_000, startedAt: new Date(now - DEFAULT_STALE_MS - 60_000).toISOString(), host: 'stale' };
    fs.writeFileSync(path.join(LOCK_DIR, 'owner.json'), JSON.stringify(stale), 'utf8');
    const a = acquireAc6Lock({ repo: REPO });
    assert(a.ok === true, `stale lock not taken over: ${JSON.stringify(a)}`);
    assertEq(a.staleTakenOver, true, 'staleTakenOver flag');
    assertEq(Number(a.previousOwner?.pid), 999_998, 'previousOwner pid 未保留（丢诊断信息）');
    assert(a.previousAgeMs > DEFAULT_STALE_MS, `previousAgeMs=${a.previousAgeMs}`);
    heldByUs = true;
    assertEq(Number(readLockOwner(LOCK_DIR)?.pid), process.pid, 'after takeover the owner must be us');
    // 抢占后我们持的是**活锁** → 未过期，第三方不许再抢
    const b = acquireAc6Lock({ repo: REPO });
    assertEq(b.ok, false, 'fresh lock after takeover must not be stealable');
    return `stale(pid=999998, age=${Math.round(a.previousAgeMs / 60000)}min) 被抢占；未过期锁不可抢`;
  });
} finally {
  if (heldByUs) { try { releaseAc6Lock(LOCK_DIR); } catch { /* 收尾尽力而为 */ } }
}

// ── M7 零泄漏：锁目录不存在，git 状态与本门开始前逐字一致 ────────────────────────
check('M7 零泄漏：锁目录已清除 + git 状态与本门开始前逐字一致（含无新残骸）', () => {
  assert(!fs.existsSync(LOCK_DIR), `lock dir leaked: ${LOCK_DIR}`);
  const after = gitState();
  assertEq(after.head, before.head, 'HEAD changed');
  assertEq(after.worktrees.join('|'), before.worktrees.join('|'), 'worktree list changed');
  assertEq(after.candidateBranches.join('|'), before.candidateBranches.join('|'), 'candidate/* branches changed');
  const newRoots = tempRoots().filter((r) => !rootsBefore.includes(r));
  assertEq(newRoots.length, 0, 'new temp corpses: ' + newRoots.join(', '));
  return '锁无泄漏、git 无副作用';
});

console.log('\n=== 汇总 ===');
console.log(`  AC6 E2E 并发互斥门: ${pass} PASS / ${fail} FAIL`);
if (fail === 0) console.log('  PASS AC6 real-E2E mutex (shared-git-dir lock: fast-fail, zero git side effects, stale takeover)');
else console.log('  FAIL AC6 real-E2E mutex — ' + failures.join(' ; '));
process.exit(fail === 0 ? 0 : 1);
