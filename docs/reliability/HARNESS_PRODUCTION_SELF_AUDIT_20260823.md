# HARNESS_PRODUCTION_SELF_AUDIT_20260823

- 日期：2026-08-23（只读审计，未修改任何代码/配置/进程）
- 审计员视角：反方审计员（攻击性验证，先反证后分类）
- 审计对象：DeepSeek Harness 生产环境（dsh 0.1.1-rc.2）

---

## 1. Executive Summary

本审计以反方视角对当前生产 Harness 做了全面只读攻击。**未修改任何文件、未重启 Server、未停止进程、未升级、未恢复 Goal、未泄漏 secret。**

核心结论：系统整体稳定（Server 已稳定运行多日，4 次重启自动续跑验证通过），**无 P0**。但发现 **3 个 P1** 和 **8 个 P2**，其中最重要的 P1 是 **execution-continuity 的 CONTEXT_OVERFLOW 恢复因作用域错误从不触发 compaction（"假 DEGRADED"）**——恢复质量受损但不威胁稳定。

## 2. Current Runtime Baseline

| 项 | 值 |
|---|---|
| dsh version | 0.1.1-rc.2 |
| backend PID | 19108（start 2026-08-23 06:43:09） |
| 3080 listener | node 19108 + tailscaled 6160（tailnet proxy，非 DSH） |
| host.describe | ok=True |
| session.list | ok=True, count=326 |
| running sessions | 1（当前会话，goal active） |
| events.mux / events.host | OPEN / OPEN |
| Guardian | PID 4988 + watchdog 4156（无 duplicate） |
| restart budget | attempts=0, hourAttempts=3, circuit 未开 |
| execution-continuity | ACTIVE（enableAutoResume=true），compaction 报告 UNAVAILABLE（见 P1-1） |
| 插件清单 | 18 段（cordis.patch.yml） |

## 3. Confirmed P0

**无。**

## 4. Confirmed P1

### P1-1 【CONFIRMED】execution-continuity CONTEXT_OVERFLOW 恢复从不 compact（"假 DEGRADED"）
- **证据**：autonomous preset agent.cordis.yml L423-444 在 **realm 隔离**（isolate: { compaction: true }）内挂载 `compaction-basic`（thresholdRatio 0.6/retainRatio 0.2/maxTokens 32768）；而 execution-continuity L610 用 **host 层 `ctx.get("compaction")`** 查服务 → 因 realm 隔离返回 undefined → `compaction=UNAVAILABLE`。
- **为什么是 bug**：L612 `comp.compactNow(agent, ...)` 传 agent 参数，说明 compactNow 设计为 agent-scoped——execution-continuity **本应通过 agent 上下文获取 compaction**，却用 host ctx.get。
- **影响**：CONTEXT_OVERFLOW 从不压缩上下文，总是直接切更大 context 模型（次优恢复）。**不威胁稳定**（fallback 路径有界），但恢复质量受损。
- **反证尝试**：官方 agent 层 compaction-basic 是**自动触发**的（thresholdRatio 0.6），长任务仍有官方压缩保护——P1 严重性受此限制（EC 的假 DEGRADED 只影响"EC 主动 compact"路径，不影响官方自动压缩）。**降级考量：P1（恢复质量）/ 若只看稳定性则 P2**。

### P1-2 【CONFIRMED】WAITING_USER 保护实际未实现（hasPendingQuestion 从未在生产路径调用）
- **证据**：hasPendingQuestion（L235）只在 L859 导出给测试；**生产恢复路径（resumeViaApi / recoverableScan / turn-end handler）从不调用它**。goal/changed hook（L743-745）只处理 paused/active/complete，**从不设置 WAITING_USER**。
- **影响**：有未回答 ask_user_question 的 goal（phase=active），Server 重启后 boot scan 会把它当 RUNNING 恢复并注入"继续"消息——**违反"未回答提问不自动恢复"的声明的语义**（L29-30 注释声称此保护存在）。
- **反证尝试**：goal 提问时若用户已离开，goal phase 仍 active → 无保护。仅当 goal 被显式 pause 才安全。**反证失败，保留**。

