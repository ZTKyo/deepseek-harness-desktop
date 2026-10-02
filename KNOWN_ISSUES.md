# KNOWN_ISSUES.md — 已知问题与踩坑记录

## 2026-08-19 P2.6 R1.1 quota 集成测试"卡死"真相（重要，避免再次误判）

**现象**：`tests/continuity/verify-p26-r1-1-managed-direct-quota.mjs` 在 8s/46s/90s 超时下
总被杀死，看起来"卡死"在某个 V 步骤；90s 那次恰好停在 V5b（13 PASS）后。

**根因（非死锁，是设计内行为）**：
1. `plugins/execution-continuity-core.mjs` L80：QUOTA_EXHAUSTED 分类默认
   `providerRetryAfterMs: retryAfter || 30000`（30 秒有界退避）。
2. `plugins/execution-continuity.mjs` L1147：quota 分支（有 fallback 预算时）
   `await sleep(backoffDelay(it.retryCount, budgets, cls.providerRetryAfterMs))` →
   每次 quota 错误固定 sleep ≈30s（`Math.min(30000, 60000)`）。
3. 该测试含 **4 个 quota 场景**（V1 zhipu / V2 bai / V4 commandcode / V6 openrouter）
   = 总时长 **≈120 秒**。任何 ≤90s 的超时都会在中途杀死它。

**结论**：测试真实结果 **15 pass, 0 fail**（2026-08-19 210s 完整运行验证）。V6a 断言
"移出耗尽路线"的 `model=xiaomi/mimo-v2.5` 也是 PASS（并非要求特定模型）。

**教训（写进记忆，避免重复踩坑）**：
- 涉及 EC quota 分类的集成测试，前台超时至少给 **210s**；判断"卡死"前先查
  `execution-continuity-core.mjs` 的 `providerRetryAfterMs` 默认值（quota=30000、
  provider-overload=5000、provider-outage=10000）。
- 想加速测试可临时设 `budgets.sameModelRetries=0` 或注入小 retryAfter，但断言不改。
- marker 注入（fs 打点）若用 replace 不匹配就静默失败，会误导定位；先确认注入成功。

## 2026-08-28 P2.6 R1.1 时区陷阱：UTC CI runner 上 naive 重置时间被 +08:00 锚定解析成"过去时间"（重要）
**现象**：本地（+08:00）全部测试 PASS，但 GitHub Actions（UTC）上 ci-level2 两处失败：
1. classifier 测试 failure-classifier 断言 unavailableUntil 取到 null / 解析差 8h；
2. 集成测试 verify-p26-r1-quota-defer.mjs：V1e/V2d/V4a FAIL（15 pass 3 fail），defer 不生效。
**根因**：真实 zhipu/bai 1310 报错里的 naive 时间（"2026-08-28 15:06:06 重置"）是**服务端本地时区（Asia/Shanghai +08:00）**，无时区后缀；core 解析时固定锚定 +08:00（CJK 服务商）。但测试构造 naive 串用的是**进程本地时钟**——UTC runner 上 new Date(RESET_AT) 的 getHours() 是 UTC 小时，core 按 +08:00 解释 → 时间偏移 8h、甚至落入过去 → parseResetTimestamp 返回 null。
**修复**：测试构造改为 new Date(RESET_AT + 8*3600e3) 取 **getUTC* 分量**生成 naive 串（模拟服务端 +08:00 墙钟），任何主机 TZ 下一致；V2 variant 小时同改 getUTCHours()。core 侧见 commit e72f879。
**教训**：
- 涉及"服务端 naive 时间解析"的测试，**必须模拟服务商时区（+08:00）构造输入**，不能依赖进程本地 TZ；本地过了 ≠ CI 过，务必用 TZ=UTC（或 CI 实测）复验。
- 时区相关修复要同时检查 core 解析 + 所有测试 fixture 的构造，两边都可能各错一半。
- 对 Windows 上 node 设置 TZ 环境变量在同一命令行内生效（$env:TZ='UTC'; node ...）；pwsh 分号连接即可，不要用外部包装。

