# P0 对抗式评审 · AC1–AC7 差量（round 1）

评审对象：`_p4r2-final-closure/p0-review/DIFF_plugins.txt`（= `_p4r2-inject-fix/plugins/*` 对官方基线的差量）
评审姿态：**对抗式**——目标是尽量**推翻**"AC1–AC7 已闭合"的结论，而不是复述 diff。
基准事实：被评审字节与生产已部署字节**逐字节相同**（SHA256 一致），故下列复现既可对候选亦可对部署文件执行。

| 文件 | 候选 SHA256 | 部署 SHA256 | 相同 |
|---|---|---|---|
| plugins/learn-core.mjs | 4091825530F9E1DD…C203（157504 B） | 同 | 是 |
| plugins/learn-candidate.mjs | F732806AA5F9D868…4E97（50835 B） | 同 | 是 |
| plugins/learn.mjs | 24234C0D4AE6F25E…0751（125853 B） | 同 | 是 |

回归基线（本次实跑，exit 0）：AC1 家族测试 `PASS=40 FAIL=0`；候选生命周期 `39 PASS / 0 FAIL`；
R-3 脱敏加固 `62 PASS / 0 FAIL`。

---

## P0-1（MEDIUM，但**正好落在 AC1 修复的靶心**）：`redactStore` 对 `uri-credential` 不幂等
→ 永久误报 `STORE_REDACTED` + 每次载入都白写一次盘

**代码承诺**（learn-core.mjs `redactStore` 文档，diff 行 488）：
> 幂等：占位符 `[REDACTED:<family>]` 不再命中任何家族 ⇒ 二次调用 count=0 且库完全不变。

**实测反证**（经验条目 body 形如 `note postgres://user:s3cr3tP@ss@db:5432/x`）：

```
h1.count= 1 entries= 1   h1.fields= ["experiences[0].body(uri-credential)"]
h1.body = "note postgres://[REDACTED:uri-credential]@db:5432/x"
h2.count= 1   ←← 文档承诺 0
h2.fields= ["experiences[0].body(uri-credential)"]   ←← 审计线索指向一个**并不存在的新泄漏**
h2 字节不变 = true
占位符仍被判为家族命中 = ["uri-credential"]
telemetry 数组引用变化 = true
```

复现（只读，纯函数）：
```powershell
cd 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2-inject-fix'
node --input-type=module -e "
import { redactStore } from './plugins/learn-core.mjs';
const uri='postgres://user:s3cr3tP@ss@db:5432/x';
const mkExp=(over={})=>({ id:'exp-uri', state:'PROPOSED', title:'title', body:'note '+uri, tags:[], sourceEventSeqs:[1], originSessionId:'sess', createdAt:1, approvedAt:null, approvedBy:null, approvalEvidence:null, rejectedAt:null, rejectedBy:null, rejectionReason:null, retiredAt:null, promotion:'NONE', promotionEvidence:null, recallCount:0, lastRecalledAt:null, ...over });
const store={schemaVersion:2,sessionId:'sess',version:3,experiences:[mkExp()],telemetry:[],updatedAt:0};
const h1=redactStore(store), h2=redactStore(h1.store);
console.log('h1.count=',h1.count,'h2.count=',h2.count,'(应为 0)','字节不变=',JSON.stringify(h2.store)===JSON.stringify(h1.store));
"
```

**根因**（`redactTree`，diff 行 446-449）：把命中**先记账、后比较**——
```js
if (!containsSecret(node)) return { value: node };
hits.push(`${pathStr}(${secretFamiliesIn(node).join('+')})`);   // ← 先 push
return { value: redactSecrets(node) };                          // ← 值可能与 node 完全相同
```
`uri-credential` 的正则（`://…最后一个@`）会**匹配它自己的输出**：`postgres://[REDACTED:uri-credential]@db:5432/x`
里 `[REDACTED:uri-credential]` 含 `:`，形似 `user:pass@`，于是 `containsSecret()` 再次返回 true，
而 `redactSecrets()` 返回**同一字符串** ⇒ `changed=false`（数据没被改写，引用也没变，**没有数据损坏**），
但 `hits.length` 已经 +1。

**按家族逐条定界**（13 个样本实测）：只有 `uri-credential` 会重新命中自己的占位符；
`generic-assignment / bearer / stripe / google / jwt / aws / slack-webhook / npm / gitlab / pem` 均**不会**。
即缺陷面窄但确定：**恰好是连接串那一家族**（本项目经验库里 DB/broker 连接串很常见）。

**真实后果**（生产路径，learn.mjs `loadStore` 行 592-596）：
```js
const heal = redactStore(ok);
if (heal.count > 0) { diag(`STORE_REDACTED sid=… fields=${heal.count} …`); saveStore(heal.store); }
```
⇒ 任何含"已脱敏 URI 占位符"的会话库，**每次载入都会**：
1. 打印一条与真实清理**同形**的 `STORE_REDACTED` 审计行（运维/评审无法据此区分"本次真清了新泄漏"与"又在重报老占位符"）；
2. 调用 `saveStore()` 白写一次盘 —— 该写还会推进 `writesSincePrune`，间接加速其它会话库的保留策略淘汰。
**永不收敛**：`count` 永远 ≥1，"清理干净"这一可用信号被摧毁。

