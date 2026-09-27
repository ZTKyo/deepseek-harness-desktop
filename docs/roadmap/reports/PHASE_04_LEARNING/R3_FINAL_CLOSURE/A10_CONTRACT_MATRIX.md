# A10 — P4 FINAL CONTRACT MATRIX（AC1–AC10 + 4 个 mandatory scenarios）

- 生成时间：2026-09-28 00:1x（本机）
- 代码身份（**source == deployed**，四个插件逐一 SHA256 前 12 位一致）：

| 文件 | source | deployed |
|---|---|---|
| learn.mjs | 6BDD3FE5B68B | 6BDD3FE5B68B |
| learn-core.mjs | 4FB40331B607 | 4FB40331B607 |
| learn-candidate.mjs | F218514751C5 | F218514751C5 |
| learn-gap-veto.mjs | B7623CEDF87E | B7623CEDF87E |

- 全量回归（本轮新鲜执行）：**29/29 套件全绿，门槛断言 1129 PASS / 0 FAIL**（含
  `test-learn-ac1-secret-families` 40 PASS、`run-learn-contract-scenarios` 36 PASS、
  `run-learn-real-e2e` 65 PASS、`mount-gate` 1 PASS）。
- 生产进程：PID 15540，启动 09-27 23:29:37 —— **该进程装载的是 AC1 修复之前的字节**；
  AC1 修复（00:05:57 部署）需一次服务重启才生效（本轮末已排定）。
- 合同来源：`docs/roadmap/reports/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md:122-132`
  （canonical AC1–AC10 逐字）与 `:115-120`（4 个 mandatory 场景逐字）。
- 旧证据复用规则：下表每行都给出**当前最终代码下的重测计数**（证明最终代码没有推翻旧结论）。

---

## 一、AC1–AC10（canonical）

| AC | 合同要求（逐字摘要） | 当前实现位置 | 本轮新鲜证据 | 裁决 |
|---|---|---|---|---|
| **AC1** | Experience compact、结构化、**无 Secret** | `learn-core.mjs` 家族模式表 + `redactSecrets`（7 处 @261,301,323,474,990,992…）；本轮新增 7 个家族（google/stripe/gitlab/huggingface/npm/pem/slack-webhook/uri-credential/generic-*）+ 载入自愈迁移 | 家族数 **19**；`test-learn-ac1-secret-families` **40 PASS/0 FAIL**（含 §5 自愈断言）；生产审计：会话库仍 **google=1、stripe=1**（旧进程写入的存量，修复后新写入为 0；同字节文件自愈证明已通过） | **PASS（代码+新写入）**；存量 2 命中待重启自愈清除 |
| **AC2** | 不会的问题**不第一时间失败/问用户**，低风险场景**会自主研究** | `learn-candidate.mjs:181 researchPlan`、`:116 MAX_RESEARCH_ATTEMPTS=3`、`learn-core.mjs:161 RESEARCH_BOUNDED_EXHAUSTED` | plugins 全量 grep：`researchPlan` **仅 1 处 = 定义本身**（learn.mjs 未 import、无调用者）；研究能力存在且有单测（`test-learn-candidate` 39 PASS），但**运行时研究腿未接线** | **PARTIAL / 未证明**（研究由 agent 自身工具链承担，插件层无研究留痕；合同场景①无插件级证据） |
| **AC3** | 经验只有**验证成功后**进入 verified | `learn-core.mjs` verified 授予点（22 处 @126-141…）；`learn.mjs:757` | `test-learn-stage2-schema-and-negative-lock` 23 PASS、`test-learn-r2-b1-approval-gate` 19 PASS、`test-learn-b2-verify-output-contract` 21 PASS（全绿） | **PASS** |
| **AC4** | 复用时做环境/version check | `learn-core.mjs` 适用性检查（24 处 @175,849-866…）、`learn.mjs` 6 处 | `run-learn-contract-scenarios` 36 PASS/0（场景②）；生产遥测 `RECALLED=1` | **PASS**（运行时证据偏薄：仅 1 次召回） |
| **AC5** | Failure Classification 能阻止错误学习 | `learn-gap-veto.mjs`（20 处 @22,48-51…）、`learn.mjs:527` | `test-learn-ac5-gap-veto` 44 PASS、`test-learn-ac5-e2e` 13 PASS；**真实生产遥测：`GAP_VETOED=4`、`CAPABILITY_GAP_VETOED=1`** | **PASS（含真实运行时证据）** |
| **AC6** | Candidate **复用现有 CI/Transaction**，不造第二套 promotion engine | `learn-candidate.mjs:85-110 STAGE_DELEGATION`（声明 ci-level1 / dsh-transaction.ps1 / reliability-lab / plugin-transaction） | CI 腿真实接线（`.github/workflows/ci-level2.yml:139-144,155-177`）；**2026-09-28 关闭（真实 E2E）**：`test-learn-ac6-real-promotion-e2e` **24 PASS / 0 FAIL** —— 真 git worktree/commit `74fd41c9…`、在该 commit 上真跑 ci-level2 作业命令（14 命令全 exit 0 / 13 套件）、真 `dsh-transaction.ps1` 到 `COMMITTED`+`COMMIT_READY`+journal 独立回读、真隔离宿主 canary（3099）、正向 `PROMOTED`（只存 1859 B 摘要）、**3 组篡改全拒 + 留痕 + 状态不动**、插件哈希不变。原始证据 `docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/`；报告 `AC6_REAL_PROMOTION_CLOSURE.md` | **PASS**（R3 初判 PARTIAL「Transaction/canary/deploy 腿仅声明、零调用」**已由真 E2E 关闭**）。**注意**：CI 腿是本地执行 CI 作业命令（`runUrl` 空），**不等于** CI 内有真实 E2E 门 ⇒ AC10 仍未关闭 |
| **AC7** | Candidate 无法直接覆盖 Stable | `learn-candidate.mjs:610,615 stableOverwriteGuard` + `ac7_direct_stable_overwrite_forbidden` | `test-learn-candidate` 39 PASS/0（A2–A5 段）；无真实运行时 Stable 覆盖尝试证据 | **PASS（合成断言）** |
| **AC8** | 无常驻 daemon / vector DB / 自训练平台 | 运维不变量 | plugins 全量 grep：`setInterval｜child_process｜spawn(｜embedding｜vectorStore｜selfTrain` = **0 命中** | **PASS** |
| **AC9** | Learning 不导致插件数量无界增长 | `MAX_*` 上限常量（learn-candidate 27、learn-core 94、learn.mjs 43 处） | 上限常量与裁剪逻辑存在；套件绿；**无"插件数量"专门断言**（诚实标注） | **PASS（有边界，断言强度一般）** |
| **AC10** | **真实 E2E 证据 PASS** | 4 个真实数据门 + 拓扑门 | 本轮本地全绿：`run-learn-real-e2e` 65P/0、`run-learn-contract-scenarios` 36P/0、`run-learn-real-gap-e2e` 20P/0、`mount-gate` 1P/0、`test-learn-real-topology-tool-events` 22P/0；但 `ci-level2.yml:149-154` 自述**刻意把 6 个真实数据门排除出 CI** | **PARTIAL**（本地真实门 PASS；CI 内无真实 E2E 门） |