## 2026-08-28 P2.6 R1.2 配额无替代 → 零盲重试（Reviewer Blocker 2，已完成+已验证）

**问题**：配额耗尽（1310/QUOTA）且 fallback 链无任何与当前模型不同的候选（单模型链/链末）
时，Router 无法改走替代路线，但 EC 仍 sleep 退避后 retry → 对已耗尽配额池打 1 次盲重试
（R1 已把同路重试预算归零，但"换路由"分支的无替代兜底仍是盲打）。

**修复**（`plugins/openrouter-router.mjs` + `plugins/execution-continuity.mjs`）：
1. Router 在 agent/request 决议时记录 `st.lastChainIds`（= 该决议的 fallback 链，可被
   模态裁剪到单模型）；quota recovery-requirement 到达时，静态判定用
   `pickQuotaRouteTarget(lastChainIds, sourceModel, cfg)` 精确复刻 agent/request 的
   pickQuotaRouteTarget 语义（无链时保守回退全局池 deepseek/qwen/mimo）。
2. 无替代 → Router **同步** emit `ec/quota-no-alternative`（在 emit recovery-requirement
   期间回执）；agent/request 的 openrouter 链耗尽 / 跨 provider 无替代分支也兜底 emit。
3. EC 消费回执：`it.routerNoAlternative` 一次性标志 → QUOTA case **同一 pass** 直接
   defer（WAITING_PROVIDER，`unavailableUntil` 精确 or bounded），不返回 retry = 零盲重试。

**验证**：`tests/continuity/verify-p26-r1-2-quota-no-alternative.mjs` **10 pass 0 fail**：
V1 静态无替代（单模型链）同步回执+同 pass defer；V2 有替代不误伤（retry + 移出耗尽模型）；
V3 跨 provider（zhipu→openrouter 换池）；V4 迟到回执下一次失败即 defer。
全量 continuity 回归串行通过（p26-r1-1 单独 15/15；其余各 9~41 PASS；并行跑会因共享
EC_STATE_DIR 临时目录冲突致超时，属测试脚手架问题，串行无碍）。

**教训**：
- Router 状态 Map 公开但 `.set` 是整条目替换；集成测试注入字段必须
  `{ ...cur, ...patch }` merge，否则会覆盖 recoveryRequirement 等关键状态。
- EC request-error 的 defer 语义返回 **null**（不是 `{kind:"retry"}`）；断言"无重试"
  写 `!action || action.kind !== 'retry'`。

## 2026-08-28 P2.6 R3 A2 配额重置时间"倒序 ISO-Z"解析失败（真实产品 bug，已修复+已验证）

**现象**：`verify-p26-r1-2-quota-no-alternative.mjs` V5d FAIL——nextRetryAt ≈ now+90s
（bounded backoff），而非精确的 unavailableUntil。V5 是单模型链 + 配额耗尽 + 无替代
→ 走 deferQuota，但 `cls.unavailableUntil === null` → 退化为 90s 轮询，违反 R1.2
"provider 明确给出重置时间时精确 defer"的设计意图。

**根因**：1310 配额消息的常见中文格式是 **"您的限额将在 <UTC ISO 带 Z> 重置"**——
日期在"重置"label **前面**（倒序），且带小数秒 + Z（`2026-08-28T18:21:35.542Z`）。
`parseResetTimestamp` 的优先级链：
1. `RESET_ISO_RE`（正确处理 Z/±hh:mm）只匹配 **label 在日期前**（`重置[^\d]{0,16}日期`）
   → 倒序不匹配；
2. 回退 `RESET_PLAIN_DATE_RE` 能匹配 `2026-08-28T18:21:35`，但 time 组不含 `.542Z`，
   且该分支把 naive 时间**锚定 +08:00** → `18:21:35+08:00` = `10:21:35Z`，早于 now
   → 判"过去时间"返回 null。
