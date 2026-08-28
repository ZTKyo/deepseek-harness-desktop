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
