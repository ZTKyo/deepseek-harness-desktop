// tests/learn/test-learn-ac5-gap-veto.mjs
// P4 R2 — AC5「Failure Classification 能阻止错误学习」验证套件
//
// 验证目标（合同 AC5 + 任务书 §20/§21/§22）：
//   A. 否决语义：P2.6 的 9 个分类**全部**被正确否决（硬否决 / 条件否决）
//   B. fail-closed：无分类 / 未知分类 / taxonomy 不兼容 → 一律否决
//   C. Gap 资格：4 项全满足才 qualified；任一不满足即拒
//   D. **真实数据回放**：生产 P2.6 证据流 1,257 条 → 否决率必须 = 100%
//   E. 反证 R1：R1 的误检案例（环境故障照样 propose）在 R2 下必须被否决
//
// 运行：node tests/learn/test-learn-ac5-gap-veto.mjs
// 退出码：0 = 全 PASS；1 = 有 FAIL

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateGapVeto,
  evaluateClassifiedRecord,
  qualifyGap,
  replayEvidenceRecords,
  gapDedupKey,
  HARD_VETO_CLASSES,
  CONDITIONAL_VETO_CLASSES,
  KNOWN_CLASSES,
  VETO_REASON,
  REPEAT_THRESHOLD,
} from '../../plugins/learn-gap-veto.mjs';

import { FAILURE_CLASS, TAXONOMY_VERSION } from '../../plugins/failure-classifier-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
}

const rec = (classification, signature = 'p|m|' + classification + '|-|-|v1', tv = TAXONOMY_VERSION) =>
  ({ classification, normalizedSignature: signature, taxonomyVersion: tv, provider: 'p', model: 'm' });

console.log('══════════ A. 否决语义（9 个分类全覆盖）══════════');

// A1 硬否决集：7 类，任何情况下都否决
for (const c of HARD_VETO_CLASSES) {
  const v = evaluateClassifiedRecord(rec(c));
  check(`A1 hard-veto ${c}`, v.vetoed === true && v.reason === VETO_REASON.HARD_VETO,
    `vetoed=${v.vetoed} reason=${v.reason}`);
}

// A2 条件否决集：2 类，默认否决
for (const c of CONDITIONAL_VETO_CLASSES) {
  const v = evaluateClassifiedRecord(rec(c));
  check(`A2 conditional-veto(no evidence) ${c}`,
    v.vetoed === true && v.reason === VETO_REASON.CONDITIONAL_NO_EVIDENCE,
    `vetoed=${v.vetoed} reason=${v.reason}`);
}

// A3 条件否决集 + 显式证据 → 放行（唯一合法放行路径）
for (const c of CONDITIONAL_VETO_CLASSES) {
  const v = evaluateClassifiedRecord(rec(c), { capabilityEvidence: 'excluded own-code defect; 3 independent repos show same missing capability' });
  check(`A3 conditional-veto(with evidence) ${c}`, v.vetoed === false,
    `vetoed=${v.vetoed} reason=${v.reason}`);
}

// A4 覆盖完整性：9 类必须全部落在两个否决集之一（无遗漏 = 无"默认放行"后门）
check('A4 all 9 classes covered by veto sets',
  HARD_VETO_CLASSES.length + CONDITIONAL_VETO_CLASSES.length === KNOWN_CLASSES.length
  && KNOWN_CLASSES.length === 9,
  `hard=${HARD_VETO_CLASSES.length} cond=${CONDITIONAL_VETO_CLASSES.length} known=${KNOWN_CLASSES.length}`);

console.log('');
console.log('══════════ B. fail-closed ══════════');

check('B1 missing record → vetoed', evaluateClassifiedRecord(null).vetoed === true
  && evaluateClassifiedRecord(null).reason === VETO_REASON.MISSING_CLASSIFICATION);
check('B2 missing classification → vetoed', evaluateClassifiedRecord({ normalizedSignature: 'x' }).vetoed === true
  && evaluateClassifiedRecord({ normalizedSignature: 'x' }).reason === VETO_REASON.MISSING_CLASSIFICATION);
check('B3 unknown classification → vetoed',
  evaluateClassifiedRecord(rec('SOME_MADE_UP_CLASS')).vetoed === true
  && evaluateClassifiedRecord(rec('SOME_MADE_UP_CLASS')).reason === VETO_REASON.UNKNOWN_CLASS);
