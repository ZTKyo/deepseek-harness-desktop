# P2.5 R5.1-D FINAL TRUTH CLOSURE — External Review Round 8 最小事实收口（2026-08-28）

> 单一事实载体：`docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/R5_1_D_FINAL_TRUTH_CLOSURE.md`
> 范围：**只**登记 External Review Round 8（CHANGES_REQUIRED）四个 blocker 的最小事实收口。
> 不改 §0–§19 已载结论；不改任何生产代码/配置；未重设计 Context Memory；未建第二套评测系统。
> 状态维持 **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**，等待 **External Review Round 8 的重新审核**（本报告为 R8 修复轮交付物）。

---

## 1. 四个 blocker 与事实裁定（结果在最前）

| Blocker | Round 8 批评 | 本轮最小收口裁定 | 载体 |
|---|---|---|---|
| **A. Completion Quality V4 自动 rate verdict** | V4 用 echo-excluded incident per-1k 规则（ON 0 ≤ OFF 0 × 2）自动产出 verdict，固定字段未参与裁决；echo 剔除按事件类型无法证明非真实错误；与 Round 7「禁止再设计 metric」合同冲突 | **已修复**：V5 弃用 rate/per-1k/×2/echoExcluded 自动 verdict；改为 **task-quality 事实裁决**（四代表会话 COMPLETED + PR/CI/报告回证链；真实 tool/provider error=0；duplicate side-effect=0；false-completion 由既有双门 verifier 覆盖）；不可观测字段如实 N/A；verdict=NO MATERIAL REGRESSION（若 Reviewer 要求严格 acceptance 回放则 fallback=INCONCLUSIVE，登记册 #5 开放） | `evidence/r5-completion-quality-v5-20260828-r8c/R5_COMPLETION_QUALITY_V5.json` |
| **B. SH-R9 posture 需 LIVE 重跑** | V4 为 2026-08-27 快照，Round 8 需当前时点 live 复核 | **已修复**：V4 生成器**原样复跑**（断言零改动，只读）→ **16/16 PASS**（generatedAtUtc=2026-08-27T17:53:36Z，本地 2026-08-28 01:53 CST；9 canonical SH-R9 + EXT-1 Guardian 活性 + EXT-2 凭据 DACL + EXT-3 hardened config + EXT-4 近 24h 周期 + EXT-5 凭据同源链 + EXT-6 repo+worktree 活体 secret scan + EXT-7 snapshot identity；工件身份字段已更新为 V5 快照） | `evidence/r5-sh9-posture-v5-20260828-r8c/R5_SH9_POSTURE_V5.json` |
| **C. canonical 前向路线统一** | 需确认 GitHub ↔ Notion（Master/02.5/02.6/02.75/03）一致 | **已核验**：Master 页 2026-08-27 路线更新（02.6 RETRY SEMANTICS → 02.75 SUPERVISOR → 03）；02.5 页 Waiting For=Round 8；CURRENT_STATUS L13 同口径；02.6 硬前置=P2.5 外部 VERIFIED；02.75 硬前置=02.6 VERIFIED；P3 前置=02.5+02.75 VERIFIED；01/02/02-SH 均已 VERIFIED（历史 APPROVED） | Notion Master 页 + 02.5 页 + `docs/roadmap/CURRENT_STATUS.md` L13/L27-L31 |
| **D. R5.1-C 状态核实** | 需确认 PR #53 已 MERGED、状态未越权 | **已核验**：PR #53 squash MERGED=`fedfeb7`（CI 三项全绿：DSH boot + readiness smoke / Reliability state machine / Static + secret + syntax）；main HEAD=3f6e029（=fedfeb7 + 纯状态 backfill `3f6e029`）；CURRENT_STATUS 记录 R5.1-C merge backfill；**未**将 P2.5 标 VERIFIED；checkpoint 完好 | git log + `CURRENT_STATUS.md` + PR #53 记录 |

---

## 2. 本轮 LIVE 复核证据（2026-08-28 02:00Z 现场）

