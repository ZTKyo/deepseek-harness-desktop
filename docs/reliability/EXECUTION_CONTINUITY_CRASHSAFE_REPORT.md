# EXECUTION_CONTINUITY_CRASHSAFE_REPORT

- 日期：2026-08-23
- 任务：修复 execution-continuity 插件导致 DSH Server crash-loop（P0）
- 结论：**FIXED**（插件 crash-safe 重注册成功，Server 稳定超过旧 crash 窗口，基础 recovery runtime PASS）
- 执行人：DeepSeek Harness 自主执行（无人值守）

---

## 1. Root Cause（精确）

**execution-continuity 在 `inject` 中把 `compaction` 声明为 boot 期硬依赖，而 web profile 的 host 组合树不提供 compaction service，导致 Cordis boot 审计判定插件永远 PENDING → 整个 Host throw → 进程退出。**

证据链（源码 + 日志双重坐实）：

1. `execution-continuity.mjs`（crash 前版本）第 55 行：
   `export const inject = ["agents", "goals", "sessions", "compaction"];`
2. web profile 组合树：`dsh-web-app/cordis.patch.yml`（官方 bundle 层）对 dsh-base 的
   `compaction-basic` 与 `command-compact` 均显式 `disabled: true`（`dsh --profile web --dump-config`
   确认 L233-241：`compaction-basic ... disabled: true`）。web host 平面**没有激活的 compaction service**。
3. Cordis 加载器（`dsh-app-boot/lib/index.js` `assertEntriesActivated`，L1134）：
   对任何 `FIBER_PENDING` 的 enabled entry，若 `fiber.ctx.get(service) === undefined`，
   直接 throw `"1 entry did not activate"` → boot 失败 → `exit 1`。
4. 实际 crash 日志（`dsh-server-3080.log`）：
   ```
   Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
   ./execution-continuity.mjs: pending (waiting for service: compaction)
       at assertEntriesActivated (dsh-app-boot/lib/index.js:1134)
       at boot (dsh-app-boot/lib/index.js:1179)
   ```
   该错误在 2026-08-23 00:12:45 注册后反复出现，每 21~95 秒循环（Guardian 拉起 → 又退出）。

**根因分类：C 类 —— 一个本应 optional 的依赖被错误声明成 mandatory boot dependency。**
插件运行时对 compaction 的全部访问都是防御性的（`ctx.compaction && typeof ...compactNow === "function"`），
说明设计者本意是 optional，但 `inject` 声明把它变成了 boot 硬依赖。

## 2. Dependency

| 项 | 值 |
|---|---|
| service | `compaction` |
| required or optional | **optional**（修复前被错误声明为 mandatory） |
| provider | `@deepseek-ai/dsh-compaction-basic`（官方） |
| 为什么 unavailable | web profile 的 host 平面由 dsh-web-app 层显式禁用 `compaction-basic`（`disabled: true`）；compaction 实际位于 dsh-base 的 agent preset realm，只在创建 Agent 后生效，host 平面不可见 |
| 最终如何处理 | 从 `inject` 移除；改为运行时惰性探测（`getCompaction()`：`ctx.get` 优先，属性访问兜底，缺失返回 null）；缺失时仅 `contextOverflowRecovery` 的 compact 子环节降级为 `COMPACTION_UNAVAILABLE`，其余能力与 Host 完全不受影响（fail-open） |

## 3. Crash-Safe Design

设计原则：**missing dependency → capability degrade → warning/diagnostic → Host keeps running**，而不是 missing dependency → Host crash。

具体实现（全部在 Plugin 层，不改官方 Core）：

1. **inject 瘦身**：`["agents","goals","sessions"]`（web host 平面真实存在的服务）。
2. **惰性 Compaction 探测**：`getCompaction(ctx)` 用 `ctx.get("compaction", false)` 优先读取
   （Cordis 官方无 inject 读服务 API），属性访问包 try/catch 兜底，任何异常视为缺失；
   结果缓存避免每事件重复探测。`compactionAvailable(ctx)` 检查 `compactNow` 函数存在性。
3. **Capability-Level Degradation**：`capability` 矩阵区分 retryRecovery / providerFallback /
   goalResume / restartRecovery / contextOverflowRecovery / reasoningProtocolRecovery。
   compaction 缺失只影响 contextOverflowRecovery 的 compact 子环节（`COMPACT-UNAVAILABLE`），
   不牵连其余能力。