结果：unavailableUntil=null → EC 用 bounded backoff 而非精确 defer 到重置点。

**修复**（`plugins/failure-classifier-core.mjs` `parseResetTimestamp`）：
- 新增**位置无关的显式时区 ISO 提取**，置于优先级最前：`(\d{4}-\d{2}-\d{2})[ T]
  (\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))`，带 labeled 守卫
  （文本须含 重置/恢复/解锁/reset）→ `Date.parse` 原样解析（显式时区无需猜测）。
- labeled 守卫防止长消息里无关 ISO 时间戳劫持解析。
- 显式时区信息完整，天然最高可信，放在 CJK/ISO/epoch 之前不改变既有语义
  （既有 D1-D7、A1-A5、F 组全部照旧 PASS）。

**验证**（全部实际运行）：
- `tests/reliability/test-failure-classifier-v1.mjs` **34 pass 0 fail**（新增 D8 倒序 ISO-Z
  精确解析、D8b 倒序 +08:00 保留偏移、D9 无 label 不误抓）；
- `tests/continuity/verify-p26-r1-2-quota-no-alternative.mjs` **17 pass 0 fail**
  （V5d drift=0ms，nextRetryAt 精确等于 unavailableUntil）；
- `tests/continuity/verify-p26-r3-a1-official-retry-zero.mjs` **16 pass 0 fail**（回归无破坏）。

**教训**：
- 供应商配额消息有两种常见语序："重置后 <时间>"（label 前）与"将在 <时间> 重置"
  （label 后）；解析必须位置无关，且**显式时区（Z/±hh:mm）优先于 naive 猜测**。
- naive 时间锚定 +08:00 的分支绝不能接收带 Z/偏移的 ISO——会按本地墙钟误算
  （本 bug 的次根因：RESET_PLAIN_DATE_RE 吞掉 `.542Z` 后仍匹配）。
- 测试新增防回归 case 时必须同时覆盖：倒序 ISO-Z、倒序带偏移 ISO、以及"无 label 不误抓"。

## 2026-08-30 P3 R1 Correction 期间发现：profile 插件部署漂移（pre-existing，未修，需专项处理）

**现象**：`tests/reliability/verify-r2-restart-recovery.mjs` 30 PASS / 6 FAIL，6 个 FAIL
全部来自 `install-plugin --check`（`tools/install-plugin.mjs`）对 profile 部署位的校验失败：
10 个插件的 profile 位比 repo 源旧——ask-telegram / computer-use / secret-gate /
completion-notify / failure-classifier / openrouter-router / agentrouter-wire /
agent-inspector / keepalive-patch / model-selection-guard。

**根因（时间线证据）**：profile 位 secret-gate.mjs LastWriteTime=2026-08-18，而 repo 侧
这些插件 2026-08-23 ~ 08-29 间多次更新（fc181dd/df5bf43/5eff17a 等）后**从未同步到
profile**——即漂移至少从 08-23 起就存在，早于 P3 R1（08-30）与本任务，属长期手工部署
流程欠账。execution-continuity.mjs 在 R1 时已同步（✓ 一致），不在漂移清单。

**影响**：运行中的 3080 服务一直在用旧版插件（ask-telegram/computer-use/secret-gate 等
08-18 版）；`verify-r2-restart-recovery` 的 install-plugin 校验腿因此常绿性破坏
（任何改动前后跑它都会 6 FAIL，与改动无关）。

**为何本任务不修**：同步这 10 个插件=对运行面引入 10 个与本任务无关的行为变更，且需
重启才生效，超出 P3 R1 Correction 范围（变更确认纪律：只报告不执行）。

**修复路径（供后续专项）**：`node tools/install-plugin.mjs --preset
"$env:USERPROFILE\.dsh\.agent-presets\autonomous" --profile "$env:USERPROFILE\.dsh\profiles\web"`
（无 --check 即同步），先由用户确认时机（会引入插件行为变化 + 需重启），同步后重跑
verify-r2-restart-recovery 应回到 36/36。

