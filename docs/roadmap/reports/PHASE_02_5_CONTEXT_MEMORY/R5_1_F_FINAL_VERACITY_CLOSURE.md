# P2.5 R5.1-F FINAL VERACITY CLOSURE — External Review Round 9 三个 blocker 最小事实收口（2026-08-28）

> 单一事实载体：`docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/R5_1_F_FINAL_VERACITY_CLOSURE.md`
> 范围：**只**处理 External Review Round 9（REVIEW_REQUIRED / P2.5 BLOCKED）三个 blocker 的最小事实收口：
> A. Completion Quality V5 与 V4 fixed-field 数据冲突；B. SH-R9 posture 缺三组机器字段/证据；
> C. Notion 02.5 页 canonical 前向路线 stale。
> 不改 §0–§19 已载结论；不改任何生产代码/配置；未重设计 Context Memory；未建第二套评测系统；未开 SH-R10。
> 状态维持 **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**，等待 **External Review Round 10 的重新审核**（本报告为 R9 修复轮交付物）。
> **后续（2026-08-28）**：External Review **Round 10 = APPROVED**（PURE STATUS BACKFILL 已执行；
> P2.5 → **VERIFIED**，见 CURRENT_STATUS 变更日志 + REPORT_R5 §23）；本报告仅追加 verdict pointer，
> 不改历史 evidence。

---

## 1. 三个 blocker 与事实裁定（结果在最前）

| Blocker | Round 9 批评 | 本轮最小收口裁定 | 载体 |
|---|---|---|---|
| **A. Completion Quality V5 与 V4 数据冲突** | V5 声称四会话 `toolErrors=0 / llmRetries=0 / userContinue=0`，与已审核 V4 fixed-field 数据冲突（V4 实际 toolErrors=355/40/111/19、llmRetries=52/2/126/26、userContinue=111/7/74/11） | **已纠正 → verdict=INCONCLUSIVE**：V6 逐会话把 V5 误写的 0 纠正为 V4 真实值（定义/note 原样保留）；不再宣称四会话 error/retry/continue=0；不再声明 NO MATERIAL REGRESSION。既有 report/PR/CI 仅证明阶段最终 COMPLETED + 回证链，但按 Round 9 合同（禁重扫日志、禁新 evaluator、禁新 rate/score）无法用现有事实严格排除 CM 与执行期错误的 material 关联 → **最终 verdict 必须 INCONCLUSIVE** | `evidence/r5-completion-quality-v6-20260828-r9c/R5_COMPLETION_QUALITY_V6.json` |
| **B. SH-R9 posture 缺三组机器字段/证据** | V5 的 guardian 活性/restore、凭据同源、配置身份缺机器可回证字段 | **已补全 16/16 PASS + 三组机器字段**：(1) guardian.log 全史 9546 行扫描——lastgood restore 3 次全部带时间戳（08-24 settings / 08-26 cordis / 08-27 18:49:19 cordis.patch.yml INVALID→mirror restore，均属预期 CONFIG SAFETY 恢复）；**stale-lastgood-rollback=0、unexpected-rollback=0、quarantine=0、failed-guardian-cycles=0**；restart-24h=4、stale-24h=0、lastgood-restores-24h=1；guardian 进程 3（PID 5068/4988/24004）。(2) 凭据同源：effective=preflight=runtime 实际读取路径全部 `C:\Users\Administrator\.dsh\.credentials.yaml`（sha16=`4E7C2041133E5FB4`）；DSH_CREDENTIALS_PATH 未设置→resolver 默认同源；值未读取。(3) 配置身份：cordis.patch.yml live==lastgood `28D115EC4ACD8BAE` eq=true；settings.yaml live `09655E5AE2DB73F9`≠lastgood `88D53D7918ACB711`（合法演进，restoreSafe(backups)=true，V5 EXT-7 已判） | `evidence/r5-sh9-posture-v6-20260828-r9c/R5_SH9_POSTURE_V6.json` |
| **C. Notion 02.5 页 canonical 前向路线 stale** | 02.5 页残留 `P3 AUTONOMY：BLOCKED BY P2.5 REVIEW` 与 `Waiting For: External Review Round 6`，与 2026-08-27 canonical 路线（02.5→02.6→02.75→P3）冲突 | **已修正**：patch `4bcdd4b0` → `P2.6 BLOCKED BY P2.5 REVIEW / P2.75 BLOCKED BY P2.6 / P3 BLOCKED BY P2.75`；patch `41e27d89` → `当前 Waiting For = External Review Round 10（R5.1-F 已提交）`；页尾追加 R5.1-F 状态段 | Notion 02.5 页（blocks `4bcdd4b0` / `41e27d89`） |

---

## 2. 本轮 LIVE 复核证据（2026-08-28 03:56 CST 现场）

### A. Completion Quality V6 真值对照（V4 已知值，V5 曾误写 0）

