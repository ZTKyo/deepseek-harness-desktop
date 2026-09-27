# POST_RESTART_LOAD_AND_REGRESSION.md

> 目的：给出 **重启之后**（新字节已装载）的 P4 终局证据：`source == deployed == loaded`、
> 生产健康与安全扫描、工具面、全量回归。**本文件之前取到的所有"生产证据"，其对象都是旧字节**，
> 因此不作为"修复已在生产生效"的判据（该规则见 `~/.dsh/AGENTS.md` 与本目录 P4_FINAL_VERDICT.md）。
>
> 时间：2026-09-28 07:22（本地）~ 07:40（本地）｜执行：主 Agent（同一 turn 内自主执行）
> 结论：**P4 生产装载成立、全量回归 34/34 全绿（门槛断言 1217 PASS / 0 FAIL）**

---

## 1. 重启与装载（权威判据链）

| 环节 | 证据 | 结论 |
|---|---|---|
| 旧进程停止 | restart 台账 `2026-09-28 07:22:41 validated DSH loopback PID 20580 creation=2026/9/28 0:17:35 cmdHash=F2C1DA2B…B676` → `07:22:43 stopped reason=loopback_listener_gone` → `DSH loopback free: True` | 旧字节进程已退出 |
| 新进程 | `07:22:45` 启动，`127.0.0.1:3080` LISTEN 属主 = **PID 20528**（`Get-NetTCPConnection` + `Get-Process` 核对） | 新进程就位 |
| 健康 | `GET http://127.0.0.1:3080/ -> HTTP 200` | 服务在线 |
| 延迟复核触发条件 | 只要"监听 PID ≠ 20580 且 `GET /` = 200"才复核 → `[23:22:50Z] 监听 pid=20528 health=200 ready=true（等待 41s）` | 复核对象确定是新进程 |
| 字节一致 | `learn.mjs / learn-core.mjs / learn-candidate.mjs / learn-gap-veto.mjs`：生产 profile 与仓库 `_p4r2-inject-fix/plugins` **逐字节 SAME**（`Get-FileHash` / 探针 ①） | `source == deployed` |
| **装载判定** | **运行时行为探针**（`tests/learn/production-load-probe.mjs`）：新建探针会话 `session-348f2f5c-8d5f-4500-8f52-73104b7da1bb` → 真实 `learn_recall` 返回带 `"researchDirective":{"legId":"leg_6206c91a","state":"OPEN","trigger":"task_no_experience_coverage",…}` → 读官方会话日志取证 →**`VERDICT=NEW_CODE_LOADED`，exit=0，`LOADED=TRUE`** | `deployed == loaded` ✅ |

**为什么"已装载"只能用行为探针**：`~/.dsh/profiles/web/*.mjs` 由 `cordis.patch.yml` 在服务启动时
import 一次，本机**没有**插件/patch 的文件监视器（2026-09-28 已实测证伪：改插件文件 mtime 与内容，
运行进程 PID 与行为均不变）。因此 `mtime < 启动时间`、`size/hash 相符` 都只能证明"已部署"，
不能证明"已装载"。（此前 `_post-restart-verify.mjs` 曾据 mtime 把"部署后未重启"误判为已装载，已纠正。）

旁证（同一新进程）：本会话自身就是 20528 的客户端，工具面含 **恰好 6 个 `learn_*` 工具**
（`learn_propose` / `learn_review` / `learn_recall` / `learn_status` / `learn_verify` / `learn_promote`），
无重复；且本会话的 learn 台账 `…\DSHHarness\state\learn\session-76de1ca9-….json`（728,766 bytes）
在新进程下**持续被写入**（最后写入 07:31:28），说明 learn 插件在生产进程中真实工作。

## 2. 生产健康与安全扫描（只读）

| 检查 | 结果 |
|---|---|
| 重复注册 | **无** |
| 插件加载失败 | **无** |
| learn 相关错误 | **无** |
| 未捕获异常 | **无** |
| 旧 mount 崩溃签名（当前 boot 内） | **0**：本 boot 首个 `[20528: …` 行 = 日志 **2383021 行**，全部 420 处历史崩溃签名最后出现于 **2155440 行**（早于本 boot） |
| 家族密钥泄漏复核（生产 learn 状态目录，只读） | 家族数=19、扫描文件=14、**零命中** → `LEAK_AUDIT=CLEAN` |
| 日志尾部 | `dsh-server-3080.log` 持续写入（07:40:04 仍活跃） |