**附带改进建议（未实施）**：`plugins/autonomy-state-core.mjs` 是 EC 的相对 import 依赖，
但不在 cordis.patch.yml 的 16 个挂载清单里——install-plugin 不会自动同步它，当前靠手动
copy 到 profile。建议后续把它加进挂载清单（属配置变更，需重启生效，故本任务未动）。

## 2026-08-30 P3 R1C 收口时发现：session.list goal 投影落后真实会话状态（observability debt，non-blocking）

**现象**：execution 会话（7177d0c5）真实停止于 14:09（IntentStore lastProgressAt=14:08:55
本地，state=COMPLETED、autonomy.verificationState=VERIFIED），但 `session.list` 的
`projections.values.goal` 仍显示 `updatedAt=13:01:26`（goal 标记 complete rev=3 的时刻）——
比真实会话最后活动早约 67 分钟。

**影响**：仅可观测性/门面展示（消费该投影的界面会看到偏旧的时间戳与 phase）。
不影响 EC 恢复与 autonomy 元数据真源（IntentStore 是唯一真源，恢复逻辑不读该投影）。

**为何本任务不修**：属 `@deepseek-ai/dsh` host 侧 session.list 投影刷新语义，与本轮 P3
修复无关；修复涉及运行中服务进程行为，须专项处理。

**修复路径（供后续专项）**：排查 session.list 投影 updatedAt 的刷新时机（goal phase 变更
后是否不再刷新），确认语义后二选一：修复刷新链路，或文档化"updatedAt=goal 状态变更时刻"
以免误读为会话活动时间。

---

## 2026-09-28 P4 合同缺口 3 处（A10 独立复核确认；本轮**只登记不修**，属既有范畴）

判定 P4 时发现，与 B1/B2 修复无关、也非本轮引入。修复会改 CI 工作流与插件架构 ⇒ 超出本轮授权
（"最小修复 + 终局判定"），故一律 `NOT FIXED / OUT OF SCOPE`，仅登记证据：

1. **AC2 运行时研究腿未接线**：`plugins/learn-candidate.mjs:181` 定义了 `researchPlan`，但 plugins
   全量 grep **仅 1 处命中（=定义本身）**，`learn.mjs` 未 import、无调用者 ⇒ mandatory 场景①
   （陌生低风险任务：自主研究→解决→保存经验）**无插件级证据、未达成**。
   修复方向：决定"研究由 agent 工具链承担并在插件层留痕"或"插件层真接线研究腿"，二选一后补证据。
2. **AC6 Candidate 复用/晋升的 Transaction/canary/deploy 腿零调用**：`learn-candidate.mjs:85-110`
   `STAGE_DELEGATION` 声明了 `dsh-transaction.ps1` / reliability-lab / plugin-transaction，但
   `tests/learn` 中 `Transaction` 引用 **= 0**；且 `ci-level1.yml:191` 把 `dsh-plugin-transaction.ps1`
   列入 `$skip`。CI 腿是真的，其余三条腿**只有声明**。
3. **AC10 CI 内无真实 E2E 门**：本地真实门全绿（`run-learn-real-e2e` 65P、`run-learn-real-gap-e2e` 20P、
   `mount-gate` 1P、`test-learn-real-topology-tool-events` 22P），但 `ci-level2.yml:149-154` **自述刻意
   把 6 个真实数据门排除出 CI** ⇒ 真实 E2E 依赖本地执行，CI 绿不能代表 AC10。

---

## 2026-09-28 任务产物会携带真实凭据副本（实测踩坑 + 处置规则）

**现象**：做"密钥零泄漏"审计时发现，**任务自己的产物**才是真正的泄漏面——`_p4r2-final-closure/checkpoint/.../
cordis.patch.yml.prod.before` 与 `_p4r2-evidence/prod-rollback-*/cordis.patch.yml` 各含 1 个
**与现行生产配置同值**的 Notion PAT（哈希比对确认）；另有 1 份生产 store 快照含 google/stripe 形态的值。