| session | era | toolErrors | providerErrors | llmRetries | userContinue | incidents(proto/quota) |
|---|---|---|---|---|---|---|
| 9e3b29bb… | OFF | **355** | T26/R1/TO22/S3 | **52** | **111** | 0 / 0 |
| 11c7aa70… | OFF | **40** | T2 | **2** | **7** | 0 / 0 |
| 34e86c7a… | ON | **111** | R73/T13/TO40 | **126** | **74** | 0 / 0 |
| a144fe3f… | ON | **19** | TO3/S23 | **26** | **11** | 41 / 39（审查回声，V4 已裁不采） |

- V6 仅纠正 V5 误写的 0 → V4 真实值；V4 定义/note 原样保留；未重扫日志、未新算 rate/score。
- verdict=**INCONCLUSIVE**（Round 9 合同约束下，现有事实无法严格排除 material regression；不再声明 NO MATERIAL REGRESSION）。
- 诚实声明：acceptance 逐项回放、false-completion 独立判定、manual-intervention 区分仍 N/A；登记册 #5 维持开放。

### B. SH-R9 posture V6 三组机器字段

| 事实组 | 实测值 | 判定 |
|---|---|---|
| guardian restore 全史 | guardian.log 9546 行扫描：lastgood restore 3 次（2026-08-24 01:40:18 settings INVALID / 2026-08-26 17:20:47 cordis.patch INVALID / 2026-08-27 18:49:19 cordis.patch.yml INVALID），全部为 CONFIG SAFETY mirror restore（预期） | PASS |
| guardian 健康计数 | stale-lastgood-rollback=0；unexpected-rollback=0；quarantined=0；failed-guardian-cycles=0；restart-events(24h)=4；stale-session(24h)=0；lastgood-restores(24h)=1 | PASS |
| guardian 活性 | 进程 3（PID 5068/4988/24004，CommandLine 含 dsh-guardian）；guardian.log age=0.5min（fresh<15min） | PASS |
| 凭据同源链 | effective=preflight=runtime 实际读取路径全 = `C:\Users\Administrator\.dsh\.credentials.yaml`（sha16=`4E7C2041133E5FB4`）；DSH_CREDENTIALS_PATH env 未设置 → Get-DshCredentialsPath 默认路径；Get-DshCredentialRefValue 同路径；值未读取/未输出 | PASS |
| 配置身份 | cordis.patch.yml live `28D115EC4ACD8BAE` == lastgood `28D115EC4ACD8BAE` eq=true；settings.yaml live `09655E5AE2DB73F9` ≠ lastgood `88D53D7918ACB711`（模型配置合法演进，restoreSafe(backups)=true） | PASS（合法演进） |
| V5 frozen 16 项 | items 1-9 + EXT-1..7 原样冻结，断言零改动 | PASS 16/16 |

### C. Notion 02.5 页 canonical 修正

- `4bcdd4b0`（P3 AUTONOMY：BLOCKED BY P2.5 REVIEW）→ `P2.6 BLOCKED BY P2.5 REVIEW / P2.75 BLOCKED BY P2.6 / P3 BLOCKED BY P2.75`（与 Master 页 2026-08-27 路线 02.6→02.75→03 及 CURRENT_STATUS L14-L16 同口径）。
- `41e27d89`（Waiting For: External Review Round 6）→ `当前 Waiting For = External Review Round 10（R5.1-F 已提交）`。
- 页尾追加 R5.1-F 段（本报告摘要 + 状态维持 AWAITING_REVIEW）。

---

## 3. 治理与边界声明

- 本报告为**证据收口**（docs/evidence V6 ×2 + 本报告 + CURRENT_STATUS 状态行 + Notion 02.5 页同步），
  无生产代码/配置改动；未重启服务；零中断。
- 未重跑已 ACCEPTED 的 Gate7 四腿 / kill-switch / provider switch / token A/B；未重设计 CM；未开 SH-R10；
  未新写任何 evaluator / metric / rate / score；未重扫 session 日志。
- 状态维持 **IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**；Waiting For=**External Review Round 10 的重新审核**。
- Registry #5（独立评测体系）保持开放，不由本代理 gate 关闭。
- 同步动作（已执行）：Notion 02.5 页 patch + 追加段；CURRENT_STATUS 追加 R5.1-F 行；
  入库建议走 `fix/context-memory-r5-1-f-final-veracity-closure` 分支 + PR（遵循 R5.1-B/C/D/E 先例）。

---

## 4. 本报告自审

- 是否造第二套评测系统？否；V6 仅纠正既有 V4 数据冲突，未新增 metric/evaluator。✅
- 是否诚实？V5 与 V4 冲突数字已逐会话纠正，verdict 按 Round 9 合同改 INCONCLUSIVE，不再粉饰。✅
- 是否越权？未标 VERIFIED；未改生产；状态由 AWAITING_REVIEW 维持。✅
- 未完成项：Notion 02.5 页同步 + git 入库（见 §3，属收口链下一步）。

*End of R5_1_F_FINAL_VERACITY_CLOSURE.md*
