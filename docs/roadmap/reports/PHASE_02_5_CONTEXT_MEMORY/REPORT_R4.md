# PHASE_02_5_CONTEXT_MEMORY — REPORT_R4（R4 REAL Evidence Closure）

> 报告路径：docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/REPORT_R4.md
> 轮次：External Review Round 3 = CHANGES_REQUIRED 之后的 R4 证据收口轮。
> 性质：仅补 REAL acceptance evidence；不重设计、不扩架构、不建第二套系统、不开 SH-R10、不进 P3。

## §0 执行摘要与状态判定

- R4 收口结论：Round-3 七项 REAL Gate 中 **①②④⑤⑥⑦ 六门以真实执行/账本级证据闭环入库**；
  **③ COMPLETION QUALITY 双 verdict 中仅 TOKEN EFFICIENCY 半边有 REAL 数据（↓86.5%/88.7%），
  COMPLETION QUALITY 跨会话 A/B 维持 PARTIAL**——其需要独立评测系统，治理红线禁止本轮私建
  （证据文档风险登记册 #5 原文在档）。
- 本轮三次 PR 全部 CI L1/L2/L3 三绿后 squash 合入：
  `#43`=`107433e`（R3 Closure）→ `#44`=`601d425`（R4 运行时补充）→
  `#45`=`7fa327a`（Gate-7 四段实测 + recall5 v2 + fail-open 活体）；
  main 终态 backfill=`a7e36bd`。
- 治理状态不变：**IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**，
  Waiting For = **External Review Round 4**；P3 = BLOCKED BY P2.5 REVIEW。
- 本报告按总控计划"18 节"规格出具（§0–§17）；验收证据单载体说明见 §17。

## §1 本轮范围与边界

- 覆盖：七 REAL Gate（①provider switch / ②token A-B / ③completion quality / ④recall 5 类 /
  ⑤corrupt fail-open / ⑥missing fail-open / ⑦kill-switch rollback）、R4-8 SH-R9 只读姿态核对、
  duplicate-side-effect audit、context rot / false-completion 后半段检查、CURRENT_STATUS 漂移清理。
- 边界（全程遵守）：未改动 src/plugins 运行时逻辑（除既有配置开关演练后复位）；未创建任何第二
  Task/Goal/Recovery/Router/Memory 系统；未动 Security-Hardening 主线；观察者角色不变。

## §2 方法链与证据规范

- Token 口径：provider 官方 usage 字段（`assistant/message.data.usage`），禁用 bytes/chars 估算；
  本会话 1,846 条有效 usage 记录，message 级 100% 非零。
- 会话取证：Official Session raw log 只读解码（zstd 多帧无损：51,772 行 / 16,432 事件 /
  seq 0–679,541）；提取一律走插件部署版 `messageOfEvent` / `recursiveText`（与生产 recall 字节同源）。
- 重启类操作权威凭证：dsh 官方 restart attempt ledger（COMMITTED 才算成功）；副作用审计以此为账本。
- 全部佐证原件脱敏后入仓（JSON excerpt 掩码、无密钥；L1 静态门含 secret scan）。

## §3 R4-1 REAL Provider Switch — CLOSED

- R3 轮受控真实切换已完成并在案（Router 正式通道决策，激活持久化 active=true / lastSwitchAt 在档）。
- E2E 增强：模型实际收到的观察快照头 v145 与 store.refs 末条逐字段一致（出处：Notion P2.5 页
  Status 区块 R3 记录 + `evidence/R3_RUNTIME_EVIDENCE.md`）。
- 本轮续证：OFF-era vs ON-era 天然 A/B 的两组路由对照见表 §4，切换前后路由族一致性满足对照条件。

## §4 R4-2 REAL Token A/B — CLOSED（含如实残留）

- 设计：不用多 K 投影回放估算；每轮注入 ≈100–180 tok 替代巨量 raw history 重发（变更日志原文）。
- 结果（`evidence/R4_LIVE_ROUTE_STATS.json`，同 deepseek-v4-flash 族天然跨会话对照）：

| 条件 | 路由 | 中位压力 tok | p95 |
|---|---|---|---|
| OFF 对照② | commandcode（n=2102） | 422,693 | 586,200 |
| OFF 对照① | deepseek-official（n=572） | 275,770 | 742,266 |
| ON 活体 | commandcode（n=405） | **56,933（↓86.5%）** | 77,463 |
| ON 活体 | bai（n=239） | **50,925（对同族 ↓88.7%）** | 64,533 |