**规则（今后照做）**：任何"改前快照 / 回滚备份 / 会话转储 / 证据副本"在创建时就要**同步脱敏或明确标注**，
不要等事后审计；审计时用"哈希比对"判定是否真值（只输出 true/false，绝不打印值）。

**处置工具（可复用，留在 `_p4r2-final-closure/`）**：`_ac1-workspace-leak-scan.mjs`（19 族扫描）、
`_ac1-hit-classify.mjs`（上下文分类）、`_ac1-peek.mjs`（无泄漏细看：只打前 45 字+占位符）、
`_ac1-redact-artifacts.mjs`（就地脱敏 + 逐文件复验 0）。

**配套坑（判据）**：源码**注释里的示例**（`postgres://user:s3cr3tP@ss@host`）、**源码表达式**
（`token = randomBytes(32).toString('hex')`）、**测试夹具** 都会被密钥模式命中 —— 这三类**不许脱敏**
（会把源码/基线/夹具改坏），要看上下文判定后保留。

## 2026-09-28 PowerShell 5.1 `Out-File -Encoding UTF8` 带 BOM 连环坑（本回合踩两次）

1. 用它写 JSON 供 node `JSON.parse` 读 → `SyntaxError: Unexpected token ''`；
2. 用它写文件再整份 `git commit -F <file>` → 提交标题首字节是 BOM（`git log --format=%s` 显示 `fix(...)`）。

**规则**：给工具/程序消费的文本一律用
`[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`（**无 BOM**）；
读取侧对不可控输入统一 `.replace(/^\uFEFF/,'')` 兜底。（注意与既有铁律区分：`.ps1/.cmd` **必须** UTF-8 **带** BOM。）

## 2026-10-02 监听器形态不匹配 = 静默失效（S1/S2，已修复待部署）

**现象（对官方 base `0.2.0-rc.2` 的静态契约审计发现）**：三个插件的 `ctx.on(...)` 回调参数形态与目标 base
不一致，而**注册成功、无报错、无日志**——只是永远看不到事件：

- S1 `model-selection-guard.mjs` / S1' `context-memory.mjs`：`agent/created` 写成 0.1.1 载体形态
  `(carrier, name, payload)`，官方 base 是 `(payload)` → `payload` 恒为 `undefined`，两个插件的
  `agent/created` 分支永不执行。
- S2 `execution-continuity.mjs`：`session/event` 写成 `(payload)`，官方 base 是 `(session, event)`
  → **P0 可恢复类错误（turn/end error）的第二层兜底永不触发**，可恢复中断不会排队恢复。

**规则**：`ctx.on` 绑定的正确性**不能**用「注册成功 / 进程起来了 / 日志没报错」证明；必须
① 用官方 base 的签名表做**静态契约检查**，② 用**两种形态各自**的行为用例证明回调真的被触发。

**修复**：新增共享形态选择器 `plugins/event-shape-compat.mjs`（多形态识别 + 未知形态显式
`LISTENER_BINDING_FAILED` + 启动自检 + 诊断只带形态不带值），三个插件改为 `(...args) => pick…(args)`，
**回调函数体一字未改**（降低 P0 判定逻辑的回归风险）。

**证据**：`_p4_5-sandbox/evidence/session-compat/S1_S2_LISTENER_BINDING_REMEDIATION.md`
（含 INERT 反证 / BOUND 双向用例 / FAIL-SAFE / 前后哈希 / 复现命令 / 回滚）；测试
`tests/continuity/verify-s2-listener-binding.mjs`（24 PASS）、`plugins/model-selection-guard-test.mjs`（21 PASS）。

**边界**：本修复已在**候选树**验证；生产插件改了必须重启服务才生效，故按阶段计划**批量延后部署**——
在部署前，生产侧仍是旧字节（静态审计的生产列仍会显示这三条缺陷，属预期状态而非遗漏）。
