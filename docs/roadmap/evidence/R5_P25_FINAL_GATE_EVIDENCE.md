# P2.5 Context Memory — R5 Final Gate Evidence（R5-1 · R5-2 · R5-3 · R5-4 · R5-5 · R5-6 · 2026-08-27）

> 承载文档说明：本文件即 P2.5 R5 全部 6 项的 REAL 证据单一载体。
> 18 节级总报告见 `REPORT_R5.md`；本文件仅列证据快照以便审计。
>
> 机器可读交付物（2026-08-27 收口新增，与本文一一对应）：
> - `R5_RECALL5_EXACT.json` — R5-1 语义 5 类逐条证据（USER_ORIGINAL_WORDING / ORIGINAL_ERROR / TOOL_OUTPUT / PATCH_FILE_EVIDENCE / TIMELINE_SIDE_EFFECT，verdict=5/5 PASS）
> - `R5_COMPLETION_QUALITY.json` — R5-4 Completion Quality OFF/ON 6 项审计（verdict=NO MATERIAL REGRESSION）
> - `R5_SH9_POSTURE.json` — R5-5 SH-R9 只读 Posture 9 项快照（9/9 PASS，NO STOP）

## R5-1 STRICT Recall Verifier — CLOSED

- `tests/context-memory/recall-verifier.mjs`（P2.5 R5-1 STRICT verifier，legacy 2300+ 条全驳回）。
- 活体验证：`cm-r5-recall-verifier-snapshot.mjs` → `R5_RECALL_STRICT_LIVE_20260827.json`
- 结果：**STRICT RECALL 7/7+CHAIN ALL-PASS**
  - indexedEvents: 19,495 | claimNodesFound: 41 | schemaAnomalies: 0
  - storeVersion: 237 | maxStoreRefEnd: 811,720
  - C1 goal: PASS_refs_exact（multihit 105 命中）
  - C2 error: PASS_refs_exact（multihit 2 命中）
  - C3 completed: PASS_refs_exact（3 采样全 PASS）
  - C4 filechg: PASS_refs_exact（3 采样全 PASS）
  - C5 refs: PASS_monotonic_bounded_watermarked（windows=64, 采样 present=2/2）
  - sideEffectChain: PASS_before_target_after（before=809409, target=811720, after=811720）
  - scannedLines: 70,764 | elapsedMs: 614
- 佐证：`R5_RECALL_STRICT_LIVE_20260827.json`（脱敏）

## R5-2 REAL MISSING Projection 集成测试 — CLOSED

- 方式：`gate7/webdriver.mjs leg=missing`（孤立 dsh web 实例，真实 HTTP RPC 多轮会话）
- 过程：MISSING_AT=ROUNDS/2（第 2 轮后 `renameSync(STATE, state.moved-<ts>)` 移走整个 state 目录 → 第 3/4 轮插件从 raw events 重建 store → fail-open+可重建+零损伤）
- 复用 Web 实例和各腿 port 隔离（port 3191），与 baseline/failopen/envkill 同架构
- 结果：
  - missingRebuilt: **true**（重建 store: version=3, watermark=443, refs=3, obsKeys=7）
  - missingMoved: **true**（旧 store rename 保留于 `state.moved-1787804737922`，1185B）
  - taskComplete: **true**（workdir 4 文件 a.txt-d.txt 全部创建）
  - zeroDamage: **全 true**（oldStoreRenamedNotDeleted✅, oldStoreRecoverableBytes=1185✅, sameSessionContinue✅, watermarkProgressed✅, refsAccumulated✅）
  - **ok: true**
- 佐证：`gate7/legs/missing/result.json`（54 行，含完整证据字段）

## R5-3 Gate-7 REAL Kill-Switch Drill 四腿全绿（含 R5-2 missing 腿）— CLOSED

| 腿 | 状态 | 关键证据 | 说明 |
|---|---|---|---|
| baseline | PASS | 1 store file, 4 rounds settled, workdirOk | 基础挂载正常 |
| failopen | PASS | corrupt seed→no block→auto rebuild, 4 rounds settled | 损坏 store 不阻塞任务 |
| envkill | PASS | CM_DISABLED=true, 0 store files, 4 rounds settled | 环境开关零文件 |
| missing | PASS | state moved mid-session→rebuilt v3, 4 rounds, zero damage | 移走 store 后自动重建 |
| **汇总** | **四腿全 PASS** | OK 4/4, rounds_settled 4×4=16/16, workdirOk 4/4 | 无 regression |

- 环境：孤立 dsh web 实例 / DSH_HOME 隔离 / 端口 3188-3191
- 路由器：provider=bai model=deepseek-v4-flash（REAL, verified HTTP 200）
- 佐证：`gate7/gate7-web-drill-result.json`（三腿）+ `gate7/legs/missing/result.json`（missing 腿）

## R5-4 Completion Quality OFF/ON 可审计 Checklist — 三态 verdict: NO MATERIAL REGRESSION

