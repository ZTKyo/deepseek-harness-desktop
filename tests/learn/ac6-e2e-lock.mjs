// ac6-e2e-lock.mjs —— AC6 重 E2E 的**跨 worktree 互斥锁**（真缺陷回归修复，2026-09-29）
//
// 存在理由（实测缺陷，非假想）：
//   `test-learn-ac6-real-promotion-e2e.mjs` 会在**确定性命名的隔离分支** `candidate/<candidateId>`
//   上真跑 `git worktree add -b`。而 `_wt-ac6` / `_wt-ci` / `_p4r2-inject-fix` 等**所有 worktree
//   共享同一个 refs 命名空间**（实测三者 `git rev-parse --git-common-dir` 全等于
//   `.../deepseek-harness-desktop/.git`）。于是两次运行一旦时间重叠，后者就会撞上前者已建的分支：
//     live 证据（%TEMP%\ac6-real-e2e-* 两份 report 对照）
//       171459: started 17:15:00.099Z → finished 17:15:56.809Z, pass=24 fail=0
//       171553: started 17:15:53.763Z（上一次还没结束）,       pass=16 fail=8
//       failures[0] = "git worktree add -b candidate/cand_d9b6ae32 ... fatal: a branch named
//                      'candidate/cand_d9b6ae32' already exists"
//       cleanup     = "git branch -D candidate/cand_d9b6ae32 failed: branch ... not found"
//   两次观察自相矛盾（后者说分支已存在、又被清理成不存在）⇒ 唯一解释就是**并发**，
//   8 个 FAIL 是并发测量伪影，不是产品缺陷；串行时该 suite 稳定 24/24。
//
// 设计要点（为什么不改分支命名）：收据契约逐字断言 `candidate/<candidateId>`（负控里还有
// `branch=candidate/somebody-else expected=...`），改名会破坏收据语义 ⇒ **只能加锁**。
//
// 锁位置：共享 git 目录（`git rev-parse --git-common-dir`）下的 `ac6-real-e2e.lock/`，
// 对**所有 worktree 可见**。原子性靠 `fs.mkdirSync`（已存在即 EEXIST，OS 级原子）。
// 陈旧锁：默认 >20 分钟视为陈旧可抢占（避免进程被杀后永久死锁）；可用
// `AC6_E2E_LOCK_STALE_MS` 覆盖。
//
// 纪律：本模块零网络、零子进程（只在求锁目录时跑一次**只读** git），不写仓库工作区。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOCK_NAME = 'ac6-real-e2e.lock';
export const DEFAULT_STALE_MS = 20 * 60 * 1000;

/** 共享 git 目录（所有 worktree 共同的 refs 命名空间）——锁必须放这里才对并发可见。 */
export function sharedGitDir(repo) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git rev-parse --git-common-dir failed in ${repo}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  const raw = (r.stdout || '').trim();
  if (!raw) throw new Error('git rev-parse --git-common-dir returned empty');
  return path.resolve(repo, raw);
}

export function lockDirFor(repo) {
  return path.join(sharedGitDir(repo), LOCK_NAME);
}

/** 读持有者信息；损坏/不可读时返回 null（调用方按 mtime 判陈旧）。 */
export function readLockOwner(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 锁的年龄（ms）：优先 startedAtEpoch，其次 owner.json 的 mtime，最后目录 mtime；都拿不到 → Infinity。 */
export function lockAgeMs(lockDir, now = Date.now()) {
  const owner = readLockOwner(lockDir);
  const fromOwner = Number(owner?.startedAtEpoch);
  if (Number.isFinite(fromOwner) && fromOwner > 0) return now - fromOwner;
  for (const p of [path.join(lockDir, 'owner.json'), lockDir]) {
    try { return now - fs.statSync(p).mtimeMs; } catch { /* 继续尝试下一个 */ }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 尝试取锁。
 * @returns {{ok:true, lockDir:string, owner:object, staleTakenOver:boolean}}
 *        | {{ok:false, reason:'held', lockDir:string, owner:object|null, ageMs:number}}
 * 非 EEXIST 的错误一律抛出（fail-closed + 可诊断，不做静默绕过）。
 */
export function acquireAc6Lock({ repo, staleMs = Number(process.env.AC6_E2E_LOCK_STALE_MS) || DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const lockDir = lockDirFor(repo);
  const mine = {
    pid: process.pid,
    startedAtEpoch: now,
    startedAt: new Date(now).toISOString(),
    host: os.hostname(),
    repo,
    cwd: process.cwd(),
    node: process.version,
    argv: process.argv.slice(0, 3),
  };
  const write = () => fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(mine, null, 2), 'utf8');

  let staleTakenOver = false;
  try {
    fs.mkdirSync(lockDir);           // ★ 原子：别人已持有 → EEXIST
    write();
    return { ok: true, lockDir, owner: mine, staleTakenOver };
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }

  const owner = readLockOwner(lockDir);
  const ageMs = lockAgeMs(lockDir, now);
  if (ageMs <= staleMs) {
    return { ok: false, reason: 'held', lockDir, owner, ageMs };
  }
  // 陈旧（多半是上次进程被强杀）：抢占一次；抢不到说明有人刚好同时也在抢 → 仍判 held。
  const holder = Number(owner?.pid);
  const holderAlive = Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder);
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 下面 mkdir 会给出真实结论 */ }
  try {
    fs.mkdirSync(lockDir);
    staleTakenOver = true;
    write();
    return { ok: true, lockDir, owner: mine, staleTakenOver, previousOwner: owner ?? null, previousAgeMs: ageMs, previousHolderAlive: holderAlive };
  } catch (e2) {
    if (e2?.code !== 'EEXIST') throw e2;
    return { ok: false, reason: 'held', lockDir, owner: readLockOwner(lockDir), ageMs: lockAgeMs(lockDir, now) };
  }
}

/** 仅当锁的 owner.json 记的 pid 是本进程时才释放（避免抢占竞态里误删别人的锁）。 */
export function releaseAc6Lock(lockDir) {
  if (!lockDir) return { released: false, reason: 'no_lock_dir' };
  const owner = readLockOwner(lockDir);
  if (owner && Number(owner.pid) !== process.pid) {
    return { released: false, reason: 'not_owner', ownerPid: Number(owner.pid), selfPid: process.pid };
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (e) {
    return { released: false, reason: 'rm_failed', error: e.message };
  }
  return { released: true };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
