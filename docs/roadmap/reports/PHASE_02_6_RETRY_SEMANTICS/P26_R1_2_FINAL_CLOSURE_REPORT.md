# P2.6 R1.2 — quota no-alternative → zero blind retry（Reviewer Blocker 2）最终收口报告

日期：2026-08-29
会话：session-a144fe3f
状态：**IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW ROUND 3**（R1 + R1.1 + R2 + R3 + R3-A1 + R1.2 全量合入 canonical main 并事务化部署到运行 profile + 受控重启加载；禁止自标 VERIFIED/APPROVED，等待 External Reviewer Round 3）

---

## 1. 背景与目标（Reviewer Blocker 2）

R1/R1.1/R2 已覆盖：1310→QUOTA_EXHAUSTED 不可重试 + unavailableUntil defer 预算、
commandcode 与 direct managed provider（zhipu/bai）配额耗尽跨 provider 改写 openrouter。
但存在一个残余盲点：**当配额耗尽的 provider/model 是唯一候选**（回退链中不存在不同
model id）时，Router 的 agent/request 改写无法离开已耗尽的配额池。此场景下旧行为是：
EC 在 backoff sleep 后仍发出 **1 次盲重试**（对已耗尽配额池的无谓命中），然后才 defer。

**R1.2 目标（Blocker 2）**：把该残余 1 次盲重试归零——quota 无替代时，EC 在同一
request-error pass 直接 defer（WAITING_PROVIDER），零盲打。

---

## 2. 交付物（全部已合入 canonical main，commit `5eff17a`）

| 文件 | 类型 | 说明 |
|---|---|---|
| `plugins/execution-continuity.mjs` | 修改（+64/−16） | 消费 `ec/quota-no-alternative` 一次性 `routerNoAlternative` 标志；同 pass 改 defer（WAITING_PROVIDER，unavailableUntil-exact 或 bounded），不再返回 `{kind:"retry"}` |
| `plugins/openrouter-router.mjs` | 修改（+32） | 每次 agent/request 决策记录 `lastChainIds`；收到 quota recovery-requirement 时用与 `pickQuotaRouteTarget` 相同语义做静态 no-alternative 判断并同步发出 `ec/quota-no-alternative`；agent/request 的 openrouter chain-exhausted 与 cross-provider no-target 分支也补发 receipt |
| `KNOWN_ISSUES.md` | 修改（+30） | 记录 no-alternative 语义与已知限制 |
| `tests/continuity/verify-p26-r1-2-quota-no-alternative.mjs` | 新增（155 行） | R1.2 验证套件（10 断言，V1 static no-alt / V2 alt-exists 回归 / V3 cross-provider 回归 / V4 late receipt） |

Commit 证据：`git show --stat 5eff17a`（见 §20 命令清单）。

---

## 3. 语义契约（EC request-error 返回值）

- EC request-error **返回 `null`** = 本 pass defer（WAITING_PROVIDER）。
- **返回 `{kind:"retry"}`** = 请求重试。
- R1.2 断言"no retry" == `(action == null || action.kind !== "retry")`。
- R1.2 保证：收到 `ec/quota-no-alternative` 的同一 request-error pass，EC 直接 defer，
  不 sleep、不盲打、不返回 retry。

---

## 4. 测试证据（全部本地实测，2026-08-29 部署后复跑）

| 套件 | 断言 | 结果 |
|---|---|---|
| `verify-p26-r1-2-quota-no-alternative.mjs`（R1.2） | 10/10 | PASS（V1 静态无替代 defer、V2 有替代回归、V3 跨 provider 回归、V4 late receipt） |
| `verify-p26-r1-quota-defer.mjs`（R1） | 18/18 | PASS |
| `verify-p26-r1-1-managed-direct-quota.mjs`（R1.1） | 15/15 | PASS |
| `verify-p26-r1-2-quota-no-alternative.mjs`（R1.2） | 10/10 | PASS（如上） |
| `verify-p26-r1-network-error.mjs`（R1） | 20/20 | PASS |
| `verify-p26-r1-rollback-switch.mjs`（R1） | ALL PASS | PASS |
| `verify-p26-r2-commandcode-quota.mjs`（R2） | 9/9 | PASS |
| `verify-p26-r3-retry-policy.mjs`（R3） | 41/41 | PASS |
| `verify-p26-r3-a1-official-retry-zero.mjs`（R3-A1） | 9/9 | PASS |

