# P2.6 R1.1 — direct managed provider 配额耗尽跨池回退（Blocker 1）完成报告

日期：2026-08-28
会话：session-a144fe3f
状态：实现 + 验证完成（**随 R1.1 PR 提交，未单独部署到运行 profile**；R1 授权范围内增量）

## 背景与目标（Blocker 1）

R1 已把 1310/QUOTA_EXHAUSTED 分类为不可重试（无窗口）+ unavailableUntil 语义，R2 打通了
commandcode 主力配额耗尽 → EC 发 quota requirement → Router commandcode 分支跨 provider
改写 openrouter（不同配额池）。R1.1 补齐 **direct managed provider**（zhipu/bai）这一缺口：
zhipu/bai 主力配额耗尽时，同样发 quota requirement 并记录 `sourceProvider`/`sourceModel`，
Router 泛化 `isPrimaryModel` + 复用 `pickQuotaRouteTarget`（**零第二引擎**），任一主力
（zhipu/bai/opencode/commandcode）出现 quota requirement 即跨 provider 改写 openrouter，
未命中不误伤。

## 交付物（repo 工作区；随 R1.1 PR 提交）

| 文件 | 类型 | 说明 |
|---|---|---|
| `plugins/openrouter-router.mjs` | 修改 | `isPrimaryModel` 泛化 + quota requirement 分支覆盖 direct managed provider；复用 `pickQuotaRouteTarget` |
| `plugins/execution-continuity.mjs` | 修改 | quota requirement 记录 `sourceProvider`/`sourceModel` |
| `tests/continuity/verify-p26-r1-1-managed-direct-quota.mjs` | 新增 | R1.1 验证套件（15 断言，本地实测） |
| `docs/roadmap/evidence/P26_R1_1_MANAGED_DIRECT_QUOTA_VERIFY.md` | 新增 | 证据存档（完整输出） |

## 测试证据（全部本地实测，2026-08-28）

| 套件 | 断言 | 结果 |
|---|---|---|
| `verify-p26-r1-1-managed-direct-quota.mjs`（R1.1） | 15/15 | PASS（zhipu 配额→openrouter、bai 配额→openrouter、commandcode 回归、无 requirement 不误伤、openrouter 分支不回归） |
| `verify-p26-r2-commandcode-quota.mjs`（R2 回归） | 9/9 | PASS |
| `verify-p26-r1-quota-defer.mjs`（R1 回归） | 18/18 | PASS |
| `verify-p26-r1-network-error.mjs`（R1 回归） | 20/20 | PASS |
| `verify-p26-r1-rollback-switch.mjs`（R1 回归） | ALL PASS | PASS（含开关 OFF 恢复语义） |
| `test-failure-classifier-v1.mjs`（classifier 纯单元） | 31/31 | PASS |
| `verify-p26-r3-retry-policy.mjs`（R3 本地线） | 41/41 | PASS（R3 guard 在部署 EC 上，与 R1.1 正交；不随 R1.1 PR） |

合计 **134+ 断言 0 fail**。全部脚本 `node --no-warnings` 直接运行正常退出（exit=0）。

证据分类（沿用 R1 报告的 REAL/CONTROLLED/SYNTHETIC/INFERRED）：
- **REAL**：1310 分类规则来自 2026-08-28 真实 incident（bai/glm-5.3-flash 流式网络故障）；zhipu 1310 code 为真实错误体样本。
- **CONTROLLED**：R1.1 15 断言全部为受控注入（模拟 quota requirement 事件经 EC → Router 全链路解析）。
- **SYNTHETIC**：测试夹具中的 provider/model 名（glm-4.6、deepseek-v4-flash 等）为合成路由目标。
- **INFERRED**：openrouter 与 direct managed provider 属不同配额池（供应商隔离）——依据 provider 池配置，无独立计量观测。

## 部署与回滚（如实记录）

- **R1.1 改动当前仅在 repo 工作区，未部署到运行 profile**（`~/.dsh/profiles/web/`）。
  运行 profile 的 router 为 R1 版本（BD453674），EC 为 R3 中间态（含 R3 guard、不含
  sourceProvider）。R1.1 随 PR 合入后，按 R1 事务流程统一部署。
- **R1.1 与 R3 为同一文件（EC/router）上的两组正交改动**：R1.1 = sourceProvider +
  managed-direct 覆盖；R3 = RATE_LIMIT-free retry policy。两者各自独立验证通过，
  **合并部署前需重新跑一次 R1.1 + R3 双方套件确认无回归**（见「后续」）。
- 备份：`DSH-Client/_backup-p26-r2/`（openrouter-router.mjs.20260828-180756.bak +
  settings.yaml.20260828-180756.bak，R2 线留存）。R1.1 无独立部署，无需额外回滚文件；
  回滚 = git revert PR 即可。

## 过程发现与处置

1. **R2 报告"本地部署"表述不精确**：R2 实际只把改动留在 repo 工作区 + 备份，未覆盖
   profile 运行版本。本报告已如实修正为"随 PR 提交、未部署"。
2. **部署漂移风险**：profile 的 EC（18:51）含 R3 guard、不含 R1.1 sourceProvider；
   repo 工作区 EC 反之。二者需在下次部署时合并并双线回归。
3. **Router 惰性 Socket 句柄残留（R1 既有，非本次引入）**：agent/request 路径产生 1 个
   Socket 句柄；测试脚本顶层 `process.exit(0)` 已规避；不影响运行中服务（进程常驻）。
   工具管道 `2>&1` 会因 node stderr 警告造成伪超时，须 `node --no-warnings` 直接运行。

## 结论

direct managed provider（zhipu/bai）配额耗尽可自动跨 provider 落到 openrouter（不同配额池），
补齐 R5 typed bridge + R2 commandcode 覆盖后的最后一类主力 provider；零第二引擎、无行为回归。
状态维持 **IMPLEMENTATION_COMPLETE / AWAITING_EXTERNAL_REVIEW**（R1 授权范围内增量，
随 R1.1 PR 提交）。

## 后续（部署时必做）

- [ ] R1.1 PR 合入后：按 R1 事务流程将 repo 版 EC/router/classifier 部署到
      `~/.dsh/profiles/web/`，**与 R3 guard 合并**。
- [ ] 合并部署后重跑 R1.1（15）+ R2（9）+ R1 三套件（18/20/ALL）+ R3（41）回归，
      确认双线无冲突。
- [ ] 重启后终验清单（R1 报告 82-92 行的复用项）按 R1 流程执行。