### P1-3 【CONFIRMED】notify sidecar 运行旧代码，通知静默失效
- **证据**：notify sidecar PID 18064 启动于 01:33（加载**修复前**的 dsh-event-notify.mjs）；notify-events.log 最后写入 02:02:06，此后（含 06:43 至今的多次重启与大量活动）**零日志**——sidecar 一直处于 WS 断连未重连状态。
- **影响**：事件通知（任务完成/提问/审批 toast）**静默失效**。不影响 Host 稳定性（sidecar 独立）。
- **根因**：reconnect 修复已写入文件（onerror→close→重连），但 sidecar 进程不会自动重载，需**重启 sidecar 才生效**（由 Desktop client 管理，client 未重启）。
- **反证尝试**：无——日志时间戳铁证。

## 5. Confirmed P1（插件架构面）

### P1-4 【HIGH-CONFIDENCE】10/13 插件 apply() 无顶层 try/catch——同步 throw = Host boot 失败
- **证据**：13 个插件仅 keepalive-patch/agentrouter-wire/tool-output-offload 的 apply() 有 try 保护；其余 10 个（execution-continuity/model-selection-guard/openrouter-router/commandcode-router/vision-bridge/ask-telegram/secret-gate/agent-inspector/computer-use/completion-notify）的 apply() 若同步抛错 → Cordis assertEntriesActivated → **Host 启动失败**（与 execution-continuity crash 同类的单点故障面）。
- **已确认的具体同步 throw 点**：ask-telegram L65 `mkdirSync`（无 try/catch）；其余多为 async 路径或已包 try（vision-bridge/completion-notify 反证安全）。
- **影响**：配置文件缺失/IO 失败/权限问题时，插件初始化错误 = 整个 Host 起不来（无隔离）。
- **反证尝试**：多数插件的同步初始化很简单，实际抛错概率低；但**架构上无防护**是真实的。

## 6. P2 Findings

| # | Finding | 分类 |
|---|---|---|
| P2-1 | openrouter-router（内存 state）与 execution-continuity（持久 pendingFallback）是**双 Authority**，跨请求 fallback 决策可能冲突（同一 session 两套逻辑各切一次模型） | HIGH-CONFIDENCE |
| P2-2 | resumeViaApi 的 RESUME-DEFER（API 失败）不写 nextRetryAt → 若 API 持续不可用且无重启，session 不再被 timer 重试（饿死窗口） | CONFIRMED（LIKELY 触发） |
| P2-3 | Register-DshRestartSuccess 在 client-ready 后 reset budget → **间歇性 crash**（起得来跑 10 分钟再崩）绕过 budget 保护 | CONFIRMED |
| P2-4 | MODEL_CONTEXT_WINDOWS 硬编码表（core L203-218）与 settings 动态 contextWindow 可能漂移；modelSupports 用正则猜图片能力（新模型误判） | CONFIRMED |
| P2-5 | fallback 不检查 reasoning/thinking 能力（切到无 thinking 模型可能再触发 reasoning_content 协议错误） | CONFIRMED |
| P2-6 | vision-bridge 白名单仅 bai/deepseek-v4-flash-vision-exp，settings 声明 11 个 image-capable 模型 → mimo/opencode vision 被降级转述（质量下降） | CONFIRMED |
| P2-7 | NEW_LOCAL_GOLDEN 缺 DSH-Harness-PS.ps1（RC8 有，NEW 漏拷） | CONFIRMED |
| P2-8 | goal-recovery ledger 随重启增长（36 文件/26 gen，长期持续）；双恢复系统零共享状态（ledger vs intent store 互不可见） | CONFIRMED |
| P2-9 | goal 完成事件丢失 + 重启 = 已完成 goal 被重新拉起一次（prompt 兜底浪费） | LIKELY |

