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
const SELF_TEST = has('--self-test');
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

// ── 0. 结论文案生成器（纯函数）+ 合成 facts 自检（R2 / 外部评审 Finding G） ────────
// 被取代的旧行为：R1 的"机器结论"句里有一段**固定文案**——
//   "缺口不在"门假"…，而在**承载（required 列表）/绕过（enforce_admins、无 ruleset）**没堵住。"
// 它与**同一次运行自己算出的读数**冲突：同一份输出上方已打印 `绕过路径：关闭`
// （adminBypass=false、enforce_admins=true、有 main ruleset），下方却宣称"绕过没堵住"。
// 根因不是数据错，而是文案不派生：句子写死，读数变化它不会跟着变。
//
// 修法：结论的每个"缺口"都由 facts **逐条派生**，只有对应读数成立时才出现；
//       并新增 `--self-test`（离线、无网络、无 gh）对合成 facts 做负控，
//       其中 G3 是**回归锁**：R1 那句冲突原文必须再也无法被生成。
function summarize(f) {
  const rulesetsText = (f.mainRulesets || []).length ? f.mainRulesets.join(' | ') : '无';
  const reqText = JSON.stringify(f.requiredContexts || []);
  // 读数不可用 ⇒ 不给出判定（fail-closed）。旧实现只在注释里写了这条纪律：
  // branch protection 读失败时 requiredContexts=[]、enforceAdmins=null、rulesets=[]，
  // 文案于是把"读不到"渲染成"实测 0 条必需检查 / 绕过关闭 / 直推无人拦"——
  // 结论级别的假绿（本次实测复现：一次瞬时 API 失败就产出"6 条门不在 required 内"）。
  // 现在：读数未取全 ⇒ 结论显式 = 不可判定，任何缺口从句都不生成。
  if (f.readingsAvailable !== true) {
    return {
      prLine: '不可判定（线上读数未取全）',
      dpLine: '不可判定（线上读数未取全）',
      bypassLine: '不可判定（线上读数未取全）',
      gaps: [`读数缺口：线上只读探测未全部成功（${f.readingsDetail || '未提供明细'}）`
        + ' ⇒ **不给出**"红门能否到达 main"的判定（"读不到"绝不当"没问题"）'],
      conclusion: '**不可判定（fail-closed）**：线上读数未取全，本工具拒绝给出"红门能否到达 main"的结论。'
        + '请重跑；若持续不可读，按"缺权限 / 被限流 / API 故障"处理并保留 RED，绝不当成"无缺口"。',
    };
  }
  const gaps = [];
  if (f.prNotRequired > 0) {
    gaps.push(`承载缺口：${f.prNotRequired} 条 learn 门的 context 不在 required contexts 内（required=${reqText}）`);
  }
  if (f.bypassOpen) {
    gaps.push(`绕过缺口：绕过路径开通（enforce_admins=${f.enforceAdmins}，main rulesets=${rulesetsText}）`
      + ` ⇒ 管理员可绕过必需检查${f.prBypass > 0 ? `；其中 ${f.prBypass} 条门落在该路径上` : ''}`);
  } else if (f.prBypass > 0) {
    gaps.push(`绕过缺口：${f.prBypass} 条门在 required 内、但绕过路径读数判为关闭`
      + `（enforce_admins=${f.enforceAdmins}，main rulesets=${rulesetsText}）⇒ 读数之间自相矛盾，需人工复核`);
  }
  if (f.dpOpen > 0) {
    const why = [`${f.dpOpen} 条 learn 门所在 workflow 不在 push→main 触发`];
    if (!f.rulesetBlocksPush) why.push('无 ruleset 强制 PR');
    if (!f.rulesetEnforcesChecks) why.push('无 ruleset 必需检查');
    gaps.push(`直推缺口：${why.join('、')}`);
  }
  const prLine = f.prOpen > 0
    ? `**红门能到达 main**（${f.prNotRequired} 条门不在必需检查内、${f.prBypass} 条门在必需检查内但绕过路径开着）`
    : '红门被拦（门在必需 context 内且无绕过）';
  const dpLine = f.dpOpen > 0
    ? `**红门能到达 main**（${f.dpOpen} 条：${(f.dpReasons || []).length ? f.dpReasons.join(' / ') : '见上逐路径判定'}）`
    : '红门被拦';
  const bypassLine = f.bypassOpen ? '开通（enforce_admins=false 或 ruleset 有 bypass_actors）' : '关闭';
  const conclusion = gaps.length === 0
    ? '无已知路径能让红门到达 main。'
    : `当前存在"红门能到达 main"的路径。**真实缺口（由本轮读数逐条派生）**= ${gaps.join('；')}。`
      + '**门本身不在缺口内**：门确实在跑，变异证明也证明它可变红。';
  return { prLine, dpLine, bypassLine, conclusion, gaps };
}

