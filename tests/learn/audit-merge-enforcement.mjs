// 合并门"硬度"审计（只读）——把「配置了必需检查」升级为「每条路径到底能不能拦住一个红门」的机器结论。
//
// 为什么需要它：AC10 证明了"门存在"（注册表 + 变异证明），但"门存在"≠"红门能拦住合并"。
// 本仓库实测过的事故 PR #97：`DSH boot + readiness smoke` 那条 job 红着，PR 依然被合并进
// main（mergeCommit 171f1b40）。原因不是门假，而是**承载它的 context 不在必需检查里**，且
// `enforce_admins=false` ⇒ 管理员可绕过。所以"门硬不硬"必须逐条路径问：
//   ① PR → main：(a) 这条路径上跑的门，它的 context 在 required_status_checks 里吗？
//                 (b) 绕过路径开着吗（enforce_admins / rulesets 的 bypass_actors）？
//   ② 直推 → main：必需检查只作用于 PR，直推是否另有 ruleset 拦？（没有 ⇒ 直推是无检查盲区）
//
// 用法（全程只读 GET，绝不改仓库设置、不开 PR、不合并）：
//   node tests\learn\audit-merge-enforcement.mjs              # 报告模式，永远 exit 0（除非读数失败）
//   node tests\learn\audit-merge-enforcement.mjs --strict      # 只要"红门能到达 main"就 exit 1
//   node tests\learn\audit-merge-enforcement.mjs --json        # 机器可读结论
//   node tests\learn\audit-merge-enforcement.mjs --pr 97       # 复核某次事故 PR 的红门证据
//
// 依赖：gh CLI 已登录且对该仓库有 admin 级只读权限（`GET /branches/main/protection` 需要 admin）。
// 缺权限时本工具如实报"读不到"，绝不把"读不到"当成"没问题"。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const STRICT = has('--strict');
const AS_JSON = has('--json');
const ACCIDENT_PR = Number(valueOf('--pr', '97'));
const REPO_DIR = path.resolve(valueOf('--repo', process.cwd()));

const notes = [];
const note = (s) => { notes.push(s); if (!AS_JSON) console.log(s); };

function run(cmd, cmdArgs, opts = {}) {
  let r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
  if (r.error && /ENOENT/.test(String(r.error.code || r.error.message))) {
    r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024, ...opts });
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (a) => run('git', a, { cwd: REPO_DIR });
const ghJson = (a) => { const r = run('gh', a); if (r.code !== 0) return { ok: false, raw: (r.err || r.out).slice(0, 300) }; try { return { ok: true, data: JSON.parse(r.out) }; } catch { return { ok: false, raw: r.out.slice(0, 300) }; } };

// ── 1. 从本地 workflow 读出：每条 lane 的 job 名（= 必需 context 的真实来源）+ 触发路径 ──
function parseWorkflows() {
  const dir = path.join(REPO_DIR, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const wfName = (/^name:\s*(.+)$/m.exec(text) || [])[1]?.trim() || f;
    const jobs = [];
    let inJobs = false; let cur = null; let jobIndent = null;
    for (const line of text.split(/\r?\n/)) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (!inJobs) continue;
      const m = /^(\s+)([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m && (jobIndent === null || m[1].length === jobIndent)) {
        if (cur) jobs.push(cur);
        cur = { id: m[2], name: null, steps: [] };
        if (jobIndent === null) jobIndent = m[1].length;
        continue;
      }
      if (!cur) continue;
      const nm = /^\s+name:\s*(.+)$/.exec(line);
      if (nm && cur.name === null) cur.name = nm[1].trim();
      const st = /^\s+-\s+name:\s*(.+)$/.exec(line);
      if (st) cur.steps.push(st[1].trim());
    }
    if (cur) jobs.push(cur);
    const triggers = [];
    if (/^\s{2}push:/m.test(text)) {
      const b = /^\s{2}push:\s*\r?\n(?:\s*branches:\s*\[([^\]]*)\])?/m.exec(text);
      triggers.push(`push(${b && b[1] ? b[1].trim() : 'all-branches'})`);
    }
    if (/^\s{2}pull_request:/m.test(text)) {
      const b = /^\s{2}pull_request:\s*\r?\n\s*branches:\s*\[([^\]]*)\]/m.exec(text);
      triggers.push(`pull_request(${b && b[1] ? b[1].trim() : 'all-branches'})`);
    }
    if (/^\s{2}workflow_dispatch:/m.test(text)) triggers.push('workflow_dispatch');
    if (/^\s{2}schedule:/m.test(text)) triggers.push('schedule');
    out.push({ file: `.github/workflows/${f}`, wfName, jobs, triggers });
  }
  return out;
}

