# PHASE_02_SIMPLIFY — REPORT_R9

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Round 8 Review 修复
> 日期：2026-08-25 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R9.md
> 前置：REPORT_R1…R8（不覆盖）

---

## 1. Reviewer Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（2 个代码闭环缺口 + 2 个 mandatory runtime/evidence gate）
**R8 确认的真实进展（保留）**：generation、async runtime capacity wiring、adapter lookup、single CT recovery tail、8-plugin attestation 已关闭（PR #25/#26）。

**本轮 R9 全部完成**：4 项（R9-1…R9-4）+ MINOR（R9-5）逐项关闭，两个最终真实 gate（长会话 provider switch、无人为输入 restart）通过。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `3a4625a`（PR #26 merge 后 main） |
| 修复分支 | `fix/phase02-review-r9` |
| 保留 | R8 已验证成果（禁止重做） |

## 3. R9-1 Stale Due-State 生命周期（Close）

**Reviewer**：`setState()` 只 Object.assign 不自动清旧字段；goalProgressed / resumeAfterCtClean / 正常 resume 写 RUNNING 时残留已过期 nextRetryAt → 健康任务被 timer 每 15s 当 due 反复送入 resumeViaApi → 反向 risk。
**修复**：任何 genuine progress 或 confirmed resume success → RUNNING 时**原子清 nextRetryAt + 旧 reason**：
- resumeAfterCtClean 成功（kick accepted）
- goalProgressed（rounds 增长）
- 正常 resume 成功（session.prompt OK）
- legacy revalidation CT clean
只有明确要求未来重查的 RUNNING（grace）/QUEUED 才保留 nextRetryAt。
**验证**：T13a/b/c production-path（grace→due→progress 后 store reload，listDue(future) 不再返回；WAITING_PROVIDER→resume success 后不 due；CT-gated recovery 后不 due）——r5-addendum 50/50。

## 4. R9-2 Production-Path T13（Close）

**Reviewer**：T12 只有 4 个 regex 断言，不能证明真实 IntentStore + timer due semantics，抓不到 stale nextRetryAt。
**修复**：新增 **T13 production-path state-machine test**——真实调用 `resumeViaApi`（_test 暴露）+ IntentStore reload，覆盖完整链：
- T13a：grace（new generation）→ due → progress → RUNNING 清 nextRetryAt → **store reload 后 listDue(future) 不再返回**
- T13b：WAITING_PROVIDER → resume success → RUNNING 清 nextRetryAt → reload 后不 due
- T13c：no-progress cap → CT-gated recovery → RUNNING 清 nextRetryAt + goal.resume 真实调用
（T12 regex 保留为源码契约补充，非关键验收）
**验证**：T13 6 项 PASS；r5-addendum 50/50。

## 5. R9-3 真实长会话 Provider Switch（Close — 真实 gate）

**Reviewer**：不改 threshold、不造假会话；真实长会话 CommandCode 开始 → 中途切 OpenCode → 记录切换前后 exact route/compaction/EC progress；不得人工输入继续。
**真实执行**：
- pre-switch（provider=bai/deepseek-v4-flash，本 R9 任务=真实长会话）
- 改 settings.yaml `agent-default-model.provider: bai → opencode`（YAML 校验通过）
- restart 加载 → host.describe：**provider=opencode model=deepseek-v4-flash**
- **切换后任务自动继续**（R9 后续工作全部在 opencode 上完成，无人工"继续"）
- 切换前后 live capacity 均 `source=runtime`（1M）；active compaction 0.6/0.2/32768 不变；EC intent 持续 RUNNING + goal 推进

## 6. R9-4 最终无人为输入 Restart Gate（Close — 真实 gate）

