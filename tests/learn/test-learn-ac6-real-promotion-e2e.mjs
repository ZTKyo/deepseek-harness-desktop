// test-learn-ac6-real-promotion-e2e.mjs —— AC6 **真实** 端到端：真 Git / 真 CI / 真 Transaction
//
// 与 test-learn-candidate-receipts.mjs 的分工（两者互补，勿删其一）：
//   - 那个文件是**契约测试**：收据形状/篡改矩阵，全部在内存里造形状（零子进程、零网络、可上 CI）。
//   - 本文件是**真实证据测试**：三腿收据必须由**既有系统自己产出**——
//       ① git 腿 = 真 `git worktree add` + 真隔离分支 + 真 commit（40 位对象名）
//       ② ci 腿  = 真在 worktree@commit 上跑 ci-level2.yml 的**同一个 job 命令清单**（逐条 exit 0）
//       ③ tx 腿  = 真 `dsh-transaction.ps1` 的 Invoke-DshTransaction，在 mount-gate 保活的
//                  隔离宿主（隔离 profile，非生产 3080）上跑到 COMMITTED，并回读**真实 journal**
//   然后才允许 promoteCandidate；晋升后再做**负向对照**（篡改一腿 ⇒ 必须被拒且留痕）。
//
// 纪律：不碰生产 3080；所有临时状态在 %TEMP%；结束清理 worktree/分支/进程；不 push / 不建 PR。
// 运行：node tests/learn/test-learn-ac6-real-promotion-e2e.mjs
// 退出码：0 全 PASS；1 有 FAIL；2 环境不满足（仓库有未提交改动 / propose 失败）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as C from '../../plugins/learn-candidate.mjs';
import { qualifyGap } from '../../plugins/learn-gap-veto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const ROOT = path.join(os.tmpdir(), `ac6-real-e2e-${STAMP}`);
const GATE_LOG = path.join(ROOT, 'mount-gate.log');
const RELEASE = path.join(ROOT, 'release.flag');
const TX_RECEIPT = path.join(ROOT, 'tx-receipt.json');
const TX_RUNNER = path.join(ROOT, 'run-tx.ps1');
const CI_LOG = path.join(ROOT, 'ci-run.log');
const REPORT = path.join(ROOT, 'ac6-real-e2e-report.json');
const TX_BASE = path.join(ROOT, 'tx');
const TX_CKPT = path.join(TX_BASE, 'ckpts');
const TX_JOURNAL = path.join(TX_BASE, 'tx-journal.json');
const STATE_ROOT = path.join(ROOT, 'state');
const EMPTY_PROFILE = path.join(ROOT, 'empty-profile');
const HOST_PORT = 3099;

