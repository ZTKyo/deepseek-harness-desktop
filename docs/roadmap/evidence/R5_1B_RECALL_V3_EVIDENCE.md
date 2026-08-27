# R5.1-B — Recall 5 类代表制精确门（Round 6 合同）证据载体

**单一事实载体**（SINGLE SOURCE OF TRUTH）— 本文件 + 同目录 `R5_RECALL5_EXACT_V3.json`。
日期：2026-08-27 ｜ 状态：未改任何生产插件代码，零重启，全程只读扫描。

## 0. Round 6 合同要点（本门解决的问题）

External Review Round 6 对 v2 双门精确门的两条合同修正：

1. **BLOCKER 1（C2 ORIGINAL_ERROR_RECORD）**：允许**跨真实 Session 选代表样本**。
   v2 在活体主 store（session-34e86c7a，v329）如实报 `FAIL_claim_lacks_error_evidence`
   ——其 blockers[0] 是一份 Temp 目录清单（无错误措辞），语义门把它当真阳性拦下，判定正确。
   Round 6 授权：从**另一条真实生产 store** 取合法 error-backed claim 作代表，
   **不需要改 production、不触发 PROVENANCE_GAP**。
2. **C4 PATCH_FILE_EVIDENCE**：要求「≥1 条严格合法的真实代表 PASS」，噪声（todo-receipt）
   **单独诊断为 HARDENING_DEBT**，不再拖垮整类。

## 1. 全库普查（只读；%LOCALAPPDATA%\DSHHarness\state\context-memory，5 个真实 store）

扫描器：`_r51-work/c2-global-scan.mjs`（结构严格验证 `resolveClaim` + ERROR_RECORD 语义门 +
错误族分类，零写入；报告 `_r51-work/c2-scan-report.json`）。

| store（sessionId 前缀） | ver | active | ERROR_RECORD claims | 合法 C2 | 代表 ref → raw 错误证据 |
|---|---|---|---|---|---|
| 34e86c7a（主载体） | 329 | true | 1 | ⛔ 0 | blockers[0]=Temp 目录清单，语义门正确驳回（FAIL_claim_lacks_error_evidence） |
| 5cd0722e | 6 | false | 2 | ✅ 2 | refs=59271 → `[stderr] fatal: not a git repository`（tool/result） |
| a144fe3f | 7 | false | 1 | ✅ 1 | refs=102834 → `[stderr] Error formatting a string: Input string was not in a correct format`（tool/result） |
| ad148b88 | 12 | true | 1 | ✅ 1 | refs=131416 → `Error: cannot edit "C:\...\_release-staging\docs...`（tool/result） |
| c4cc512e | 2 | false | 1 | ✅ 1 | refs=52405 → `Error: tool call timed out after 60000ms`（tool/result） |

**结论：4/5 真实 store 已存在合法 error-backed claim（claim→own ref→raw error 全链可回源）。**
另：每个会话 raw log 均有大量真实错误事件（如主会话 PROTO 族 12 / TIMEOUT 216 / TOOL 122 等），
证明「错误真实存在、仅投影层缺采集」并非事实——投影层在真实会话中确有 ERROR_RECORD 记录。

**C2 代表选定**：`c4cc512e` blockers[0]（timeout，结构最干净、与 R4 时代 ①REAL 5 类回源同族）。
其余三条作为候补代表记录在上表，任一可复核复跑。

## 2. V3 门实现与 verdict

生成器：`evidence/make-r5-recall5-exact-v3.mjs`
（复用同一单源：`cm-r5-recall-verifier-snapshot.mjs` 严格原语 + v2 `semanticGateAll` 语义门，
import 复用、零复制粘贴；fixtures 由既有 `cm-r5-make-live-fixtures.mjs` 只读解码）。

输入指纹（sha256 前 16）：
- main：store `6f6057bd8b34fd72`（v329 active=true）／events `ea1b283e6490416e`（25729 事件）
- c2 代表源：store `1fcf4f8bab130431`（v2 active=false）／events `be7501105f731f84`（2637 事件）
- 主 raw log：`~/.dsh/sessions/--C-Users-Administrator-Desktop-sdeepseek~0020harness--/session-34e86c7a-…/session.jsonl.zstd`

**verdict = `5/5 REPRESENTATIVE PASS`（ok=true, EXIT=0）**：

| class | verdict | 代表样本 | strict | semantic |
|---|---|---|---|---|
| C1 USER_ORIGINAL_WORDING | PASS | goal（main store） | PASS_refs_exact | PASS_direct_user_wording |
| C2 ORIGINAL_ERROR_RECORD | **PASS（跨会话）** | c4cc512e blockers[0] refs=[52405] matchedSeq=52405 evt=tool/result「Error: tool call timed out after 60000ms」 | PASS_refs_exact | PASS_all_refs_semantic_clear |
| C3 TOOL_RUNTIME_EVIDENCE | PASS | newest-3 completedActions/runtimeFacts/verifiedEvidence（main） | ≥1 全通过 | PASS |
| C4 PATCH_FILE_EVIDENCE | **PASS（noise 隔离）** | keyFileChanges[22] `<path>C:\...\_release-staging\docs\...` + Created 回执 | PASS | PASS |
| C5 TIMELINE_SIDE_EFFECT | PASS | before=1012213 < target=1027575 < after=1029605（raw 事件号，dups=0）+ timeline monotonic/watermarked | PASS | PASS |

**C4 noise 诊断（单独列示，不判类失败）**：noiseCount=2，均为 todo-receipt 投影
（`FAIL_false_file_evidence_todo_noise`），与 v2 双门真阳性结论一致（登记册 #8 不变：
插件分类策略修订不在本轮授权，HARDENING_DEBT）。

## 3. 合同符合性小结

- C2：跨会话代表 = Round 6 明文授权；代表 claim/refs/matchedSeq/eventType 全部来自真实
  production store 与真实 raw 会话日志（c4cc512e），结构严格 + 语义门双通过。
- C4：representative PASS + noiseExamplesSanitized（脱敏）+ noiseVerdict=HARDENING_DEBT 分离。
- C1/C3/C5：维持 Round 6 已认可状态，逻辑未改动。
- verdict 字段：每类输出 class/sourceSessionId/claimPath/claim 指纹/refs/matchedSeq/eventType/
  semanticType/strictSourceResult/semanticResult/representativeResult（artifact 内逐条可查）。
- **未改生产插件代码；未触发 PROVENANCE_GAP；零重启。**

## 4. 复跑方式（可重现命令）

```bash
node docs/roadmap/evidence/cm-r5-make-live-fixtures.mjs \
  <34e86c7a session.jsonl.zstd> <stateDir>/session-34e86c7a-….json \
  plugins/context-memory-core.mjs <out>/main
node docs/roadmap/evidence/cm-r5-make-live-fixtures.mjs \
  <c4cc512e session.jsonl.zstd> <stateDir>/session-c4cc512e-….json \
  plugins/context-memory-core.mjs <out>/c2src
node docs/roadmap/evidence/make-r5-recall5-exact-v3.mjs \
  <out>/main/live-events.json <out>/main/live-store.json \
  <out>/c2src/live-events.json <out>/c2src/live-store.json \
  plugins/context-memory-core.mjs <out>
# 期望：verdictSummary=5/5 REPRESENTATIVE PASS，EXIT=0
```