## 7. Disproved Findings（反证成功，非问题）

| 假设 | 反证结果 |
|---|---|
| Guardian 双进程（可能竞争重启锁） | **DISPROVED**：第二个 PID 是审计命令自身，Guardian 单实例 |
| model-selection-guard listener 泄漏 | **DISPROVED**：per-agent scoped ctx 各 1 个 listener，Cordis fiber dispose 自动清理 |
| /health 404 影响健康判定 | **DISPROVED**：Guardian 用 host.describe+WS，不依赖 /health |
| 双 kick 导致重复执行 | **DISPROVED（降为 P2-8）**：EC boot scan 5s vs goal-recovery 17s+grace 15s，EC 先跑，goal-recovery 检测 running 不重复 |
| restart budget 无限重启 | **DISPROVED**：10min 3 次 + 15min pause 有界 |
| token 泄入日志 | **DISPROVED**：sk-/ntn_ 无命中 |
| 坏 session 阻塞 boot recovery | **DISPROVED**：官方 repair + per-session catch + autoResumeCycles 10 上限 |
| 插件编码损坏 | **DISPROVED**：全部 utf8 OK（PowerShell 显示乱码） |
| 0.1.1 改变了 compaction 状态 | **DISPROVED**：0.1.1 web profile 同样禁用 compaction-basic（与 rc.8 一致） |

## 8-11. 子系统审计结论
（详细证据见 _investigation/audit-ec-20points.md 与 audit-stage2-summary.md）

- **EC 20 点**：3 项 CONFIRMED（P1-1/P1-2/饿死窗口）、其余 NOT AN ISSUE 或有界
- **模型分类**：优先级正确（reasoning/ctx 先于 429）；quota 400→QUOTA_EXHAUSTED ✓、quota 429→RATE_LIMIT ✓、Retry-After 有 60s 上限 ✓
- **Model Selection**：guard 每 agent 单 listener ✓；router 改 pair 后 guard 验证 final pair ✓（waterfall 顺序正确）
- **Router**：lastReal 修复真实存在 ✓；双 Authority（P2-1）
- **Guardian**：budget 有界 ✓；graceful exit 不会被误判（重启走 restart-dsh-server-delayed，Guardian 只处理非 client-ready）
- **Notify**：P1-3 + rotation 单进程安全 ✓
- **ask-telegram**：cleanup 正确 ✓；P1-4 的 mkdirSync 无保护
- **Vision**：白名单漂移（P2-6）；native vs text-only 边界机制存在 ✓
- **Session**：官方 repair ✓；隔离 ✓；有界 ✓
- **安全**：**CodexSandboxUsers 对 .credentials.yaml / settings.yaml / .agent-presets 有 ReadAndExecute**（P1 安全面，本轮不修改）
- **Golden**：两 Golden 存在、manifest 完整、生产无 drift、rollback 适用；P2-7 缺文件

## 12. Security Audit

| 路径 | 权限 | 风险 |
|---|---|---|
| ~/.dsh/.credentials.yaml | CodexSandboxUsers: ReadAndExecute | **P1**：Codex 沙箱进程可读凭据明文 |
| ~/.dsh/settings.yaml | CodexSandboxUsers: ReadAndExecute | P1：模型配置+API key env 引用 |
| ~/.dsh/.agent-presets | CodexSandboxUsers: ReadAndExecute | P2：预设指令（非凭据） |
| 日志 | sk-/ntn_ 无命中 | 无泄漏 ✓ |

（SECURITY_REVIEW_REQUIRED：CodexSandbox 用途不明，建议评估移除读权限或确认必要性）

## 13. Golden Drift Audit

- RC8_LOCAL_GOLDEN：13 文件 + manifest ✓；NEW_LOCAL_GOLDEN：12 文件 + manifest ✓
- 生产 vs NEW：execution-continuity/cordis.patch/settings/goal-recovery/notify **全 MATCH** ✓
- drift：**NEW 缺 DSH-Harness-PS.ps1**（P2-7，RC8 有）
- rollback：`npm install -g @deepseek-ai/dsh@0.1.0-rc.8` + 配置回拷（仍适用）✓

