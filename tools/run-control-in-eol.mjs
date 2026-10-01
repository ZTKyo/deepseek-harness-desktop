// run-control-in-eol.mjs —— 在「指定的检出换行风格」下真跑某一个门/控制套件。
//
// 为什么需要它（真实事故，2026-10-01）：`ci-level1.yml` 里 Finding A 控制套件在 GitHub
// runner 上 FAIL（`A3a: expected pattern not found in docs/roadmap/P4_STATUS.json`），
// 而本机全绿。根因不是产品逻辑，而是**检出的换行风格**：仓库里的 blob 是 CRLF，
// Linux runner 检出 CRLF，本机工作树是 LF；控制套件里含字面 `\n` 的 needle 只在 LF 下匹配。
//
// ⇒ 「控制套件在 CI 上真的绿」必须**两种换行风格都真跑过**才算证明。本工具把仓库按
//   目标风格复制成干净检出（含一次真 commit，使 `git show HEAD:<file>` 可用），在其中运行
//   指定套件。本机与 CI 共用同一个实现，避免"CI 里另写一份模拟"造成第二套真相。
//
// 用法：node tools/run-control-in-eol.mjs <套件相对路径> <lf|crlf> [附加参数...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [suiteRel, eolArg, ...extra] = process.argv.slice(2);

if (!suiteRel || !['lf', 'crlf'].includes(String(eolArg || '').toLowerCase())) {
  console.error('usage: node tools/run-control-in-eol.mjs <suite-rel-path> <lf|crlf> [extra args...]');
  process.exit(2);
}
const eol = eolArg.toLowerCase();

const TEXT_EXT = new Set(['.md', '.json', '.mjs', '.js', '.cjs', '.yml', '.yaml', '.txt', '.csv', '.ps1', '.cmd', '.sh']);
const toLf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const toCrlf = (s) => toLf(s).replace(/\n/g, '\r\n');

// `git ls-files` is the source of truth: the copy must contain exactly the tracked tree,
// so a stray local file cannot make a control pass that would fail on the runner.
const ls = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (ls.status !== 0) {
  console.error('RUN-CONTROL-IN-EOL: FAILED — git ls-files failed: ' + (ls.stderr || ''));
  process.exit(2);
}
const tracked = ls.stdout.split(/\r?\n/).filter(Boolean);

const dest = fs.mkdtempSync(path.join(os.tmpdir(), `eol-${eol}-`));
let converted = 0;
for (const rel of tracked) {
  const from = path.join(REPO, rel);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (TEXT_EXT.has(path.extname(rel).toLowerCase())) {
    const text = fs.readFileSync(from, 'utf8');
    fs.writeFileSync(to, eol === 'crlf' ? toCrlf(text) : toLf(text), 'utf8');
    converted++;
  } else {
    fs.copyFileSync(from, to);
  }
}

// A real one-commit baseline: several gates compare against `git show HEAD:<file>`, and a
// copy without HEAD would make them red for a reason unrelated to the case under test.
// core.autocrlf is pinned false so the blobs really carry the requested EOL style
// (that is what a Linux runner does).
const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
const g = (args) => spawnSync('git', args, { cwd: dest, encoding: 'utf8', env: gitEnv });
g(['init', '-q']);
g(['add', '-A']);
g(['-c', 'user.email=eol-matrix@local', '-c', 'user.name=eol-matrix', 'commit', '-q', '-m', `${eol} baseline`]);

console.log(`run-control-in-eol: suite=${suiteRel} eol=${eol} tree=${dest} (${converted} text files converted)`);

const r = spawnSync(process.execPath, [suiteRel, ...extra], {
  cwd: dest, stdio: 'inherit', env: gitEnv,
});
fs.rmSync(dest, { recursive: true, force: true });
if (r.status !== 0) {
  console.log(`run-control-in-eol: FAILED (${suiteRel} is not ${eol.toUpperCase()}-checkout safe) exit=${r.status}`);
  process.exit(r.status === null ? 2 : r.status);
}
console.log(`run-control-in-eol: PASSED (${suiteRel} behaves identically in a ${eol.toUpperCase()} checkout)`);
