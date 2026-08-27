# P2.6-A Evidence 追加：reasoning_content 400 根因闭环（2026-08-27 晚）

## 结论
根因不是投影/存储丢失，而是 **compat 门控修复未随进程重启生效**：
- 在役服务 PID 28968 启动于 08-27 05:00:45（dsh-server-3080.log `runner start 2026-08-26T21:00:45Z`）。
- `settings.yaml` 三处 provider 级 compat
  （`requiresReasoningContentOnAssistantMessages: true` / `thinkingFormat: deepseek`，
  line 23/160/191）最早写入于 08-27 17:36，晚于进程启动 → 内存中的路由构建从未携带该门控。
- pi-ai 校验器（dsh-llm-pi-ai/lib/index.js L495-506）只在**启动时**读取 compat；
  surface 重写无原始日志回退（dsh-session README L40），故在跑会话无法热修复。

## 定量铁证（trace 工具 tmp-p26-trace.mjs，session c4cc512e 全量日志）
- 165 条 assistant/message 中 116 条含 `reasoning` 块（旧版脚本误找 `thinking` 类型为 0）。
- 14 次 400 错误序列（seq=5011,7221,9269,9271,25778,30505,38685,50665,50685,56813,59601,64323 等）
  **全部**与最近一条带 reasoning 的 assistant 消息间隔恰 +6 seq
  （固定事件模式 assistant/msg→tool/call→tool/result→step/end→step/start→error），零例外。
- replacement surfaceOp 共 21 个，无一覆盖任一 reasoning 消息 → 排除投影丢弃假说。

## 协调事实
- 同机另一独立会话 session-c4cc512e 正在执行「GLM-5.3-Flash 接入」（用户实时在场指挥，
  最近指令 10:05Z）；settings.yaml 17:36 与 18:00 两次变更为其写入（新增 glm 相关配置），
  YAML 校验 OK。compat 门控内容完好。
- 因此重启时点必须避开其活跃回合：轮询其日志静止 ≥90s 后执行
  `restart-dsh-server-delayed.ps1 -Detach` 单次重启，同时加载 compat 门控 + GLM 变更。

## 备份
`DSH-Client\_backup-p26-compat-load-20260827-*\`：settings.yaml、cordis.patch.yml、
provider-registry-core.mjs、model-registry.mjs（重启前快照，可整体回滚）。

## 遗留
重启后需冒烟验证：新进程加载 settings 成功、BAI 路由带 reasoning 的多轮工具调用
无 400、legacy 会话（历史 reasoning 块回放）不复发。
