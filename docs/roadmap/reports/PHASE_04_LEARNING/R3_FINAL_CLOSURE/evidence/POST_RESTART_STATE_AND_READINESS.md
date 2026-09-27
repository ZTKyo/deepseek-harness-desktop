# POST_RESTART_STATE_AND_READINESS.md

> 本文件是 2026-09-28 07:22 重启之后**本轮实际取得的状态与就绪度**记录，
> 并**明确拒绝**在真人审批门未通过前冻结 `POST_P4_VERIFIED_GOLDEN`。
>
> 时间：2026-09-28 07:22 ~ 07:50（本地）｜执行：主 Agent（自主执行）

## 0. 一处自我纠正（必须留痕）

07:44 我一度生成过 `POST_P4_VERIFIED_GOLDEN.txt` 并把 P4 判为 `VERIFIED`。
随后逐条对照 `_TASK_SPEC.md` 的 **A11 门槛**（"只有全部满足……才能 P4 = VERIFIED"）发现：
门槛里包含 **real human approval PASS / global publish PASS / new-session recall PASS /
applicability PASS / reuse PASS / reverify PASS**，而这 6 项**当前都还没有完成**
（真人审批门按规定停住，A9 之后的步骤尚未开始）。
⇒ 那份 `POST_P4_VERIFIED_GOLDEN.txt` 是**越权断言，已作废并删除**（未提交 git、未被任何文件引用）。
作废件的可识别指纹：`sha256=534EB6795093D8157762CB46043DFFABDA81AD98C7F3410AECD458A9FB9DC099`、`size=5540`、
生成时间 07:44、删除时间 07:47。
本文件取代它。**这正是"历史不做洗白"要求的处理方式：先纠正，再记录纠正本身。**

## 1. 本轮真正达成（全部有机器可核证据）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 新进程在位且健康 | 旧 PID 20580 → 新 PID **20528**（07:22:45 启动，`Get-NetTCPConnection`+`Get-Process` 核对）；`GET http://127.0.0.1:3080/ -> 200` |
| 2 | `source == deployed` | 生产 profile 与仓库 `_p4r2-inject-fix/plugins` 4/4 文件逐字节 SAME（sha256 见第 3 节） |
| 3 | `deployed == loaded` | 运行时行为探针：探针会话 `session-348f2f5c-…` 真实 `learn_recall` 返回带 `researchDirective{legId:leg_6206c91a}` ⇒ **`VERDICT=NEW_CODE_LOADED`，exit=0** |
| 4 | 生产健康/安全扫描 | 重复注册 **无**、插件加载失败 **无**、learn 相关错误 **无**、未捕获异常 **无**；旧 mount 崩溃签名在当前 boot 内 **0**（本 boot 首行 2383021 > 最后崩溃签名行 2155440）；家族密钥泄漏 `LEAK_AUDIT=CLEAN`（家族 19 / 文件 14 / 零命中） |
| 5 | 工具面 | 生产进程侧：日志无重复注册 + 本会话工具面恰好 **6 个 `learn_*`** 无重复 + 行为探针成功；真实加载器 mount 门（同字节、隔离宿主）捕获**恰好 6 个、无重复**（`deploy-preflight` A2 / `mount-gate` 1P/0F） |
| 6 | 全量回归（新字节） | `regression.post-restart-v3.txt`：**34/34 全绿**，门槛断言 **1217 PASS / 0 FAIL**，含 `test-learn-ac6-real-promotion-e2e` **24P/0F**（真实提升 E2E，真 git worktree + 真 CI 作业 + 真事务） |
| 7 | 生产负向安全 8 项重检 | 8/8 DENIED，逐项承载断言见 `PROD_NEGATIVE_8_MATRIX.md`；生产侧旁证：全局库 `experiences: []`、2×`GLOBAL_PUBLISH_DENIED`、实时 `learn_recall items:[]` |
| 8 | 本轮口径修正（透明） | 回归器 3 处把"非产品失败"误判为 FAIL 的问题已修（`--deploy` 参数、无数字摘要的 `VERDICT=` 裁决行、`exit 2 + 环境字样` 单列 ENV）；**未放宽任何断言**（`OLD_CODE_STILL_LOADED` 仍判 FAIL） |
| 9 | 提交 | `e2f51ec3ef0d`（分支 `p4-final-b1b2-fix`）：AC2/B1B2 收尾证据 + 探针脚本 + 回归器口径修正；工作树清零后 **ac6 的真实 git 前置被满足，ac6 真的跑起来并通过** |

## 2. 当前 P4 判定（A11 门槛逐项）