**合计 122 断言 0 fail**（部署后复跑，脚本 `node --no-warnings` 直接运行，exit=0）。

---

## 5. 部署与加载（本报告最重要的新增证据链）

R1.1 报告 §46-56 如实记录了"R1.1/R2/R3 尚未部署到运行 profile"的漂移。**本轮已闭环**：

1. **Canonical 确认**：`origin/main` = `f0a6c47`（Merge pull request #60，
   mergedAt=2026-08-28T16:50:47Z）；`git merge-base --is-ancestor 5eff17a origin/main` = YES；
   `git diff f0a6c47 5eff17a` = 空 → **R1.2（含 R1.1/R2/R3/R3-A1 全部前序改动）已在 main**。
2. **事务化部署**：将 main 版三个插件字节精确写入运行 profile
   `~/.dsh/profiles/web/`（`execution-continuity.mjs` / `failure-classifier-core.mjs` /
   `openrouter-router.mjs`），用 cmd 原生重定向保证字节精确（此前 `Set-Content -Encoding Byte`
   管道写坏为空文件，已废弃该写法）。
3. **Attestation（source==deployed==loaded）**：
   - deployed 文件 `git hash-object` == canonical `git rev-parse origin/main:plugins/<f>`（三个均一致）：
     - `execution-continuity.mjs` → `8a9950c13a`
     - `failure-classifier-core.mjs` → `d4631cc6c5`
     - `openrouter-router.mjs` → `c96a4d88be`
   - workspace 副本亦 == source（三方统一）。
4. **受控重启加载**：`restart-dsh-server-delayed.ps1 -RestartAndWait`（Detach 模式，Reason
   "P2.6 R1.2 deploy"）→ 新服务进程 pid=24372（launcher 23896）监听 3080；
   服务日志 `dsh-server-3080.log` 出现 boot-time 证据行：
   `[failure-classifier] armed (P2.6 R1 observation plugin loaded; boot-time evidence line)`
   → **新插件已被运行中服务实际加载**。
5. **Runtime health**：HTTP GET `http://127.0.0.1:3080/` = **200**；日志尾部无致命错误。
6. 重启过程被中断过一次（turn 中断），已按"先验证外部状态再继续"复核：服务确实由新进程
   接管、端口就绪、loaded 证据行在位，确认完成，未重复执行副作用动作。

---

## 6. 验证证据分类（REAL / CONTROLLED / SYNTHETIC / INFERRED）

沿用 R1/R1.1 报告的标注体系，本报告 20 项证据清单如下：

