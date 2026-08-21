# FAULT CATALOG — Harness Reliability Control Plane v1

每个受控故障都必须在此登记。Chaos 测试禁止发明未登记的故障注入。

## F-YAML 系 — 配置语法故障

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-YAML-001 | settings.yaml 语法损坏 | 写入非法 YAML（截断/错缩进） | Test-YamlFile=false | Guardian Check-ConfigSafety 从 guardian-lastgood 镜像恢复 | RECOVERED（Normal） | LOW（配置文件可恢复） | L1/L2/L3 |
| F-YAML-002 | cordis.patch.yml 语法损坏 | 写入非法 YAML | Test-YamlFile=false | 同上恢复镜像 | RECOVERED | LOW | L1/L2/L3 |

## F-CONFIG 系 — 语法有效但运行时有毒

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-CONFIG-001 | settings.yaml 语法有效但引用不存在 provider | 设置 provider: no-such-provider | boot 失败（api_unready） | 事务 ROLLBACK；**禁止 promote Last Good**（syntax valid != LG） | ROLLED_BACK | MEDIUM（配置被改） | L2/L3 |
| F-CONFIG-002 | 语法有效但引用不存在 model | model: no-such-model | boot 失败 | 同上 | ROLLED_BACK | MEDIUM | L2/L3 |
| F-CONFIG-003 | plugin 引用不存在文件 | patch 里 name: './missing.mjs' | boot 失败 | 事务 ROLLBACK + 恢复镜像 | ROLLED_BACK | MEDIUM | L2/L3 |

## F-PROC 系 — 进程/身份故障

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-PROC-001 | 已验证 DSH 进程崩溃 | Stop-Process（身份已核验） | Guardian 检测 readiness 下降 | 受控重启（restart budget 内）→ 新 generation → client_ready | RECOVERED | LOW | L2/L3 |
| F-PROC-002 | 僵尸监听者占用端口 | 伪造 DSH 身份进程占 3080 | Get-DshLoopbackOwner=ok 但 readiness 失败 | CleanReclaim 回收（仅限已核验 DSH 身份） | RECOVERED | LOW | L2/L3 |
| F-PROC-003 | 身份不匹配的监听者 | 非 DSH 进程占端口 | owner=identity_mismatch | **不杀**，跳过并告警 | LEFT_ALONE | LOW | L2/L3 |
| F-PROC-004 | stale PID 文件 | 写入不存在的 PID | 身份模块验证失败 | 忽略/清理 stale 状态 | RECOVERED | LOW | L1 |

## F-LOOP 系 — 重启风暴

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-LOOP-001 | 连续启动失败（重启风暴） | 反复注入 toxic config | Restart Budget attempts 达阈值 | circuit open（15min pause）→ Restore Verified Last Good → 再试 | NORMAL_RECOVERED | MEDIUM | L2/L3 |
| F-LOOP-002 | 恢复仍失败 | 风暴后仍无法 client_ready | budget 耗尽 + verify 失败 | ENTER_SAFE_MODE（boot-mode=safe） | SAFE_MODE | MEDIUM | L2/L3 |

## F-SAFE 系 — Safe Mode 状态机

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-SAFE-001 | Safe Boot 正常 | boot-mode=safe + safe profile | 新 generation + 完整 readiness | Safe 会话验证 | SAFE_ACTIVE | LOW | L2/L3 |
| F-SAFE-002 | Safe Exit 后 Normal 仍坏 | Normal 配置保持 toxic | Exit 后 verify 失败 | 自动 boot-mode=safe → 重启 Safe | RETURNED_TO_SAFE | LOW | L2/L3 |
| F-SAFE-003 | Normal 已修复 → Safe Exit | 恢复 Normal 配置 | Exit 后 verify 通过 | SAFE_EXITED | LOW | L2/L3 |

## F-TX 系 — 事务/检查点

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-TX-001 | 坏 checkpoint 路径 | Restore 指向不存在目录 | 返回 checkpoint_not_found | 安全失败，不破坏现状 | FAILED（无副作用） | LOW | L1 |
| F-TX-002 | 损坏事务 manifest | 写坏 manifest.json | 读取失败 | 跳过损坏记录 | FAILED | LOW | L1 |
| F-TX-003 | 事务 apply 失败 | Apply 抛异常 | 状态机捕获 | ROLLBACK + 恢复 | ROLLED_BACK | LOW | L1/L2 |
| F-TX-004 | 事务 verify 失败 | toxic apply | COMMIT_READY 失败 | ROLLBACK → RESTART → VERIFY_RECOVERY | ROLLED_BACK | MEDIUM | L2/L3 |
| F-TX-005 | 恢复仍失败 | toxic apply + 无法恢复 | recovery 失败 | ESCALATE_TO_SAFE_MODE | SAFE_MODE | MEDIUM | L2/L3 |

## F-SEC 系 — 安全/密钥

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-SEC-001 | 诊断输出注入假 secret | 在配置中放密钥样式的值并运行诊断 | secret 扫描 | CI 必须 FAIL；诊断必须脱敏 | BLOCKED | HIGH | L1/CI |
| F-SEC-002 | 私钥文件进入工作树 | 写入 *.pem/*.key | gitignore + 扫描 | CI 必须 FAIL | BLOCKED | HIGH | L1/CI |

## F-STATE 系 — 状态文件

| faultId | description | injectionMethod | expectedDetection | expectedAction | expectedFinalState | dataRisk | allowedEnvironment |
|---|---|---|---|---|---|---|---|
| F-STATE-001 | 损坏 boot-mode 状态 | 写非法 JSON | Get-DshBootMode 捕获 | 回退 normal（RC8 兼容） | NORMAL | LOW | L1 |
| F-STATE-002 | 损坏 restart-budget 状态 | 写非法 JSON | Read-DshRestartBudget 捕获 | 回退默认预算 | NORMAL | LOW | L1 |
| F-STATE-003 | 损坏 safe-mode 状态 | 写非法 JSON | Read-SafeFlag 捕获 | 按未进入处理 | NORMAL | LOW | L1 |