- 活体 seq 62 万+ 场景下计费上下文压平 ~8 万 tok 内（最新三采样 77,530/81,542/81,542，cacheRead 主导）。
- **残留 PARTIAL（登记册 #4）**：「严格同任务跨天配对」未获取——现有为三点 REAL 序列 +
  跨会话天然对照 + 合成级下限的组合证据。

## §5 R4-3 Completion Quality A/B（双 verdict）— PARTIAL（红线受限，如实申报）

- TOKEN EFFICIENCY verdict：已具备 REAL 结论——见 §4（注入开销较 raw-history 路径大幅下降且
  p95 同步下降，无膨胀迹象）。
- COMPLETION QUALITY verdict：**未建立**。原因：跨会话质量 A/B 需要独立评测系统，而治理红线
  明确禁止本轮私建评测基础设施（避免再造一套不可信的自评分体系）。该限制自 REPORT_R3 §16 起
  持续在案，本轮以风险登记册 #5 保持申报。
- 判定：**PARTIAL / 不宣称关闭**。处置建议留待 Reviewer Round 4 裁决：或在 P3 预算内立项
  独立质量评测，或将"质量不降级"验收改为可审计的人工抽验协议。本轮不自作主张。

## §6 R4-4 REAL 5 类精确回源 — CLOSED（v2）

- 方法升级：claim 经部署版 `messageOfEvent`/`recursiveText` 提取；needle 对全量 raw log
  （51,772 行 / 16,432 事件）做**全语料逐字校验**，排除采样间隙。
- 结果：C1 goal / C2 error / C3 toolout / C4 filechg 四类逐字回源（C2 精确命中 seq=667615 且与
  自身 ref 对齐；C1 有 174 个历史事件共同佐证）；C5 refs 时序单调、三窗口抽样 present=3/3；
  storeVersion==log 头部最大版本（195）。
- **SUMMARY：RECALL 5/5 ALL-CLASS-PASS（exit=0）**。原件：`R4_RECALL5_20260827.json`
  （excerpt 已掩码）+ `cm-r4-recall5.mjs`。

## §7 R4-5 REAL corrupt projection fail-open — CLOSED

- 对象：LIVE store 原始字节副本（SHA256 前缀 `9fbb42766ab70df4` 存档），临时目录内受控破坏；
  活体文件零改动（`mutatedLiveFile:false` 自证）、全程零重启。
- 判废算法直接 import 部署版 `validateStore`/`emptyObs`/`buildObservation`（非复刻规则）。
- 结果：半截 JSON / 非 JSON / schemaVersion 错误三类损坏全部 usable=false → 重建路径可渲染
  （rebuildDemo skeletonValid=true、观察头可渲染）；对照臂 ACCEPT。
- 原件：`R4_FAILOPEN_LIVE_20260827.json` + `cm-r4-failopen-live.mjs`；文档 §P2.8。

## §8 R4-6 REAL missing projection fail-open — CLOSED

- 缺失 store 文件场景 → `FRESH_LEARN_FROM_RAW_SESSION`（从原始会话确定性重学），任务继续不阻断。
- 与 §7 同一实验框架产出，两半边合计覆盖 R2 合同 B4 的 fail-open 面。

## §9 R4-7 REAL kill-switch rollback（四段闭环）— CLOSED

- OFF-leg：enabled:false 落盘 → `restart-dsh-server-delayed.ps1 -RestartAndWait` 真实重启。
  Ledger `94988ebcc1054202915a09a403d5d369` @2026-08-27T04:55:05+08:00 COMMITTED；
  旧服 loopback PID 22596（02:19:24 起）04:53:49 停止 → 新服 PID 27540（04:53:51 起，
  generation `639234032317218804_27540`）30s 稳定窗后 COMMITTED。
- Resume-leg：同一 session 无缝续跑；停机窗内工具流按预期中断并自动续接；guardian 孤儿锁接管
  未被触发（不需要）。
- ON-leg：enabled:true 回切（目标行 sha16 `9DBCAA662B0CBE8B`→`85289DF4241238FE`，另一处无关
  enabled:false 零误伤；post-flip 结构校验通过——此前一次校验器语法自伤被 throw 正确拦截、
  未触发重启，校验门故障方向同样工作）→ 二次真实重启：Ledger
  `2777bf9655a94aedb5a78f23f280caaa` @05:02:01 COMMITTED，新服 PID 28968，HTTP `/`=200。