| A11 门槛项 | 当前状态 | 依据 |
|---|---|---|
| B1 CLOSED | ✅ | `test-learn-b1-session-access` 22P/0F；生产无 `approval_host_fact_session_unavailable` |
| B2 CLOSED | ✅ | `test-learn-b2-verify-output-contract` 21P/0F；`value.method` 合法且来自真实 file_hash |
| production healthy | ✅ | `GET / = 200`，PID 20528 |
| 6 learn tools loaded | ✅ | 见第 1 节 #5 |
| negative security PASS | ✅ | 8/8 DENIED（`PROD_NEGATIVE_8_MATRIX.md`） |
| **real human approval PASS** | ❌ **未完成** | A8 门停住：等待真人对精确 digest 的 APPROVE/REJECT；代理请求被拒（未自动批准、未模拟真人） |
| **global publish PASS** | ❌ 未开始 | 依赖上一步（A9） |
| **new-session recall PASS** | ❌ 未开始 | 依赖 publish（A9.1） |
| **applicability / reuse / reverify PASS** | ❌ 未开始 | A9.2/A9.3 |
| AC1–AC10 PASS | ✅ | `run-learn-contract-scenarios` 36P/0F；矩阵见 `A10_CONTRACT_MATRIX.md` |
| mandatory scenarios PASS | ✅ | 4 个 mandatory scenarios 全 PASS |
| no blocker | ⚠️ **有唯一阻塞**：真人审批门 | 该阻塞**是设计要求的停点**，不是缺陷 |

### ⇒ 判定：`P4 = NOT_VERIFIED（BLOCKED_AT_HUMAN_GATE）`

- `POST_P4_VERIFIED_GOLDEN` **不予冻结**（冻结动作必须发生在真人批准 + A9 五步 + A11 全门槛满足之后）。
- `STAGE B (P4.5 只读审计)` **不进入**（规范要求：仅在 P4=VERIFIED 之后）。
- 本回合到此为止是**规范要求的正确停点**，不是失败。

## 3. 冻结基线（供批准后核对；现在只作"当前状态快照"）

```
Git        HEAD = e2f51ec3ef0dc7ed149da69ef1d741f38f7348f2（branch p4-final-b1b2-fix）
           origin/main = 171f1b4（分支已含 origin/main 全部提交，ahead 19，无 force push）
插件哈希    learn.mjs          bf5cfa6d7f0360751bc2c252a7b93e870804a56c39abfdc16c5eb270813a4ffc
           learn-core.mjs     38c1d09296aa4bc1c8144603698434292f8455a2139a66a10fd4a6721be5700c
           learn-candidate.mjs f732806aa5f9d868febd07d597f78c4fb65858e51f5cbf1c9de9a3b831514e97
           learn-gap-veto.mjs  b7623cedf87e13f49500b368e27bbf9dc358b9b400d7a0b7a064e1c27a090b36
           生产 profile 与仓库同名字节一致（SAME）
运行时      port 3080 / PID 20528 / 启动 2026-09-28 07:22:45 / GET / = 200 / VERDICT=NEW_CODE_LOADED
工具面      learn_propose, learn_review, learn_recall, learn_status, learn_verify, learn_promote（6 个，无重复）
测试        regression.post-restart-v3.txt：34/34 全绿，门槛断言 1217 PASS / 0 FAIL
回滚点      DSH-Client\_backup-learn-20260928-AC2deploy（5 文件）；
           git p4-final-b1b2-fix@e2f51ec3ef0d（上一提交 9a318fc）
待办（真人） 在审批策略=ask 的会话中批准 exp-2ed0f0c9（精确 digest 绑定）
```

## 4. 证据文件 sha256

| 文件 | sha256 |
|---|---|
| `POST_RESTART_VERIFY.txt` | `30AD17484AFAE94EC15CF85CC75A8D703F743DC3EEBA00B45F0D77DF9E4F56EA` |
| `POST_RESTART_VERIFY.json` | `CCC02D3D71AD4F01F5FAD3BE466F793115588645B2E2A65FAA16B732D1ECFB09` |
| `regression.post-restart-v3.txt` | `012BC554004A3721AABF9B57A87F28B47515C7A4158055161F83732432FB997C` |
| `POST_RESTART_LOAD_AND_REGRESSION.md` | `7C409C7C6C30942800CCF91A4865636E602BF765EC22BD0555477E006E8959C6` |
| `PROD_NEGATIVE_8_MATRIX.md` | `D222AE5460291D9A1C02C7174ABDE486935606E53810D4026C7E271AE1C66922` |
| `P4_FINAL_VERDICT.md` | `568D976F6CF82826EE4B3F2479CE1C18D130CDA85E23A1F9F9739F9F08786C16` |

## 5. 限制（诚实清单）

1. 8 项负向检查的**驱动**在隔离宿主中针对与生产逐字节相同的模块执行；生产侧为只读旁证，
   未把 8 项逐条通过生产进程自身的工具面重放（需 8 个真实 LLM 会话回合）。
2. "恰好 6 个工具"的生产侧证据是"日志无重复注册 + 本会话工具面 6 个 + 探针成功"，
   未在生产进程内直接枚举注册表（该服务无此只读接口）。
3. `GET /health`、`/api/health` 在 3080 返回 404（该服务无此路径，健康判据是 `GET / = 200`）。
4. 重启台账 JSON 带 BOM，复核器读取失败——**只影响台账展示**，不影响本文件结论。
5. 本轮不进入 STAGE B；P4.5 的版本地图/变更矩阵/439 会话可读性重测等**均未开始**。