function selfTest() {
  let pass = 0; let fail = 0;
  const t = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  };
  const base = {
    prOpen: 1, prNotRequired: 1, prBypass: 0, dpOpen: 0, dpReasons: [],
    enforceAdmins: true, mainRulesets: ['main-protection(bypass=0)'],
    rulesetBlocksPush: true, rulesetEnforcesChecks: true, bypassOpen: false,
    requiredContexts: ['DSH boot + readiness smoke'],
    readingsAvailable: true,
  };
  // S1 = 本轮真实读数形态（R1 冲突发生的那组 facts）
  const s1 = summarize(base);
  t('G1 required-only gap is reported as a carry gap', s1.gaps.length === 1 && /承载缺口/.test(s1.gaps[0]), JSON.stringify(s1.gaps));
  t('G2 no bypass gap is claimed while the bypass path reads closed', !/绕过缺口/.test(s1.conclusion) && s1.bypassLine === '关闭', s1.conclusion);
  t('G3 R1 conflicting sentence can no longer be produced (regression lock)',
    !s1.conclusion.includes('承载（required 列表）/绕过（enforce_admins') && !/无 ruleset/.test(s1.conclusion), s1.conclusion);
  t('G4 conclusion cites the measured readings', /required contexts/.test(s1.conclusion), s1.conclusion);
  // S2 = 真的开通了绕过：此刻才允许说绕过
  const s2 = summarize({ ...base, prNotRequired: 0, prBypass: 2, bypassOpen: true, enforceAdmins: false, mainRulesets: [] });
  t('G5 a real bypass gap names its actual reading', s2.gaps.some((g) => /绕过缺口/.test(g) && /enforce_admins=false/.test(g)), JSON.stringify(s2.gaps));
  t('G6 bypass line follows the computed flag', s2.bypassLine.startsWith('开通'), s2.bypassLine);
  // S3 = 全堵住（注意：承载缺口的那条 facts 也必须归零，否则测的是别的东西）
  const s3 = summarize({ ...base, prOpen: 0, prNotRequired: 0, prBypass: 0, dpOpen: 0 });
  t('G7 no gaps ⇒ honest "no known path" conclusion', s3.gaps.length === 0 && /无已知路径/.test(s3.conclusion), s3.conclusion);
  // S4/S5 = 直推缺口的从句只在该读数成立时才出现
  const s4 = summarize({ ...base, prOpen: 0, dpOpen: 1, dpReasons: ['该 workflow 不在 push→main 触发'] });
  t('G8 direct-push gap omits clauses its readings do not support',
    /直推缺口/.test(s4.gaps.join('')) && !/无 ruleset/.test(s4.gaps.join('')), JSON.stringify(s4.gaps));
  const s5 = summarize({ ...base, prOpen: 0, dpOpen: 1, rulesetBlocksPush: false, rulesetEnforcesChecks: false, dpReasons: ['x'] });
  t('G9 direct-push gap adds the "no ruleset" clauses only when true',
    /无 ruleset 强制 PR/.test(s5.gaps.join('')) && /无 ruleset 必需检查/.test(s5.gaps.join('')), JSON.stringify(s5.gaps));
  // S6 = 线上读数未取全：必须显式"不可判定"，不得把"读不到"渲染成"实测无缺口/缺口"
  const s6 = summarize({ ...base, readingsAvailable: false, readingsDetail: 'branch protection ok=false', requiredContexts: [], enforceAdmins: null, mainRulesets: [], prOpen: 6, prNotRequired: 6 });
  t('G10 unreadable readings ⇒ explicit "undecidable", never a measured gap claim',
    /不可判定/.test(s6.conclusion) && s6.gaps.length === 1 && /读数缺口/.test(s6.gaps[0])
    && !/承载缺口/.test(s6.gaps.join('')) && !/绕过缺口/.test(s6.gaps.join(''))
    && s6.bypassLine.includes('不可判定') && !/关闭/.test(s6.bypassLine),
    JSON.stringify({ gaps: s6.gaps, bypass: s6.bypassLine }));
  // S7 = 读数正常但保护里真的没有必需检查 ⇒ 这是**真实发现**，必须照报（区别于 S6）
  const s7 = summarize({ ...base, requiredContexts: [], prNotRequired: 1, prBypass: 0 });
  t('G11 a genuinely empty required list is still reported as a real carry gap',
    /承载缺口/.test(s7.gaps.join('')) && /required=\[\]/.test(s7.gaps.join('')), JSON.stringify(s7.gaps));
  console.log(`\nAUDIT SUMMARY SELF-TEST ASSERTIONS: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) { console.log('AUDIT SUMMARY LOGIC SELF-TEST: FAILED'); process.exit(1); }
  console.log('AUDIT SUMMARY LOGIC SELF-TEST: PASSED');
  process.exit(0);
}

if (SELF_TEST) selfTest();

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
// 读数是否完整（fail-closed 的判据）：任一只读探测失败 ⇒ 本轮不给判定。
// 必须在 §2 打印之前声明（打印要用它决定"无 ruleset"还是"读不到"）。
const unreadableRulesetDetails = rulesetDetails.filter((r) => r._unreadable).length;
const readingsComplete = prot.ok === true && rulesetList.ok === true && unreadableRulesetDetails === 0;
const readingsDetail = `branch protection ok=${prot.ok}, rulesets list ok=${rulesetList.ok}, ruleset 详情不可读=${unreadableRulesetDetails}`;

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
  console.log(`  required contexts : ${requiredContexts.length ? requiredContexts.join('  |  ') : (prot.ok ? '(空：保护存在但**无必需检查**) ' : '(读不到)')}`);
  console.log(`  strict(up-to-date): ${strictUpToDate}`);
  console.log(`  enforce_admins    : ${enforceAdmins}`);
  console.log(`  main rulesets     : ${mainRulesets.length ? mainRulesets.map((r) => `${r.name}(blind=${(r.bypass_actors || []).length})`).join(' | ') : (readingsComplete ? '[]（无：直推 main 无人拦）' : '读不到 → 不可判定')}`);
  console.log(`  protection 读数   : ${prot.ok ? 'ok' : `失败/无权限 → ${prot.raw}`}`);
  console.log(`  读数完整性        : ${readingsComplete ? '完整（可判定）' : `**不完整 ⇒ 本轮不给判定**（${readingsDetail}）`}`);
  console.log('\n=== 3. learn 门落在哪个 context（红灯能否被 required 承载）===');
  for (const g of learnGates) console.log(`  ${g.file} job=${g.job} context="${g.context}" required=${g.required}  :: ${g.step}`);
  console.log('\n=== 4. 逐路径判定（谁能不能拦住红门） ===');
  for (const v of verdicts) console.log(`  [${readingsComplete ? (v.blocked ? 'BLOCKED' : 'NOT-BLOCKED') : 'UNKNOWN(读数不可用)'}] ${v.path}\n      carrier: ${v.carrier}\n      why    : ${v.reasons.join('；')}`);
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
      console.log(`  ⇒ ${accident.checks.length ? (accident.checks.some((c) => c.required) ? '红的**是**必需检查仍被合并 ⇒ **该次合并当时**存在绕过路径（enforce_admins / bypass_actors）。这是**历史事件**：当前绕过状态见 §2 与本轮结论，不得据历史推断当前（同理，也不得据当前推断当时）' : '红的是**非必需**检查 ⇒ 这条红灯本来就不拦合并（缺口就在 required 列表）') : '未取到失败检查'}`);
    }
  } else if (!AS_JSON) console.log(`\n=== 5. 事故实证 PR #${ACCIDENT_PR} 读不到（${pr.raw}）`);
}

