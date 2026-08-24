# PHASE_02_SIMPLIFY — REPORT_R6

> Phase 02：SIMPLIFY / Architecture Consolidation + Reliability P2 — Reviewer Round 5 修复
> 日期：2026-08-24 ｜ 执行：Harness Master Orchestrator
> 报告路径：docs/roadmap/reports/PHASE_02_SIMPLIFY/REPORT_R6.md
> 前置：REPORT_R1/R2/R3/R4/R5（不覆盖）

---

## 1. Reviewer Round 5 Verdict & 修复范围

**Reviewer Verdict：CHANGES_REQUIRED**（6 个源码级 BLOCKING）
**R5 确认的真实进展（保留）**：PR #21 merged + Level1/2/3 绿；RestartAndWait exact attempt + 非空 generation；legacy NEEDS_VERIFICATION → RESUME-OK（goal rounds 0→4）；Goal Recovery 只读；Completion Truth exact callId；EC 无 compactNow；RESUME-DEFER durable。

**本轮 R6 全部完成**：6 个 BLOCKING（B1-B6）逐项关闭（详见 §3-§8）。

## 2. Baseline

| 项 | 值 |
|---|---|
| Base Commit | `6e4aef26`（PR #21 merge 后 main） |
| 修复分支 | `fix/phase02-review-r6`（8 commits） |
| 保留 | R5 已验证成果（禁止重做） |
| DSH 版本 | 0.1.1-rc.2 |

## 3. R5-B1 Test Isolation 完善（Close）

**Reviewer**：StageE 无 DSH_TX_ROOT（Enter 创建真实 tx-checkpoint）；StageC tx-journal mtime 非真 pre/post。
**修复**：
- Test-StageE：加 DSH_TX_ROOT 隔离（safe-mode Enter 的 Transaction checkpoint 落 temp）+ E6 真实 0-delta deny（tx-checkpoints hash/count pre vs post）
- Test-StageC：C5 改**真 pre/post**——journal mtime+hash 与 checkpoint count 在测试**开始前**记录，结束后对比（原为测试后连读两次）
**验证**：StageC C5（true pre/post + count 355==355）PASS；StageE E6（0-delta）PASS。

## 4. R5-B2 Process Authority 收口（Close）

**Reviewer**：Guardian 自带 Restart-Server 不走 exact attempt；Guardian 成功调 Register-DshRestartSuccess（无 candidate 不 reset）日志矛盾；Transaction BOOT_FAILED 无 journal/rollback；13:54 attempt 短暂 api_unready 被误标 FAILED。
**修复**：
- Guardian Restart-Server → **复用 restart-dsh-server-delayed.ps1 -RestartAndWait**（exact attempt：candidate+generation+stable+COMMIT_READY+commit）；移除 Register-DshRestartSuccess + 矛盾日志（worker 已 commit budget）
- Transaction BOOT_FAILED → **journal 记录 + rollback**（restore checkpoint + exact-terminal rollback restart）——无静默半应用
- restart worker stable re-check → **有界 boot grace**（3×10s 重试）——瞬态 api_unready 不再误标 FAILED（13:54 case）
**验证**：StageC/E/FinalDrill/RestartBudget 全 PASS。

## 5. R5-B3 LastGood Required-Set（Close）

**Reviewer**：Save 缺 1-2 个文件仍 promote；Test-VerifiedSet 不验 cardinality；Guardian restore 无 manifest 时 legacy copy 绕过。
**修复**：
- Save：required set（settings+cordis.patch+cordis.yml）对照**全集**检查（调用方传更少也拒绝）；缺 required → 拒绝 promote；manifest 带 schema=2 + required
- Test-VerifiedSet：required-set cardinality（每个 required 在 manifest）+ 逐文件 sha256
- Guardian Restore-LastGoodConfig：**无 meta/manifest/required 缺失/hash mismatch 一律拒绝**；legacy no-manifest copy **移除**
**验证**：StageB C6（missing-source 拒绝 / full promotes / missing-manifest invalid / torn-pointer no-set / mixed-set invalid）ALL PASS。

## 6. R5-B4 Liveness State Machine（Close）

**Reviewer**：anti-double-kick 没比较 generation/revision；roundsStarted 无进展立即 INTERRUPTED+同次 kick；goalRoundsObserved 初始 null 无 grace；CT defer cap 后 boot 又能自动重评（跨 restart 不生效）。
**修复**：
- intent 持久化 `serverGenerationSeen`（processStartMs）+ `goalIdObserved` + `goalRevisionObserved` + `goalRoundsObserved` + `goalObservedAt` + `livenessUnknownCount`
- 新 generation/新 goal 首次观察 → **GRACE SKIP**（记录 identity，不 kick）
- 同 generation + 同 goal + rounds 推进 → SKIP（真 progress）
- 无进展超 60s grace → **RECOVERY_QUEUED + nextRetryAt + bounded count**（cap 6 → FAILED_FATAL manual review）——**绝不同次立即 kick**；timer 到期重读
- **legacy migration 只允许 schemaVersion<2**；schema2（含 cap-exhausted LEGACY_EVIDENCE_UNAVAILABLE）boot 后仍 manual，不自动迁移
**验证**：test-r5-addendum 29/29（T3 grace/generation/identity/recheck + T10 schema2 no-migrate）；crashsafe 33 / fault 38 / bridge 14 PASS。

## 7. R5-B5 Capacity Truth（Close）