- Revival-leg：恢复后 `[context-memory observation]` 注入头即时回归并继续演进（v212/v213、
  sourceRange 推进）＝插件复活活体正证，开关终态=开启。
- 原件：文档 §P2.10。

## §10 R4-8 SH-R9 只读活体姿态核对 — PASS（无 STOP 事项）

- 部署字节复验：live 插件 SHA256 == repo 字节；agent.cordis.yml 挂载链活体自证冷加载。
- 免重启、零中断完成；未发现 security regression → 按合同**不触发 STOP、不新建 SH-R10**。

## §11 Duplicate-side-effect audit（数字终值）

- 全史 restart-attempt ledger 共 **61 笔**；0827 当日 **5 笔（COMMITTED 4）**。
- R7 双向演练窗口恰 **2 笔**（04:55 OFF / 05:02 ON）且全部 COMMITTED ——
  **零重复点火、零孤儿实例、无计划外 ledger**。

## §12 Context rot / false-completion 后半段检查 — PASS

- 套件级：R2-7 false-completion/context-rot 修复验证 61 PASS（R2 轮在案，PR #42 系列）。
- 实况级：本轮即为超长任务后半段——全程未见重新采纳已判定失败/过期的旧方案；无 false completion
  声明（所有 CLOSED/PARTIAL 判定均附在档证据指针）；goal 锁定原始 objective 无漂移。

## §13 CURRENT_STATUS 漂移清理

- Canonical main HEAD 演进链：`1e1f290`（R3 起点，Round-3 合同锚点）→ `c105d6a`（#44 backfill）
  → `7fa327a`（#45 squash）→ `a7e36bd`（#45 backfill，本报告出具时的 final）。
- 变更日志按时间追加式修订，历史条目不改写；状态字段单一来源为 CURRENT_STATUS 总览区。

## §14 证据清单与脱敏声明

- 入库目录 `docs/roadmap/evidence/`：`R4_P25_VERIFICATION_EVIDENCE.md`（验收证据单载体，§P2.1–P2.10）、
  `R4_RUNTIME_EVIDENCE.md`、`R4_LIVE_ROUTE_STATS.json`、`R4_CORRELATE.json`、`R4_DEDUPE.json`、
  `R4_PROBE_RAW_OUTPUT.json`、`R4_ROUTE_STATS_RAW_OUTPUT.json`、`R4_SWITCH_FAILOPEN_RERUN_20260827.txt`、
  `R4_RECALL5_20260827.json`、`R4_FAILOPEN_LIVE_20260827.json`、分析脚本 `cm-r4-{log-decoder,
  route-stats,anchor,correlate,dedupe,recall5,failopen-live}.mjs`。
- 脱敏：日志片段与 JSON excerpt 掩码化；无 token/key/明文凭据；CI L1 secret-scan 连续三轮 PASS。

## §15 局限与 PARTIAL 如实清单

1. Gate-③ COMPLETION QUALITY verdict 未建立（需独立评测系统，红线禁止私建）——登记册 #5。
2. Gate-② 残留：「严格同任务跨天配对」窗口未获取——登记册 #4（已有组合证据兜底）。
3. A/B 为天然跨会话对照（同时代不同任务分布），非随机分组实验——已在 §4 口径说明。
4. 观测环境坑：端口 3080 多监听行（tailscaled 持 Tailscale 接口面），属主判定须过滤
   loopback 并交叉核对 cmdline/generation（已沉淀工作区 KNOWN_ISSUES.md）。

## §16 治理状态与不越权声明

- 状态：**IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**；Waiting For = External Review Round 4；
  P3 = **BLOCKED BY P2.5 REVIEW**。
- 声明：Harness 未亦不得自行宣布 VERIFIED/APPROVED；仅外部 Reviewer APPROVED 后方可做
  AWAITING_REVIEW→VERIFIED 的纯状态 backfill；本报告不含任何审批结论。

## §17 工件命名映射与本报告偏差登记

- 总控计划点名 `docs/roadmap/evidence/R4_REAL_ACCEPTANCE_EVIDENCE.md`：实际以
  `R4_P25_VERIFICATION_EVIDENCE.md` 单载体承载全部 REAL acceptance evidence（文档头部有承载说明；
  不另建同名第二份，避免证据双源）。命名差异于 CURRENT_STATUS 变更日志如实登记。
- 本报告（REPORT_R4.md）为本偏差修正的一部分，随附后续分支入库；章节编号 §0–§17 与
  总控计划"18 节"规格对应。