// 逐路径事实先算出来（原先只在人类可读分支里算 ⇒ --json 消费者拿不到派生结论）。
const prNot = verdicts.filter((v) => /^PR/.test(v.path) && !v.blocked);
const prNotRequired = prNot.filter((v) => /required=\*\*否\*\*/.test(v.reasons.join('；'))).length;
const prBypass = prNot.length - prNotRequired;
const dpNot = verdicts.filter((v) => /^直推/.test(v.path) && !v.blocked);
// 直推缺口的"为什么"也从每条的 reasons 里抽真话，而不是写死的从句。
const dpReasons = [...new Set(dpNot.flatMap((v) => v.reasons.filter((r) =>
  /该 workflow 在 push→main 触发=\*\*否\*\*/.test(r)
  || /ruleset 强制 PR（可堵死直推）=\*\*否\*\*/.test(r)
  || /ruleset 必需检查且无 bypass=否/.test(r))))];
const summary = summarize({
  prOpen: prNot.length, prNotRequired, prBypass,
  dpOpen: dpNot.length, dpReasons,
  enforceAdmins,
  mainRulesets: mainRulesets.map((r) => `${r.name}(bypass=${(r.bypass_actors || []).length})`),
  rulesetBlocksPush, rulesetEnforcesChecks, bypassOpen,
  requiredContexts,
  readingsAvailable: readingsComplete,
  readingsDetail,
});
const verdict = {
  repo: SLUG,
  requiredContexts, enforceAdmins, strictUpToDate,
  mainRulesets: mainRulesets.map((r) => ({ name: r.name, bypassActors: (r.bypass_actors || []).length })),
  learnGateCarriers: learnGates.map((g) => ({ step: g.step, context: g.context, required: g.required, file: g.file })),
  pathVerdicts: verdicts,
  requiredChecksOnDirectPush: Object.fromEntries(requiredCarrierPushMain),
  redCanReachMain: canRedReachMain,
  derivedSummary: { gaps: summary.gaps, pr: summary.prLine, directPush: summary.dpLine, bypass: summary.bypassLine, conclusion: summary.conclusion },
  accident,
  gitHead: git(['rev-parse', 'HEAD']).out.slice(0, 12),
  generatedAt: new Date().toISOString(),
};
// hard 必须与派生缺口等价：旧式 `prOpen || dpOpen || adminBypass` 在"绕过开着但 PR 路径本身
// 没被判定为开放"时仍为真，派生逻辑用 bypassOpen 分支覆盖同一条件 ⇒ 语义保持。
const hard = summary.gaps.length > 0;

if (AS_JSON) console.log(JSON.stringify(verdict, null, 2));
else {
  console.log('\n=== 6. 机器结论（每条都由本轮读数派生） ===');
  console.log(`  PR → main：${summary.prLine}`);
  console.log(`  直推 → main：${summary.dpLine}`);
  console.log(`  绕过路径：${summary.bypassLine}`);
  console.log(`  ⇒ 结论：${summary.conclusion}`);
}
if (STRICT && hard) {
  console.log('\n--strict：存在能让红门到达 main 的路径 ⇒ exit 1');
  process.exit(1);
}
process.exit(0);