---

## 二、4 个 mandatory scenarios（合同 `:115-120`）

| # | 场景（逐字摘要） | 真实运行时证据（生产遥测新鲜计数） | 裁决 |
|---|---|---|---|
| **①** | 陌生低风险任务：自主研究→解决→保存经验 | 插件层无研究记录（`researchPlan` 零调用）；有 `CAPABILITY_GAP_QUALIFIED=3`、`cand_` 记录 2 条 | **未达成**（研究腿未接线） |
| **②** | 第二次相似任务：检索→复用→**重新验证** | 合成门 `run-learn-contract-scenarios` 36P/0；生产 `RECALLED=1`；**跨会话层**：全局库 `_global-verified.json` 中 `experiences` 为空、`GLOBAL_PUBLISH_DENIED=2`（且会话内计数 7） | **半达成（合成）**：真实跨会话复用未发生（被"无人工审批"正确拒绝） |
| **③** | 伪能力缺口（网络/Provider 故障）→ 正确分类、**不生成 Candidate** | **`GAP_VETOED=4`、`CAPABILITY_GAP_VETOED=1`**（生产真实遥测） | **达成（真实运行时）** |
| **④** | 重复真实缺口→Candidate→测试→**证明 Stable 未被直接覆盖** | `CAPABILITY_GAP_QUALIFIED=3`（真实）；Candidate 仅内存态；Stable 守卫仅合成断言 | **部分达成** |

---

## 三、A10 结论

- **AC1 / AC3 / AC4 / AC5 / AC7 / AC8 / AC9 = PASS**（其中 AC5、AC1 有真实生产运行时/字节级证据）
- **AC6 / AC10 = PARTIAL**（Transaction 腿零调用；CI 内无真实 E2E 门）
- **AC2 = PARTIAL/未证明**（运行时研究腿未接线；场景①无插件级证据）
- **mandatory scenarios：③ 达成；② 半达成（合成）；④ 部分达成；① 未达成**

