# P3 AUTONOMY R1 Correction — 宿主侧确定性证据复核（AC5 / 外审 Round 1 Blocker F1 修复）

日期：2026-08-30　分支：`p3-autonomy-r1-correction`　前置：REPORT_R1（P3 AUTONOMY R1）

## 1. 背景与 Blocker

外审 Round 1 在 R1 的真实 E2E 中发现 **F1（fabricated-evidence acceptance）**：
`autonomy_verify` 完全信任模型自述的证据字符串——模型可以对**不存在的文件**编造
"pwsh 输出显示哈希一致"式的 PASS 证据，直接把 criterion 升级 PASS、写入里程碑与
checkpoint，进而把整个任务推到 `verificationState=VERIFIED`。这违反了 autonomy
体系的立约前提：**验证必须是宿主侧可独立复核的事实，而不是模型的一句话**。
E2E 脚本在 R1 运行时已把 F1 标注为 R2 候选修复项；本 Correction 轮提前闭环。

## 2. 方案：机读证据规范 + 宿主确定性复核门禁（fail-closed）

**证据规范**（仅两类 PASS 证据设闸，其余类不设闸）：

| evidenceClass | 规范格式 | 宿主复核动作 |
|---|---|---|
| `file_hash` | `file:<绝对路径>\|sha256:<64位hex>\|[自由文本 note]` | 读真实文件 → sha256 → 与声称值比对 |
| `system_api` | `api:port=<1-65535>\|path=/<路径>\|expectStatus=<100-599>[&expectContains=<串>][&note]` | 对 127.0.0.1:port 发真实 GET → 比对状态码与响应包含 |

**复核语义（核心不变量）**：
- PASS + file_hash/system_api → **必须先过宿主复核**：通过 → 证据记录加 `HOST-VERIFIED (…)` 前缀照常升级；不通过 → **fail-closed 降级 UNVERIFIED**（不计 PASS、不建里程碑、不写 checkpoint），证据记录保留真实失败原因：`HOST-VERIFY FAILED (<reason>): …`（reason ∈ format_invalid / file_missing / hash_mismatch / request_failed / status_mismatch / contains_mismatch / class_not_host_verifiable）。
- 状态列即实际宿主复核结论；PASS 记录的 file_hash/system_api ⇒ 宿主已复核成功。
- **FAIL / UNVERIFIED 方向不设闸**：它们只会阻断 VERIFIED，不存在升级风险，照单记录。
- **其余证据类不设闸**（git / browser_state / screenshot / ai_judgment）：本设计把"可机读复核"的类收敛到能确定性复核的两类；其余类保持 R1 语义，避免把门禁扩成"什么都验不了就什么都拒绝"的假安全。哈希比对/HTTP 断言之外的场景（截图、git 历史）宿主复核属 R2+ 范畴。
- 复核器 `hostVerifyEvidence()` 走注入 io（readFile/sha256Hex/fetch），核心层零副作用、可单测；生产 io 用 node:crypto + 全局 fetch。
- 降级路径诊断日志：`AUTONOMY-VERIFY sid=… status=UNVERIFIED claimed=PASS … hostVerify=<reason>`。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `plugins/autonomy-state-core.mjs`（新增至 v3 core 的部分） | `HOST_VERIFIABLE_CLASSES`、`parseFileHashEvidence()`、`parseSystemApiEvidence()`（严格段解析：未知 key 拒、重复 key 拒、非 key=value 尾段视作 note）、`hostVerifyEvidence()`（注入 io、fail-closed） |
| `plugins/execution-continuity.mjs` | `autonomy_verify` execute：PASS + host-verifiable 类先复核再入账（降级/前缀逻辑），diag 扩展 `claimed=`/`hostVerify=` 字段 |
| `tests/autonomy/test-autonomy-state-core.mjs` | C11/C11b/C12：解析器正反样例、复核器注入 io 全路径（match/mismatch/missing/format/unreachable/refuse） |
| `tests/autonomy/test-ec-autonomy-deployed.mjs` | I5 改用 git 证据；新增 I10（伪造 file_hash fail-closed）I11（真实文件 PASS）I12（prose 拒）I13（真实回环 API 三态）I14（FAIL 方向不设闸）I15（ai_judgment 不受影响） |

## 4. 验证证据（全部真实运行，2026-08-30）

| 层 | 测试 | 结果 |
|---|---|---|
| core 纯逻辑 | test-autonomy-state-core.mjs | **86 PASS / 0 FAIL**（新增 25 项：C11/C11b/C12） |
| 已部署面（profile 文件直连） | test-ec-autonomy-deployed.mjs | **52 PASS / 0 FAIL**（新增 I10-I15） |
| 真实 Runtime E2E（隔离实例×4，真实模型） | run-autonomy-real-e2e.mjs（E1,E2,E2B,E3） | **32 PASS / 0 FAIL**：E1 8/0、E2 9/0、E2B 7/0、E3 8/0 |
| EC 回归 | tests/continuity/*.mjs ×15 | 全部 exit 0（RESULT 行合计 55 PASS / 0 FAIL） |
| EC 相关 reliability | completion-truth / ec-router-bridge / resume-defer / r5-addendum / r5-runtime-truth | 全部 exit 0 |

E2E 证据：`docs/roadmap/reports/PHASE_03_AUTONOMY/e2e/E{1,2,2B,3}-2026-08-30T05-36-49.json`。
R1 时的 `[FINDING F1]`（伪造证据可升级）在本轮宿主复核落地后，其全部条件断言通过。

**已知无关失败（pre-existing，非本轮引入）**：`verify-r2-restart-recovery.mjs` 30 PASS / 6 FAIL——6 个 FAIL 全部来自 `install-plugin --check` 对 10 个 profile 部署漂移插件的校验（repo 侧 08-23~08-29 更新未同步，早于 R1）；本轮部署的 execution-continuity.mjs 校验 ✓ 一致。详见 KNOWN_ISSUES.md 2026-08-30 条目。

## 5. 部署与回滚

- 已部署：`~/.dsh/profiles/web/execution-continuity.mjs` + `autonomy-state-core.mjs`（sha256 与 repo 一致，2026-08-30 13:25）。
- 回滚锚点：`~/.dsh/profiles/web/_pre-p3r1c-20260830-132546-*.mjs.bak`（两文件各一份）+ git 分支。
- **生效条件**：运行中的 3080 服务仍在用旧版（内存态）；需一次服务重启后新逻辑才对生产会话生效（攒批中，见 §7）。

## 6. 设计边界（明示不覆盖项）

- file_hash 规范要求绝对路径：模型只能对宿主可达的文件声称哈希；相对路径/prose 一律 format_invalid 拒绝。
- system_api 限定 `127.0.0.1` 回环 + 显式端口：复核动作本身不产生外呼风险。
- expectContains 为子串匹配（非正则），保持确定性。
- 里程碑/证据长度沿用现有 sanitize 上限（300/500 字符截断）。

## 7. 遗留与后续

1. **主服务重启**（待用户确认时机）：重启后新 verify 门禁对生产会话生效；重启前生产行为与 R1 相同。
2. **部署漂移专项**（KNOWN_ISSUES 2026-08-30）：10 个插件 profile 位落后 repo，建议择机 `install-plugin` 同步 + 重启（独立变更，须用户确认）。
3. **install-plugin 挂载清单**：建议把 `autonomy-state-core.mjs` 加入 cordis.patch.yml 挂载（配置变更 + 重启生效，故本轮未动，当前靠手动 copy + 哈希校验）。
4. R2 候选：git/browser_state/screenshot 类证据的宿主复核。
