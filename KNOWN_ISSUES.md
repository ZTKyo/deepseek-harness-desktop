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