→ 按 A11 的判定条件，**P4 ≠ VERIFIED**。除 A8"真人审批不可达"这一结构性阻塞外，
本轮又独立确认三个**合同级缺口**（AC2 研究腿、AC6 Transaction 腿、场景①/② 的真实性）。
这些缺口**属于既有 P4 合同审查范畴**，本轮遵守"最小修复 + 只登记不扩范围"原则，
**未擅自扩大改动**（B1/B2 最小修复范围外）。

---

## 四、本轮已完成 / 待办（重启后回合）

**已完成（本回合）**
1. AC1 密钥族加固 + 存量自愈迁移（源码）；`test-learn-ac1-secret-families` 40P/0。
2. 全量回归 29/29 套件全绿（门槛断言 1129 PASS / 0 FAIL）。
3. 修复版已原子部署到生产 profile（备份 `deploy-backup-20260928-000557`），source==deployed。
4. A10 合同矩阵（本文件）。

**待办（写入延迟重启，由重启后的回合执行）**
1. 执行**一次**规范化服务级重启，使 AC1 修复生效（本轮末已排定；含插件挂载预检）。
2. 重启后复核：`健康 200`、`6 个 learn 工具`、`无重复注册`、`无旧崩溃签名`、
   `载入哈希 = 部署哈希`。
3. 重启后复核存量泄漏：会话经验库 google/stripe 命中应归零（自愈迁移生效）。
4. 更新本文件"生产生效"段落 + A11 治理（CURRENT_STATUS / Reviewer 99 / VERIFICATION / RUNBOOK）。

**重启后回合的确定性执行序列（照抄即可）**
```powershell
# 1) 取新服务 PID + 启动时间（重启后必定是新 PID）
$p = Get-Process -Id ((netstat -ano | Select-String ':3080\s' | Select-String 'LISTENING' |
      ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Where-Object { $_ -ne '7176' } |
      Select-Object -First 1)
$p.Id; $p.StartTime

# 2) 一键复核（健康 + 台账 + source==deployed&mtime + 存量泄漏 + 崩溃签名）
cd 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2-final-closure'
node _post-restart-verify.mjs "<上一步的 StartTime，格式 2026-09-28 HH:mm:ss>"

# 3) 契约门重跑（证明最终代码未推翻结论）
node 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2-inject-fix\tests\learn\mount-gate.mjs' `
     --plugin 'C:\Users\Administrator\.dsh\profiles\web\learn.mjs' --expect pass
```
判定：`LEAK_AUDIT=CLEAN`（存量 google/stripe 归零）+ 四个插件 `SAME + mtime<start` + 健康 200 + 无重
复注册/崩溃签名 ⇒ AC1 修复**生产生效**，A5 生产再取证完成。

---

## 五、生产生效补充（重启后实进程取证，2026-09-28 00:17–00:25）

**这次是真重启，不是推断**（延迟重启脚本自身日志）：

| 时刻 | 事件 |
|---|---|
| 00:17:31 | 校验旧服务 PID 15540（creation 09-27 23:29:37，cmdHash `F2C1DA2B…9F5A`） |
| 00:17:33 | `stop result: stopped reason=loopback_listener_gone`（loopback 释放成功） |
| 00:17:59 | 新服务 PID **20580** 绑定（generation `639261514555153163_20580`，starter exit 0） |
| 00:18:44/45 | 稳定窗口 30s 后 `COMMIT_READY: True` → **restart committed（budget reset）** |

**重启后复核（均为新鲜取证）**

| 项 | 结果 | 证据 |
|---|---|---|
| 装载 = 部署字节 | ✅ 四个插件 `SAME`，且 mtime（16:04/16:05/14:37）< 服务启动 00:17:59 | `_post-restart-verify.mjs` ③ |
| 健康 | ✅ HTTP **200** | 同上 ② |
| learn 工具数 | ✅ 恰好 **6** 个，无重复注册 | 同上 ②⑤ |
| 崩溃/加载失败签名 | ✅ 全 0（无插件加载失败、无 learn 报错、无未捕获异常） | 同上 ⑤ |
| **存量泄漏** | ✅ **CLEAN**：19 族 × 10 文件零命中；重启前 `google=1, stripe=1` → **0**（**自愈迁移生效**） | 同上 ④ |
| 负向安全 | ✅ 8/8 DENIED（含本轮 A8 复现的"代理自审批被拒"） | A5 台账 + A8 实测 |
| 边界 6 项 | ✅ 全 **NO**（无 force push / 无重启 Windows / 无 base 变更 / 无真实会话迁移 / 无 P5） | A9 核验 |

⇒ **AC1 行裁决由「PASS（代码+新写入）」升级为「PASS（含存量自愈，生产生效）」**；
P4 总判定仍为 **≠ VERIFIED**，原因见 `P4_FINAL_VERDICT.md`（A8 真人门 + AC2/AC6/AC10 缺口）。

