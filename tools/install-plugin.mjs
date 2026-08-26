#!/usr/bin/env node
// tools/install-plugin.mjs —— P2.5 正式修复（Incident 2026-08-26 restart-block）：
// "profile→active preset 同步/安装可靠性" 的权威安装器。
//
// 背景：R1 部署时只把 context-memory*.mjs 拷进 ~/.dsh/profiles/web/，而预设
// agent.cordis.yml 的挂载 `name: './context-memory.mjs'` 是相对**预设目录**
// （~/.dsh/.agent-presets/autonomous/）解析的 → 重启后 mount 解析失败、
// 会话 resume 被阻断。Codex 的 emergency recovery 只补了文件（非正式闭环）。
//
// 本工具 = 正式闭环第一层：把插件文件原子同步到**所有挂载位**并**自校验**，
// 未通过则以非零码退出（阻止"装一半就重启"）。
//
// 用法：
//   node tools/install-plugin.mjs --plugin context-memory            # 同步+校验
//   node tools/install-plugin.mjs --plugin context-memory --dry-run  # 只校验不写
//   node tools/install-plugin.mjs --plugin context-memory --plugin tool-output-offload
//   node tools/install-plugin.mjs --check                            # 只校验现状（不写）
// 退出码：0=通过；1=校验失败（未写或已写但校验失败）；2=用法错误
//
// 零第三方运行时依赖（node:std only；YAML 解析复用已装 js-yaml，找不到则跳过 YAML 校验并告警）。
// 幂等：重复执行不产生副作用差异；校验始终基于"目标位实际文件"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');
const DEFAULT_PRESET_DIR = path.join(os.homedir(), '.dsh', '.agent-presets', 'autonomous');
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'web');

// ---- arg parsing -------------------------------------------------------------
const args = process.argv.slice(2);
const plugins = [];
let presetDir = DEFAULT_PRESET_DIR;
let profileDir = DEFAULT_PROFILE_DIR;
let dryRun = false;
let checkOnly = false;

function usage() {
  console.log(`用法:
  node tools/install-plugin.mjs --plugin <name> [--plugin <name> ...] [--preset <dir>] [--profile <dir>] [--dry-run|--check]
  --plugin <name>   插件名（plugins/<name>*.mjs 匹配；可多次）
  --preset <dir>    目标预设目录（默认 ~/.dsh/.agent-presets/autonomous）
  --profile <dir>   目标 profile 目录（默认 ~/.dsh/profiles/web）
  --dry-run         只做校验，不写任何文件
  --check           只校验当前挂载现状（不写），用于 restart 前预检
  --help            本帮助`);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--plugin') { plugins.push(args[++i]); }
  else if (a === '--preset') { presetDir = args[++i]; }
  else if (a === '--profile') { profileDir = args[++i]; }
  else if (a === '--dry-run') { dryRun = true; }
  else if (a === '--check') { checkOnly = true; }
  else if (a === '--help') { usage(); process.exit(0); }
  else { console.error(`未知参数: ${a}`); usage(); process.exit(2); }
}

// ---- helpers -----------------------------------------------------------------
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// 从 dsh 安装点找 js-yaml（guardian Find-JsYaml 同策略；扩展候选以覆盖
// GitHub Actions Windows runner 的 npm 全局 prefix = C:\npm\prefix 等差异）
function npmGlobalModulesRoot() {
  // 1) 环境变量：GH Actions setup-node 显式设置 npm_config_prefix（Windows
  //    runner 上 = C:\npm\prefix），npm 自身也会在脚本环境继承它。零 spawn、
  //    最可靠，优先。注意 npm_config_prefix 是 **prefix 根**，npm 全局模块根 =
  //    <prefix>/node_modules（与 `npm root -g` 输出同语义）——少拼 node_modules
  //    会导致 js-yaml 找不到（CI 实测踩坑）。
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (prefix) return path.join(prefix, 'node_modules');
  // 2) 解析 npm 命令取 root -g（输出即 <prefix>/node_modules）。注意 Windows 上
  //    Node 的 spawnSync 不解析 PATHEXT：裸 'npm' 会 ENOENT，必须用 'npm.cmd'
  //    且 shell:true 让 cmd.exe 解析。Unix 直接 'npm'。
  try {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(cmd, ['root', '-g'],
      { encoding: 'utf8', shell: process.platform === 'win32' });
    const out = (r.stdout || '').trim();
    return out || null;
  } catch { return null; }
}

