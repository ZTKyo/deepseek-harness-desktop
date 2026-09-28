# P0 对抗式评审 round 1 的 6 项发现 · round 2 处置状态（2026-09-29）

- 评审原文：`P0_REVIEW_FINDINGS_AC1-AC7_round1.md`（同一目录，未改写、不洗白）
- 本轮工作树：`p4-integration-r3`（= `_wt-integrate`）
- 本文件的判定口径：**只有"能被打红"的检查才算证据**（静态断言全绿 ≠ 生产行为存在），
  因此每一项都标注了「哪个门 / 哪条检查 / 是否已被真实突变抓住」。

## 0. 一句话结论

6 项全部处置完毕（5 项改码 + 1 项如实记录为有意副作用）；其中 4 项带**真实突变验证**
（把修复回退掉必须能让指定检查变红），证据如下表。**唯一未闭合的是"部署"这一环**：
修复已在仓库（见 §3 哈希），但生产 profile 里的 3 个插件仍是旧字节 ⇒ 本机 `ac1` 门
（它按设计测的是**生产已部署字节**）仍报 FAIL，直到部署 + 重启后才应转 PASS。

## 1. 逐项状态

| 编号 | 评审指控 | 处置 | 证据（门 / 检查 id / 突变 id） |
|---|---|---|---|
| P0-1 | `redactStore` 对 `uri-credential` 不幂等 ⇒ 二次调用仍报 count=1（占位符被误判为新泄漏）⇒ STORE_REDACTED 永久误报、自愈永不收敛 | **已修**（commit `3a3d1b4`）+ 补夹具 | `test-learn-ac1-secret-families.mjs`：对**仓库**字节 `PASS=43 FAIL=0 / VERDICT=PASS`（含 §5.5 幂等：二次零命中零字段） |
| P0-2 | AC2 研究腿的阶梯依据是**伪造的常量**（三个输入都填 false）⇒ `reason` 凭空断言"不存在既有 skill" | **已修**：区分"给过依据/没给依据"，无依据时如实写 `no_qualification_basis_conservative_new_skill`；形态选择结果不变 | 门 `test-learn-ac2-research-leg.mjs` 检查 **A3**（两处断言：腿自身 + 指令面）；`test-learn-candidate.mjs` 检查 **D6**；**突变 M7**（把研究腿调用点改回填死值）⇒ A3 变红 ✅ |
| P0-3 | `fulfillResearchLegs` 只按**时间**闭环、不按主体 ⇒ 一条无关经验可一次闭掉全部腿 ⇒ `RESEARCH_FULFILLED count=N` 多报不成立的因果 | **已修**：闭环强度分两级——主体绑定才记 `RESEARCH_FULFILLED`，仅时间序则记新遥测 `RESEARCH_LEG_CLOSED_TIME_ONLY`（措辞明确"相关、非因果"） | 门 **C3**（无关主体 ⇒ 必须 time_only、不得 FULFILLED）+ **C4-1/C4-2**（主体绑定的正例必须真的可达）；**突变 M9**（去掉主体判定）⇒ C3 变红 ✅ |
| P0-4 | AC6 收据门只证明"自洽"，措辞却像"来源已被核实"（`receipts_from_existing_git_ci_transaction_consistent`） | **已修**：措辞精确化为 `receipts_three_leg_consistent_source_authenticity_not_attested`（说明来源真实性由既有系统产出时的指纹 + E2E 真跑过程保证）；另拒绝"在本模块内再加一套校验引擎" | 门 `test-learn-candidate-receipts.mjs` 检查 **D5**（33P/0F 全绿）；本门是**纯函数直接值断言**（拿真实产出的 `acc.reason` 逐字比对），故未另设突变——回退措辞会直接命中该断言 |
| P0-5 | "尝试次数"由**召回未命中**消耗而非研究动作消耗 ⇒ 上限被读成"约束研究动作"；且账本是每进程内存 ⇒ 不能当持久保证 | **已修**：不改行为（有界性仍成立），但 `learn_status` 增加 `boundSemantics = per_session_leg_opens_not_research_actions`，指令面/遥测如实说明"本上限约束的是**本会话的打开次数**" | 门检查 **A5**；**突变 M8**（删掉 `boundSemantics`）⇒ A5 变红 ✅ |
| P0-6 | 只读的 `learn_recall` 会**写库**（未命中也 `tel → commit → saveStore`） | **如实记录为"有意的副作用"**（代码内 ★P0-6 注释说明"本应只读、此处有意留痕"），不改变行为 | 代码注释（learn.mjs ★P0-6）+ 门 **A6** 保证"未命中召回**不改经验库**"（不自动提案/不自动审批/全局库仍空）这一真正要紧的性质仍成立 |

