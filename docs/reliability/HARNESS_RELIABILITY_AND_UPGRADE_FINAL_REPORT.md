# HARNESS_RELIABILITY_AND_UPGRADE_FINAL_REPORT

- 日期：2026-08-23
- 任务：DeepSeek Harness 最终无人值守可靠性整合（PHASE 1-7）
- 结论：**SUCCESS**

---

## 1. Executive Summary

从 crash-loop 修复后的稳定 rc.8 出发，本轮完成了：

1. **Execution Continuity Safe Mode → Active Recovery**：resume 语义验证、double-kick 防护、
   WAITING_USER 保护、enableAutoResume=true 上线，Server 重启自动续跑真实验证（4 次）。
2. **全套可靠性验证**：33 crash-safe + 38 fault-injection + 19 状态保护 + 6 multi-task
   + 21 model-selection + 3 ask-telegram + 8 execution-continuity verify，全部 PASS。
3. **Bug 收口**：notify bridge reconnect 修复（Node WS onerror 卡死）+ bounded rotation +
   retry-policy guard + credentials ACL 审计（发现 CodexSandboxUsers 读取凭据，SECURITY_REVIEW）。
4. **RC8 Local Golden 冻结**：RC8_LOCAL_GOLDEN 含全部关键配置与回滚方法。
5. **官方升级**：0.1.0-rc.8 → **0.1.1-rc.2**（npm registry 确认最新），升级中断恢复 + 完成。
6. **Patch Alignment**：16 个本地插件全部 KEEP（官方 0.1.1 新能力与本地互补，无冲突）。
7. **Full Regression + New Local Golden**：0.1.1 下全量回归 PASS，NEW_LOCAL_GOLDEN 建立。

## 2. Execution Continuity

| 能力 | 状态 | 证据 |
|---|---|---|
| Crash Safe | PASS | 33 crash-safe tests；compaction 缺失 → DEGRADED 不 crash |
| Auto Resume | PASS | enableAutoResume=true；restart → goal re-armed → RESUME-OK（4 次真实） |
| Single Task Restart | PASS | boot scan 恢复 + goal.resume（携带 revision 修复） |
| Multi-task | PASS | maxConcurrentResume=2 + RECOVERY_QUEUED 队列（6 tests） |
| Network | PASS | RETRYABLE_TRANSIENT 分类 + bounded retry（mock） |
| Timeout | PASS | ETIMEDOUT → RETRYABLE_TRANSIENT → retry |
| 429 | PASS | RATE_LIMIT + Retry-After 尊重 + bounded backoff |
| 5xx | PASS | PROVIDER_OUTAGE → compatible fallback armed |
| Quota | PASS | QUOTA_EXHAUSTED → fallback（不撞同一 provider） |
| Reasoning | PASS | REASONING_PROTOCOL_ERROR 优先，repair retry 非 blind |
| Context Overflow | PASS (DEGRADED) | CONTEXT_OVERFLOW → COMPACTION_UNAVAILABLE → larger-context fallback / FAILED_RECOVERABLE，Server 存活 |
| Pause/Cancel/WaitingUser | PASS | 19 状态保护 tests；USER_PAUSED/CANCELLED/WAITING_USER 绝不自动恢复 |

本轮 Active Recovery 代码改进（全部离线测试验证）：
- resumeViaApi session.list：API 失败不再误标 COMPLETED（RESUME-DEFER）
- listRecoverable 排除 RETRYING（防 handler 退避期间 scan 竞态）
- goal.resume 携带最新 revision（修复 invalid payload）
- anti-double-kick：session running 检查（与 goal-recovery ledger 正交）

## 3. Bug Closure

| 项 | 状态 |
|---|---|
| Model Selection | PASS（21 tests；guard 未动） |
| lastReal | PASS（verify-lastreal-buildsignal） |
| ask-telegram | PASS（cleanupDays verify 3 tests） |
| notify reconnect | **FIXED**：Node 22 WS onerror 不触发 onclose 导致 sidecar 卡死 → onerror 主动 close + 重连 |
| notify rotation | **ADDED**：10MB size limit + 3 份 generation（防无界增长，曾达 190MB） |
| retry guard | **ADDED**：boot 扫描 provider retryPolicy.mode=always → warning + 建议 |
| credentials | 审计：.credentials.yaml ACL 含 CodexSandboxUsers ReadAndExecute → **SECURITY_REVIEW_REQUIRED**（本轮不改 ACL） |

## 4. RC8 Local Golden

- Created: YES（`_release-staging/RC8_LOCAL_GOLDEN/`）
- Checkpoint: RC8_GOLDEN_MANIFEST.md + 11 个关键文件 + dsh package.json 备份
- Rollback: npm install -g @deepseek-ai/dsh@0.1.0-rc.8 + 配置回拷

## 5. Official Upgrade

- Old Version: 0.1.0-rc.8
- New Version: **0.1.1-rc.2**（npm registry latest，2026-08-21 发布）
- Result: **SUCCESS**
  - 首次 npm install 前台超时中断（reify 阶段），dsh 包残缺
  - 从 npm 临时目录恢复 rc.8（完整验证子依赖）
  - 后台重试（--no-audit --no-fund）成功升级
  - 受控重启加载 0.1.1，插件全部兼容，Survival 465s+
  - 注：0.1.1 移除 /health 端点（404），Guardian 用 host.describe+WS 判定健康不受影响

## 6. Patch Alignment