function findJsYaml() {
  const candidates = [
    // npm 全局 prefix 的模块根（npm_config_prefix / npm root -g 均指向 <prefix>/node_modules）
    ...(() => { const root = npmGlobalModulesRoot(); return root ? [path.join(root, 'js-yaml')] : []; })(),
    // 常规 npm 全局安装点（%APPDATA%\npm —— 本机 dsh 安装点）
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'js-yaml'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'js-yaml'),
    // NODE_PATH：Windows 分号 / Unix 冒号分隔的多路径，逐个尝试
    ...(process.env.NODE_PATH
      ? process.env.NODE_PATH
          .split(process.platform === 'win32' ? ';' : ':')
          .map((p) => p.trim()).filter(Boolean)
          .map((p) => path.join(p, 'js-yaml'))
      : []),
  ];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch {}
  }
  return null;
}

// !!js 容忍的 YAML 解析（语法守卫口径；语义求值归 cordis）
function loadYamlLoose(text) {
  const jyDir = findJsYaml();
  if (!jyDir) return { ok: false, reason: 'js-yaml not found; YAML check skipped' };
  const require = createRequire(import.meta.url);
  const yaml = require(jyDir);
  const cleaned = text.replace(/!!js(\s+)/g, 'str$1');
  try {
    return { ok: true, doc: yaml.load(cleaned) };
  } catch (e) {
    return { ok: false, reason: `YAML 解析失败: ${e.reason ?? e.message}` };
  }
}

// 解析 YAML 文档里的挂载条目：{ name: './xxx.mjs' }（顶层或任意 plugins/config 列表）
function collectModuleRefs(doc, acc = []) {
  if (Array.isArray(doc)) { for (const x of doc) collectModuleRefs(x, acc); return acc; }
  if (doc && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'name' && typeof v === 'string' && /^\.\//.test(v)) acc.push(v);
      else collectModuleRefs(v, acc);
    }
  }
  return acc;
}

// 校验单个配置文件：所有相对模块引用必须在其所在目录存在
function verifyConfig(configPath) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(configPath)) return { ok: true, skipped: 'config not present', refs: [], missing: [] };
  const text = fs.readFileSync(configPath, 'utf8');
  const { ok, reason, doc } = loadYamlLoose(text);
  if (!ok) return { ok: false, reason: `YAML 解析失败: ${reason}`, refs: [], missing: [] };
  if (doc == null) return { ok: true, skipped: 'empty doc', refs: [], missing: [] };
  const refs = collectModuleRefs(doc);
  const missing = refs.filter((r) => !fs.existsSync(path.join(dir, r)));
  if (missing.length > 0) {
    return { ok: false, reason: `挂载引用缺失文件 → ${missing.join(', ')}（重启将阻断；请先同步）`, refs, missing, dir };
  }
  return { ok: true, refs, missing, dir };
}