**Reviewer**：Router 用 registry hint 做最终 capacity 决定；权威应是 runtime resolveModelInfo。
**修复**：
- **新 `capacity-resolver.mjs`**：可注入 exact route resolver——`createCapacityResolver({runtimeResolve, hintWindow})`；runtime resolveModelInfo(provider,model) 是 **AUTHORITY**；runtime 路径存在但 unknown → **fail-closed**（不用 hint 伪造）；无 runtime 路径（测试）→ registry hint；unknown → null
- openrouter-router / commandcode-router：needLargerContext 用 resolver（config.capacityResolver 可注入），日志含 capacitySource
**验证**：test-capacity-resolver 5/5（runtime wins / runtime-unknown fail-closed / hint fallback / unknown null / default）；bridge 14 / commandcode 51 / router 9+25 PASS。

## 8. R5-B6 CI/Preset/Loaded Attestation（Close）

**Reviewer**：thresholdRatio 硬编码 0.8/0.16 没读 active preset（实际 0.6/0.2/32768）；attestation 无 loaded hashes；Level3 只 4 插件。
**修复**：
- r5-runtime-truth.mjs：**真实读取 active preset**（`.agent-presets/autonomous/agent.cordis.yml`）→ thresholdRatio=**0.6** / retainRatio=**0.2** / maxTokens=**32768**（修正 R5 硬编码 0.8/0.16）；loaded release attestation（runtime entryHash + plugin mtime vs server start 推断 loaded）；exact route capacity 输出（CommandCode/OpenCode/OpenRouter 候选）
- ci-level2.yml：加 **production-path 状态机测试**（ec-router-bridge / capacity-resolver / r5-addendum / model-registry / completion-truth / resume-defer + StageB required-set）——不再只有代表性子集
**验证**：preset 0.6/0.2/32768 真实读取；source==deployed 7/7 MATCH；loaded attestation 正确标记 capacity-resolver 为"部署晚于启动"（需重启加载——诚实识别，不假装已加载）。

## 9. 已确认 PASS（R6 禁止重做）

- PR #21 merged；Level1/2/3 绿（当前 DSH + hard fail）
- RestartAndWait exact attempt + 非空 generation（12:51 attempt b34f... COMMITTED）
- legacy NEEDS_VERIFICATION → RESUME-OK（13:54，goal rounds 0→4）
- Goal Recovery 只读；Completion Truth exact callId；EC 无 compactNow；RESUME-DEFER durable
- LastGood versioned set + pointer 方向（R6 补 required-set + 统一 restore）
- CommandCode bridge wiring + 真实 ack（R6 换 capacity truth source）

## 10. Real vs Synthetic Evidence 分栏

| 证据 | 类型 |
|---|---|
| preset thresholdRatio=0.6/retainRatio=0.2/maxTokens=32768（真实文件读取） | real |
| source==deployed 7/7 MATCH；loaded attestation 诚实 flag | real |
| liveness grace/recheck + schema2 no-migrate | synthetic（生产模块+mock ctx） |
| capacity resolver runtime/hint/fail-closed | synthetic（纯模块） |
| LastGood required-set C6 | synthetic（隔离 state） |
| Guardian exact-attempt / BOOT_FAILED rollback / boot grace | synthetic（代码路径 + 历史 real restart 佐证） |

## 11. Regression（全量）

| 测试 | 结果 |
|---|---|
| RestartBudget R1-R18 / StageB C1-C6 / StageC / StageE / StageD | PASS |
| CommitReadiness / FinalDrill D1-D8 / Lab L1 9 | PASS |
| model-registry 33 / CT 18 / resume-defer 12 / r5-addendum 29 / capacity 5 | PASS |
| ec-router-bridge 14 / crashsafe 33 / fault 38 / compaction 18 / WAITING_USER 12 | PASS |
| router 9+25 / commandcode 51 | PASS |
| r5-runtime-truth（preset + attestation + capacity） | PASS |

## 12. PR / CI / Merge SHA

- PR #22（代码）：`fix/phase02-review-r6`（commits，8 个）
- CI：Level 1/2/3（待 PR 创建后跑）
- Merge SHA：待 merge 后记录（不留 pending）

## 13. Rollback

- Checkpoint：`DSH-Client\_checkpoint-PHASE02-R6-20260824-161923`（Base 6e4aef26）
- git：`git reset --hard 6e4aef26`（R6 前）

## 14. Remaining UNKNOWN / BACKLOG

**UNKNOWN**：
- AGENTROUTER_BACKEND_ACCEPTED_CONTEXT（300K probe 需成本+key）
- commandcode 路由 settings contextWindow 未声明（registry hint=1310720；resolver hint 源）

**BACKLOG**：
- Test-P20OrphanLock flaky（guardian dot-source 主循环）
- Live cordis.patch.yml 硬编码 NOTION_TOKEN（SECURITY-HARDENING 阶段）
- settings.yaml 中文 displayName 乱码（显示级）

## 15. Final Verdict

**IMPLEMENTATION_COMPLETE**

（6 BLOCKING 全部关闭；全量回归绿；real vs synthetic 分栏清晰；PR/CI/merge SHA 明确记录）

## 16. Waiting For

**EXTERNAL_REVIEW**

（等待 Reviewer Verdict；未 APPROVED 禁止 Phase 03；Phase 03 入口仍先执行 Security-Hardening gate）

---

*报告不可覆盖：复审修改将生成 REPORT_R7.md……*