**为什么回归测试没抓到**：`test-learn-ac1-secret-families.mjs` §5.2（行 134-137）的幂等夹具只用
`stripe` + `google`（行 102-110），恰好**不含** `uri-credential` 家族 ⇒ §5.2 空转通过。

**最小修法**（改一处、加一条夹具，不新建任何系统）：
```js
// learn-core.mjs redactTree()，string 分支
if (!containsSecret(node)) return { value: node };
const next = redactSecrets(node);
if (next === node) return { value: node };      // 已是占位符：不计命中、不算改写
hits.push(`${pathStr}(${secretFamiliesIn(node).join('+')})`);
return { value: next };
```
并在 §5.2 夹具里加一条 `body: 'note postgres://user:s3cr3tP@ss@db:5432/x'` 的经验条目，
把"二次 count=0"真正锁住（当前该断言对本题无效）。

---

## P0-2（MEDIUM）：AC2 的"阶梯选择"在生产是**常量**，RULE / EXTEND_SKILL / NEW_PLUGIN 永不可达

代码注释声称研究腿"阶梯选择：**复用**候选面的唯一阶梯（RULE → EXTEND_SKILL → NEW_SKILL → NEW_PLUGIN）"。
但两个生产调用点都**没有提供阶梯依据**：

- learn.mjs 行 832（研究腿）：`chooseCandidateKind({ ruleExpressible: false, existingSkill: '', requiresRuntimeCapability: false })`
- learn.mjs 行 1381（缺口级计划）：`researchPlan(gap)` —— **无 opts**，内部 `chooseCandidateKind({})`（learn-candidate.mjs 行 410）

实测：
```
chooseCandidateKind({ruleExpressible:false, existingSkill:'', requiresRuntimeCapability:false})
  → {"kind":"NEW_SKILL","reason":"no_existing_skill_capability_is_procedural"}
chooseCandidateKind({})  → 同上（NEW_SKILL）
```
⇒ 契约 §七 的四级阶梯在**生产路径上恒为分支③**，另外三级**没有任何可达调用方**；
交给 agent 的 `researchDirective.candidateKind` 永远是 `NEW_SKILL`（哪怕该缺口本可用 RULE 表达）。
这不是安全缺陷，而是**"复用"只复用了函数形状、没有复用判断**：条款上"按阶梯选择"与实际"恒定选择"不一致。

**修法（本任务范围内）**：让调用方真的给出依据——研究腿用 `classifyResearchRisk()` 的结论 +
既有 skill 清单（`STAGE_DELEGATION` 同源）填三个输入；缺口级把 `qualifyGap()` 已有的
`ruleExpressible/existingSkill/requiresRuntimeCapability` 透传给 `researchPlan(gap, opts)`。
若暂不具备依据，则应把注释与遥测 reason 改成"无依据 ⇒ 保守取 NEW_SKILL"，不要宣称走了阶梯。

---

## P0-3（MEDIUM，审计真实性）：`fulfillResearchLegs` 只按**时间**闭环，不按**主体** ⇒ `RESEARCH_FULFILLED` 多报

learn.mjs 行 892-903：只要 `leg.openedAt <= experience.createdAt`，就关**全部**未闭环的腿
（同一会话内）。一条经验可以把 5 条**主题毫不相干**的研究腿一次全标成 fulfilled，
并记 `RESEARCH_FULFILLED count=5`——遥测因此声称了不成立的因果关系。
腿本身已带确定性 `subjectKey`（`candidateIdOf(subject)`，行 826），**闭环却没用它**。

**修法**：闭环前置加主体匹配（腿的 `subjectKey` 与经验的派生键/`sourceEventSeqs` 归一签名一致才闭环），
或把遥测措辞降级为"时间上可能相关"并另留 evidence 字段；否则 AC2 的"闭环事实"不可作为证据使用。

---

## P0-4（MEDIUM，AC6 闸门的**实际强度**）：收据门只验证"形状 + 三腿自洽"，**不绑定任何真实系统**

AC6 的措辞是"晋升必须**真走**既有 Git / CI / Transaction"，且遥测 reason 写
`receipts_from_existing_git_ci_transaction_consistent`。但 `verifyPromotionReceipts()` 校验的是
**调用方传入**的结构：`system` 白名单、分支名必须等于候选派生 label、`commitSha` 是 40 位十六进制、
`worktreePath` 非空、`isolated === true`、`ci.headSha === git.commitSha`、事务 label/transactionId 互洽。
learn-candidate.mjs 行 6/13 自己也声明"**本模块不执行任何真实的 git / CI / 部署动作**、绝不 spawn 进程"。

