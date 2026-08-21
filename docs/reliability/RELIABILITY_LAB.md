# Reliability Lab — Harness Reliability Control Plane v1 (Stage F)

Chaos 绝不直接对真实生产环境"乱搞"。可靠性实验分三层，越往后越接近真实，
每层都有明确的隔离边界与允许环境（见 FAULT_CATALOG.md 的 allowedEnvironment）。

## Level 1 — Synthetic Faults（隔离合成测试）

执行器：`dsh-reliability-lab.ps1`

```powershell
powershell -File dsh-reliability-lab.ps1 -List      # 列出已登记故障
powershell -File dsh-reliability-lab.ps1 -RunAll    # 运行全部 L1 故障
powershell -File dsh-reliability-lab.ps1 -Run F-YAML-001,F-STATE-001
```

隔离保证：
- 所有模块状态走 `%TEMP%\dsh-lab-*` 隔离路径（DSH_BOOT_MODE_PATH / DSH_RESTART_BUDGET_PATH /
  DSH_SAFE_FLAG_PATH / DSH_SAFE_PROFILE_DIR 环境变量覆盖）
- 不接触真实 profile、真实服务、真实 session
- 覆盖 FAULT_CATALOG：F-YAML-001 / F-PROC-004 / F-TX-001..003 / F-STATE-001..003 / F-SEC-001

当前状态：**9/9 PASS**（2026-08-21，reliability-v1）

## Level 2 — Experimental Profile Chaos（实验环境故障注入）

允许环境：experimental profile（`~/.dsh/profiles/experimental`），禁止第一轮注入用真实
Normal profile。

登记场景（对应 FAULT_CATALOG）：

| chaos | fault | 场景 |
|---|---|---|
| CHAOS-01 | F-YAML-001/002 | YAML 语法损坏 → Verified LG 恢复 |
| CHAOS-02 | F-CONFIG-001/002 | YAML valid 但运行时坏 → 禁止 promote LG → rollback |
| CHAOS-03 | F-CONFIG-003 | 插件部分修改 → verify fail → rollback → hash 还原 |
| CHAOS-04 | F-PROC-001 | 已验证 DSH 进程崩溃 → guardian 检测 → 受控重启 → 新 generation → client_ready |
| CHAOS-05 | F-LOOP-001 | 重启风暴 → Restart Budget → circuit → escalation |
| CHAOS-06 | F-LOOP-002 | Normal 恢复失败 → Safe Mode |
| CHAOS-07 | F-SAFE-001 | Safe Boot → 真实 Safe Session completed |
| CHAOS-08 | F-SAFE-002 | Safe Exit → Normal 仍坏 → 自动回 Safe |
| CHAOS-09 | F-SAFE-003 | Normal 修复 → Safe Exit → Normal client_ready |
| CHAOS-10 | F-SEC-001 | 诊断注入假 secret → CI 必须 FAIL |

执行方式：CI Level 4（nightly/manual/release-candidate）驱动；本地可手动在
experimental profile 上逐个执行。**不要求每个 PR 都跑。**

## Level 3 — Production Shadow（生产影子演练）

不破坏真实重要 Session。创建 `production-shadow` 影子环境：
- 复制 **sanitized** 生产配置（去除真实 Secret 明文，值替换为占位符）
- 复制插件组合结构、provider schema、model registry 结构
- 匿名/测试 session
- 启动拓扑

演练完整事故链（Final Reliability Drill 的预演）：

```
Golden → Bad Change → Health FAIL → Rollback → Recovery FAIL → Safe Mode
→ Safe Session → Repair Normal → Exit Safe → Normal → Full Health
```

只有这条链在 shadow 环境完整 PASS，才把 Recoverability 正式标为 PASS。

## 运行纪律

- 每个 fault 必须先在 FAULT_CATALOG.md 登记（faultId / injection / expected / dataRisk / env）
- L1 必须全绿才能推进 L2
- L2 只允许在 experimental 环境
- L3 只允许在 production-shadow 环境
- 真实生产环境的任何故障注入 = 违反本 Lab 章程