## 14. Long Task Risk（2h / 6h / 12h）

- **官方 agent 层 compaction-basic 自动工作**（thresholdRatio 0.6）——长任务上下文有官方压缩保护
- tool-output-offload 裁剪大工具输出（realm 内，先于 compaction）✓
- **核心风险**：EC 的 CONTEXT_OVERFLOW 恢复从不 compact（P1-1）→ 若官方自动压缩仍超限（极端长任务），EC 切大模型是"延迟问题"，最终 fallback 预算耗尽 → FAILED_RECOVERABLE（有界停住）
- 2h：低风险（官方压缩 + offload）；6h：中（依赖官方压缩正常触发）；12h+：**信息丢失风险**（retainRatio 0.2 反复压缩）+ EC fallback 耗尽后停住

## 15. Recommended Next Actions（按优先级）

1. **修复 EC compaction 作用域**（P1-1）：从 agent 上下文（agent.ctx / payload 携带的 ctx）获取 compaction，而非 host ctx.get——恢复 CONTEXT_OVERFLOW 的压缩路径
2. **接入 hasPendingQuestion**（P1-2）：在 resumeViaApi/recoverableScan 前检查未回答提问 → 设 WAITING_USER 跳过
3. **重启 notify sidecar**（P1-3）：让 reconnect 修复生效（需 client 配合或手动拉起）
4. **评估 CodexSandboxUsers 凭据读权限**（P1 安全）：用途不明应移除
5. **插件 apply() 顶层防护**（P1-4）：为 10 个插件包 try/catch（ask-telegram mkdirSync 优先）
6. **统一 fallback Authority**（P2-1）：router 与 EC 共享会话级 fallback 状态
7. Golden 补齐 DSH-Harness-PS.ps1（P2-7）

## 总评分

| 维度 | 分数 | 扣分来源 |
|---|---|---|
| Server Stability | 92/100 | 无 P0、稳定运行多日；插件 apply() 无防护（-8） |
| Unattended Reliability | 78/100 | WAITING_USER 保护缺失（-10）、notify 失效（-6）、饿死窗口（-6） |
| Recovery Safety | 80/100 | 假 DEGRADED 不 compact（-10）、双 Authority（-6）、budget 间歇绕过（-4） |
| Model Routing Integrity | 82/100 | 双 Authority（-8）、context 表漂移（-5）、reasoning 能力未检查（-5） |
| Long-task Durability | 75/100 | 依赖官方压缩（-10）、EC 无 compact（-10）、12h+ 信息丢失（-5） |
| Security | 68/100 | CodexSandboxUsers 凭据读权限（-25）、无日志泄漏（+3 基础分） |
| Maintainability | 80/100 | 13 插件无统一防护（-10）、硬编码表/白名单（-5）、golden 缺文件（-5） |
| **Overall Production Readiness** | **80/100** | 无 P0 + 稳定为主；P1 均不威胁崩溃，但无人值守质量（WAITING_USER/notify/compact）有实质缺口 |

## 最终 Verdict

**PRODUCTION READY WITH KNOWN RISKS**

理由：
- 无 P0，Server 稳定（多日 + 4 次重启自动续跑）
- 3 个 P1 均**不威胁 Host 崩溃**（作用域错误/保护缺失/通知失效），但影响无人值守质量
- 最重要的修复点明确：EC compaction 作用域（P1-1）、WAITING_USER 接入（P1-2）、notify sidecar 重启（P1-3）
- 安全面有 CodexSandboxUsers 凭据读权限待评估（SECURITY_REVIEW_REQUIRED）

不建议夜间无人值守运行需要 WAITING_USER 交互的 goal（会被自动恢复），其余场景可安全无人值守。
