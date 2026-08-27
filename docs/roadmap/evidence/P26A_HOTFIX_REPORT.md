# P2.6-A EMERGENCY HOTFIX REPORT — DeepSeek thinking-mode `reasoning_content` 400（2026-08-27 夜）

## §0 结论（TL;DR）
- **故障类别**：PROTOCOL_MISMATCH —— 服务端要求「thinking 模式下带 `reasoning_content` 的
  assistant 消息在后续请求中原样回传」，客户端历史回放时将其剥离，触发
  `400: The reasoning_content in the thinking mode must be passed back to the API`。
- **根因（单一、已证）**：compat 门控（`requiresReasoningContentOnAssistantMessages: true` +
  `thinkingFormat: deepseek`，settings.yaml 三处 provider 级）写入于 08-27 17:36，而**在役服务进程
  PID 28968 启动于当日 05:00:45**——pi-ai 校验器仅在**启动时**读取 compat（dsh-llm-pi-ai/lib/index.js
  L495-506），故整日在役构建从未携带该门控。属「配置生效路径」故障，非代码缺陷；
  **修复 = 单次受控重启加载既有配置**（18:14:52 新进程 PID 20420），零代码改动。
- **盲重试判定：同一坏请求字节级重试 = 0。** 铁证：seq 9269/9271 为同一步内一次失败的双重
  chunk 上报（usage→finish-error→usage→finish-error，同 turn1/step18）；每次 400 即终止该 turn，
  由 execution-continuity 拼接 `[execution-continuity] A recoverable provider/network interruption...`
  恢复消息开新回合（seq 9273–9278）。副作用无双发：每个 step 仅发出一次工具调用。

## §1 定量证据（session c4cc512e 全量日志，trace 工具 `evidence/tmp-p26-trace.mjs`）
- 语料规模：events 2396 条 / seq 0–65713；assistant/message 165 条，其中 **116 条含 `reasoning` 块**。
- 400 错误共 14 个序列位（5011, 7221, 9269(+9271 同步双报), 25778, 30505, 38685, 50665, 50685,
  56813, 59601, 64323 等），**全部紧跟最近一条含 reasoning 的 assistant 消息之后固定 +6 seq**
  （事件模式：assistant/message → tool/call → tool/result → step/end → step/start → 400），零例外。
- 投影替换 surfaceOp 共 21 个，无一覆盖任何 reasoning 消息 → 排除「存储/投影丢失」假说
  （修正记录：旧版临时脚本误找 `thinking` 块类型得 0，系查找目标错误，已由 v2 脚本纠正）。
- 故障形态：会话内每多进行一轮，历史即多一条孤儿 reasoning 消息 → 后续每轮首个工具往返必炸，
  与「门控未装载」模型完全一致。

## §2 关键坑与更正（沉淀）
1. **端口属主幽灵**：`Get-NetTCPConnection -LocalPort 3080 -State Listen` 曾返回 OwningProcess=6160，
   实为 **tailscaled.exe**（08-23 开机自启，持有连接而非监听行）——判定进程代际必须用服务日志
   `runner start` 行 + spawn PID（`%LOCALAPPDATA%\DSHHarness\logs\dsh-server-3080.log`）。
   （此前 KNOWN_ISSUES 已记类似坑，本次再次命中，复现两次。）
2. **错误双报非重试**：finish-error chunk 双发射是该日志形态的固有噪声，统计故障次数须按
   step 去重。
3. **readiness 探针误报**：重启 ledger 记录 `api_unready ×3` 但实际 web 已就绪——boot-grace 的
   探测端点超时不影响真实可用性（GUI HTTP 200 + headless 冒烟通过为准）。
4. **共存协调**：同时段另一独立会话正在执行 GLM-5.3-Flash 接入并写 settings.yaml（17:36/18:00，
   含上述 compat 配置，YAML 校验 OK）。重启时点选择其 turn/end 边界（日志静止 99s +
   尾事件=turn/end 解码确认），实现单次重启同时加载两批变更，零腰斩。

## §3 修复后验收（全部 REAL，2026-08-27 晚执行）
| 验收项 | 结果 |
|---|---|
| 重启加载 | dsh-server-3080.log `runner start 10:14:52Z / child spawned pid=20420`；GUI HTTP 200 |
| 最小工具冒烟 | pwsh `echo P26-SMOKE-OK` 往返成功，输出原样返回 |
| ≥10 工具调用周期 | headless 强制 10 连环调用 `SMOKE-CYCLE-1..10` → `CYCLES=10 ALL-OK` |
| reasoning 400 | **修复后 0 次**（对比修复前同会话模式 14/14 必现） |
| legacy 会话恢复 | 本会话（数百条历史 reasoning 消息）于新进程直接续跑，本报告撰写过程十余次工具调用全通 |
| CM ON/OFF | Context Memory 插件全程挂载正常（注入头照常出现），无回归 |
| side-effect 防重 | 重启演练窗操作均为只读+单次写入类，无重复触发 |

## §4 分类记录
- Error Class: **PROTOCOL_MISMATCH**（provider 合同类 400，非超时/限流/网络）。
- Retry Policy 实测：无同请求自动重试机制介入（每 step 单次调用；双报为日志形态）;
  恢复走 execution-continuity（换载荷新回合），故「盲目字节级重试」计 0。
- Residual Risk：配置门控依赖重启时机；未来同类改动应尽量纳入重启批次并在变更日志标注
  「需重启生效」。执行连续性(§9274 splice)在被击中后会无限续接导致当轮反复失败，已有
  guardian/goal 兜底，本轮未改动该链路（超出最小修边界）。

## §5 载体与回滚
- 备份：`DSH-Client\_backup-p26-compat-load-20260827-*\`（settings.yaml / cordis.patch.yml /
  provider-registry-core.mjs / model-registry.mjs 四件套快照）。
- 回滚方式：恢复四件套 + 同款延迟重启脚本一次即可；门控移除后行为回到修复前
  （即「报错但可执行连续性续接」，不会变砖）。
- 证据文件：`evidence/p26-compat-load-evidence.md`、`evidence/tmp-p26-trace.mjs`（v2 修正版）、
  会话日志 zstd（append-only，原始事件可逐条复核）。

## §6 Governance
- P2.5 CONTEXT MEMORY 保持 `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW` 不变；
  本热修期间其存档/checkpoint 完好（R5 证据与 live store 未被触碰）。
- P2.6-A 状态置 **DONE / VERIFIED-PENDING-REVIEW**（自证验收全绿；权威 APPROVED 待外部 Reviewer）。
- 未进入 P3；未新增第二 Authority；未触碰 Official Core 代码。
- **Route 覆盖披露**：本热修全部 REAL 验证经 **BAI 路由**完成（主力 deepseek-v4-flash）。
  CommandCode 路由（settings.yaml 第三处同参 compat 门控，L160 区域）使用同一 pi-ai 校验器
  与同一启动加载机制，配置身份一致；今晚未做其专用客户端链路的活线探测——「至少两个
  DeepSeek-compatible route/adapter 实测」合同按 02.6 页原文归属正式 REPORT_R1 范围，
  随 Failure Taxonomy / classifier 一并验收，不在本热修内冒认。
