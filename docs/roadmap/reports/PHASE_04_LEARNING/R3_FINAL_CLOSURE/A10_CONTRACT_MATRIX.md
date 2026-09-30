# A10 — P4 FINAL CONTRACT MATRIX（AC1–AC10 + 4 个 mandatory scenarios）

> ## ⚠ 时效标注（2026-10-01 增补；**本文下方正文逐字保留历史原样，未作任何改写或删除**）
>
> **标记规范**：本次全部时效标注共用同一 token「**2026-10-01 时效标注**」，由 CI 门
> `tests/roadmap/validate-p4-status-consistency.mjs` fail-closed 校验（任何历史文档缺标注即红灯）。
>
> 本文是 **2026-09-28 00:1x 的 R3 历史快照**。其中的结论在其写下时**属实**，但**不是当前状态**。
> 本标注即为"更正留痕"，引用本文任何历史结论时**必须连同本标注一起引用**。
>
> ### 当前状态（唯一口径，基线 `main@63bf558`）
> - **AC1–AC10 = 全 PASS**；整体判定字符串 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`。
> - 权威来源：`docs/roadmap/CURRENT_STATUS.md` →「2026-09-30 P4 canonical 封条」段
>   与同文件「2026-10-01 External Review remediation（D1–D13）」段。
> - 本仓库对同一 audited baseline 只承认上述这一个 AC 状态；本文的旧结论仅作历史证据链，不作当前口径。
>
> ### 本文中已被取代的具体条目（逐条对应，行号为本文行号）
> | 本文位置 | 历史结论（当时属实） | 取代事实 |
> |---|---|---|
> | §一 **AC6 行（L33）** | 裁决 `PASS`，但与本文件 §三 L55 自相矛盾 | 同一条目内两处口径不符，是 D1 的**文件内**矛盾；AC6 已于 2026-09-28 01:41 由真三腿 E2E 关闭（24P/0），2026-09-30 封条判 PASS |
> | §三 **L55** | `AC6 / AC10 = PARTIAL` | **已被取代**：AC6 见上；AC10 已于 2026-09-30 由线上只读 GET 前后对照客观闭合（required contexts 三项 + `enforce_admins=true` + `strict=true`；PR #100 BLOCKED / PR #99 MERGED） |
> | §三 **L58** | `场景 ③ 达成；② 半达成（合成）；④ 部分达成；① 未达成` | **已被取代**：按合同原文（「至少设计并执行」）4 个场景全部**已执行**；②④① 的"生产自然实例缺口"以"裁决 + 诚实边界"两列如实登记，不再表现为"未达成" |
> | §三 **L60** | `按 A11 的判定条件，P4 ≠ VERIFIED` | **已被取代**：见「当前状态」 |
> | §一 **AC1 行（L28）** | 「存量 2 命中待重启自愈清除」 | **已被取代且口径更正**：09-28 重启后归零；2026-10-01 复算确认该"2 命中"是**度量假阳性**（见下） |
> | §一 **AC2 行（L29）/ §六 L149-154** | 「生产 profile 仍是旧插件副本 …… 生产运行时遥测尚不存在」 | **已被取代**：该部署已于 2026-09-30 封条前完成，并以运行时行为探针 `NEW_CODE_LOADED` 判装载 |
>
> ### 2026-10-01 追加更正（External Review D11 / D12）
> 1. **D11（度量口径）**：本文 AC1 行的「存量 2 命中」经复算为**度量假阳性** ——
>    插件自身的脱敏占位符 `[REDACTED:uri-credential]` 处在 `postgres://…@host` 形态中时，
>    会被 `uri-credential` 家族正则**再次命中**（占位符含 `:`，形似 `user:pass@`）。
>    剥掉 `[REDACTED:*]` 标记后命中 = 0、`containsSecret` = false ⇒ **真实密钥 = 0**。
>    自 2026-10-01 起审计输出必须区分 **RAW MATCH / REDACTION PLACEHOLDER / REAL SECRET** 三个数。
> 2. **D12（自愈作用域）**：本文所述"存量自愈迁移"的**作用域是"载入某个会话库时按需执行"**，
>    **不批量扫掠历史库**（生产实测：重启后仅当前活动会话库被写入；3 个 `schemaVersion=1` 旧库
>    与含标记的历史库 mtime 未变）。因此准确表述是「**当前已加载会话已自愈；历史库未扫掠**」。

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
| **AC1** | Experience compact、结构化、**无 Secret** | `learn-core.mjs` 家族模式表 + `redactSecrets`（7 处 @261,301,323,474,990,992…）；本轮新增 7 个家族（google/stripe/gitlab/huggingface/npm/pem/slack-webhook/uri-credential/generic-*）+ 载入自愈迁移 | 家族数 **19**；`test-learn-ac1-secret-families` **40 PASS/0 FAIL**（含 §5 自愈断言）；生产审计：会话库仍 **google=1、stripe=1**（旧进程写入的存量，修复后新写入为 0；同字节文件自愈证明已通过） | **PASS（代码+新写入）**；存量 2 命中待重启自愈清除 | 〔**⚠ 2026-10-01 时效标注：本行已过时** —— 已有 09-28 重启后归零；且该「2 命中」复算为**度量假阳性**、真实密钥 = 0；自愈作用域 = 按需（仅已加载会话），不扫掠历史库。见文首标注〕
| **AC2** | 不会的问题**不第一时间失败/问用户**，低风险场景**会自主研究** | `learn-candidate.mjs:181 researchPlan`（定义）、`:116 MAX_RESEARCH_ATTEMPTS=3`、`learn-core.mjs:161 RESEARCH_BOUNDED_EXHAUSTED`；**2026-09-28 接线**：`learn.mjs` 研究腿 —— 工具输出契约新增 `researchDirective`，插件把 directive 交回**既有** agent 研究工具链执行（不新建第二套研究系统），有界失败落 `EXPERIENCE_LOOKUP_MISS` 遥测 | ① `test-learn-ac2-research-leg` **25 PASS / 0 FAIL**（真跑插件 execute 路径，非自证）；② **负控**：7 种「拆接线 / 假接线」突变**全部被抓住**（`_ac2-mutation-proof` **7 PASS / 0**  ⇒ 接线锁不是恒真）；③ **CI 内**：`ci-level2.yml` 已纳入该套件，真 CI 作业命令在隔离 commit `8211c184…` 上 `tests/learn/test-learn-ac2-research-leg.mjs (exit 0)`；④ **批准后发布链路**：`test-learn-b1-session-access` **22 PASS / 0**（真宿主 ApprovalService + 真人「允许一次」→ 批准 → 发布 → 进程重启后**另一会话仍可召回**，含拒绝/伪造/篡改负控） | **PASS（代码闭合 + CI 锁 + 负控）**。**注意**：生产 profile 仍是**旧插件副本**（`~/.dsh/profiles/web/learn.mjs` sha `6bdd3fe5…` ≠ 源 `bf5cfa6d…`；旧副本内 `researchDirective` = **0 命中**）⇒ **生产运行时遥测要等一次服务重启部署后才有**（部署 = 需用户在场的一次性动作，步骤见 `RUNBOOK.md`） |
| **AC3** | 经验只有**验证成功后**进入 verified | `learn-core.mjs` verified 授予点（22 处 @126-141…）；`learn.mjs:757` | `test-learn-stage2-schema-and-negative-lock` 23 PASS、`test-learn-r2-b1-approval-gate` 19 PASS、`test-learn-b2-verify-output-contract` 21 PASS（全绿） | **PASS** |
| **AC4** | 复用时做环境/version check | `learn-core.mjs` 适用性检查（24 处 @175,849-866…）、`learn.mjs` 6 处 | `run-learn-contract-scenarios` 36 PASS/0（场景②）；生产遥测 `RECALLED=1` | **PASS**（运行时证据偏薄：仅 1 次召回） |
| **AC5** | Failure Classification 能阻止错误学习 | `learn-gap-veto.mjs`（20 处 @22,48-51…）、`learn.mjs:527` | `test-learn-ac5-gap-veto` 44 PASS、`test-learn-ac5-e2e` 13 PASS；**真实生产遥测：`GAP_VETOED=4`、`CAPABILITY_GAP_VETOED=1`** | **PASS（含真实运行时证据）** |
| **AC6** | Candidate **复用现有 CI/Transaction**，不造第二套 promotion engine | `learn-candidate.mjs:85-110 STAGE_DELEGATION`（声明 ci-level1 / dsh-transaction.ps1 / reliability-lab / plugin-transaction） | CI 腿真实接线（`.github/workflows/ci-level2.yml:139-144,155-177`）；**2026-09-28 关闭（真实 E2E）**：`test-learn-ac6-real-promotion-e2e` **24 PASS / 0 FAIL** —— 真 git worktree/commit `74fd41c9…`、在该 commit 上真跑 ci-level2 作业命令（14 命令全 exit 0 / 13 套件）、真 `dsh-transaction.ps1` 到 `COMMITTED`+`COMMIT_READY`+journal 独立回读、真隔离宿主 canary（3099）、正向 `PROMOTED`（只存 1859 B 摘要）、**3 组篡改全拒 + 留痕 + 状态不动**、插件哈希不变。**AC2 接线后复跑（2026-09-28 01:5x，HEAD `b5f198f`）仍 24 PASS / 0 FAIL**，CI 腿扩为 **15 命令全 exit 0 / 14 套件 + plugin-contract gate**（含新增 `tests/learn/test-learn-ac2-research-leg.mjs (exit 0)`，隔离 commit `8211c184…`）。原始证据 `docs/roadmap/evidence/AC6_REAL_E2E_R3_CLOSURE/` + `R3_FINAL_CLOSURE/evidence/AC6_E2E_AFTER_AC2.txt`；报告 `AC6_REAL_PROMOTION_CLOSURE.md` | **PASS**（R3 初判 PARTIAL「Transaction/canary/deploy 腿仅声明、零调用」**已由真 E2E 关闭**）。**注意**：CI 腿是本地执行 CI 作业命令（`runUrl` 空），**不等于** CI 内有真实 E2E 门 ⇒ AC10 仍未关闭 |
| **AC7** | Candidate 无法直接覆盖 Stable | `learn-candidate.mjs:610,615 stableOverwriteGuard` + `ac7_direct_stable_overwrite_forbidden` | `test-learn-candidate` 39 PASS/0（A2–A5 段）；无真实运行时 Stable 覆盖尝试证据 | **PASS（合成断言）** |
| **AC8** | 无常驻 daemon / vector DB / 自训练平台 | 运维不变量 | plugins 全量 grep：`setInterval｜child_process｜spawn(｜embedding｜vectorStore｜selfTrain` = **0 命中** | **PASS** |
| **AC9** | Learning 不导致插件数量无界增长 | `MAX_*` 上限常量（learn-candidate 27、learn-core 94、learn.mjs 43 处） | 上限常量与裁剪逻辑存在；套件绿；**无"插件数量"专门断言**（诚实标注） | **PASS（有边界，断言强度一般）** |
| **AC10** | **真实 E2E 证据 PASS** | 4 个真实数据门 + 拓扑门 | 本轮本地全绿：`run-learn-real-e2e` 65P/0、`run-learn-contract-scenarios` 36P/0、`run-learn-real-gap-e2e` 20P/0、`mount-gate` 1P/0、`test-learn-real-topology-tool-events` 22P/0；但 `ci-level2.yml:149-154` 自述**刻意把 6 个真实数据门排除出 CI** | **PARTIAL**（本地真实门 PASS；CI 内无真实 E2E 门） |