⇒ 该门挡住的是"缺收据 / 形状不对 / 三腿互相矛盾"，**挡不住"形状正确但整组伪造"**：
没有任何环节去问真实仓库"这个 sha 存在吗"、CI 是否真跑过、journal 是否真有那条事务。
即：**证明的是自洽，不是来源**。E2E 证据之所以可信，靠的是执行过程（真跑一遍），不是这行代码。
（旁证：`promoteCandidate` 在**生产**里没有任何调用方——它只被测试/E2E 调用；所以这个门的强度
完全取决于未来那个调用方是否诚实。）

**建议（最小、且不违反复用规则）**：不要把 git/CI 引擎塞进本模块（B3 静态锁正是为了禁止它）。
改为 ① 在文档/遥测措辞上**精确化**："本门证明收据三腿自洽，来源真实性由 E2E 过程保证"；
② 真实仓库侧的只读交叉校验交给**已有的既有系统消费者**（CI/事务侧），由它们在产出收据时附来源指纹，
本模块只做一致性校验。任何"再加一套校验引擎"的做法都应被拒绝。

---

## P0-5（LOW-MEDIUM，AC2/AC8 语义）：研究腿的"尝试次数"由**召回未命中**消耗，不是由研究消耗

`openResearchLeg()`（learn.mjs 行 809-）每次被调用都把 `recordResearchAttempt(... outcome:'PROGRESS')`
记一次，而它的唯一触发是 `learn_recall` **无命中**（行 1756）。
⇒ 同一主题**连续三次召回未命中**（哪怕一次研究都没做）即达 `MAX_RESEARCH_ATTEMPTS=3`，
此后返回 `research_bounded_exhausted`，指令面告诉 agent"已达上限、停止研究"。
"禁无限重试"的有界性成立（实测：attempt 1/2/3 ok，第 4 次 `research_bounded_exhausted`），
但被限流的是**查询**而不是**研究动作**；账本又是 `persistence: 'in_memory_only'`（已如实声明），
所以上限是**每进程**上限，重启即清零 —— "有界"不能当作持久保证来引用。
**建议**：把"打开腿"与"消耗一次尝试"解耦（打开腿 = 记账 0 次；尝试由调用方显式上报），
或在遥测/指令里明确"本上限约束的是本会话的打开次数"。

---

## P0-6（LOW）：只读的 `learn_recall` 现在会**写库**

未命中分支新增 `tel(sid,'EXPERIENCE_LOOKUP_MISS'…)` + `tel(sid,'RESEARCH_REQUESTED'…)`，
而 `tel → commit → saveStore`。即：一次纯查询会为**此前没有任何库**的会话创建 store 文件并落盘，
并在每次未命中时重写。功能上可接受、也无密钥面风险（遥测只含 query 的 oneLine 摘要——**注意**：
query 原文本会进入遥测，仍受同一脱敏表覆盖），但违反"召回是只读操作"的直觉，
评审时应明确记录为**有意的副作用**而不是默认预期的行为。

---

## 已复核且**成立**的断言（避免评审过度指控）

1. `learn_status` 的 `summary: { type:'object', additionalProperties: true }`（行 1964）
   ⇒ 追加 `researchLegs`/`researchBounded` 是合法纯增量，**不会**触发宿主 `dsh-tools` 输出校验拒绝。✔
2. `learn_verify` 的 B2 修复方向正确：schema（行 1858-1868）中 `method`/`error` 均非 required，
   省略键合法、`null`/`undefined` 非法（引用的宿主校验器 L457/L465 口径自洽）。✔
3. 收据门的插入位置正确：`promoteCandidate` 顺序为 ①not_ready → ②missing_stage_evidence →
   ③`promotion_requires_human_approval` → ④收据门（行 820-864），
   与 `test-learn-candidate.mjs` E4/E5/E6 期望逐条吻合（E6 已补 `receipts: realReceipts(...)`）。✔
4. `memoryFootprint()` 里的 `researchLegs.size`（行 531）**不是 TDZ 风险**：
   `researchLegs` 声明于行 780，但唯一出口 `_memoryFootprint: () => memoryFootprint()`（行 2071）是**惰性 thunk**，
   apply 期不会触碰。✔（此项曾按其历史 TDZ 事故形态重点排查）
5. 三条回归测试本次实跑全绿（AC1 40/0、候选 39/0、R-3 62/0，exit 0）——**但** §5.2 的幂等断言对 P0-1 无效（见上）。✔

## 结论

AC1–AC7 的**主体实现方向成立**，未发现数据损坏、密钥外泄或启动期崩溃类缺陷；
但"已闭合"的结论**不应直接采信**：P0-1 使 AC1 的自愈路径**永不收敛且持续误报**（且恰好是连接串家族，
正是本次修复的目标场景），P0-2/P0-3 使 AC2 的两处"可审计事实"（阶梯、闭环）在生产上分别是**常量**与**多报**，
P0-4 使 AC6 的闸门强度低于其措辞。建议：P0-1 修完并补 §5.2 夹具后再宣布 AC1 闭合；
P0-2/P0-3 至少修正措辞或补主体依据后再引用其遥测作为证据。
