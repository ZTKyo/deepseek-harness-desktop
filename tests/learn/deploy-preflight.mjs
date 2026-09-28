#!/usr/bin/env node
/**
 * 生产部署预检（deploy pre-flight）—— **部署到生产挂载位之前**必须跑的那一层
 *
 * 为什么需要它（2026-09-28，AC2 收尾时发现的风险）：
 *   仓库 `plugins/` 与生产 profile 的差异**并不等于**"本轮要部署的文件集"：
 *   逐文件比对发现 learn 家族的**相对导入闭包**里有 4 个文件与生产不同，其中
 *   `failure-classifier-core.mjs` 的差异来自 **P2.6**（f44e822 / e72f879），
 *   与本轮 P4/AC2 无关。若按"让闭包全部一致"去部署，就会把 P2.6 的改动
 *   顺带推上生产（**范围外变更**，用户明确要求这类必须先确认）。
 *   反过来，若只部署 3 个文件而新 `learn-core.mjs` 恰好依赖新分类器的新导出，
 *   又会把生产推到"半新半旧"状态 —— 正是 mount-gate 诞生时那类事故（2026-09-26 生产 boot 失败）。
 *   ⇒ 唯一可靠做法：**按候选组合造一个"生产同形候选目录"，在真实 loader 上先挂一次**。
 *
 * 本脚本做的事（只读生产 + 只在临时目录写）：
 *   ① 计算 learn.mjs 的相对导入闭包（仓库源），逐文件与生产 sha256 比对；
 *   ② 按 `--deploy`（必填，显式列出要部署的文件）造候选目录：
 *        候选 = 生产当前文件（铺底） + `--deploy` 列出文件的**仓库版本**覆盖；
 *      ⇒ 候选目录 = "部署完成后的生产应有的样子"（逐字节核对来源）。
 *   ③ 闭包内**有差异但未列入 --deploy** 的文件 = STALE_BY_DESIGN（范围外）
 *      —— 打印其**最近一次改动的提交**，便于人工确认"确实与本轮无关"。
 *   ④ 调用既有 `tests/learn/mount-gate.mjs`（真实 loader / 真实 Cordis inject / 隔离 DSH_HOME）
 *      对候选 learn.mjs 做挂载级判定（A1 无失败签名 / A2 恰好 6 个 learn_* 工具 /
 *      A3 sessions 可解析 / A4 无工具面告警 / A5 记录生产监听者前后一致）。
 *   ⑤ verdict = PASS 仅当：哈希核对全 OK **且** mount-gate exit 0。
 *
 * 不做的事：**绝不写生产目录**（只在 os.tmpdir() 下造候选）；不重启服务；不改 cordis.patch.yml。
 *
 * 用法：
 *   node tests/learn/deploy-preflight.mjs \
 *        --deploy learn.mjs,learn-core.mjs,learn-candidate.mjs \
 *        [--prod "%USERPROFILE%\.dsh\profiles\web"] [--repo-plugins <dir>] \
 *        [--port 3098] [--slug pf] [--keep] [--json <outfile>]
 * 退出码：0 = PASS；1 = FAIL；2 = 参数/环境错误
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HOME = os.homedir();

function failEnv(msg) { console.error(`\n[env error] ${msg}\n`); process.exit(2); }

function argv() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = (i + 1 < a.length && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[k] = v;
    } else out._.push(a[i]);
  }
  return out;
}
const A = argv();
const PROD = path.resolve(String(A.prod ?? path.join(HOME, '.dsh', 'profiles', 'web')));
const SRC = path.resolve(String(A['repo-plugins'] ?? path.join(REPO, 'plugins')));
const ENTRY = String(A.entry ?? 'learn.mjs');
const PORT = String(A.port ?? '3098');
const SLUG = String(A.slug ?? 'pf');
const KEEP = Boolean(A.keep);
const JSON_OUT = A.json ? path.resolve(String(A.json)) : null;
const GATE = path.join(REPO, 'tests', 'learn', 'mount-gate.mjs');

if (!A.deploy || A.deploy === true) failEnv('缺少 --deploy <file1,file2,...>（显式列出本轮要部署的文件；不支持"全部同步"）');
const DEPLOY = String(A.deploy).split(',').map((s) => s.trim()).filter(Boolean);
if (!fs.existsSync(PROD)) failEnv(`生产 profile 目录不存在: ${PROD}`);
if (!fs.existsSync(SRC)) failEnv(`仓库 plugins 目录不存在: ${SRC}`);
if (!fs.existsSync(GATE)) failEnv(`找不到既有门禁: ${GATE}`);

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha12 = (p) => sha(p).slice(0, 12);

function localImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const re = /(?:from|import)\s*\(\s*['"](\.\/[^'"]+)['"]|from\s+['"](\.\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1] || m[2]);
  return [...out];
}

function lastCommit(file) {
  try {
    return execFileSync('git', ['log', '--oneline', '-1', '--', `plugins/${file}`], { cwd: REPO, encoding: 'utf8' }).trim() || '(无提交记录)';
  } catch { return '(git 查询失败)'; }
}

// ---------- ① 闭包 + 差异 ----------
const closure = [];
const seen = new Set();
(function walk(rel) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) { closure.push({ file: rel, missingInRepo: true }); return; }
  closure.push({ file: rel });
  for (const spec of localImports(abs)) walk(path.normalize(spec.replace(/^\.\//, '')));
})(ENTRY);

console.log('=== deploy pre-flight ===');
console.log(`  repo plugins : ${SRC}`);
console.log(`  production   : ${PROD}`);
console.log(`  entry        : ${ENTRY}   闭包 ${closure.length} 个文件`);
console.log(`  deploy set   : ${DEPLOY.join(', ')}`);
console.log('');

const rows = closure.map(({ file, missingInRepo }) => {
  const rp = path.join(SRC, file);
  const pp = path.join(PROD, file);
  const inRepo = !missingInRepo && fs.existsSync(rp);
  const inProd = fs.existsSync(pp);
  const hRepo = inRepo ? sha(rp) : null;
  const hProd = inProd ? sha(pp) : null;
  const planned = DEPLOY.includes(file);
  const same = hRepo && hProd && hRepo === hProd;
  const klass = !inRepo ? 'REPO_MISSING'
    : !inProd ? (planned ? 'NEW_FILE(计划新增)' : 'PROD_MISSING(未列入部署)')
      : same ? (planned ? 'SAME(计划部署但内容相同→空操作)' : 'SAME')
        : planned ? 'DEPLOY(计划部署)' : 'STALE_BY_DESIGN(有差异但范围外，不部署)';
  return { file, inRepo, inProd, hRepo, hProd, planned, klass };
});

for (const r of rows) {
  const tag = r.klass.padEnd(40);
  console.log(`  ${tag} ${r.file}`);
  console.log(`      repo=${r.hRepo ? r.hRepo.slice(0, 12) : '-'}  prod=${r.hProd ? r.hProd.slice(0, 12) : '-'}`);
  if (r.klass.startsWith('STALE')) console.log(`      最近改动来源: ${lastCommit(r.file)}   ← 请人工确认与本轮无关`);
}

const badDeployArg = DEPLOY.filter((f) => !closure.includes(f) && !rows.some((r) => r.file === f));
const notInClosure = DEPLOY.filter((f) => !rows.some((r) => r.file === f));
if (notInClosure.length) {
  console.log('');
  console.log(`  [warn] --deploy 里有文件不在 ${ENTRY} 的导入闭包里（仍会部署，但不会被挂载门禁覆盖）: ${notInClosure.join(', ')}`);
}

// ---------- ② 造候选目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-deploypf-${SLUG}-${stamp}-`));
const CAND = path.join(scratch, 'candidate');
fs.mkdirSync(CAND, { recursive: true });

const copyIn = (from, file) => { fs.copyFileSync(path.join(from, file), path.join(CAND, file)); };
for (const r of rows) {
  if (r.missingInRepo) continue;
  // 铺底：优先生产版本（=部署前生产）；仓库独有文件则用仓库版本；随后 --deploy 覆盖仓库版本
  if (fs.existsSync(path.join(PROD, r.file))) copyIn(PROD, r.file);
  else copyIn(SRC, r.file);
}
for (const f of DEPLOY) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) failEnv(`--deploy 指定的文件在仓库不存在: ${f}`);
  copyIn(SRC, f);
}

console.log('');
console.log(`  candidate    : ${CAND}  （临时目录；只读生产，绝不写生产）`);
console.log('  --- 候选逐字节来源核对 ---');
let hashOk = true;
for (const r of rows) {
  if (r.missingInRepo) continue;
  const want = r.planned ? r.hRepo : (fs.existsSync(path.join(PROD, r.file)) ? r.hProd : r.hRepo);
  const got = sha(path.join(CAND, r.file));
  const ok = want && got === want;
  if (!ok) hashOk = false;
  console.log(`    ${ok ? 'OK  ' : 'BAD '} ${r.file.padEnd(34)} ${got.slice(0, 12)}  期望=${want ? want.slice(0, 12) : '-'} (${r.planned ? 'repo' : 'prod'})`);
}
console.log(`  ⇒ 候选哈希核对: ${hashOk ? 'PASS' : 'FAIL'}`);

// ---------- ③ 真实 loader 挂载门禁 ----------
console.log('');
console.log(`  --- 真实 loader 挂载门禁（既有 tests/learn/mount-gate.mjs，隔离 DSH_HOME）---`);
const gateArgs = [GATE, '--plugin', path.join(CAND, ENTRY), '--port', PORT, '--timeout', '120', '--slug', `${SLUG}-pf`];
if (KEEP) gateArgs.push('--keep');
const g = spawnSync(process.execPath, gateArgs, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const gateOut = `${g.stdout ?? ''}${g.stderr ?? ''}`;
for (const line of gateOut.split(/\r?\n/)) if (line.trim()) console.log(`    | ${line}`);
const gateCode = g.status;

const verdict = hashOk && gateCode === 0 ? 'PASS' : 'FAIL';
console.log('');
console.log(`  --- verdict: ${verdict} ---   (hashCheck=${hashOk ? 'PASS' : 'FAIL'}, mountGate exit=${gateCode})`);
console.log(`  candidate kept at: ${CAND}`);

const report = {
  tool: 'deploy-preflight',
  at: new Date().toISOString(),
  repoPlugins: SRC,
  production: PROD,
  entry: ENTRY,
  deploySet: DEPLOY,
  closure: rows.map((r) => ({ file: r.file, klass: r.klass, repo: r.hRepo, prod: r.hProd })),
  candidateDir: CAND,
  hashCheck: hashOk ? 'PASS' : 'FAIL',
  mountGateExitCode: gateCode,
  verdict,
  mountGateStdout: gateOut,
};
const outFile = JSON_OUT ?? path.join(scratch, 'deploy-preflight.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`  report json : ${outFile}`);

process.exit(verdict === 'PASS' ? 0 : 1);