| # | 证据 | 类型 | 说明 |
|---|---|---|---|
| E1 | `verify-p26-r1-2-quota-no-alternative.mjs` 10/10 PASS | CONTROLLED + SYNTHETIC | 受控注入 quota requirement + 无替代链；夹具 provider/model 名为合成路由目标 |
| E2 | `verify-p26-r1-quota-defer.mjs` 18/18 PASS | CONTROLLED | R1 Retry-After 延迟 + 预算回归 |
| E3 | `verify-p26-r1-1-managed-direct-quota.mjs` 15/15 PASS | CONTROLLED | R1.1 direct managed provider 回归 |
| E4 | `verify-p26-r1-network-error.mjs` 20/20 PASS | CONTROLLED | R1 stream/network 分类回归 |
| E5 | `verify-p26-r1-rollback-switch.mjs` ALL PASS | CONTROLLED | 单开关回滚语义回归 |
| E6 | `verify-p26-r2-commandcode-quota.mjs` 9/9 PASS | CONTROLLED | R2 commandcode 分支回归 |
| E7 | `verify-p26-r3-retry-policy.mjs` 41/41 PASS | CONTROLLED | R3 RATE_LIMIT-free retry policy 回归 |
| E8 | `verify-p26-r3-a1-official-retry-zero.mjs` 9/9 PASS | CONTROLLED | R3-A1 官方 retry 中间件 1310 same-provider retry=0（含 V2 负对照） |
| E9 | 合计 122 断言 0 fail（部署后复跑） | CONTROLLED | 全部套件退出码 0 |
| E10 | `git show --stat 5eff17a`：EC +64/−16、Router +32、KNOWN_ISSUES +30、新测试 155 行 | REAL | commit 本体 |
| E11 | `origin/main`=`f0a6c47`（PR #60 MERGED，mergedAt 2026-08-28T16:50:47Z） | REAL | GitHub API / gh CLI 实测 |
| E12 | `git merge-base --is-ancestor 5eff17a origin/main` = YES；`git diff f0a6c47 5eff17a` = 空 | REAL | R1.2 已合入 canonical main |
| E13 | deployed profile 三个插件 `git hash-object` == canonical blob id（8a9950c1/d4631cc6/c96a4d88） | REAL | source==deployed 字节一致 |
| E14 | 新服务进程 pid=24372 监听 3080；启动时间 2026-08-29 01:02:30 | REAL | `Get-NetTCPConnection` / Win32_Process 实测 |
| E15 | 服务日志 boot 证据行 `[failure-classifier] armed (P2.6 R1 observation plugin loaded)` 位于新启动段 | REAL | loaded 的直接证据 |
| E16 | HTTP `http://127.0.0.1:3080/` = 200（len=15017） | REAL | runtime health |
| E17 | 部署字节精确（cmd 重定向 size==git blob size：87952/19462/32456） | REAL | 防止管道写坏（Set-Content -Encoding Byte 缺陷） |
| E18 | 重启脚本 Detach 模式（WMI 分离进程自持生命周期，maintenance lock 必释放） | REAL | `restart-dsh-server-delayed.ps1` 头部注释 + 日志记录 |
| E19 | 重启过程一次 turn 中断 → 复核外部状态确认完成（未重复副作用） | REAL | 恢复纪律证据（先验证再继续） |
| E20 | openrouter 与 direct managed provider 属不同配额池 | INFERRED | 依据 provider 池配置推断，无独立计量观测（如实标注，同 R1.1 E20） |

**合计 20 项**：REAL ×10（E10-E19）、CONTROLLED ×8（E1-E9，E1 兼 SYNTHETIC）、
SYNTHETIC ×1（E1 夹具）、INFERRED ×1（E20）。

---

## 7. 与既有架构关系（零第二引擎）

- **复用**：Router 沿用 `pickQuotaRouteTarget`（agent/request 同款语义）；EC 沿用既有
  retry budget / nextRetryAt / WAITING_PROVIDER defer / RECOVERY_QUEUED 冷却；classifier
  仍为 evidence-only 观测层（不改 payload.failure、不加会话事件、不重试、不选模型）。
- **新增**：仅 `lastChainIds` 决策记录 + 一次性 `routerNoAlternative` 标志消费。
- **不重复 Authority**：没有新建 watchdog / router / progress / recovery / quota 引擎。

---

## 8. 红线遵守

- classifier 未改 payload.failure、未新增会话事件、不重试、不选模型，异常全隔离，
  链路永远 next() 透传（R1 契约保持）。
- 一键回滚 = config `{ enabled: false }`（R1 rollback-switch 套件持续验证）。

---

## 9. 已知限制（KNOWN_ISSUES.md 同步）

- Router agent/request 路径存在 1 个 Socket 句柄惰性残留（R1 既有，非本次引入）；
  测试脚本顶层 `process.exit(0)` 规避；不影响运行中服务（进程常驻）。
- 工具管道 `2>&1` 会因 node stderr 警告造成伪超时，须 `node --no-warnings` 直接运行。

---

## 10. 部署备份

- 部署前已确认 profile 原始版本可恢复（R1 事务流程既有备份 `DSH-Client/_backup-p26-r2/`、
  R1.1 报告 §54 记录；本轮部署写入前未破坏原文件，可随时 git 恢复 canonical 字节）。