## 3. 全量回归（重启后，新字节）

**记录文件**：`regression.post-restart-v3.txt`（`node tests/learn/run-learn-all-tests.mjs`，34 个套件）

```
套件：34/34 全绿    （门槛套件 29 个 / 观测套件 5 个 / 环境前置未满足 0 个）
门槛断言：1217 PASS / 0 FAIL
```

关键套件（全部 exit 0）：

| 套件 | 断言 | 说明 |
|---|---|---|
| `deploy-preflight.mjs` | 1P/0F | A1 无加载器失败签名 / A2 探针捕获**恰好 6 个 learn_* 工具、无重复** / A3 生产监听器未被触碰 |
| `mount-gate.mjs` | 1P/0F | 真实加载器 mount 门（含两个负向对照） |
| `production-load-probe.mjs` | 1P/0F | `VERDICT=NEW_CODE_LOADED` |
| `run-learn-contract-scenarios.mjs` | 36P/0F | AC1–AC10 合约矩阵 + 4 个 mandatory scenarios |
| `test-learn-ac6-real-promotion-e2e.mjs` | **24P/0F** | **真实提升 E2E**（真 git worktree + 真 CI 作业 + 真事务落 COMMITTED + 清理核对） |
| `test-learn-ac1-secret-families.mjs` | 40P/0F | 家族密钥不进入任何产物 |
| `test-learn-b1-session-access.mjs` / `test-learn-b2-verify-output-contract.mjs` | 22P/0F / 21P/0F | B1 宿主事实直取优先+守卫回退；B2 验证输出契约 |
| 其余 26 套件 | 见记录文件 | core 504P、r3-* 加固/伪造/密钥/污染/隔离、r2-* 边界、redteam-r3-*（5 个观测套件） |

### 3.1 回归器口径修正（3 例，透明声明；**未放宽任何断言**）

回归器 `tests/learn/run-learn-all-tests.mjs` 本轮修正了 3 处**把"非产品失败"误判为 FAIL** 的口径，
每一处都保留了原有的失败判定能力（负向结果仍判 FAIL）：

1. `deploy-preflight.mjs` 需要显式 `--deploy` 文件清单 → 回归器现在传该参数（此前因缺参 exit 2，被误判 FAIL）。
2. `production-load-probe.mjs` 的裁决行是无数字摘要的 `VERDICT=NEW_CODE_LOADED` → 折算 1/0；
   **`OLD_CODE_STILL_LOADED` 仍判 FAIL**（真断言）。
3. `exit 2 + 环境字样`（如 ac6 要求"仓库有未提交改动）" → 单列 **ENV** 类别，不再混入产品 FAIL；
   ENV 不计入"新失败"，但在报告里**必须显式列出**，退出码不受其影响。

配套动作：本轮把"AC2/B1B2 收尾证据 + 探针脚本 + 回归器口径修正"提交为
**`e2f51ec3ef0d`**（分支 `p4-final-b1b2-fix`），使工作树清零 —— ac6 的"真 git worktree"前置由此真实满足，
**ac6 得以在本轮真实运行并 24P/0F 通过**（不是被跳过、也不是被降级）。

## 4. 生产账本现状（只读）

| 项 | 事实 |
|---|---|
| 全局已验证库 `_global-verified.json` | `experiences: []`（**count=0**，未批准内容未发布） |
| 全局发布拒绝遥测 | **2 × `GLOBAL_PUBLISH_DENIED`**：`exp-8a2fd284`、`exp-2ed0f0c9`，原因均为 `refused publish: not_human_approved:VERIFIED_EXPERIENCE` |
| A7 正向 Experience | `exp-2ed0f0c9` 状态 `VERIFIED`（确定性验证通过），随后发布被正确拒绝（上表遥测） |
| A8 真人审批门 | 停在等待真人对精确 digest 的 `APPROVE/REJECT`；**代理请求被拒**（未自动批准、未模拟真人、未把 prompt 当授权） |
| 本会话台账 | `session-76de1ca9-….json` version 694、728,766 bytes，新进程下持续写入 |

## 5. 回滚点（如需退回旧字节）

