# PHASE_02_SIMPLIFY — REPORT_R10

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Round 9 Review 修复
> 日期：2026-08-25 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R10.md
> 前置：REPORT_R1…R9（不覆盖）

---

## 1. Reviewer Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（2 个代码/契约 blocker + 2 个证据/状态 blocker）
**R9 确认的真实进展（保留）**：stale due-state lifecycle、production-path T13、长会话 provider switch（bai→opencode）、无人为输入 restart auto-resume—但 bai≠CommandCode。

**本轮 R10 全部完成**：4 项（R10-1…R10-4）逐项关闭。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `4b5a047`（PR #27 merge 后 main） |
| 修复分支 | `fix/phase02-review-r10` |
| 保留 | R1–R9 已验证架构成果（禁止重做） |

## 3. R10-1 Budget-Generation 一次性语义（Close）

**Reviewer**：R9 的 reset 分支用 `serverGenerationSeen`（liveness observation 语义）兼任 budget epoch；early return（session.list fail / WAITING_* / cooldown / prompt-fail）不更新 liveness marker → 同一 boot 再次 entry 又 reset → 退化成"同一 boot 多次 fresh budget"。
**修复**：新增 **`autoResumeBudgetGeneration`** 专用持久字段：
- 检测真实新 boot（`autoResumeBudgetGeneration !== serverGeneration`）时**原子写 `autoResumeCycles=0 + autoResumeBudgetGeneration=serverGeneration`** 在**一次 persist 中**
- 同一 boot 后续任何路径（cooldown / defer / prompt-fail / success）再次 entry 时 marker==gen → 跳过 reset
- initialState 含 `autoResumeBudgetGeneration: null`
**验证**：T14（5 源码契约）+ **T15（production-path：once-per-boot guard / 原子写 marker+cycles / marker persist / store reload 保持 marker）**——r5-addendum 59/59 PASS。

## 4. R10-2 真实 Exact CommandCode→OpenCode Gate（Close — 真实 gate）

**Reviewer**：R9 的 bai→opencode 不满足要求——`bai` = **B.AI**（baseURL `api.b.ai`），不是 CommandCode（`api.commandcode.ai`）。需用 Runtime exact route truth 重新执行。
**真实执行**（两次真实切换，2026-08-25）：
```
pre-switch:  settings.yaml provider: commandcode, model: deepseek/deepseek-v4-flash
             重启 → host.describe: provider=commandcode model=deepseek/deepseek-v4-flash
             capacity: source=runtime wired=True (1M)
             generation: boot:20572_1787595237255

post-switch: settings.yaml provider: opencode, model: deepseek-v4-flash
             重启 → host.describe: provider=opencode model=deepseek-v4-flash
             capacity: source=runtime wired=True (1M)
             generation: boot:30840_1787595405158
```
- 两侧 `source=runtime`（官方 ctx.llm.resolveModelInfo 真接线）
- active compaction 0.6/0.2/32768 不变
- EC intent/goal progress 连续，两次重启后均自动恢复（RESUME-OK timer）
- 无人为"继续"（用户确认无点击）

## 5. R10-3 Runtime Evidence File（Close）

**Reviewer**：R9 无独立 evidence artifact，REPORT 手写时间线不足。
**新增**：`docs/roadmap/evidence/PHASE02_R9_RUNTIME_GATES.md`（只读，不含 secret/raw key）：
- §1 真实 CommandCode→OpenCode 切换时间线（exact tuples、generation、capacity）
- §2 无人为输入 restart 时间线（pre-restart intent → RESUME-BUDGET-RESET → RESUME-OK）
- §3 人工输入判定方法 + 用户确认原话
- §4 脱敏 identifiers 摘要
- §5 不含 secret 声明

## 6. R10-4 REPORT_R9 编码修复 + CURRENT_STATUS Truth（Close）

**Reviewer**：REPORT_R9.md 在 4b5a047（cherry-pick merge-SHA backfill）时被 PowerShell 编码损坏（mojibake：`閳?REPORT_R9`）。
**修复**：从 git 历史 PR #27 merge 前的正确 UTF-8 版本（84c7754）恢复，用 node（UTF-8 安全）替换 merge SHA/CI truth 行。mojibake=0 确认（node 字节级验证 `# PHASE_02_SIMPLIFY — REPORT_R9`）。
**CURRENT_STATUS truth**：
- Round 9 external review = CHANGES_REQUIRED、R10 pending
- PR #27 merge = f3336eb8
- 路线顺序：P2 VERIFIED → Security-Hardening → P2.5 → P3

## 7. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| 真实 CommandCode→OpenCode 两次切换（host.describe exact + generation + capacity） | real |
| 切换后 live capacity source=runtime wired=True（官方 resolveModelInfo） | real |
| 无人为输入 restart 自动 RESUME-OK（timer 驱动，log 行 + 用户确认） | real |
| autoResumeBudgetGeneration 跨 restart 语义保持（loaded-release 含） | real |
| T15 once-per-boot production-path（marker 原子写 + reload 保持） | synthetic（生产模块 + mock fetch） |
| PHASE02_R9_RUNTIME_GATES.md（可审核 evidence） | real（文档） |

## 8. Regression（全量）

| 测试 | 结果 |
|---|---|
| r5-addendum 59/59（T14 5 + T15 4） | PASS |
| crashsafe 33 / fault 38 / model-registry 33 / CT 18 / resume-defer 12 / capacity 6 / adapter 13 / bridge 14 | PASS |
| router 9+25 / commandcode 51 / RestartBudget / StageB-E / FinalDrill / Lab 9 | PASS |
| r8-attestation-check（3-way ALL MATCH） | PASS |

## 9. PR / CI / Merge SHA（回填后不留 pending）

- **PR #28（代码+报告）**：`fix/phase02-review-r10`
- CI：Level 1/2/3 全部成功（Static 1m15s / Reliability 1m37s / Boot smoke 4m3s）
- Merge SHA：**`3c005b64`**（2026-08-25 merged）

## 10. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R10-20260825-015957`
- settings.yaml 备份：`settings.yaml.bak-r10`

## 11. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key）
**BACKLOG**：Test-P20OrphanLock flaky；Live cordis.patch.yml NOTION_TOKEN（Security-Hardening 阶段）

## 12. Final Verdict

**IMPLEMENTATION_COMPLETE**

（4 项全部关闭：budget once-per-boot、真实 exact CommandCode→OpenCode gate、runtime evidence file、REPORT_R9 编码 + CURRENT_STATUS truth；全回归绿）

## 13. Waiting For

**EXTERNAL_REVIEW**

（若上述四项全部真实闭环，下一轮有资格把 Phase 02 判定为 APPROVED/VERIFIED；
之后严格进入路线：P2 VERIFIED → Security-Hardening → P2.5 → P3）

---

*报告不可覆盖：复审修改将生成 REPORT_R11.md……*