4. **Safe Mode**：`enableAutoResume: false` 默认——只启用被动能力（错误分类 + 有界
   retry/fallback 决策 + 诊断日志），自动 resume / 恢复扫描 / turn/end 补位回踢默认关闭。
   第一轮注册先证明"插件能安全存在于 Host"，再逐步开启主动能力。
5. **异常隔离**：boot IIFE 全包 try/catch；`agent/request` 与 `agent/request-error` 的
   `await next()` 单独 try/catch（上层异常记录后原样重抛，不吞官方错误）；所有 handler
   内部 catch 不逃逸；recoverableScan 逐 session 隔离（一个坏 Session 不拖死其他 Session）。
6. **启动非阻塞**：boot 服务就绪等待有界（30×1s），compaction 探测同步完成（29ms），
   无 unbounded promise。

## 4. Files Changed

| path | change | reason | risk | rollback |
|---|---|---|---|---|
| `~/.dsh/profiles/web/execution-continuity.mjs` | inject 去 compaction；新增 getCompaction/compactionAvailable；替换 2 处 ctx.compaction 访问；新增 Safe Mode（enableAutoResume）；boot/handler 异常隔离；diagnostics 增加 capability/compactionAvailable/safeMode；修复 hasPendingQuestion（tool/result 按 call_id 匹配） | crash-safe 核心修复 | 低（全部防御性改动，官方 Core 未动） | 从 checkpoint 恢复：`Copy-Item _checkpoint\EXECUTION_CONTINUITY_CRASHSAFE_PRE_FIX\execution-continuity.mjs` → profile 目录 |
| `~/.dsh/profiles/web/cordis.patch.yml` | 末尾新增 execution-continuity 注册段（Safe Mode: `enableAutoResume: false`） | 正式 Safe Mode 注册 | 低（YAML 校验通过） | 删除该 insert 段（或从 checkpoint 恢复整个文件） |
| `~/.dsh/profiles/web/execution-continuity-crashsafe-test.mjs` | **新增**：Crash-Safe 离线测试套件（CS-1..CS-6 + 分类器优先级 + hasPendingQuestion） | 离线验证 | 无（测试文件，不加载） | 删除即可 |
| `execution-continuity-core.mjs` | **未修改**（hash 不变） | — | — | — |

改动前 checkpoint：`~/.dsh/profiles/web/_checkpoint/EXECUTION_CONTINUITY_CRASHSAFE_PRE_FIX/`
（含 3 文件 + manifest.json，含 hash/mtime）。

## 5. Official Core Mutation

**NO。** 未修改任何 `node_modules/@deepseek-ai/dsh/**` 文件。全部修复在 profile 插件层完成。

## 6. Offline Tests

| 测试 | 结果 |
|---|---|
| syntax | PASS（`node --check` 双文件） |
| unit（CS-1..CS-6 + 附加） | **33 PASS / 0 FAIL** |
| missing dependency（CS-1/CS-2） | PASS：compaction 缺失 → apply() 成功；CONTEXT_OVERFLOW → 安全 fallback，Host 存活 |
| handler exception（CS-3） | PASS：内部 try/catch + boot IIFE 隔离 |
| initialization（CS-6） | PASS：apply() 29ms，boot 等待有界（30×1s） |
| dispose（CS-5） | PASS：listener 恒定 5/5/5，timer 有界 |
| shadow load | PASS：headless profile 真实 boot（web 等价：显式禁用 compaction-basic + command-compact），插件 ACTIVE 非 PENDING，`compaction=UNAVAILABLE -> contextOverflowRecovery DEGRADED`，进程存活 60s+ 无 crash（旧版同场景 21~95s 必 crash） |

## 7. Runtime Registration

| 项 | 值 |
|---|---|
| execution-continuity registered | **YES**（`cordis.patch.yml` 末尾，2026-08-23 01:54:30） |
| Safe Mode | **YES**（`enableAutoResume: false`） |
| 注册前验证 | YAML parse OK（16 entries）；module import OK；inject 不含 compaction 确认 |

## 8. Server Survival

| 项 | 值 |
|---|---|
| PID（旧→新） | 8848 → **9620** |
| start time | 2026-08-23 02:02:04 |
| 180 seconds | **PASS**（存活 555s+ 时检查） |
| 300 seconds | **PASS**（Survival monitor 326s 0 告警；最终确认 uptime 725s+） |
| health check | `/health` 200；`host.describe` ok=True；`session.list` ok=True（325 会话）；`events.mux` OPEN；`events.host` OPEN |
| 新增 health FAIL | 0 |