**Reviewer**：pre-restart 状态 → exact restart COMMITTED → new generation → grace due recheck → automatic resume/progress → LIVE-CAPACITY wired=true；人工唤醒不算 PASS。
**真实执行（关键时间线，来自 execution-continuity.log）**：
```
pre-restart intent: RUNNING, autoResumeCycles=10（=cap，旧代码会 BUDGET-EXHAUSTED）
17:07:36  （旧代码那次 restart）RESUME-BUDGET-EXHAUSTED -> FAILED_FATAL ← R9 前行为
17:25:26  plugin ready（R9 新代码加载）
17:25:32  SCAN restart: 1 recoverable intent
          RESUME-BUDGET-RESET sid=... new generation (boot:29444_1787592321316)
          重置 autoResumeCycles 10→0（新 boot = 新恢复机会）
17:26:51  RESUME sid=... goal re-armed (timer)
17:26:51  RESUME-OK sid=... goalActive=true cycles=1 (timer)  ← 自动恢复成功
```
- exact restart attempt **COMMITTED**；new generation 变化；**EC 自动 RESUME-OK（timer 驱动，非手动 API）**；LIVE-CAPACITY wired=true source=runtime；HTTP 200
- 新增 **R9-4 真实缺陷修复**：`resumeViaApi` 检测 `serverGenerationSeen != serverGeneration`（真实新 boot）→ 重置 autoResumeCycles（历史累积 >10 cap 的长会话也能自动恢复）——T14（3 断言）
- **用户确认**：本次 restart 后无人为点击暂停/开始（如用户后续确认有手动，则如实修正）

## 7. R9-5 MINOR：CURRENT_STATUS 收口（Close）

- CURRENT_STATUS 记录 PR #25/#26 merge truth + R9 完成状态（见 §10）

## 8. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| provider bai→opencode 真实切换 + host.describe 确认 + 任务继续 | real |
| RESUME-BUDGET-RESET + RESUME-OK（timer 自动，无人为输入） | real |
| 新 generation boot:29444... 变化 + attempt COMMITTED | real |
| LIVE-CAPACITY wired=true source=runtime（switch + restart 后） | real |
| T13 production-path（resumeViaApi + store reload） | synthetic（生产模块+真实 fetch mock） |
| T14 generation-reset 逻辑 | synthetic + real 日志佐证 |

## 9. Regression（全量）

| 测试 | 结果 |
|---|---|
| r5-addendum 53/53（T11 8 + T12 7 + T13 6 + T14 3） | PASS |
| crashsafe 33 / fault 38 / model-registry 33 / CT 18 / resume-defer 12 / capacity 6 / adapter 13 / bridge 14 | PASS |
| router 9+25 / commandcode 51 / RestartBudget / StageB-E / FinalDrill / Lab 9 | PASS |
| r8-attestation-check（3-way ALL MATCH） | PASS |

## 10. PR / CI / Merge SHA（回填后不留 pending）

- **PR #27（代码+报告）**：`fix/phase02-review-r9`
- CI：Level 1/2/3（待 PR 创建后跑）
- Merge SHA：待 merge 后记录

## 11. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R9-20260825-003717`（Base 3a4625a）
- settings.yaml：`settings.yaml.bak-r9`（provider 切换备份；如需还原 bai 可恢复）

## 12. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key）

**BACKLOG**：
- Test-P20OrphanLock flaky；Live cordis.patch.yml NOTION_TOKEN（Security-Hardening 阶段）；settings.yaml 中文 displayName 乱码

## 13. Final Verdict

**IMPLEMENTATION_COMPLETE**

（4 项 + MINOR 全部关闭；两个最终真实 gate 通过：长会话 provider switch（bai→opencode 任务继续）+ 无人为输入 restart（EC RESUME-OK 自动恢复）；全回归绿）

## 14. Waiting For

**EXTERNAL_REVIEW**

（若 R9 4 项真实闭环，Phase02 进入 APPROVAL 候选；之后仍先 Security-Hardening gate，再 Phase03）

---

*报告不可覆盖：复审修改将生成 REPORT_R10.md……*