---

## 二、4 个 mandatory scenarios（合同 `:115-120`）

| # | 场景（逐字摘要） | 真实运行时证据（生产遥测新鲜计数） | 裁决 |
|---|---|---|---|
| **①** | 陌生低风险任务：自主研究→解决→保存经验 | ~~插件层无研究记录（`researchPlan` 零调用）~~ **已接线**：插件级证据 = `test-learn-ac2-research-leg` 25P/0 + CI 内 exit 0 + 突变负控 7/7；生产遥测里仍是 `CAPABILITY_GAP_QUALIFIED=3`、`cand_` 记录 2 条（旧副本） | **代码层达成**；**生产运行时留痕待部署**（旧插件副本未含研究腿） |
| **②** | 第二次相似任务：检索→复用→**重新验证** | 合成门 `run-learn-contract-scenarios` 36P/0；生产 `RECALLED=1`；**跨会话层**：全局库 `_global-verified.json` 中 `experiences` 为空、`GLOBAL_PUBLISH_DENIED=2`（且会话内计数 7） | **半达成（合成）**：真实跨会话复用未发生（被"无人工审批"正确拒绝） |
| **③** | 伪能力缺口（网络/Provider 故障）→ 正确分类、**不生成 Candidate** | **`GAP_VETOED=4`、`CAPABILITY_GAP_VETOED=1`**（生产真实遥测） | **达成（真实运行时）** |
| **④** | 重复真实缺口→Candidate→测试→**证明 Stable 未被直接覆盖** | `CAPABILITY_GAP_QUALIFIED=3`（真实）；Candidate 仅内存态；Stable 守卫仅合成断言 | **部分达成** |