- 生产插件备份：`DSH-Client\_backup-learn-20260928-AC2deploy`（5 个文件）
- 更早备份：`_p4r2-final-closure\deploy-backup-20260928-000052`、`deploy-backup-20260928-000557`、
  `worktree-wip-backup-20260927`
- 回滚步骤：把备份里的 4 个 `learn*.mjs` 覆盖回 `~/.dsh/profiles/web/` → 用
  `DSH-Client\restart-dsh-server-delayed.ps1`（先 `-PreflightOnly`，再 `-Detach -DelaySeconds 240`）
  重启服务 → 用行为探针复核 `VERDICT=NEW_CODE_LOADED/OLD_CODE_STILL_LOADED` 判定是否回滚成功。
- Git 回滚点：分支 `p4-final-b1b2-fix`，`HEAD = e2f51ec3ef0d`（上一提交 `9a318fc`、`949f6e7`）。

## 6. 绝对边界（本轮未触碰）

`OFFICIAL_DSH_UPGRADE=NO`｜`PRODUCTION_BASE_CHANGED=NO`｜`REAL_SESSIONS_MIGRATED=NO`｜
`PHASE_05_STARTED=NO`｜`WINDOWS_REBOOT=NO`｜`FORCE_PUSH=NO`
（依据：Git `READY`=e2f51ec3ef0d，分支 `p4-final-b1b2-fix` 相对 `origin/main`（171f1b4）**已包含 origin/main 全部提交**、ahead 19、无 force push；无生产基准替换；无会话迁移；无重启整机。）

## 7. 证据文件哈希（sha256）

| 文件 | sha256 |
|---|---|
| `POST_RESTART_VERIFY.txt` | `30AD17484AFAE94EC15CF85CC75A8D703F743DC3EEBA00B45F0D77DF9E4F56EA` |
| `POST_RESTART_VERIFY.json` | `CCC02D3D71AD4F01F5FAD3BE466F793115588645B2E2A65FAA16B732D1ECFB09` |
| `regression.post-restart-v3.txt` | `012BC554004A3721AABF9B57A87F28B47515C7A4158055161F83732432FB997C` |
| 生产 `~/.dsh/profiles/web/learn.mjs` | `BF5CFA6D7F0360751BC2C252A7B93E870804A56C39ABFDC16C5EB270813A4FFC` |
| 生产 `~/.dsh/profiles/web/learn-core.mjs` | `38C1D09296AA4BC1C8144603698434292F8455A2139A66A10FD4A6721BE5700C` |
| 生产 `~/.dsh/profiles/web/learn-candidate.mjs` | `F732806AA5F9D868FEBD07D597F78C4FB65858E51F5CBF1C9DE9A3B831514E97` |
| 生产 `~/.dsh/profiles/web/learn-gap-veto.mjs` | `B7623CEDF87E13F49500B368E27BBF9DC358B9B400D7A0B7A064E1C27A090B36` |
| `_post-restart-verify.mjs` | `09055E965DBE976FBD583D27D57363E1C7EA85F6807397409CB15CA3F425CCAC` |
| `_post-restart-watch.mjs` | `CD86A3FE6654DAEBBA58E062C404706E64FF112D86A63B989307A26EC662B9E2` |

（生产 4 个插件的哈希 = 仓库 `_p4r2-inject-fix/plugins` 同名字节的哈希，即 `source == deployed` 的机器可核证据。）

## 8. 限制与未覆盖（诚实清单）

1. `GET /health`、`GET /api/health` 在 3080 上返回 **404**（该服务没有这两个路径，健康判据是 `GET / = 200`），
   复核器已按此修正，不把 404 当作不健康。
2. 重启台账 `restart-attempts` 的 JSON 带 BOM，复核器 `ConvertFrom-Json` 读取失败（**只影响台账展示，
   不影响本文件任何结论**）；该不足已记录，未修改台账内容。
3. 本文件不覆盖 STAGE B（P4.5 只读审计）的任何结论——STAGE B 仅在 P4 = VERIFIED 之后另行开展。
4. "恰好 6 个 learn 工具、无重复"的**主证据**来自真实加载器 mount 门（同一字节、隔离宿主）；
   生产进程侧的证据是"日志无重复注册/无加载失败" + 本会话工具面恰好 6 个 + 行为探针成功。
   未在生产进程内直接枚举工具注册表（该服务未提供相应只读接口）。