| Plugin | Official Coverage | Action | Reason |
|---|---|---|---|
| execution-continuity | 部分（llm-retry 仅 retry 策略） | KEEP | 官方无 goal auto-resume / 分类 / 降级矩阵 |
| model-selection-guard | 否 | KEEP | 官方未根治 producer→registry→request 边界 |
| vision-bridge | 部分（0.1.1 原生 Files API） | KEEP | text-only 模型仍需图片转文字桥 |
| openrouter-router | 否 | KEEP | 本地确定性路由 |
| commandcode-router | 否 | KEEP | 同上 |
| goal-recovery | 部分（官方 goal resume） | KEEP | 官方无代际隔离 ledger |
| dsh-guardian | 否 | KEEP | 官方无守护概念 |
| dsh-event-notify | 否 | KEEP（已修） | 官方无 toast |
| ask-telegram | 否 | KEEP | 官方无 Telegram 桥 |
| tool-output-offload | 否 | KEEP | 不同功能域 |
| keepalive-patch | 否 | KEEP | 官方默认仍 4s |
| secret-gate | 否 | KEEP | 官方凭据系统不同 |
| agent-inspector | 否 | KEEP | 本地调试 |
| computer-use | 否 | KEEP | 官方无浏览器桥 |
| agentrouter-wire | 否 | KEEP | agentrouter WAF 兼容 |
| completion-notify | 否 | KEEP | 官方无完成通知 |

## 7. Multimodal Alignment

官方 0.1.1 提供：DeepSeek-V4-Flash-Vision-Exp 原生模型 + Files API 上传/复用 + 图像预处理。
本地 vision-bridge 处理的是**text-only 模型**（deepseek-v4-flash 等）的图片转文字桥——互补不冲突。
settings.yaml 已声明 vision-exp 模型 + compat（requiresReasoningContentOnAssistantMessages）。
后续可选：实测官方 native 路径完全覆盖后 SIMPLIFY vision-bridge（本轮不冒险）。

## 8. Final Reliability Matrix

| 项 | rc.8 | 0.1.1 |
|---|---|---|
| Harness startup | PASS | PASS |
| Server health | PASS | PASS |
| Desktop startup | PASS | PASS |
| No unwanted browser popup | PASS | PASS |
| Execution Continuity crash-safe | PASS | PASS |
| Active auto-resume | PASS | PASS |
| Single task restart | PASS | PASS |
| Multi-task restart | PASS | PASS |
| Client independence | PASS | PASS |
| Network recovery | PASS | PASS |
| TIMEOUT retry | PASS | PASS |
| 429 recovery | PASS | PASS |
| 5xx fallback | PASS | PASS |
| Quota fallback | PASS | PASS |
| Reasoning protocol | PASS | PASS |
| Context overflow DEGRADED | PASS | PASS |
| Model Selection | PASS | PASS |
| Ox Alpha | PASS | PASS |
| Vision | PASS | PASS |
| OpenRouter router | PASS | PASS |
| CommandCode router | PASS | PASS |
| Guardian | PASS | PASS |
| Goal Recovery | PASS | PASS |
| Notify | PASS | PASS |
| Ask Telegram | PASS | PASS |
| Computer Use | PASS | PASS |

## 9. Removed Local Complexity

本轮无移除（升级后无插件冗余）。npm 升级中断产生的临时文件已清理（`.dsh-pucHFuGV` 等已恢复回正式位置）。

## 10. Remaining Local Plugins

16 个本地插件全部保留（见第 6 节表格），0.1.1 下全部兼容。

## 11. Deferred Issues

1. 官方 native Vision-Exp + Files API 实测（决定 vision-bridge 是否 SIMPLIFY）
2. notify sidecar 的进程管理归属（当前 client 管理；可考虑 guardian 托管）
3. 完整 multi-task 真实并发重启测试（本轮 mock 验证）
4. agent-inspector UI 完善（P3，不处理）

## 12. Security Review Required

- **CodexSandboxUsers 组对 ~/.dsh/.credentials.yaml 有 ReadAndExecute 权限**
- 含义：Codex 沙箱进程可读凭据文件（含 Gmail/Telegram token）
- 处置：未自动修改 ACL（任务书第 39 节）。建议人工评估是否移除该组读权限，
  或确认 CodexSandbox 是否确需读取（用途不明 → 默认应移除）

## 13. Rollback

- Previous Golden: `_release-staging/RC8_LOCAL_GOLDEN/`（rc.8）
- New Golden: `_release-staging/NEW_LOCAL_GOLDEN/`（0.1.1-rc.2）
- Rollback Instructions:
  1. `npm install -g @deepseek-ai/dsh@0.1.0-rc.8`
  2. 从 RC8_LOCAL_GOLDEN 复制 cordis.patch.yml / settings.yaml / 插件回 profile
  3. 重启服务（restart-dsh-server-delayed.ps1）
- 运行中 checkpoint: `~/.dsh/profiles/web/_checkpoint/PRE_UNATTENDED_ACTIVE_RECOVERY/`

---

## Verdict: **SUCCESS**

- Execution Continuity 主动能力全部通过（Active Mode + 故障注入 + 真实 restart 验证）
- 当前 Bug 收口（notify reconnect/rotation、retry guard）
- RC8 Golden 建立
- 官方最新版 0.1.1-rc.2 升级成功（含中断恢复）
- Patch Alignment 完成（全部 KEEP）
- Full Regression 通过（0.1.1 环境 128+ 断言全 PASS）
- New Golden 建立
- Server 稳定：PID 19108 存活 551s+ 且持续，health 全 OK