const slugFromRemote = (() => {
  const url = git(['remote', 'get-url', 'origin']).out || '';
  const m = /github\.com[:/]([^/]+)\/([^/.\s]+)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
})();
const SLUG = valueOf('--slug', slugFromRemote || '');

// ── 2. 线上事实（只读） ──────────────────────────────────────────────────────
const wfs = parseWorkflows();

if (!AS_JSON) {
  console.log('=== 1. 本地：lane → job 名（必需 context 的真实来源）与触发路径 ===');
  for (const w of wfs) {
    console.log(`  ${w.file}\n    name     : ${w.wfName}\n    triggers : ${w.triggers.join(', ') || '(none)'}`);
    for (const j of w.jobs) console.log(`    job      : ${j.id} → context "${j.name ?? j.id}" (${j.steps.length} steps)`);
  }
}
if (!SLUG) {
  console.log('无法确定 GitHub 仓库（origin 不是 github.com）——只能给出本地结论。');
  process.exit(0);
}

const prot = ghJson(['api', `repos/${SLUG}/branches/main/protection`]);
const rulesetList = ghJson(['api', `repos/${SLUG}/rulesets`]);
const rulesets = rulesetList.ok && Array.isArray(rulesetList.data) ? rulesetList.data : [];
// 逐个 ruleset 读详情（看 bypass_actors 与 rules 类型）
const rulesetDetails = rulesets.map((r) => {
  const d = ghJson(['api', `repos/${SLUG}/rulesets/${r.id}`]);
  return d.ok ? d.data : { id: r.id, name: r.name, _unreadable: true };
});

const requiredContexts = prot.ok
  ? ((prot.data.required_status_checks?.checks || []).map((c) => c.context).length
    ? prot.data.required_status_checks.checks.map((c) => c.context)
    : (prot.data.required_status_checks?.contexts || []))
  : [];
const enforceAdmins = prot.ok ? prot.data.enforce_admins?.enabled ?? null : null;
const strictUpToDate = prot.ok ? prot.data.required_status_checks?.strict ?? null : null;

// 哪些 ruleset 真的在拦 main，且有没有 bypass
const mainRulesets = rulesetDetails.filter((r) => !r._unreadable && r.enforcement === 'active'
  && (r.conditions?.ref_name?.include || []).some((p) => /refs\/heads\/main$|~DEFAULT_BRANCH/.test(p)));
const rulesetBlocksPush = mainRulesets.some((r) => (r.rules || []).some((x) => x.type === 'pull_request'));
const rulesetBypassOpen = mainRulesets.some((r) => (r.bypass_actors || []).length > 0);
// ruleset 里"必需检查 + 无绕过"，对 PR 与直推**都**有强制力（直推会被直接拒，
// 与 legacy branch protection 的必需检查不同——后者不作用于直推）。
const rulesetEnforcesChecks = mainRulesets.some((r) => (r.bypass_actors || []).length === 0
  && (r.rules || []).some((x) => x.type === 'required_status_checks'));
const bypassOpen = rulesetBypassOpen || (enforceAdmins === false && !rulesetEnforcesChecks);

// learn 门落在哪个 context（决定红灯能不能被 required 承载）
const learnGates = [];
for (const w of wfs) for (const j of w.jobs) for (const s of j.steps) {
  if (/P4 LEARN/i.test(s)) learnGates.push({ file: w.file, job: j.id, context: j.name || j.id, step: s, required: requiredContexts.includes(j.name || j.id), triggers: w.triggers });
}