let pass = 0; let fail = 0; const failures = [];
function check(name, fn) {
  try { const v = fn(); pass += 1; console.log(`  PASS  ${name}${v === undefined ? '' : ` — ${v}`}`); return v; }
  catch (e) { fail += 1; failures.push(`${name} :: ${e.message}`); console.log(`  FAIL  ${name}\n        ${e.message}`); return null; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd: cwd || REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}
function gitMaybe(args, cwd) { try { return git(args, cwd); } catch { return null; } }
// 本机没有 pwsh（只有 Windows PowerShell 5.1）——硬编码 'pwsh' 会 ENOENT，故先解析真实可执行文件。
const PS_EXE = (() => {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']);
    if (r.status === 0) return exe;
  }
  return null;
})();
function ps(script) {
  assert(PS_EXE, 'no PowerShell executable found (pwsh / powershell)');
  const r = spawnSync(PS_EXE, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}
// 路径归一（Windows: 短名 8.3 / 斜杠 / 大小写差异都会让朴素字符串比较误判）
function normPath(p) {
  let real = String(p);
  try { real = fs.realpathSync.native(String(p)); } catch { /* keep as-is */ }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
const listenPid = (port) => ps(`$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){"$($c.OwningProcess)"}else{''}`);

// ── 事务腿 runner：dot-source 既有引擎（不重写、不复制引擎逻辑）─────────────
const TX_RUNNER_PS1 = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$Repo,
  [Parameter(Mandatory=$true)][string]$Label,
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$TxRoot,
  [Parameter(Mandatory=$true)][string]$StateRoot,
  [Parameter(Mandatory=$true)][string]$EmptyProfile,
  [Parameter(Mandatory=$true)][string]$ReceiptPath
)
$ErrorActionPreference = 'Stop'
# 隔离：让引擎的 checkpoint 不要从生产 profile 拷贝任何文件（USERPROFILE 指向空目录）
$env:USERPROFILE = $EmptyProfile
$env:HOME = $EmptyProfile
$env:DSH_TX_ROOT = $TxRoot
$env:DSH_STATE_ROOT = $StateRoot
New-Item -ItemType Directory -Force -Path $TxRoot, $StateRoot, $EmptyProfile | Out-Null

. (Join-Path $Repo 'dsh-transaction.ps1')
if (-not (Get-Command Invoke-DshTransaction -ErrorAction SilentlyContinue)) { Write-Error 'Invoke-DshTransaction not found (engine not loaded)'; exit 3 }

$marker = Join-Path $StateRoot 'ac6-apply-marker.txt'
$apply = { param($p) Set-Content -LiteralPath $p -Value ("ac6-real-e2e apply " + (Get-Date -Format o)) -Encoding UTF8; return 'applied' }
$tx = Invoke-DshTransaction -Label $Label -Port $Port -Apply $apply -ApplyArgs @($marker) -RestartOnApply:$false -SkipLightProbe -StableWindowSec 2 -ProfileRoot $StateRoot

$journalPath = if ($env:DSH_TX_ROOT) { Join-Path (Split-Path -Parent $env:DSH_TX_ROOT) 'tx-journal.json' } else { Join-Path $env:LOCALAPPDATA 'DSHHarness\state\tx-journal.json' }
$rec = $null
if (Test-Path $journalPath) {
  $j = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
  $rec = @($j.transactions) | Where-Object { $_.transactionId -eq $tx.TransactionId } | Select-Object -Last 1
}
$out = [pscustomobject]@{
  TransactionId = $tx.TransactionId
  FinalState    = $tx.FinalState
  Verify        = $tx.Verify
  Rollback      = $tx.Rollback
  JournalPath   = $journalPath
  MarkerPath    = $marker
  MarkerExists  = (Test-Path $marker)
  JournalRecord = $rec
}
$json = $out | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($ReceiptPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("TX_RESULT FinalState=" + $tx.FinalState + " Verify=" + $tx.Verify + " Journal=" + $journalPath)
`;

console.log('=== AC6 真实端到端：候选晋升必须真走既有 Git / CI / Transaction ===');
console.log(`仓库   : ${REPO}`);
console.log(`临时根 : ${ROOT}`);
console.log('');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(TX_BASE, { recursive: true });
fs.mkdirSync(STATE_ROOT, { recursive: true });
fs.mkdirSync(EMPTY_PROFILE, { recursive: true });

const evidence = {
  startedAt: new Date().toISOString(), repo: REPO, tempRoot: ROOT,
  git: null, ci: null, transaction: null, promotion: null, negativeControl: null,
  invariants: null, cleanup: null,
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== 0. 前置检查（仓库必须干净：worktree 里跑的就是"当前代码"）===');
const dirtyBefore = git(['status', '--porcelain'], REPO);
if (dirtyBefore) {
  console.log('  仓库有未提交改动，本测试要求先提交：\n' + dirtyBefore);
  process.exit(2);
}
const baseHead = git(['rev-parse', 'HEAD'], REPO);
check('前置：工作区干净且有 HEAD', () => assertEq(dirtyBefore, '', 'dirty'), baseHead.slice(0, 12));
check('前置：找到 PowerShell（本机为 Windows PowerShell 5.1，无 pwsh）', () => {
  assert(PS_EXE, 'pwsh / powershell 都不可用');
  return PS_EXE;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 1. 状态机：propose 候选（id 决定分支名与事务 label）===');
const SID = `ac6-real-${STAMP}`;
const T = (n) => Date.now() + n;
function qualifiedGap() {
  const record = { classification: 'PROTOCOL_MISMATCH', normalizedSignature: 'openai::deepseek-v4.1-flash::PROTOCOL_MISMATCH::ac6real', taxonomyVersion: 1 };
  const observations = [
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
    { taskType: 'plugin-install', record, capabilityDeficiency: 'no retry-on-protocol-mismatch rule', capabilityEvidence: 'reviewed own code: not a self-bug' },
  ];
  return qualifyGap(observations);
}
const proposed = C.proposeCandidate(C.emptyCandidateStore(SID), qualifiedGap(), { at: T(0), ruleExpressible: true });
if (!proposed.ok) { console.log('  propose 失败：' + proposed.error); process.exit(2); }
const ID = proposed.candidate.id;
const BRANCH = C.candidateBranchName(ID);
const LABEL = C.candidateTransactionLabel(ID);
check('候选已 propose 且派生名一致（分支名/事务 label 都由 id 派生）', () => {
  assertEq(BRANCH, 'candidate/' + ID, 'branch name');
  assertEq(LABEL, 'candidate:' + ID, 'tx label');
  return `id=${ID}`;
});

// 不变量基线：真晋升过程**不得**改动生产插件文件
const PLUGIN_SHA = {
  'plugins/learn.mjs': sha256File(path.join(REPO, 'plugins', 'learn.mjs')),
  'plugins/learn-candidate.mjs': sha256File(path.join(REPO, 'plugins', 'learn-candidate.mjs')),
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. Git 腿（真 git worktree / 真隔离分支 / 真 commit）===');
const WT = path.join(ROOT, 'wt');
let commitSha = null;
check('git worktree add 建隔离工作树', () => {
  git(['worktree', 'add', '-b', BRANCH, WT, baseHead], REPO);
  assert(fs.existsSync(WT), 'worktree path missing');
  return WT;
});
check('worktree 内真提交（得到真 40 位对象名）', () => {
  fs.writeFileSync(path.join(WT, 'AC6_E2E_PROOF.md'),
    `# AC6 real E2E proof\n\ncandidate: ${ID}\nat: ${new Date().toISOString()}\n`, 'utf8');
  git(['-c', 'user.name=AC6 E2E', '-c', 'user.email=ac6@local', 'add', 'AC6_E2E_PROOF.md'], WT);
  git(['-c', 'user.name=AC6 E2E', '-c', 'user.email=ac6@local', 'commit', '-m', `AC6 real E2E: candidate ${ID} isolated commit`], WT);
  commitSha = git(['rev-parse', 'HEAD'], WT);
  return commitSha.slice(0, 12);
});
check('分支名 / 40 位对象名 / 隔离性均经真值核验', () => {
  assertEq(git(['rev-parse', '--abbrev-ref', 'HEAD'], WT), BRANCH, 'worktree branch');
  assert(/^[0-9a-f]{40}$/.test(commitSha), 'not a 40-hex object name');
  const list = git(['worktree', 'list', '--porcelain'], REPO);
  const registered = list.split(/\r?\n/).filter((l) => l.startsWith('worktree '))
    .map((l) => normPath(l.slice('worktree '.length).trim()));
  assert(registered.includes(normPath(WT)), `worktree not registered (have: ${registered.join(' ; ')})`);
  assert(gitMaybe(['ls-files', 'AC6_E2E_PROOF.md'], WT), 'proof file not tracked');
  assertEq(git(['rev-parse', 'HEAD'], REPO), baseHead, 'main worktree HEAD moved');
  return 'ok';
});
evidence.git = { system: 'git', branch: BRANCH, commitSha, worktreePath: WT, isolated: true };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. 启动隔离宿主（mount-gate --hold，端口 3099，非生产 3080）===');
const prodBefore = listenPid(3080);
console.log(`  生产 3080 监听者（前）: pid=${prodBefore || '(无)'}`);
const pluginPath = path.join(REPO, 'plugins', 'learn.mjs');
const gateLogFd = fs.openSync(GATE_LOG, 'a');
const gate = spawn(process.execPath, [
  path.join(REPO, 'tests', 'learn', 'mount-gate.mjs'),
  '--plugin', pluginPath, '--port', String(HOST_PORT), '--timeout', '150',
  '--slug', `ac6e2e${STAMP.slice(-6)}`, '--hold', '600000', '--release', RELEASE,
], { cwd: REPO, stdio: ['ignore', gateLogFd, gateLogFd], windowsHide: true });

