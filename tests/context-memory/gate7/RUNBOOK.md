# Gate-7 REAL Dual-Leg Kill-Switch Drill — RUNBOOK（情报定稿 2026-08-27）

目标：在不碰生产实例的前提下，用**真实 DSH 子实例 + 真实 Session** 证明 context-memory
kill-switch 双断腿（config enabled:false / env CM_DISABLED=true）与 fail-open 行为，
产出 gate7-*.json + EVIDENCE 补录。

## A. 已确立事实（F1-F14，附来源行号）

- **F1 挂载**：`~/.dsh/.agent-presets/autonomous/agent.cordis.yml` L423-452 `compaction` 组；
  context-memory 在 L438-441，`name: './context-memory.mjs'`，config 仅 `{enabled:true}`。
- **F2 DEFAULTS**（context-memory.mjs L44-52）：recentWindowNodes=40,
  activationThresholdTokens=50000, minNewNodes=6, capsPerSection=24, capsTotalChars=6000,
  maxRefsEntries=64, stateDir=`%LOCALAPPDATA%\DSHHarness\state\context-memory`。
- **F3 全字段可覆盖**：`apply(ctx, config)` 为 `{...DEFAULTS,...config}`（L76）。
- **F4 双断腿开关**（L78）：`cfg.enabled===false || env CM_DISABLED==='true'` → 直接 return，
  不注册任何 hook（这是被测契约本体）。
- **F5 store**：路径 `<stateDir>/<sid消毒>.json`（L91）；原子写 tmp+rename（L104-115）；
  读取损坏→null→内存 emptyStore 重建（fail-open，L92-103）。
  validateStore 拒收条件：schemaVersion!==1 / sessionId 非非空串 / version|watermark 非
  safe-int≥0 / active 非布尔 / obs 非 object / refs 非数组。
- **F6 激活门控**（L137-159，全部满足才投影）：
  nodes.length > recentWindowNodes；未激活态需 surface token 估算 ≥ activationThresholdTokens；
  freshEnd(节点末序) > watermark 且 watermark 外新节点数 ≥ minNewNodes。
  → **低阈值配置即可确定性触发，无需真实模型切换/压力线**。
- **F7 投影副作用序**（L174-184）：先 `compaction/prune`（shadowedRange/shadowedSeqs/
  shadowedTokenCount）再 `user/message` 注入观察消息（surfaceOp replace +
  sourceEventSeqs 全覆盖）。注入消息带 `source.plugin='context-memory'`（L61-73）→
  日志可凭此指纹取证。
- **F8 预设发现**（dsh-agent-presets lib index.js scanRoot L236-264）：目录名须匹配
  PRESET_ID 且含组合文件，缺失=broken 占位；preset id 即目录名；root 先到先得。
- **F9 DSH_HOME 覆盖**（dsh-home-paths L15/L65-70）：优先级 显式配置 > `$DSH_HOME` >
  `~/.dsh`；空白值视为未设。→ 设 `DSH_HOME` 即整棵 home（sessions/预设/profiles）隔离。
- **F10 ⚠️ stateDir 不随 DSH_HOME**：默认硬拼 LOCALAPPDATA（F2/F3）→ 演练若不显式覆盖
  stateDir，store 会写进**生产共享目录**。铁律：每腿独立 stateDir。
- **F11 隔离实例启动形态**：headless profile = package.json(dsh.profile.bundles:
  dsh-base+dsh-headless) + cordis.yml(`[]`) + cordis.patch.yml(insert 型 patch)；agent
  preset 由 host 树补丁 `- id: agent-presets / config: default: <id>` 选定
  （web 生产 patch L48-50 即此形态，复制该结构改 default 即可）。
- **F12 事件通道**：WS `/api/events.mux`、`/api/events.host`（client-connection L16/L18）；
  环回默认受信无需 token（isTrustedApiRequest 接受 localhost/127/8/[::1]）；
  downlink-only：客户端发任何消息→close 1008。⚠️R1：headless bundle 是否挂
  client-connection/webServer 未证实——取证主通道先用**会话日志文件**，WS 仅加分项。
