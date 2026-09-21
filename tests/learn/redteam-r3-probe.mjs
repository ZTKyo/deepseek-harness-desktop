// redteam-r3-probe.mjs —— PHASE 04 LEARN R3 质量红队探针（只测量，不改逻辑）
//
// 目的：回答"LEARN 现在抓到的信号，有多少是真的应该学习的"。
// 本文件**刻意不做断言**（不设 pass/fail 门槛）——它输出真实观测，供人工质量抽样与缺陷定位。
// 断言化的回归测试在 test-learn-core.mjs（C16+）。
//
// 纪律：假密钥一律运行时拼接，仓库内不落任何密钥形状字面量（与 test-learn-core.mjs 同规范）。

import {
  learningSignals,
  stripInjectedContent,
  buildLearnDigest,
  redactSecrets,
  containsSecret,
  SIGNAL_PATTERNS,
  P25_EXTRACTORS,
} from "../../plugins/learn-core.mjs";

let OBS = [];
function obs(group, input, result, note = "") {
  OBS.push({ group, input, result, note });
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad(group, 12)} ${pad(JSON.stringify(input).slice(0, 58), 60)} -> ${result}${note ? "   [" + note + "]" : ""}`);
}
function section(t) { console.log(`\n=== ${t} ===`); }

// 把单条文本当作用户发言，跑真实分类器
function classify(text, seq = 1, role = "user") {
  const r = learningSignals({ turns: [{ seq, role, text }] });
  return r.signals.length ? r.signals[0].kind : "none";
}
// 多条发言的时序（用于 failure→resolution 配对）
function timeline(items) {
  const turns = items.map((t, i) => ({ seq: i + 1, role: t.role || "user", text: t.text }));
  const r = learningSignals({ turns });
  return {
    kinds: r.signals.map((s) => `${s.seq}:${s.kind}`).join(","),
    resolved: r.resolved,
    unresolved: r.unresolvedFailureSeqs.join(","),
  };
}

// ─────────────────────────────────────────────────────────────
section("A. Chinese coverage（R3 规格 §4 要求的 9 个词）");
// 规格要求至少覆盖：报错 出错 崩溃 失败 修好了 已修复 跑通了 不工作 没反应
const CJK_CASES = [
  ["报错", "这里报错了", "failure"],
  ["出错", "构建的时候出错了", "failure"],
  ["崩溃", "服务直接崩溃了", "failure"],
  ["失败", "这个测试失败了", "failure"],
  ["修好了", "已经修好了", "resolution"],
  ["已修复", "这个 bug 已修复", "resolution"],
  ["跑通了", "现在跑通了", "resolution"],
  ["不工作", "这个功能不工作", "failure"],
  ["没反应", "点了以后没反应", "failure"],
];
let cjkMiss = 0;
for (const [word, sent, expect] of CJK_CASES) {
  const got = classify(sent);
  const ok = got === expect;
  if (!ok) cjkMiss++;
  obs("CJK", word, got, ok ? "ok" : `MISMATCH expected=${expect}`);
}
console.log(`  --> CJK 覆盖缺口: ${cjkMiss}/${CJK_CASES.length}`);

// ─────────────────────────────────────────────────────────────
section("B. Semantic precedence（R3 规格 §4）");
const PREC = [
  ["fixed the error", "resolution"],
  ["resolved the failure", "resolution"],
  ["actually fixed", "resolution"],
  ["still failing", "failure"],
  ["not fixed", "resolution?"],      // 期望：不应是 resolution（否定！）
  ["failed again", "failure"],
];
for (const [sent, expect] of PREC) {
  obs("PREC", sent, classify(sent), `expected≈${expect}`);
}

// ─────────────────────────────────────────────────────────────
section("C. Failure -> Resolution linkage（规格 A-E）");
const LINK = {
  A: [{ text: "这里报错了" }, { text: "我改了一下" }, { text: "现在跑通了" }],
  B: [{ text: "这里报错了" }, { text: "我改了一下" }, { text: "还是失败" }],
  C: [{ text: "这里报错了" }, { text: "另外那个模块跑通了" }],
  D: [{ text: "这里报错了" }],
  E: [{ text: "这里报错了" }, { text: "修好了" }, { text: "现在跑通了" }, { text: "又崩了" }],
};
const LINK_EXPECT = { A: "resolved=true", B: "resolved=false", C: "resolved=FALSE(无关success不得算解决)", D: "resolved=false", E: "resolved=false" };
for (const k of Object.keys(LINK)) {
  const r = timeline(LINK[k]);
  obs("LINK-" + k, `kinds=${r.kinds}`, `resolved=${r.resolved} unresolved=[${r.unresolved}]`, LINK_EXPECT[k]);
}

// ─────────────────────────────────────────────────────────────
section("D. Injection filtering（规格 §4：注入 vs 讨论）");
const INJ = [
  ["真注入(闭合)", "帮我看看这个\n<system-reminder>\n# 工作区指令\n失败 报错\n</system-reminder>", "stripped"],
  ["真注入(未闭合截断)", "帮我看看这个\n<system-reminder>\n# 工作区指令\n失败 报错", "stripped"],
  ["<system> 标签", "看看这个 <system>报错 失败</system> 怎么办", "?"],
  ["XML-like", "<tool_result>error failed</tool_result> 这是工具输出", "?"],
  ["markdown system note", "> **System Note**: previous attempt failed", "?"],
  ["tool-generated reminder", "工具提示：previous run failed with error", "?"],
  ["用户讨论该词", "我注意到日志里有 <system-reminder> 这个标签，它后面的报错都没被记录", "must KEEP user text"],
  ["用户讨论(带闭合)", "harness 会注入 <system-reminder>x</system-reminder> 这种块，导致报错被吞", "must KEEP user text"],
];
for (const [name, text, expect] of INJ) {
  const stripped = stripInjectedContent(text);
  const lost = text.length - stripped.length;
  obs("INJ", name, `kept=${stripped.length}B lost=${lost}B sig=${classify(stripped)}`, expect);
}

// ─────────────────────────────────────────────────────────────
section("E. Duplicate / ordering determinism（规格 §4）");
// 用真实 buildLearnDigest 路径测 nodeSeqs 规范化
function mkEvents(texts) {
  // 形状必须与 P2.5 官方提取器一致（见 test-learn-core.mjs C12 的 EX 构造）
  return texts.map((t) => ({ type: "user/message", data: { role: "user", content: [{ type: "text", text: t }] } }));
}
const EX = mkEvents(["这里报错了", "已经修好了", "又崩了"]);
const ORD = [
  ["[0,1,2] canonical", [0, 1, 2]],
  ["[0,0,0,1]", [0, 0, 0, 1]],
  ["[1,0]", [1, 0]],
  ["[0,1]", [0, 1]],
  ["[2,1,0]", [2, 1, 0]],
  ["[1,1,2,0,0]", [1, 1, 2, 0, 0]],
];
const ordResults = [];
for (const [name, seqs] of ORD) {
  const r = buildLearnDigest(EX, seqs, P25_EXTRACTORS);
  const sig = r.ok ? learningSignals(r.digest) : { signals: [] };
  const sigStr = sig.signals.map((s) => `${s.seq}:${s.kind}`).join(",");
  ordResults.push(sigStr);
  obs("ORDER", name, `turnCount=${r.digest ? r.digest.turnCount : "ERR"} sig=[${sigStr}]`);
}
const allSame = ordResults.every((s) => s === ordResults[0]);
console.log(`  --> 全部 nodeSeqs 变体结果一致(确定性): ${allSame}`);

// ─────────────────────────────────────────────────────────────
section("F. Negation（规格 §9：不能因含关键词就判 failure）");
const NEG = [
  ["没有报错", "failure"],
  ["没有失败", "failure"],
  ["已经不报错了", "failure"],
  ["never failed", "failure"],
  ["no error", "failure"],
  ["not broken", "failure"],
];
for (const [sent, bad] of NEG) obs("NEG", sent, classify(sent), `FALSE POSITIVE if ==${bad}`);

// ─────────────────────────────────────────────────────────────
section("G. Hypothetical（讨论错误 ≠ 实际错误）");
const HYP = [
  ["如果它报错，就重试", "failure"],
  ["假设程序失败", "failure"],
  ["if it fails", "failure"],
  ["when an error occurs", "failure"],
];
for (const [sent, bad] of HYP) obs("HYP", sent, classify(sent), `FALSE POSITIVE if ==${bad}`);

// ─────────────────────────────────────────────────────────────
section("H. Documentation（描述错误 ≠ 发生错误）");
const DOC = [
  ["“failure” 字段表示失败状态", "failure"],
  ["代码里有 error 变量", "failure"],
  ["搜索关键词“报错”", "failure"],
];
for (const [sent, bad] of DOC) obs("DOC", sent, classify(sent), `FALSE POSITIVE if ==${bad}`);

// ─────────────────────────────────────────────────────────────
section("I. Historical（过去失败 ≠ 当前未解决）");
const HIST = [
  ["昨天已经修好了", "?"],
  ["以前会报错，现在不会", "?"],
  ["this used to fail", "?"],
];
for (const [sent, note] of HIST) obs("HIST", sent, classify(sent), note);

// ─────────────────────────────────────────────────────────────
section("J. Quotation（引用 ≠ 发生）");
const QUOTE = [
  ["用户说“我这边报错了”，我怎么回？", "?"],
  ["日志里写着：ERROR failed to connect", "?"],
  ["```\nerror: cannot find module\n```\n这个怎么解决", "?"],
];
for (const [sent, note] of QUOTE) obs("QUOTE", sent, classify(sent), note);

// ─────────────────────────────────────────────────────────────
section("K. False negatives（无关键词但语义是失败）");
const FN_CN = [
  "点了以后什么都没发生",
  "结果和我预期的不一样",
  "还是老样子",
  "又回去了",
  "这个方案没用",
  "它卡在那里了",
  "这次也没成功",
  "还是进不去",
];
const FN_EN = [
  "nothing happened",
  "this didn't help",
  "still the same",
  "it went back again",
  "the result is wrong",
];
let fnMiss = 0;
for (const s of FN_CN) { const g = classify(s); if (g === "none") fnMiss++; obs("FN-CN", s, g, g === "none" ? "MISSED" : ""); }
for (const s of FN_EN) { const g = classify(s); if (g === "none") fnMiss++; obs("FN-EN", s, g, g === "none" ? "MISSED" : ""); }
console.log(`  --> 无关键词失败表达漏检: ${fnMiss}/${FN_CN.length + FN_EN.length}`);

// ─────────────────────────────────────────────────────────────
section("L. Source trust / role 是否被区分");
const ROLE = [
  ["user", "assistant 声称：问题已经解决了"],
  ["assistant", "问题已经解决了"],
];
for (const [role, text] of ROLE) {
  const r = learningSignals({ turns: [{ seq: 1, role, text }] });
  obs("ROLE", `${role}: ${text}`, r.signals.length ? r.signals[0].kind : "none", "assistant 断言是否与 user 同等对待");
}

// ─────────────────────────────────────────────────────────────
section("M. Secret / transient / temporary-state 是否进入信号文本");
const SECRET_FAKE = "sk-" + "test1234567890abcdef";
const TRANS = [
  ["transient", "请求失败：ETIMEDOUT 连接超时"],
  ["rate-limit", "API 返回 429 rate limit exceeded"],
  ["5xx", "服务端 503 Service Unavailable"],
  ["temporary-state", "端口 54321 上的进程挂了，PID 98765"],
  ["sha", "commit c0849d2 之后测试失败"],
];
for (const [tag, s] of TRANS) obs("NOISE", `[${tag}] ${s}`, classify(s));
{
  const r = learningSignals({ turns: [{ seq: 1, role: "user", text: `配置里写了 ${SECRET_FAKE} 然后报错了` }] });
  obs("SECRET", "假密钥+报错", r.signals.length ? r.signals[0].kind : "none", "信号本身是否携带原文");
  const red = redactSecrets(`token=${SECRET_FAKE}`);
  obs("SECRET", "redactSecrets", red.includes(SECRET_FAKE) ? "LEAKED" : "redacted", `containsSecret=${containsSecret(SECRET_FAKE)}`);
}

// ─────────────────────────────────────────────────────────────
section("N. SIGNAL_PATTERNS 真相表");
for (const p of SIGNAL_PATTERNS) {
  console.log(`  kind=${p.kind}`);
  console.log(`    latin: ${p.latin}`);
  console.log(`    cjk  : ${p.cjk}`);
}

// ─────────────────────────────────────────────────────────────
console.log("\n=== 探针完成（观测模式，无 pass/fail 门槛）===");
console.log(`总观测条数: ${OBS.length}`);