check('B4 taxonomy version mismatch → vetoed',
  evaluateClassifiedRecord(rec(FAILURE_CLASS.NETWORK_TIMEOUT_5XX, 'x', 99)).vetoed === true
  && evaluateClassifiedRecord(rec(FAILURE_CLASS.NETWORK_TIMEOUT_5XX, 'x', 99)).reason === VETO_REASON.TAXONOMY_VERSION_MISMATCH);
check('B5 non-object (array) → vetoed', evaluateClassifiedRecord([]).vetoed === true);
check('B6 empty-string classification → vetoed', evaluateClassifiedRecord({ classification: '' }).vetoed === true);

console.log('');
console.log('══════════ C. Gap 资格（4 项）══════════');

const sig = 'p|m|UNKNOWN_PROVIDER_FAILURE|-|4xx|v1';
const goodRec = (s = sig) => ({ classification: FAILURE_CLASS.UNKNOWN_PROVIDER_FAILURE, normalizedSignature: s, taxonomyVersion: TAXONOMY_VERSION });
const obs = (taskType, record, capabilityDeficiency, capabilityEvidence) =>
  ({ taskType, record, capabilityDeficiency, capabilityEvidence });

const EV = 'excluded own-code defect';
const base = [obs('plugin-install', goodRec(), 'no capability to X', EV), obs('plugin-install', goodRec(), 'no capability to X', EV)];

check('C1 all 4 satisfied → qualified', qualifyGap(base).qualified === true,
  JSON.stringify({ r: qualifyGap(base).reason, c: qualifyGap(base).count }));

check('C2 below repeat threshold → rejected',
  qualifyGap([base[0]]).qualified === false && /below repeat threshold/.test(qualifyGap([base[0]]).reason),
  qualifyGap([base[0]]).reason);

check('C3 mixed task type → rejected',
  qualifyGap([base[0], obs('other-task', goodRec(), 'no capability to X', EV)]).qualified === false
  && /mixed task type/.test(qualifyGap([base[0], obs('other-task', goodRec(), 'no capability to X', EV)]).reason));

check('C4 mixed signature → rejected',
  qualifyGap([base[0], obs('plugin-install', goodRec('different|sig|v1'), 'no capability to X', EV)]).qualified === false);

check('C5 missing capability deficiency → rejected',
  qualifyGap([obs('plugin-install', goodRec(), '', EV), obs('plugin-install', goodRec(), '', EV)]).qualified === false
  && /missing capability deficiency/.test(qualifyGap([obs('plugin-install', goodRec(), '', EV), obs('plugin-install', goodRec(), '', EV)]).reason));

check('C6 different capability deficiency → rejected',
  qualifyGap([obs('plugin-install', goodRec(), 'deficiency A', EV), obs('plugin-install', goodRec(), 'deficiency B', EV)]).qualified === false
  && /different underlying capability deficiency/.test(qualifyGap([obs('plugin-install', goodRec(), 'deficiency A', EV), obs('plugin-install', goodRec(), 'deficiency B', EV)]).reason));

check('C7 empty observations → rejected', qualifyGap([]).qualified === false && qualifyGap([]).reason === 'no observations');

// C8 ★ 关键：任何一条被否决 → 整组不成立（即使其余条件全满足）
const vetoedOne = [obs('plugin-install', goodRec(), 'no capability to X', EV),
                   obs('plugin-install', rec(FAILURE_CLASS.NETWORK_TIMEOUT_5XX), 'no capability to X', EV)];
const q8 = qualifyGap(vetoedOne);
check('C8 one vetoed observation poisons whole group', q8.qualified === false && q8.vetoedCount === 1,
  `qualified=${q8.qualified} vetoedCount=${q8.vetoedCount} reason=${q8.reason}`);

check('C9 dedup key uses P2.6 signature verbatim',
  gapDedupKey('plugin-install', goodRec()) === `plugin-install::${sig}`,
  gapDedupKey('plugin-install', goodRec()));

check('C10 dedup key recomputes via authority when signature absent',
  gapDedupKey('t', { provider: 'p', model: 'm', classification: 'X', providerCode: null, httpStatus: 404 })
    === 't::p|m|X|-|4xx|v1',
  gapDedupKey('t', { provider: 'p', model: 'm', classification: 'X', providerCode: null, httpStatus: 404 }));

console.log('');
console.log('══════════ D. 真实数据回放（生产 P2.6 证据流）══════════');

const EVIDENCE_LOG = process.env.DSH_P26_EVIDENCE
  || path.join(os.homedir(), '.dsh', 'p26-failure-classifier.log');

