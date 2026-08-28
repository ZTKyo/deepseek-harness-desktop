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
1. classifier 测试 ailure-classifier 断言 unavailableUntil 取到 null / 解析差 8h；
2. 集成测试 erify-p26-r1-quota-defer.mjs：V1e/V2d/V4a FAIL（15 pass 3 fail），defer 不生效。
**根因**：真实 zhipu/bai 1310 报错里的 naive 时间（"2026-08-28 15:06:06 重置"）是**服务端本地时区（Asia/Shanghai +08:00）**，无时区后缀；core 解析时固定锚定 +08:00（CJK 服务商）。但测试构造 naive 串用的是**进程本地时钟**——UTC runner 上 
ew Date(RESET_AT) 的 getHours() 是 UTC 小时，core 按 +08:00 解释 → 时间偏移 8h、甚至落入过去 → parseResetTimestamp 返回 null。
**修复**：测试构造改为 
ew Date(RESET_AT + 8*3600e3) 取 **getUTC* 分量**生成 naive 串（模拟服务端 +08:00 墙钟），任何主机 TZ 下一致；V2 variant 小时同改 getUTCHours()。core 侧见 commit e72f879。
**教训**：
- 涉及"服务端 naive 时间解析"的测试，**必须模拟服务商时区（+08:00）构造输入**，不能依赖进程本地 TZ；本地过了 ≠ CI 过，务必用 TZ=UTC（或 CI 实测）复验。
- 时区相关修复要同时检查 core 解析 + 所有测试 fixture 的构造，两边都可能各错一半。
- 对 Windows 上 node 设置 TZ 环境变量在同一命令行内生效（$env:TZ='UTC'; node ...）；pwsh 分号连接即可，不要用外部包装。