---

## 三、A10 结论

- **AC1 / AC3 / AC4 / AC5 / AC7 / AC8 / AC9 = PASS**（其中 AC5、AC1 有真实生产运行时/字节级证据）
- **AC6 / AC10 = PARTIAL**（Transaction 腿**已由真 E2E 关闭**；**仍开：CI 内无真实 E2E 门 = AC10**） 〔**⚠ 2026-10-01 时效标注：本行已被取代** —— AC6 于 09-28 01:41 关闭、AC10 于 09-30 客观闭合，当前 AC6/AC10 = **PASS**。见文首标注〕
- **AC2 = PASS（代码闭合 + CI 锁 + 负控）**（研究腿已接线：25P/0 + 突变 7/7 + CI 内 exit 0 + 批准后发布链路 22P/0）；
  **生产运行时遥测待部署**（生产 profile 仍跑旧副本 ⇒ 这不是"证据缺失被掩盖"，而是**已登记的待办动作**，见 §六）
- **mandatory scenarios：③ 达成；② 半达成（合成）；④ 部分达成；① 未达成** 〔**⚠ 2026-10-01 时效标注：本行已被取代** —— 按合同原文「至少设计并执行」，4 场景当前全部判**已执行**（生产自然实例缺口以"诚实边界"列登记）。见文首标注〕