### 审计项
| # | 审计项 | 数据源 | 判定规则 | 结果 |
|---|---|---|---|---|
| 1 | 每回合 agent 有效输出（非空/非错误） | message.data.usage 非零可用 | usage 可用率≥99% | 100%（1,846 条有效，message 级 100% 非零） |
| 2 | 任务完成率（gate7 四腿） | gate7 各腿 rounds_settled | 全部 settle=true | 16/16 rounds_settled=true |
| 3 | 无 error 注入/半途中断 | gate7 各腿 serverAlive + stateOk | 无未捕获异常 | 四腿 serverAlive=true, stateOk=true |
| 4 | OFF/ON 对照 | usage 中位压力 | ON 低于 OFF 同族路由 | ON 56,933 tok（↓86.5% vs OFF 422,693） |
| 5 | 0 side-effect（无额外文件/无损伤） | gate7 envkill 0 file + missing zeroDamage | 零副作用 | envkill 0 store files, missing zeroDamage 全 true |
| 6 | CURRENT_STATUS 状态真值一致 | R5-5 SH-R9 posture-3 | 状态=AWAITING_REVIEW | PASS（AWAITING_REVIEW=True） |

### Verdict
- **NO MATERIAL REGRESSION**（无实质退化）：ON 模式下任务完成率 100%、输出可用率 100%、token 压力显著下降（↓86.5%），无 error/中断/副作用。
- 限制声明：此为**代理质量指标 + 人工抽验 checklist**，非独立评测系统；独立评测系统建立仍保持 INCONCLUSIVE（登记册 #5）。

## R5-5 SH-R9 只读 Posture 9 项快照 — ALL PASS（无 STOP 事项）

| # | Posture | 状态 | 关键证据 |
|---|---|---|---|
| 1 | 凭据治理 settings.yaml 无明文 apiKey | PASS | apiKey 行数=13, 疑似明文=0 |
| 2 | fail-closed A5 store probe | PASS | L297 init=false / L305 set=true / fatal L149 检查 |
| 3 | 状态真值 CURRENT_STATUS 02.5=「AWAITING_REVIEW」 | PASS | L13 AWAITING_REVIEW=True |
| 4 | credential source coherence | PASS | 注册表与 settings.yaml 一致 |
| 5 | source-coherence 正分支契约 | PASS | 23 处 T15 正分支 |
| 6 | KillInjection 归档 no-op（3 处注释说明） | PASS | 实际调用=0, 仅注释说明 |
| 7 | restore-owner 归档（实际调用=0, archive 唯一副本） | PASS | 实际调用=0, 注释提及=3, 非 archive 副本数=0 |
| 8 | 部署字节复验 live==repo | PASS | 两文件 SHA256 匹配 |
| 9 | 挂载链 agent.cordis.yml context-memory | PASS | L439 注册 |

**结论：9 PASS / 0 FAIL → 无 regression → 无 STOP 事项。**

## R5-6 CURRENT_STATUS.md Canonical 清理 — 已执行

- 清理范围：P2.5 状态区块中过时的"待提交/进行中"字段（R3/R4 状态条目已 dating）
- 操作：仅保留 active fields（总览表 + 当前执行位置 + P2.5 状态 + R5 收口记录）
- 删除：R3/R4 的详细行日志（已归档至对应报告）
- 维持：AWAITING_REVIEW, Waiting For=External Review Round 4, P3=BLOCKED

## 工具链

- `recall-verifier.mjs`（R5-1 STRICT verifier，节点模式）
- `cm-r5-make-live-fixtures.mjs`（R5-1 活体证据生成）
- `cm-r5-recall-verifier-snapshot.mjs`（R5-1 快照捕获）
- `gate7/webdriver.mjs`（R5-2/R5-3 四腿 web 驱动）
- `gate7/runner.mjs`（R5-3 门禁 runner）
- 解码器/统计/回源/幂等工具链同 R4（`cm-r4-*.mjs`）

## 风险登记册（P2.6 终版，2026-08-27）

| # | 风险 | 等级 | 状态 | 处置 |
|---|---|---|---|---|
| 1 | LogStore 关闭窗口非持久化 | 低 | 已登记·不修 | 同 R4 |
| 2 | 会话文件残留投影 | 信息 | 已登记·设计如此 | 同 R4 |
| 3 | lastSwitchAt 只持久化激活时刻 | 低 | 已登记 | 同 R4 |
| 4 | 严格跨天同任务 token A/B 未获取 | — | PARTIAL 保持 | 同 R4 |
| 5 | completion quality 独立评测系统未建立 | — | INCONCLUSIVE 保持 | 红线禁止私建；checklist 已提供代理判定 NO MATERIAL REGRESSION |
| 6 | R5-1 STRICT verifier 拒真率 0（legacy 2300+ 全驳回） | — | 已验证 | 节点模式零误判 |
| 7 | missing 腿 state.moved-* 命名含时间戳（非固定名） | 信息 | 已登记·设计如此 | webdriver 用 `renameSync(STATE, state.moved-${Date.now()})`，搜索时需通配 `state.moved-*` |

## 脱敏声明

本文件所有证据数据取自 R5 工具链输出（`R5_RECALL_STRICT_LIVE_20260827.json`、`gate7/legs/missing/result.json`、`gate7/gate7-web-drill-result.json`），这些输出本身已做脱敏处理（secret/credential/token 替换为 `***`，sessionId 保留 UUID 格式但不指向真实用户数据）。活体会话日志引用仅限 seq 区间/版本号等统计维度，不包含用户消息原文。