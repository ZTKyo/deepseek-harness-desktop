# HOTFIX R1 — supervisor correction 注入目标规范化到 canonical receipt.sessionId

- **日期**：2026-08-30
- **分支/PR**：`hotfix/supervisor-correction-sessionid-r1` → PR #77（merge commit `dd7c12d`，CI 三 gate 全 PASS）
- **版本**：supervisor-bridge `0.2.2`（core `0.2.1` 不变）
- **性质**：P3 AUTONOMY 期间发现的生产级缺陷热修复（correction 注入路径寻址错误）

## 1. 根因（pre-fix 复现 + 调用链证据）

`/supervisor/send_correction` 在 **sg-only 寻址**（只传 `supervisorGoalId`，不传 `session_id`）时：

- `value.sessionId` 解析结果为 **null** → RPC `session.prompt` 以 null/错误 sessionId 寻址；
- 注入没有落到 canonical 原 Session（receipt.sessionId），sg-only 路径在生产实例上**必然失败**；
- 失败发生在宿主层（Harness 拒绝 null sessionId），但 bridge 已先扣减 correction 配额语义位——
  实测确认：宿主拒绝时 generation 不前进（无错误消耗），但生产调用方收到的是不可解释的失败。

复现证据：`tests/supervisor/repro-correction-addressing.mjs SB_EXPECT=pre SB_MODE=ci` → **15/15**
（LEG B：sg-only 宿主拒绝 + generation 仍 1 + 无幽灵 pending；LEG A：session 路径正常；
LEG C：双目标不一致 409 fail-closed；LEG D：同 commandId 重放零额外副作用）。
工件：`tests/supervisor/_artifacts/addr-pre-repro3.json`。

## 2. 修复（最小变更）

bridge 在发起 `session.prompt` RPC 前增加一步规范化：

```
targetSessionId = value.sessionId ?? goalReceipt.sessionId（canonical）
```

- session_id 与 supervisor_goal_id 两种寻址最终都指向 **canonical receipt.sessionId**；
- 双目标同时给出且不一致 → 维持 409 fail-closed（不变）；
- 失败注入仍不消耗 correction/generation，无 pending mutation 残留（负向全保留）。

## 3. 验证矩阵（全部真实 E2E，非 mock）

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| repro post CI 模式 | **16/16**（sg-only 200 accepted + canonical sessionId + harnessGoalId 不变 + 无幽灵 pending） | `_artifacts/addr-post-post1.json` |
| repro post full 模式 | **18/18**（FULL LEG B marker 在 sidB **原会话历史**中被真实回显执行） | `_artifacts/addr-post-full1.json` |
| canonical 三阶段 E2E（hotfix 分支代码） | **81/81**（phase1 57/57 含 T13 review FAIL→correction→VERIFIED 全协议；phase2 21/21 重启重放零二次副作用；phase3 3/3 无插件阴性） | orchestrator 控制台日志 |
| CI 三 gate（PR #77） | Static+secret+syntax 1m12s ✅ / Reliability state machine 6m47s ✅ / DSH boot+readiness smoke 17m05s ✅ | GitHub Actions run 33315517720/33315517734/33315517743 |
| 部署一致性 | 运行中 3080 实例 health identity：bridgeSha256=`057bbc0f…`、coreSha256=`59e3b5df…` 与 repo canonical 逐字节一致；ledger OK receipts=3 | `/supervisor/health` |
| 生产活体探针（LP89411） | sg-only correction（**无 sessionId 字段**）→ **200 accepted, generation 2, 回显 canonical session**；探针随即 CANCELLED 清理 | 本报告 §4 |
| P3 冻结 | 重启前后 `get_snapshot` 三行逐项一致；P3（sg-b7349）保持 AWAITING_REVIEW / gen 2 / corrections=1，Phase 04 未启动 | `_artifacts/p3-freeze-postrestart.json` |

## 4. 生产活体探针（LP89411，一次性）

生产 3080 实例：dispatch 一次性 probe goal（`hotfixr1-live-lp89411`，maxGoalRounds=2，
instruction 仅要求回复 READY）→ `send_correction` **仅带 supervisorGoalId**（复现原故障路径的
最小调用形态）→ 200 / accepted=true / generation 2 / 回显 sessionId == dispatch receipt sessionId
（canonical 解析生效的直接证据）→ 立即 `cancel_goal(action=pause)` 清理，无残留。

## 5. 部署与回滚

- 部署：merge 后受控替换 `~/.dsh/profiles/web/supervisor-bridge.mjs` + `supervisor-bridge-core.mjs`
  （拷贝后 SHA256 双侧核对），延迟重启激活；
- 备份（回滚点）：`~/.dsh/_backup-supervisor-hotfix-r1-20260830-221515/`（替换前线上原版两个文件）；
- 回滚方式：从备份目录拷回两文件 → `restart-dsh-server-delayed.ps1`。

## 6. 结论

sg-only 与 session_id 双寻址现均规范注入 canonical 原 Session；steer/queue 语义正确；
失败零副作用、重放幂等、账本 fail-closed 全部保持。P3 Goal/Session 全程只读冻结未受影响。

## 7. 收口（2026-08-31）— EXTERNAL REVIEW APPROVED → VERIFIED

- **External Review = APPROVED / PASS**（外部审核员裁决）；Status = **VERIFIED**；Waiting For = **NONE**。
- Supervisor review 受控记录：`/supervisor/review_goal`，commandId
  `sg-15fc877d-d622-5c1a-aebe-a9316e1fd99e:g4:REVIEW:1`（generation 4，verdict PASS，
  evidenceId `ev-sg-15fc877d-d622-5c1a-aebe-a9316e1fd99e-g4-r11`）→ 响应实测
  `ok=true duplicate=false controlState=VERIFIED nextExpectedAction=null correctionsLeft=0`。
- 收口时活体：ledger `state=OK trusted=true receipts=4 error=null`；P3（sg-b734914c…）复核未动
  （AWAITING_REVIEW / gen 2 / corr 1 / latestReviewVerdict=FAIL / nextExpectedAction=reconcile /
  pendingMutation=null，updatedAt 停在 12:36Z）；Phase 04 未启动。
  **Next = Phase 02.8 WATCHDOG / MOBILE MONITOR（仅记录，未启动）**。

### NON-BLOCKING OBSERVATIONS（仅记录，不重开 Hotfix）

- **O1 版本标签陈旧**：本报告头部与 §5 的"core `0.2.1` 不变"为陈旧标签；真实代码/部署事实以
  三方 SHA256 逐字节一致（bridge `057bbc0f…`、core `59e3b5df…`）及运行中 health v0.2.2 为准。
  历史原文保留不改写。
- **O2 交接期一次无归因 correction**：Hotfix 自身 receipt（sg-15fc877d…）在交接阶段出现第 3 次
  correction（gen 3→4，corrections 2→3，15:58Z），现有证据无法归因操作方。当前无 pending mutation、
  无 P3 污染，故不作为 blocker；保留记录，后续若再次出现无来源 mutation，作为 Supervisor audit
  issue 单独处理。
- **O3 acceptance 矩阵 6/12（6 pass + 6 unknown）**：review:1 提交 criteriaResults 时 PowerShell 5.1
  JSON body 将 CJK 字符编码侵蚀为 `?`（与 dispatch criteria 精确串不匹配 → 追加为独立行；原始
  dispatch 的 6 行保持 unknown）。controlState=VERIFIED 与 verdict=PASS 为权威事实；VERIFIED 为
  终态（review 仅允许 AWAITING_REVIEW 状态，bridge.mjs 守卫），矩阵文本行按设计不可修复，如实留档。