→ 按 A11 的判定条件，**P4 ≠ VERIFIED**。除 A8"真人审批不可达"这一结构性阻塞外，〔**⚠ 2026-10-01 时效标注：本判定已被取代** —— 当前判定字符串 = `VERIFIED (ENGINEERING-COMPLETE) / AWAITING EXTERNAL REVIEW`（见文首标注与 `CURRENT_STATUS.md`）〕
本轮又独立确认三个**合同级缺口**（AC2 研究腿、AC6 Transaction 腿、场景①/② 的真实性）。
这些缺口**属于既有 P4 合同审查范畴**，本轮遵守"最小修复 + 只登记不扩范围"原则，
**未擅自扩大改动**（B1/B2 最小修复范围外）。
> **后续进展（2026-09-28）**：上列缺口**其中两处已在用户明确授权后单独关闭** ——
> **AC6**（真三腿 E2E，24P/0）与 **AC2**（研究腿接线 + 接线锁 25P/0 + 突变负控 7/7 + CI 内 exit 0，见 §六）。
> **仍开：AC10**（CI 内无真实 E2E 门，需 GitHub 托管运行 = 范围扩权，待人类裁决）。

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
P4 总判定仍为 **≠ VERIFIED**，原因见 `P4_FINAL_VERDICT.md`（**A8 真人门 + AC10**；AC2/AC6 已关闭，
**AC2 另有一项待办：生产部署**，见 §六）。

---

## 六、AC2 研究腿关闭记录（2026-09-28，用户授权后）

**背景**：A10 初判 AC2 = PARTIAL，依据是「`researchPlan` 在插件内零调用 ⇒ 研究腿未接线」。
该缺口在用户明确授权后单独修复并加锁。

| 项 | 内容 | 证据 |
|---|---|---|
| 接线方式 | 插件工具输出契约新增 `researchDirective`；**不新建研究系统**，directive 交回**既有** agent 研究工具链执行；有界失败（`MAX_RESEARCH_ATTEMPTS=3` 上限）落 `EXPERIENCE_LOOKUP_MISS` 遥测 | `plugins/learn.mjs`（`researchDirective` 7 处命中）；`learn-candidate.mjs:181`、`:116` |
| 接线锁（正向） | `tests/learn/test-learn-ac2-research-leg.mjs` **25 PASS / 0 FAIL**，真跑插件 execute 路径 | `R3_FINAL_CLOSURE/evidence/AC2_RESEARCH_LEG_SUITE.txt`（含 HEAD/文件 sha256 指纹） |
| 负控（证明锁不恒真） | `tests/learn/_ac2-mutation-proof.mjs` **7 种突变全部被抓**（含"假接线：返回值被丢弃"）**7 PASS / 0** | `R3_FINAL_CLOSURE/evidence/AC2_MUTATION_PROOF.txt` |
| CI 内 | `ci-level2.yml` 已纳入该套件；真 CI 作业命令在隔离 commit `8211c184…` 上 `test-learn-ac2-research-leg.mjs (exit 0)` | `R3_FINAL_CLOSURE/evidence/AC6_E2E_AFTER_AC2.txt` |
| 批准后发布链路 | `test-learn-b1-session-access` **22 PASS / 0**：真宿主 ApprovalService + 真人「允许一次」→ 批准 → 发布 → 进程重启后**另一会话可召回** | 同上证据目录 |
| AC6 回归 | 真三腿 E2E 复跑 **24 PASS / 0 FAIL**（CI 腿扩为 15 命令 / 14 套件全 exit 0） | `AC6_E2E_AFTER_AC2.txt` |

**⚠ 唯一未完成项（部署，特意不做）**：生产 profile 仍运行**旧插件副本**
（`~/.dsh/profiles/web/learn.mjs` sha `6bdd3fe5…` ≠ 源 `bf5cfa6d…`；旧副本 `researchDirective` = 0 命中），
故 **AC2 的生产运行时遥测尚不存在**。生效方式 = 把 3 个源插件覆盖到生产 profile —— **本仓实测该 profile
有 watcher 热挂载，通常无需重启**；步骤与回滚已写入工作区 `RUNBOOK.md`「AC2 部署配方」。
部署属"改生产挂载位"，**需用户明确同意后执行**（本文不自行发起）。
**此时 AC2 的准确表述 = 代码/测试/CI 全绿 + 生产部署待执行**，不把"待部署"说成"已生效"。