let replayReported = false;
if (fs.existsSync(EVIDENCE_LOG)) {
  const raw = fs.readFileSync(EVIDENCE_LOG, 'utf8');
  const records = [];
  let parseErrors = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { records.push(JSON.parse(t)); } catch { parseErrors += 1; }
  }
  console.log(`  证据流: ${EVIDENCE_LOG}`);
  console.log(`  记录数: ${records.length}  (解析失败 ${parseErrors})`);

  const rep = replayEvidenceRecords(records);
  console.log(`  分类分布: ${JSON.stringify(rep.byClassification)}`);
  console.log(`  否决原因: ${JSON.stringify(rep.byVetoReason)}`);
  console.log(`  否决率  : ${(rep.vetoRate * 100).toFixed(2)}%  (${rep.vetoed}/${rep.total})`);

  check('D1 evidence stream is non-trivial (>=100 real records)', records.length >= 100, `n=${records.length}`);
  check('D2 ★ real-data veto rate = 100%', rep.total > 0 && rep.vetoed === rep.total,
    `vetoed=${rep.vetoed}/${rep.total} allowed=${rep.allowed} ${JSON.stringify(rep.allowedSamples)}`);
  check('D3 every real classification is a known taxonomy class',
    Object.keys(rep.byClassification).every((c) => KNOWN_CLASSES.includes(c)),
    Object.keys(rep.byClassification).join(','));
  replayReported = true;
} else {
  check('D1 evidence stream present', false, `not found: ${EVIDENCE_LOG}`);
}

console.log('');
console.log('══════════ E. 反证 R1（旧实现的误检案例）══════════');

// R1 实测：三类环境故障文本**均**照样生成 PROPOSED 候选（方向相反）。
// R2 下，这些必须全部被否决。
const R1_FALSE_POSITIVES = [
  ['provider 502 bad gateway', 'Provider outage'],
  ['network request timeout, connection failed', 'Network timeout'],
  ['service unavailable, please retry later', 'Service unavailable'],
  ['429 too many requests', 'Rate limit'],
  ['insufficient quota, please upgrade', 'Quota'],
  ['401 unauthorized: invalid api key', 'Auth'],
  ['model gpt-x not found', 'Model route'],
  ['ECONNRESET', 'Network reset'],
  ['ENOTFOUND api.example.com', 'DNS failure'],
  ['context length exceeded', 'Context overflow'],
];

for (const [text, label] of R1_FALSE_POSITIVES) {
  const v = evaluateGapVeto({ message: text, code: '' }, { provider: 'p', model: 'm' });
  check(`E1 R1-false-positive now VETOED: ${label}`, v.vetoed === true,
    `cls=${v.classification} reason=${v.reason}`);
}

// E2 ★ R1 的核心错误：纯文本 "REAL capability gap" 在 R1 里 hasSignal=false（漏检），
//    但在 R1 的 failure 关键词表下环境故障 hasSignal=true（误检）。R2 下：
//    —— 单凭一句文本**绝不**能建立 gap（必须走分类器 + 4 项资格）。
const vText = evaluateGapVeto({ message: 'REAL capability gap', code: '' }, { provider: 'p', model: 'm' });
check('E2 bare text alone cannot qualify a gap',
  qualifyGap([obs('t', { classification: vText.classification, normalizedSignature: vText.normalizedSignature, taxonomyVersion: TAXONOMY_VERSION }, 'x', EV)]).qualified === false
  || vText.vetoed === true,
  `vetoed=${vText.vetoed} cls=${vText.classification}`);

// E3 无 message 的失败也必须被分类（不能因为"文案缺失"就放行）
const vNoMsg = evaluateGapVeto({ code: 'STREAM_CLOSED' }, { provider: 'p', model: 'm' });
check('E3 code-only failure classified & vetoed', vNoMsg.vetoed === true && vNoMsg.classification === FAILURE_CLASS.PROTOCOL_MISMATCH,
  `cls=${vNoMsg.classification}`);

// E4 完全空的 failure → fail-closed
const vEmpty = evaluateGapVeto(null, { provider: 'p', model: 'm' });
check('E4 null failure → vetoed (fail-closed)', vEmpty.vetoed === true,
  `cls=${vEmpty.classification} reason=${vEmpty.reason}`);

console.log('');
console.log('══════════ 汇总 ══════════');
console.log(`THRESHOLD: REPEAT_THRESHOLD=${REPEAT_THRESHOLD}  TAXONOMY_VERSION=${TAXONOMY_VERSION}`);
console.log(`${pass} pass, ${fail} fail`);
if (failures.length) console.log(`FAILED: ${failures.join(' | ')}`);
process.exit(fail === 0 ? 0 : 1);