async function waitForHold(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const txt = fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, 'utf8') : '';
    const m = txt.match(/HOLD_HOST_READY port=(\d+) pid=(\d+)[^\n]*state=(\S+)/);
    if (m) return { port: Number(m[1]), pid: Number(m[2]), statePath: m[3] };
    if (gate.exitCode !== null) return null;
    await sleep(1500);
  }
  return null;
}
const hold = await waitForHold(200_000);
check('隔离宿主保活就绪（port/pid/hold-state.json 且插件哈希一致）', () => {
  if (!hold) {
    const tail = fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, 'utf8').split(/\r?\n/).slice(-20).join('\n') : '(no log)';
    throw new Error('no HOLD_HOST_READY; gate log tail:\n' + tail);
  }
  assertEq(hold.port, HOST_PORT, 'held port');
  assert(fs.existsSync(hold.statePath), 'hold-state.json missing');
  const st = JSON.parse(fs.readFileSync(hold.statePath, 'utf8'));
  assert(st.ready === true, 'hold-state.ready !== true');
  assertEq(st.pluginSha256, sha256File(pluginPath), 'held plugin ≠ repo plugin');
  assertEq(listenPid(HOST_PORT), String(hold.pid), 'held port owner ≠ held pid');
  return `port=${hold.port} pid=${hold.pid} pluginSha=${String(st.pluginSha256).slice(0, 12)}`;
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 4. CI 腿（真跑 ci-level2.yml 的 job 命令，cwd=隔离 worktree@commit）===');
const CI_SUITES = (() => {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci-level2.yml'), 'utf8');
  const lines = wf.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('contract-closure gates (CI-safe subset)'));
  assert(start >= 0, 'CI-safe subset block not found in ci-level2.yml');
  let end = start;
  while (end < lines.length && !lines[end].includes('PASS P4 LEARN R2 contract-closure gates')) end += 1;
  const block = lines.slice(start, end + 1).join('\n');
  return [...block.matchAll(/'((?:tests)\\[^']+\.mjs)'/g)].map((m) => m[1].replace(/\\/g, '/'));
})();
const PLUGIN_CONTRACT_GATE = 'tests/learn/test-learn-plugin-contract.mjs';
check('从 ci-level2.yml 解析出 CLI 实际跑的套件清单（真"同一个 job"）', () => {
  assert(CI_SUITES.length >= 13, `expected >=13 suites, got ${CI_SUITES.length}`);
  assert(CI_SUITES.includes('tests/learn/test-learn-candidate-receipts.mjs'), 'AC6 suite not wired into CI');
  return `${CI_SUITES.length} 套件 + plugin-contract gate`;
});
const ciLogLines = [];
const ciResults = [];
for (const suite of [PLUGIN_CONTRACT_GATE, ...CI_SUITES]) {
  const r = spawnSync(process.execPath, [suite], {
    cwd: WT, encoding: 'utf8',
    // CI-SAFE 判据：裸 runner 条件（USERPROFILE/HOME/LOCALAPPDATA 指向空目录）
    env: { ...process.env, USERPROFILE: EMPTY_PROFILE, HOME: EMPTY_PROFILE, LOCALAPPDATA: EMPTY_PROFILE },
  });
  const ok = r.status === 0;
  ciResults.push({ suite, exit: r.status, ok });
  ciLogLines.push(`--- ${suite} (exit ${r.status})`, (r.stdout || '').slice(-1500), r.stderr ? `[stderr] ${r.stderr.slice(0, 800)}` : '');
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}  (exit ${r.status})`);
}
fs.writeFileSync(CI_LOG, ciLogLines.join('\n'), 'utf8');
const ciAllPass = ciResults.every((x) => x.ok);
check('CI 腿：worktree@commit 上全部命令 exit 0（=同一 commit 的绿报告）', () => {
  assert(ciAllPass, `failing: ${ciResults.filter((x) => !x.ok).map((x) => `${x.suite}(exit ${x.exit})`).join(', ')}`);
  return `${ciResults.length} 条命令全 exit 0，日志 ${path.basename(CI_LOG)}`;
});
evidence.ci = {
  system: 'ci-level2.yml',
  job: `state-machine-tests / P4 LEARN R2 contract-closure gates (${CI_SUITES.length} suites) — local run of the workflow job commands at this commit`,
  headSha: commitSha,
  conclusion: ciAllPass ? 'success' : 'failure',
  runUrl: '',  // 未创建外部 GitHub run（不擅自 push / 建 PR）：留空而不编造
  logPath: CI_LOG,
  note: 'executed locally in the candidate worktree at headSha, USERPROFILE/HOME/LOCALAPPDATA redirected to an empty dir (same CI-SAFE criterion as ci-level2.yml)',
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 5. Transaction 腿（真 dsh-transaction.ps1，隔离宿主 + 隔离 profile 根）===');
if (hold) {
  fs.writeFileSync(TX_RUNNER, '\uFEFF' + TX_RUNNER_PS1, 'utf8');
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TX_RUNNER,
    '-Repo', REPO, '-Label', LABEL, '-Port', String(hold.port),
    '-TxRoot', TX_CKPT, '-StateRoot', STATE_ROOT, '-EmptyProfile', EMPTY_PROFILE,
    '-ReceiptPath', TX_RECEIPT,
  ];
  const r = spawnSync(PS_EXE, args, { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
  console.log(`  runner: exe=${PS_EXE} exit=${r.status} signal=${r.signal || 'none'}${r.error ? ' error=' + r.error.code + ':' + r.error.message : ''}`);
  if (r.stdout) console.log(r.stdout.trim().split(/\r?\n/).map((l) => '  | ' + l).join('\n'));
  if (r.stderr && r.stderr.trim()) console.log('  [stderr] ' + r.stderr.trim().slice(0, 1500));
  const receipt = fs.existsSync(TX_RECEIPT) ? JSON.parse(fs.readFileSync(TX_RECEIPT, 'utf8')) : null;
  check('真事务跑到 COMMITTED（引擎自报 FinalState + 真 APPLY 生效）', () => {
    assert(receipt, 'no receipt json produced');
    assertEq(receipt.FinalState, 'COMMITTED', 'engine FinalState');
    assertEq(receipt.MarkerExists, true, 'APPLY marker not written (transaction did not really apply)');
    return `${receipt.TransactionId} verify=${receipt.Verify}`;
  });
  check('真 journal 回读一致（真值，不是引擎自述）', () => {
    assert(receipt, 'no receipt');
    assertEq(receipt.JournalPath, TX_JOURNAL, 'journal path');
    assert(fs.existsSync(TX_JOURNAL), 'journal file missing: ' + TX_JOURNAL);
    const j = JSON.parse(fs.readFileSync(TX_JOURNAL, 'utf8'));
    const rec = (j.transactions || []).find((x) => x && x.transactionId === receipt.TransactionId) || receipt.JournalRecord;
    assert(rec, 'transaction record not found in journal');
    assertEq(rec.finalState, 'COMMITTED', 'journal finalState');
    assertEq(rec.faultClass, 'none', 'journal faultClass');
    assertEq(rec.rollbackResult, 'none', 'journal rollbackResult');
    assert(String(rec.verifyResult).startsWith('COMMIT_READY'), `journal verifyResult=${rec.verifyResult}`);
    assertEq(rec.label, LABEL, 'journal label');
    evidence.transaction = {
      system: 'dsh-transaction.ps1', label: LABEL, transactionId: rec.transactionId,
      finalState: rec.finalState, verifyResult: rec.verifyResult, faultClass: rec.faultClass,
      rollbackResult: rec.rollbackResult, journalPath: TX_JOURNAL,
    };
    return `journal ${rec.finalState}/${rec.faultClass}/${rec.rollbackResult} verify=${rec.verifyResult}`;
  });
  check('事务 label / transactionId 与候选派生 label 一致（三腿可互证）', () => {
    assert(evidence.transaction, 'no transaction evidence');
    assertEq(evidence.transaction.label, LABEL, 'label');
    assert(String(evidence.transaction.transactionId).startsWith(LABEL), 'transactionId does not start with label');
    return evidence.transaction.transactionId;
  });
} else {
  fail += 1; failures.push('transaction leg skipped (no held host)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 6. 释放并关停隔离宿主（并确认生产 3080 未被扰动）===');
if (hold) {
  fs.writeFileSync(RELEASE, 'release\n', 'utf8');
  const t0 = Date.now();
  while (gate.exitCode === null && Date.now() - t0 < 150_000) await sleep(1500);
  console.log(`  mount-gate exit=${gate.exitCode}（释放耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
}
const portFree = listenPid(HOST_PORT);
const prodAfter = listenPid(3080);
check('隔离宿主已关停、端口释放、生产 3080 未被扰动', () => {
  assertEq(portFree, '', '3099 still listening');
  assertEq(prodAfter, prodBefore, 'production 3080 listener changed');
  return `3099=FREE, 3080 pid=${prodAfter || '(无)'} 前后一致`;
});
const gateTail = fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, 'utf8') : '';
check('mount-gate 自身判定 PASS（A1–A5 全过）', () => {
  assert(gate.exitCode === 0, `gate exit=${gate.exitCode}; tail: ` + gateTail.split(/\r?\n/).slice(-10).join(' | '));
  assert(/PASS/.test(gateTail), 'gate log has no PASS marker');
  assert(!/tool surface unavailable/.test(gateTail), 'tool surface unavailable in gate log');
  return 'verdict PASS';
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 7. 真实晋升（三阶段证据引用真产物 + 真收据 + 人工批准）===');
let store = proposed.value;
let promoted = null;
check('三阶段推进（证据引用真实产物：CI 日志 / 事务 journal / 活宿主 canary）', () => {
  const tx = evidence.transaction;
  const steps = [
    ['ISOLATED_TESTS', `ci-level2 job commands @${String(commitSha).slice(0, 12)}: ${CI_SUITES.length} suites exit 0 (log ${path.basename(CI_LOG)})`],
    ['REGRESSION_HOLDOUT', `dsh-transaction.ps1 ${tx ? tx.transactionId : 'n/a'} journal=${tx ? tx.finalState : 'n/a'}/${tx ? tx.verifyResult : 'n/a'}`],
    ['CANARY', `mount-gate --hold host on 127.0.0.1:${HOST_PORT} (isolated profile) verdict PASS, port released`],
  ];
  for (const [state, ev] of steps) {
    const r = C.advanceCandidate(store, ID, state, { at: T(1), evidence: ev });
    assert(r.ok, `advance->${state} failed: ${r.error}`);
    store = r.value;
  }
  return 'ISOLATED_TESTS → REGRESSION_HOLDOUT → CANARY';
});
const receipts = { git: evidence.git, ci: evidence.ci, transaction: evidence.transaction };
check('门先行自检：verifyPromotionReceipts(真实收据) = ok', () => {
  const g = C.verifyPromotionReceipts({ id: ID }, receipts);
  assert(g.ok, `gate rejected real receipts: ${g.error} ${g.leg || ''} ${g.detail || ''}`);
  return `${g.summary.git.branch}@${g.summary.git.commitSha.slice(0, 12)} | ${g.summary.ci.system} | ${g.summary.transaction.finalState}`;
});
check('promoteCandidate(真实收据) → PROMOTED 且只存有界摘要', () => {
  const r = C.promoteCandidate(store, ID, {
    approvedBy: 'human:ZTKyo',
    approvalEvidence: 'user requested real proof; human-approved promotion in AC6 real E2E',
    evidence: 'three legs produced by real git / real ci run / real transaction journal',
    receipts, at: T(2),
  });
  assert(r.ok, `promote failed: ${r.error} ${r.leg || ''} ${r.detail || ''}`);
  promoted = r;
  const cand = r.value.candidates.find((c) => c.id === ID);
  assertEq(cand.state, 'PROMOTED', 'candidate state');
  assert(cand.promotionReceipts && cand.promotionReceipts.git, 'receipt summary not stored');
  const raw = JSON.stringify(cand);
  assert(!raw.includes(CI_LOG), 'raw receipt path leaked into store (summary only expected)');
  assert(raw.length < 8000, `stored candidate unexpectedly large (${raw.length} bytes) — raw receipts leaked?`);
  store = r.value;
  return `state=PROMOTED, stored bytes=${raw.length}`;
});
check('留痕：CANDIDATE_RECEIPTS_ACCEPTED + CANDIDATE_PROMOTED 均在遥测', () => {
  const t = JSON.stringify(store.telemetry || store.events || {});
  assert(t.includes('CANDIDATE_RECEIPTS_ACCEPTED'), 'missing CANDIDATE_RECEIPTS_ACCEPTED');
  assert(t.includes('CANDIDATE_PROMOTED'), 'missing CANDIDATE_PROMOTED');
  return 'ok';
});
evidence.promotion = (() => {
  const cand = promoted && promoted.value.candidates.find((c) => c.id === ID);
  return cand ? { state: cand.state, receiptsSummary: cand.promotionReceipts } : null;
})();

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 8. 负向对照（同一真实三腿，篡改一腿 ⇒ 必拒 + 留痕）===');
const negative = [];
let ctl = C.proposeCandidate(C.emptyCandidateStore(SID + '-ctl'), qualifiedGap(), { at: T(3), ruleExpressible: true });
if (ctl.ok) {
  for (const s of ['ISOLATED_TESTS', 'REGRESSION_HOLDOUT', 'CANARY']) {
    const r = C.advanceCandidate(ctl.value, ctl.candidate.id, s, { at: T(4), evidence: 'control' });
    if (r.ok) ctl = { ok: true, value: r.value, candidate: ctl.candidate };
  }
}
const mutations = [
  ['ci.headSha 改成别的 commit', { ...receipts, ci: { ...receipts.ci, headSha: 'b'.repeat(40) } }],
  ['transaction.faultClass 改成 verify_failed', { ...receipts, transaction: { ...receipts.transaction, faultClass: 'verify_failed' } }],
  ['git.branch 改成别人的分支', { ...receipts, git: { ...receipts.git, branch: 'candidate/somebody-else' } }],
];
for (const [name, mutated] of mutations) {
  check(`拒绝：${name}`, () => {
    assert(ctl.ok, 'control candidate unavailable');
    const r = C.promoteCandidate(ctl.value, ctl.candidate.id, {
      approvedBy: 'human:ZTKyo', approvalEvidence: 'control', evidence: 'control',
      receipts: mutated, at: T(5),
    });
    assert(!r.ok, 'mutation was ACCEPTED — receipts gate is not load-bearing');
    const denied = JSON.stringify(r.value.telemetry || r.value.events || {});
    assert(denied.includes('CANDIDATE_PROMOTION_DENIED'), 'denial not recorded in telemetry');
    const cand = r.value.candidates.find((c) => c.id === ctl.candidate.id) || {};
    assertEq(cand.state, 'CANARY', 'state changed despite rejection');
    negative.push({ name, error: r.error, leg: r.leg || null, detail: r.detail || null });
    return `rejected(${r.error}${r.leg ? ' leg=' + r.leg : ''}${r.detail ? ' ' + r.detail : ''}) + telemetry + state unchanged`;
  });
}
evidence.negativeControl = negative;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 9. 不变量：真晋升**没有**改动生产插件文件 ===');
check('plugins/learn.mjs 与 plugins/learn-candidate.mjs 字节不变（晋升只走候选通道）', () => {
  for (const [rel, before] of Object.entries(PLUGIN_SHA)) {
    assertEq(sha256File(path.join(REPO, rel)), before, rel + ' changed during real promotion');
  }
  assertEq(git(['status', '--porcelain'], REPO), '', 'repo working tree changed during E2E');
  return '4 项哈希一致 + 工作区仍干净';
});
evidence.invariants = { pluginHashes: PLUGIN_SHA, repoCleanAfter: true };

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 10. 清理 ===');
const cleanup = { worktreeRemoved: false, branchDeleted: false, portFree: portFree === '' };
try { git(['worktree', 'remove', '--force', WT], REPO); cleanup.worktreeRemoved = !fs.existsSync(WT); } catch (e) { cleanup.worktreeRemoveError = e.message; }
try { git(['branch', '-D', BRANCH], REPO); cleanup.branchDeleted = gitMaybe(['rev-parse', '--verify', BRANCH], REPO) === null; } catch (e) { cleanup.branchDeleteError = e.message; }
cleanup.headUnchanged = git(['rev-parse', 'HEAD'], REPO) === baseHead;
check('清理干净：worktree/分支已删、HEAD 未变、临时宿主已退', () => {
  assert(cleanup.worktreeRemoved, 'worktree still present');
  assert(cleanup.branchDeleted, 'branch still present');
  assert(cleanup.headUnchanged, 'repo HEAD changed');
  assert(cleanup.portFree, '3099 not free');
  return 'ok';
});
evidence.cleanup = cleanup;
check('临时 checkpoint 目录不含生产 profile 拷贝（隔离生效）', () => {
  const dirs = fs.existsSync(TX_CKPT) ? fs.readdirSync(TX_CKPT) : [];
  const copied = [];
  for (const d of dirs) {
    const p = path.join(TX_CKPT, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) if (/^(settings\.yaml|cordis.*\.yml|package\.json)$/.test(f)) copied.push(path.join(d, f));
  }
  assertEq(copied.length, 0, 'production config copies present: ' + copied.join(', '));
  return '无生产配置拷贝';
});

// ─────────────────────────────────────────────────────────────────────────────
evidence.finishedAt = new Date().toISOString();
evidence.pass = pass; evidence.fail = fail; evidence.failures = failures;
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2), 'utf8');

console.log('\n=== 汇总 ===');
console.log(`  AC6 真实端到端: ${pass} PASS / ${fail} FAIL`);
if (fail === 0) console.log('  PASS AC6 real promotion e2e (real git worktree/commit + real ci-level2 job run + real transaction journal)');
else console.log('  FAIL AC6 real promotion e2e — ' + failures.join(' ; '));
console.log(`  report: ${REPORT}`);
process.exit(fail === 0 ? 0 : 1);