// ── 3. 逐路径判定 ───────────────────────────────────────────────────────────
const verdicts = [];
for (const g of learnGates) {
  const pushMain = g.triggers.some((t) => /^push\(/.test(t) && (/main/.test(t) || /all-branches/.test(t)));
  verdicts.push({
    path: `PR → main（门：${g.step}）`,
    carrier: `${g.file} job=${g.job} context="${g.context}"`,
    blocked: g.required && (enforceAdmins === true || rulesetEnforcesChecks),
    reasons: [
      `context required=${g.required ? '是' : '**否**'}`,
      `跑在 PR 路径=${g.triggers.some((t) => /^pull_request\(/.test(t)) ? '是' : '否'}`,
      `enforce_admins=${enforceAdmins}`,
      rulesetEnforcesChecks ? 'ruleset 含必需检查且无 bypass' : (mainRulesets.length ? 'ruleset 有 bypass_actors' : '无 main ruleset'),
    ],
  });
  verdicts.push({
    path: `直推 → main（门：${g.step}）`,
    carrier: `${g.file} job=${g.job} context="${g.context}"`,
    blocked: rulesetBlocksPush || (g.required && rulesetEnforcesChecks && pushMain),
    reasons: [
      `该 workflow 在 push→main 触发=${pushMain ? '是' : '**否**'}`,
      `ruleset 强制 PR（可堵死直推）=${rulesetBlocksPush ? '是' : '**否**'}`,
      `ruleset 必需检查且无 bypass=${rulesetEnforcesChecks ? '是' : '否'}`,
    ],
  });
}
// 全局：必需检查本身在直推路径上是否触发
const requiredCarrierPushMain = new Map();
for (const ctx of requiredContexts) {
  const hit = wfs.flatMap((w) => w.jobs.map((j) => ({ w, j }))).find(({ j }) => (j.name || j.id) === ctx);
  requiredCarrierPushMain.set(ctx, hit ? hit.w.triggers.some((t) => /^push\(/.test(t) && (/main/.test(t) || /all-branches/.test(t))) : false);
}

const canRedReachMain = {
  prPath: verdicts.filter((v) => /^PR/.test(v.path) && !v.blocked).map((v) => v.path),
  directPushPath: verdicts.filter((v) => /^直推/.test(v.path) && !v.blocked).map((v) => v.path),
  adminBypass: bypassOpen,
};

if (!AS_JSON) {
  console.log('\n=== 2. 线上事实（只读 GET） ===');
  console.log(`  repo              : ${SLUG}`);
  console.log(`  required contexts : ${requiredContexts.length ? requiredContexts.join('  |  ') : '(none / 读不到)'}`);
  console.log(`  strict(up-to-date): ${strictUpToDate}`);
  console.log(`  enforce_admins    : ${enforceAdmins}`);
  console.log(`  main rulesets     : ${mainRulesets.length ? mainRulesets.map((r) => `${r.name}(blind=${(r.bypass_actors || []).length})`).join(' | ') : '[]（无：直推 main 无人拦）'}`);
  console.log(`  protection 读数   : ${prot.ok ? 'ok' : `失败/无权限 → ${prot.raw}`}`);
  console.log('\n=== 3. learn 门落在哪个 context（红灯能否被 required 承载）===');
  for (const g of learnGates) console.log(`  ${g.file} job=${g.job} context="${g.context}" required=${g.required}  :: ${g.step}`);
  console.log('\n=== 4. 逐路径判定（谁能不能拦住红门） ===');
  for (const v of verdicts) console.log(`  [${v.blocked ? 'BLOCKED' : 'NOT-BLOCKED'}] ${v.path}\n      carrier: ${v.carrier}\n      why    : ${v.reasons.join('；')}`);
  console.log(`\n  ⇒ 必需检查在 push→main 触发的情况：`);
  for (const [ctx, on] of requiredCarrierPushMain) console.log(`     「${ctx}」push→main 触发=${on ? '是' : '**否**（直推看不到这条检查）'}`);
}

// ── 4. 事故实证：某次"红着也进了 main"的 PR（只读复核） ──────────────────────
let accident = null;
if (ACCIDENT_PR) {
  const pr = ghJson(['api', `repos/${SLUG}/pulls/${ACCIDENT_PR}`]);
  if (pr.ok) {
    const headSha = pr.data.head?.sha;
    const cr = headSha ? ghJson(['api', `repos/${SLUG}/commits/${headSha}/check-runs`]) : { ok: false, raw: 'no head sha' };
    const bad = cr.ok ? (cr.data.check_runs || []).filter((c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)) : [];
    accident = {
      pr: ACCIDENT_PR, merged: pr.data.merged === true, mergedAt: pr.data.merged_at, mergedBy: pr.data.merged_by?.login ?? null,
      mergeCommit: pr.data.merge_commit_sha, checks: bad.map((c) => ({ name: c.name, conclusion: c.conclusion, required: requiredContexts.includes(c.name) })),
    };
    if (!AS_JSON) {
      console.log(`\n=== 5. 事故实证（只读）：PR #${ACCIDENT_PR} ===`);
      console.log(`  merged=${accident.merged} by=${accident.mergedBy} at=${accident.mergedAt} mergeCommit=${accident.mergeCommit}`);
      for (const c of accident.checks) console.log(`    ✗ ${c.name} = ${c.conclusion}  required=${c.required}`);
      console.log(`  ⇒ ${accident.checks.length ? (accident.checks.some((c) => c.required) ? '红的**是**必需检查仍被合并 ⇒ 绕过路径已开通（enforce_admins / bypass_actors）' : '红的是**非必需**检查 ⇒ 这条红灯本来就不拦合并（缺口就在 required 列表）') : '未取到失败检查'}`);
    }
  } else if (!AS_JSON) console.log(`\n=== 5. 事故实证 PR #${ACCIDENT_PR} 读不到（${pr.raw}）`);
}

const verdict = {
  repo: SLUG,
  requiredContexts, enforceAdmins, strictUpToDate,
  mainRulesets: mainRulesets.map((r) => ({ name: r.name, bypassActors: (r.bypass_actors || []).length })),
  learnGateCarriers: learnGates.map((g) => ({ step: g.step, context: g.context, required: g.required, file: g.file })),
  pathVerdicts: verdicts,
  requiredChecksOnDirectPush: Object.fromEntries(requiredCarrierPushMain),
  redCanReachMain: canRedReachMain,
  accident,
  gitHead: git(['rev-parse', 'HEAD']).out.slice(0, 12),
  generatedAt: new Date().toISOString(),
};
const hard = canRedReachMain.prPath.length > 0 || canRedReachMain.directPushPath.length > 0 || canRedReachMain.adminBypass;

if (AS_JSON) console.log(JSON.stringify(verdict, null, 2));
else {
  const prNot = verdicts.filter((v) => /^PR/.test(v.path) && !v.blocked);
  const prNotRequired = prNot.filter((v) => /required=\*\*否\*\*/.test(v.reasons.join('；'))).length;
  const prBypass = prNot.length - prNotRequired;
  const dpNot = verdicts.filter((v) => /^直推/.test(v.path) && !v.blocked);
  console.log('\n=== 6. 机器结论 ===');
  console.log(`  PR → main：${prNot.length ? `**红门能到达 main**（${prNotRequired} 条门不在必需检查内、${prBypass} 条门在必需检查内但绕过路径开着）` : '红门被拦（门在必需 context 内且无绕过）'}`);
  console.log(`  直推 → main：${dpNot.length ? `**红门能到达 main**（${dpNot.length} 条：workflow 不在 push→main 触发、且无 ruleset 强制 PR / 必需检查）` : '红门被拦'}`);
  console.log(`  绕过路径：${canRedReachMain.adminBypass ? '开通（enforce_admins=false 或 ruleset 有 bypass_actors）' : '关闭'}`);
  console.log(`  ⇒ 结论：${hard ? '当前存在"红门能到达 main"的路径。缺口不在"门假"（门确实在跑、变异证明也证明它变红），而在**承载（required 列表）/绕过（enforce_admins、无 ruleset）**没堵住。' : '无已知路径能让红门到达 main。'}`);
}
if (STRICT && hard) {
  console.log('\n--strict：存在能让红门到达 main 的路径 ⇒ exit 1');
  process.exit(1);
}
process.exit(0);