## 2. 突变验证（反空转证明）本轮结果

`node tests/learn/_ac2-mutation-proof.mjs` ⇒ **PASS=10 FAIL=0**（含基线：未突变时门全绿 PASS=27/FAIL=0）：

```
PASS 0 基线 …… PASS=27 FAIL=0
PASS M1/M6 假接线（researchPlan 调用点被删/返回值被丢弃）→ 0.7 变红
PASS M2 主能力摘掉 → 17 条变红
PASS M3 自留硬编码上限 → D2 等变红
PASS M4 输出契约破坏 → A2 变红
PASS M5 遥测被静默 → B4 变红
PASS M7 ★P0-2 回退 → A3 变红
PASS M8 ★P0-5 回退 → A5 变红
PASS M9 ★P0-3 回退 → C3 变红
```

> 同时删除了一个**重复建设**的反证脚本（`tests/learn/test-p0-negative-control.mjs`）：
> 它用"模拟旧调用形态"的方式做证明，而仓库里**已有**真实突变体系（改副本字节 + 真跑门 +
> 断言必须变红）⇒ 按"不做第二套系统"的红线，改为把 P0-2/P0-3/P0-5 三处直接**追加进既有突变表**
> （M7/M8/M9），不新建平行机制。

## 3. 尚未闭合的一环：部署（如实标注）

| 文件 | 仓库（即将提交） | 生产 `~/.dsh/profiles/web/` | 是否一致 |
|---|---|---|---|
| `learn.mjs` | `5C4EE78C…6176D` | `24234C0D…40751` | ❌ 旧字节 |
| `learn-core.mjs` | `DCF2A2AE…E919D` | `40918255…CC203` | ❌ 旧字节 |
| `learn-candidate.mjs` | `2B4D3853…10E1BF` | `F732806A…14E97` | ❌ 旧字节 |
| `learn-gap-veto.mjs` | `B7623CED…90B36` | `B7623CED…90B36` | ✅ 一致 |

**含义（不粉饰）**：
1. 修复在仓库里已成立并有突变证明，但**生产进程仍在跑旧字节**；
2. `run-learn-all-tests.mjs` 里的 `test-learn-ac1-secret-families.mjs` 默认目标就是**生产已部署文件**
   （无参数运行 ⇒ `~/.dsh/profiles/web/learn-core.mjs`），所以它现在报
   `PASS=42 FAIL=1 / VERDICT=FAIL`（§5.5 幂等仍是**旧行为**）——这是**部署缺口**，不是代码缺陷；
   同一命令对**仓库**字节跑 ⇒ `PASS=43 FAIL=0`；
3. 因此本轮的收尾顺序必须是：**提交 → PR/CI → 合并 → 部署 + 延迟重启 → 生产装载探针 + 重跑该门**，
   在此之前**不得**声称"AC1/AC2/AC6 已生产闭合"。

## 4. 不因本次评审而改的东西（防止顺手重构）

- `learn_recall` 的写库副作用（P0-6）：**保留**（遥测要留痕），只记录为有意行为；
- AC6 收据门：**不**加 git/CI 校验引擎（那是 AC6"不造第二套 promotion engine"与 B3 静态锁禁止的）；
- 研究腿的形态选择结果：P0-2 修复**只改理由措辞的可审计性**，kind 与生产行为一字不变。