- **F13 启动命令**（telegram-bot 实践背书）：`node <npmRoot>\lib\bin.js --profile headless
  "<指令>"`（一次性执行结束退出）。npmRoot=
  `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（version 0.1.1-rc.2）。
- **F14 凭据注入**：providers 用 apiKeyEnv 引用环境变量名（settings.yaml，如
  OPENROUTER_API_KEY）；启动子进程时由 `~/.dsh/.credentials.yaml` **进程内提取赋 env**
  （值不落盘、不入聊天、不入参数行）。web patch 第 33 行附近有 system-prompt persona 与
  `defaultPreset: danger-full-access`（settings L225，与 sandbox 相关，不影响）。

## B. 演练架构

根目录：`_release-staging/tests/context-memory/gate7/`

```
gate7/
  make-isolated-home.mjs   # 建每腿独立 DSH_HOME 骨架
  runner.mjs               # 启动子实例 + 驱动 session + 取证
  verify.mjs               # 各腿判定 → gate7-report.json
  legs/<leg>/home/         # 独立 DSH_HOME（profiles/headless + .agent-presets/cm-drill）
  legs/<leg>/state/        # 该腿 stateDir（多副本目录供 missing/corrupt 操作）
```

腿矩阵：
| 腿 | 配置 | 预期 |
|---|---|---|
| baseline | enabled:true + 低阈值 | 观察消息注入≥1（source.plugin='context-memory'）；state json 存在且过 validateStore |
| cfg-off | enabled:false | 零注入、零 prune、state 目录空 |
| env-off | CM_DISABLED=true | 同上 |
| missing  | baseline 后把 state 目录整体移走→同 session 继续 | fail-open：不崩、从 raw 重建重投影（version 重起）、任务完成 |
| corrupt  | 手工写坏 .json→同 session 继续 | validateStore 拒收→emptyStore 重建，零崩溃 |

隔离要点（全部来源于 F9/F10/F11/F14）：
- 每 home 一份 `profiles/headless/{package.json,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml}`；
  patch 仅两条：`agent-presets default: cm-drill`（+ 必要的 wire/router insert 视 smoke 定）。
- `home/.agent-presets/cm-drill/agent.cordis.yml`：复制生产 compaction 组结构但 context-memory
  行 **连同 context-memory.mjs + context-memory-core.mjs 两文件一起拷入该目录**
  （name:'./context-memory.mjs' 是相对预设目录解析，F8+F1）。
- context-memory config 覆盖（确定性触发配方，F6）：
  `activationThresholdTokens: 30, recentWindowNodes: 3, minNewNodes: 1,
  stateDir: <legs/<leg>/state 绝对路径>`（具体数值待 smoke 微调防零步抖动）。
- task 指令文本造长一点（>120 字符 ≈ 30 tokens）保证首步即越阈。
- runner：pwsh/node spawn，env = {DSH_HOME: legHome, CM_DISABLED?, OPENROUTER_API_KEY: <进程内提取>}，
  cwd=腿目录；等待进程自然退出；随后扫 `<home>/sessions/` 事件日志。

## C. 取证协议（主=会话日志，辅=state 文件系统）

1. 注入取证：扫描日志 user/message 事件中 `source.plugin === 'context-memory'`
   计数（+prune 事件计数）。压缩转写（zstd rotation 见生产布局）只影响历史文件；
   活跃 session 的 jsonl 为明文，进程退出后即时读取即可；必要时复用仓库现有 zstd 解码器。
2. raw 不变性：compaction/prune 仅追加事件不改写旧 seq（append-only 日志结构本身保证）；
   verify 断言 shadowedSeqs 指向的原始事件仍在日志中存在。
3. store 取证：JSON.parse + validateStore 结构断言；missing/corrupt 腿另断言重建行为。

## D. 待验证风险（Failure Ledger 初始为空；以下为预登记未知数）

- R1 headless 是否有 HTTP/WS 面（决定能否加 events.mux 监听；日志主通道不受影响）。
- R2 --profile headless 在隔离 DSH_HOME 下首启是否需要 pnpm install/workspace 元数据
  （生产 profiles 下有 node_modules；base/headless bundle 来自 npm 包，预计纯配置即可，
  smoke 验证）。
- R3 openrouter-router/agentrouter-wire 是否缺失即失败（model=auto 依赖 router；可在
  腿 patch 里照抄 headless 生产 patch 的三个 insert，name 改 '../web/...'→绝对路径引用
  真实 web 目录文件，只读不写属安全引用）。
- R4 廉价模型选择：OPENROUTER_API_KEY 下用 deepseek/deepseek-v4-flash
  （settings.yaml 已有 web-search-deepseek 条目佐证该组合可用）；每腿 ≤3 turn 成本可忽略。

## E. 当前阶段

进度：情报 100% → 下一步 make-isolated-home.mjs + smoke boot（验 R1-R3）。
回滚面：零生产写入（唯一红线=F10，config 强制覆盖规避）；演练产物全在 gate7/ 下。