- 回滚 = `git revert 5eff17a`（+ 重新部署 profile + 重启）。

---

## 11. CI

- PR #60 合入时 CI L1/L2/L3 全绿（Context 记录 statusCheckRollup 显示通过后 MERGED）；
  本报告部署复跑本地全量 122/0。

---

## 12. 过程发现与处置

1. `Set-Content -Encoding Byte` 不接受管道文本 → 把文件写坏为空文件（sha256=E3B0C44... 空哈希）。
   改用 **cmd 原生重定向**（`cmd /c "git cat-file blob origin/main:plugins/<f> > file"`）保证字节
   精确，size 与 git blob 完全一致（87952/19462/32456）。
2. 重启命令在 turn 中被中断（服务重启切断 agent 所在服务链路）→ 未盲目重试，先
   `Get-NetTCPConnection`/`Win32_Process`/日志复核外部状态，确认新进程 24372 接管、端口 200、
   loaded 证据行在位后才判定完成。
3. Notion 02.6 页曾记录"PR #60 暂不合并保留 OPEN"——与事实不符（实际已 MERGED），
   本轮已在 CURRENT_STATUS.md 与 Notion 同步纠正（见 §13-14）。

---

## 13. 状态同步

- CURRENT_STATUS.md：02.6 状态行更新为
  `IMPLEMENTATION_COMPLETE（R1+R1.1+R2+R3+R3-A1+R1.2）/ AWAITING_EXTERNAL_REVIEW ROUND 3`，
  补充 R1.2 增量与部署/loaded 闭环记录；Waiting For = External Review Round 3（禁止自标 VERIFIED）。
- Notion 02.6 页面：状态与 PR #60 合并事实同步（见 §14）。

---

## 14. Notion 同步摘要

- 状态：`IMPLEMENTATION_COMPLETE（R1 + R1.1 + R2 + R3 + R3-A1 + R1.2）/ AWAITING_EXTERNAL_REVIEW ROUND 3`
- 纠正过时记录：PR #60 已 MERGED（`f0a6c47`，2026-08-28T16:50:47Z），R1.2（`5eff17a`）在 main。
- 新增：R1.2 交付摘要 + 部署/loaded attestation（source==deployed==loaded）+ 全量回归 122/0。
- 禁止事项不变：External Reviewer APPROVED 前禁止 VERIFIED；APPROVED 前不进入 Phase 02.75。

---

## 15. 结论

Reviewer Blocker 2 已闭环：quota 无替代时零盲重试（同 pass defer），R1.2 已合入 canonical
main 并**事务化部署到运行 profile + 受控重启加载**（source==deployed==loaded 三方一致），
全量回归 122 断言 0 fail。状态 = **IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW ROUND 3**，
等待 External Reviewer Round 3（禁止自标 VERIFIED/APPROVED）。

---

## 16. 后续（等待 External Review Round 3）

- [ ] External Reviewer Round 3 审核本报告 + R1.1 报告 + R1 报告（20 项证据）。
- [ ] APPROVED 后：02.6 状态由 Reviewer 授权 backfill 为 VERIFIED → Phase 02.75 SUPERVISOR 解锁。

---

## 17. 引用文件

- 本报告：`docs/roadmap/reports/PHASE_02_6_RETRY_SEMANTICS/P26_R1_2_FINAL_CLOSURE_REPORT.md`
- R1 报告：`P26_R1_FAILURE_TAXONOMY_REPORT.md`；R1.1 报告：`P26_R1_1_MANAGED_DIRECT_QUOTA_REPORT.md`
- 证据：`docs/roadmap/evidence/P26_R1_1_MANAGED_DIRECT_QUOTA_VERIFY.md`、
  `docs/roadmap/evidence/P26_R2_COMMANDCODE_QUOTA_VERIFY.md`、`docs/roadmap/evidence/P26A_HOTFIX_REPORT.md`
- 测试：`tests/continuity/verify-p26-*.mjs`（R1/R1.1/R1.2/R2/R3/R3-A1 全部）
- 状态：`docs/roadmap/CURRENT_STATUS.md`；Notion：`02.6｜RETRY SEMANTICS｜Provider Failure Classification`
  （page `3c9357fd-c5d6-81a3-9c35-e861263fdcbc`）