| 事实组 | 实测值 | 判定 |
|---|---|---|
| 插件字节身份（live vs repo） | context-memory.mjs live=5fcd2ec401730fcd repo=同 → eq=true；context-memory-core.mjs live=e68fbd173340d008 repo=同 → eq=true | PASS |
| 插件挂载链 | agent.cordis.yml L438 id=context-memory → L439 ./context-memory.mjs（live 路径 `~/.dsh/.agent-presets/autonomous/agent.cordis.yml` 与 `~/.dsh/profiles/web/*.mjs` 均为部署真源，repo 字节一致） | PASS |
| settings.yaml 无明文 apiKey | apiKey 相关行=14；plaintext suspects=0；9 个 apiKeyEnv 名全部命中 .credentials.yaml 同名 refs（9/9 同源链） | PASS |
| YAML 有效性 | settings.yaml VALID(Object)；cordis.patch.yml VALID(Array)；cordis.yml VALID(Array)；agent.cordis.yml 含 DSH 自定义 `!js` tag（服务正常装载，属预期） | PASS |
| guardian 活性 | guardian 进程=3；guardian.log age=0.5min（fresh<15min）；keep-awake heartbeats(last60m)=60；restart-events(last24h)=4；stale-session(last24h)=0；lastgood-restores(last24h)=1；**零 quarantine、零 unexpected rollback** | PASS |
| 凭据 DACL | .credentials.yaml ACL：SYSTEM(F)/Administrators(F)/Administrator(F)/CodexSandboxUsers(RX)；值从未读取/输出 | PASS |
| repo+worktree secret scan | repo worktree=285 文件 + live-deploy=71 文件；11 处 sanctioned NOTION_TOKEN env 行（结构豁免）；**non-exempt hits=0** | PASS |
| T15 契约 | preflight 6/6（override 同源、starter 单次 resolve）+ goal-recovery 4/4（once-per-boot、原子 marker persist） | PASS |
| kill-injection / restore-owner | 生产调用=0；archive 存在（docs/archive/coldstart-restore-owner.ps1）；引用仅 doc/test | PASS |
| coldstart A5 fail-closed | coldstart-gate-worker.ps1 L297 init=false / L305 set=true / L306 catch→fatal / L309 FAIL-CLOSED gate（ColdStart 凭据门禁 fail-closed；CM 插件 fail-open 属不同组件设计，均正确） | PASS |
| settings.yaml snapshot 演进 | cordis.patch.yml snap=28d115ec4acd8bae cur=同 → eq=true；settings.yaml snap=88d53d7918acb711 cur=09655e5ae2db73f9 eq=false（模型配置演进，restoreSafe(backups)=true，guardian-lastgood 为恢复基线非活镜像） | PASS（合法演进） |
| 状态真源 | CURRENT_STATUS L13：02.5 = `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`（Waiting For=External Review Round 8）；无 VERIFIED 越权标记 | PASS |

---

## 3. Completion Quality V5 关键字段（与 V4 对照）

| 字段 | V4（Round 7 产物，历史保留） | V5（Round 8 修复） |
|---|---|---|
| verdict 机制 | echoExcluded incident per-1k 自动规则（ON 0 ≤ OFF 0 × 2） | **task-quality 事实裁决**；禁止 rate/score 自动 verdict |
| 四会话任务质量 | 固定字段表（17 项，多数 N/A） | taskType/acceptance/verifier/finalOutcome 归因（依据既有 report/PR/CI/verifier） |
| 80 raw 命中（a144fe3f） | 回声分析（V4） | 不作为降级证据（事件类型无法证明非真实；review-echo 属性） |
| fallback | — | Reviewer 若要求严格 acceptance 回放 → INCONCLUSIVE；登记册 #5 开放 |

---

## 4. 治理与边界声明

- 本报告为**证据收口**（docs/evidence + 本报告 + CURRENT_STATUS 状态行 + Notion 02.5 页同步），
  无生产代码/配置改动；未重启服务；零中断。
- 未重跑已 ACCEPTED 的 Gate7 四腿 / kill-switch / provider switch / token A/B；未重设计 CM；未开 SH-R10。
- 状态维持 **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**；Waiting For=**External Review Round 8 的重新审核**。
- Registry #5（独立评测体系）保持开放，不由本代理 gate 关闭。
- 同步动作（待执行）：Notion 02.5 页追加本 R5.1-D 段；CURRENT_STATUS 追加本收口行；入库建议走
  `fix/context-memory-r5-1-d-final-truth-closure` 分支 + PR（遵循 R5.1-B/C 先例；若按先例直推 main 需在报告中如实登记偏差）。

---

## 5. 本报告自审

- 是否重复？复用 V4 生成器（原样复跑），未新建生成器。✅
- 是否造第二套评测系统？否；verdict 由已有事实裁决，登记册 #5 维持开放。✅
- 是否越权？未标 VERIFIED；未改生产；状态由 AWAITING_REVIEW 维持。✅
- 未完成项：Notion 02.5 页同步 + git 入库（见 §4，属收口链下一步）。

*End of R5_1_D_FINAL_TRUTH_CLOSURE.md*