## 9. Recovery Tests

| 测试 | 结果 |
|---|---|
| REASONING_PROTOCOL_ERROR（`The reasoning_content in the thinking mode must be passed back to the API.`） | **PASS**：分类 REASONING_PROTOCOL_ERROR（不被 INVALID_REQUEST 吃掉） |
| CONTEXT_OVERFLOW（`Input token exceed the limit`） | **PASS**：分类 CONTEXT_OVERFLOW（不被 INVALID_REQUEST 吃掉） |
| TIMEOUT（`connect ETIMEDOUT` / `ECONNRESET socket hang up`） | **PASS**：分类 RETRYABLE_TRANSIENT → 有界重试路径 |
| 429 / 401 / 500 / quota | **PASS**：RATE_LIMIT / AUTH / PROVIDER_OUTAGE / RATE_LIMIT |
| Goal idle auto-resume（hasPendingQuestion 保护） | **PASS**（修复后）：未回答提问→true（不自动踢）；已回答（call_id/turn 匹配）→false；无提问→false |
| COMPACTION_UNAVAILABLE 运行时 | **PASS**（shadow + 真实 server）：compaction 缺失 → 仅 contextOverflowRecovery DEGRADED，Host 健康 |

注：Safe Mode 下自动 resume 默认关闭，主动 recovery 回踢将在下轮（确认稳定后开启 enableAutoResume）验证。

## 10. Regression

| 项 | 结果 |
|---|---|
| Model Selection Guard（model-selection-guard.mjs） | **未改动**（hash 不变，mtime 2026-08-22 22:23:33） |
| lastReal（settings.yaml） | **未改动**（mtime 2026-08-23 01:36:43，早于本轮） |
| ask-telegram cleanupDays（cleanupDays: 7） | **未改动**（mtime 2026-08-22 22:54:19） |
| commandcode-router / vision-bridge / keepalive-patch | **未改动** |
| settings.yaml compat 修改（bai/commandcode/opencode） | **保留未动**（本轮不评估其正确性，仅确认未触碰） |

## 11. Remaining Risks

1. **Safe Mode 主动能力未开启**：自动 resume / 恢复扫描 / turn/end 补位回踢当前关闭。
   下轮开启 `enableAutoResume: true` 前需先验证：resumeViaApi 的 loopback API 路径
   （goal.resume + session.prompt）在当前版本行为正确，以及 anti-double-kick（60s cooldown）
   与 goal-recovery.mjs 的共存。
2. **hasPendingQuestion 的 event schema 假设**：tool/result 的 call_id 匹配已覆盖常见字段
   （tool_call_id / toolCallId / call_id / id），但真实 DSH session event 结构若不同，
   需在开启 autoResume 后以真实事件回归。
3. **compaction 缺失的长期影响**：contextOverflowRecovery 的 compact 子环节永久降级
   （COMPACTION_UNAVAILABLE → larger-context fallback 或 FAILED_RECOVERABLE）。
   这是 web profile 的官方设计（compaction-basic 被 web-app 禁用），非插件可解；
   如需完整 context 恢复，需在 host 平面提供 compaction service（另立任务，本轮不做）。
4. **Restart Budget / Circuit Breaker**：本轮未修改 Guardian restart budget 与 circuit
   breaker（按任务书第十八节）。restart budget exhausted → CIRCUIT_OPEN 的逻辑保持原样，
   未来只有在 crash root cause 已解除后才允许 reset（本轮不实现）。
5. **多轮 load/dispose 的 interval 清理**：CS-5 验证 listener 恒定；interval 在 Safe Mode
   下不启动（scheduleRecoveryLoop 未调用），开启 autoResume 后需再验证 dispose 清理
   recoveryTimer。

---

## Verdict

**FIXED**

- 插件 crash-safe 重注册成功（Safe Mode）
- Server 稳定超过旧 crash 窗口（95s）数十倍：725s+ 且仍在增长
- 基础 recovery runtime PASS（分类器 8/8、WAITING_USER 保护、COMPACTION_UNAVAILABLE 降级）
- 官方 Core 零修改
- Rollback ready（checkpoint 完整）

后续（下轮）：开启 enableAutoResume 前先验证 loopback resume 路径 → 逐步启用主动恢复 →
完整 multi-task restart / network outage / server restart recovery（任务书第 37 节）。