---

## 18. 时间线（本收口轮）

| 时间（2026-08-29 本地） | 动作 |
|---|---|
| 00:54 | 事务化部署三个插件字节到 profile（cmd 重定向，size==blob 87952/19462/32456） |
| 00:54 | Attestation source==deployed（git hash-object == canonical blob） |
| 00:58 | 部署后全量回归 122/0 PASS |
| 01:02 | 受控重启（restart-dsh-server-delayed.ps1 -RestartAndWait）→ 新进程 24372 |
| 01:03 | HTTP 200；服务日志 loaded 证据行在位 |
| 01:04 | loaded attestation：profile == canonical（三个 blob 一致） |
| 01:05+ | 本报告 + CURRENT_STATUS + Notion 同步 |

---

## 19. 完成判定

- **核心目标达成**：quota no-alternative → zero blind retry（V1 断言直接覆盖）。
- **部署闭环达成**：source==deployed==loaded 三方一致（E13-E17）。
- **回归无破坏**：全量 122/0（E1-E9）。
- **非目标**：未扩架构、未新建第二引擎、未触碰 Phase 02/02-SH/02.5、未自标 VERIFIED。
- **剩余**：仅等待 External Review Round 3（外部依赖，非可自动完成的剩余工作）。

---

## 20. 命令清单（可复现）

```text
git rev-parse origin/main                      # f0a6c47
git merge-base --is-ancestor 5eff17a origin/main  # YES
git diff --stat f0a6c47 5eff17a                # 空（内容一致）
git show --stat 5eff17a                        # EC +64/-16, Router +32, KNOWN_ISSUES +30, test +155
git cat-file blob origin/main:plugins/<f> > profile/<f>   # cmd 重定向精确部署
git hash-object profile/<f> == git rev-parse origin/main:plugins/<f>  # attestation
node --no-warnings verify-p26-r1-2-quota-no-alternative.mjs  # 10/10
# + 其余 7 套件（18/15/20/ALL/9/41/9）= 122/0
Get-NetTCPConnection -LocalPort 3080           # 监听 pid=24372
Get-Content $env:LOCALAPPDATA\DSHHarness\logs\dsh-server-3080.log  # loaded 证据行
Invoke-WebRequest http://127.0.0.1:3080/       # HTTP 200
```

---

## R3-A2 补记：倒序 ISO-Z 配额重置时间解析修复（2026-08-28，本会话）

**发现**：verify-p26-r1-2 的 V5d 在修复前 FAIL——nextRetryAt ≈ now+90s（bounded backoff）
而非精确 unavailableUntil。根因：1310 配额消息常见格式 **"您的限额将在 <UTC ISO 带 Z> 重置"**
（日期在 label 前、带小数秒+Z）。旧 parseResetTimestamp：RESET_ISO_RE 只匹配 label 在日期前
（倒序不匹配）；回退 RESET_PLAIN_DATE_RE 吞掉 .542Z 后按 naive +08:00 解释 → 早于 now → null
→ unavailableUntil=null → EC 退化为 90s 轮询，违反 R1.2 精确 defer 意图。

**修复**：plugins/failure-classifier-core.mjs parseResetTimestamp 新增**位置无关显式时区 ISO
提取**（带 labeled 守卫）置于优先级最前，显式时区原样 Date.parse。既有 D1-D7/A/F 语义不变。

**修复后验证（实际运行）**：
- verify-p26-r1-2-quota-no-alternative.mjs：**17/17 PASS**（V5d drift=0ms，nextRetryAt 精确 =
  unavailableUntil）
- test-failure-classifier-v1.mjs：**34/34 PASS**（新增 D8 倒序 ISO-Z / D8b 倒序 +08:00 / D9 无 label 不误抓）
- verify-p26-r3-a1-official-retry-zero.mjs：**16/16 PASS**（回归无破坏）

细节见 KNOWN_ISSUES.md「2026-08-28 P2.6 R3 A2」条目。