// R2-2: 原子写——先写同卷 tmp 文件再 rename 覆盖，避免"复制到一半崩溃留下半文件"。
// Windows 下 rename 覆盖已存在文件是原子的（同一卷上），这是"装一半就重启"的最后一公里防线。
function atomicCopy(src, dst) {
  const dir = path.dirname(dst);
  const tmp = path.join(dir, `.${path.basename(dst)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// R2-2: 从配置文件收集所有相对挂载引用的 basename（去重），供 hash 自动校验。
// 这样 --check / --dry-run 不指定 --plugin 时，也能发现"目标位是旧版"。
function collectRefBasenames(configPaths) {
  const names = new Set();
  for (const cp of configPaths) {
    if (!fs.existsSync(cp)) continue;
    const r = verifyConfig(cp);
    if (!r.ok || r.skipped) continue;
    for (const ref of r.refs) names.add(path.basename(ref));
  }
  return [...names];
}

// ---- main --------------------------------------------------------------------
let failures = 0;

function fail(msg) { failures += 1; console.error(`  ✗ ${msg}`); }
function pass(msg) { console.log(`  ✓ ${msg}`); }

console.log('P2.5 install-plugin — 同步/安装可靠性校验');
console.log(`  repo plugins: ${PLUGINS_DIR}`);
console.log(`  preset dir : ${presetDir}`);
console.log(`  profile dir: ${profileDir}`);
console.log(`  模式: ${dryRun ? 'dry-run（只校验不写）' : checkOnly ? 'check（只校验现状）' : 'sync（同步+校验）'}`);
console.log('');

// 1) 源文件解析（--check 模式可缺省 --plugin：纯预检挂载现状）
const sourceFiles = [];
if (plugins.length === 0) {
  if (!checkOnly && !dryRun) fail('未指定 --plugin；至少需要一个插件名');
} else {
  for (const p of plugins) {
    const matches = fs.readdirSync(PLUGINS_DIR).filter((f) => f.startsWith(p) && f.endsWith('.mjs'));
    if (matches.length === 0) { fail(`plugins/ 下找不到以 "${p}" 开头的 .mjs`); continue; }
    for (const m of matches) {
      const src = path.join(PLUGINS_DIR, m);
      const h = sha256(src);
      sourceFiles.push({ name: m, src, sha: h });
      pass(`源文件 ${m} (${h.slice(0, 12)}…)`);
    }
  }
}

// 2) 同步到各挂载位（非 dry-run/check）——原子写（tmp+rename）
const targets = [presetDir, profileDir];
if (!dryRun && !checkOnly) {
  for (const t of targets) {
    if (!fs.existsSync(t)) { fail(`目标目录不存在: ${t}`); continue; }
    for (const sf of sourceFiles) {
      const dst = path.join(t, sf.name);
      try { atomicCopy(sf.src, dst); pass(`已同步 ${sf.name} → ${path.relative(os.homedir(), dst)} (原子写)`); }
      catch (e) { fail(`同步失败 ${dst}: ${e.message}`); }
    }
  }
}

// 3) 校验（对目标位实际文件，而非源）——永远执行
// R2-2: 即使 sourceFiles 为空（--check 无 --plugin），也自动发现配置挂载引用做 hash 校验
const configs = [
  { path: path.join(presetDir, 'agent.cordis.yml'), label: 'preset agent.cordis.yml' },
  { path: path.join(profileDir, 'cordis.patch.yml'), label: 'profile cordis.patch.yml' },
];
// 若显式指定了 --plugin，以显式集为准；否则自动从配置发现所有挂载引用（R2-2: --check 也能做 hash 校验）
const allSourceFiles = [...sourceFiles];
if (sourceFiles.length === 0) {
  const autoRefs = collectRefBasenames(configs.map((c) => c.path));
  for (const bn of autoRefs) {
    const src = path.join(PLUGINS_DIR, bn);
    if (fs.existsSync(src)) {
      const h = sha256(src);
      allSourceFiles.push({ name: bn, src, sha: h });
      pass(`自动发现源文件 ${bn} (${h.slice(0, 12)}…)`);
    }
  }
}
for (const c of configs) {
  const r = verifyConfig(c.path);
  if (r.skipped) { pass(`${c.label}: ${r.skipped}`); continue; }
  if (!r.ok) { fail(`${c.label}: ${r.reason}`); continue; }
  pass(`${c.label}: YAML 有效，${r.refs.length} 个相对挂载全部可解析`);
  // 插件级核对：对每个挂载引用文件，若 repo 有同名源则对比 hash（R2-2: 自动扫描所有挂载引用）
  for (const ref of r.refs) {
    const refName = path.basename(ref);
    const sf = allSourceFiles.find((f) => f.name === refName);
    if (!sf) continue; // 非本工具管理的插件，跳过 hash 校验
    const tgt = path.join(r.dir, refName);
    if (!fs.existsSync(tgt)) { fail(`${c.label}: 目标位缺少 ${refName}`); continue; }
    const th = sha256(tgt);
    if (th !== sf.sha) { fail(`${c.label}: ${refName} 校验和不一致（目标位=${th.slice(0,12)}…，源=${sf.sha.slice(0,12)}…；是旧版？重新同步）`); }
    else { pass(`${c.label}: ${refName} 与 repo 一致`); }
  }
}

console.log('');
if (failures > 0) {
  console.error(`结果: FAIL（${failures} 项失败）——请先修复再重启`);
  process.exit(1);
}
console.log('结果: PASS —— 挂载位完整，重启安全');
process.exit(0);
