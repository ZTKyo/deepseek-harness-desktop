你是 P4 learn 插件的**唯一实现者**（单写者）。本轮唯一主目标：**修复 F1 —— APPROVED 身份来源不可信**。必须走「**强制真实人类审批边界**」，**不得**把契约降级为 "approver-attested approval"。目标安全语义：**只有真正由宿主侧可证明的人类审批产生的 APPROVED，才允许经验进入 Global Store 并跨会话复用。** Agent 可无人值守地产生经验/验证/存 pending 候选/排队等待审批，但**绝不能自行完成 VERIFIED_EXPERIENCE → APPROVED 的信任跃迁**。

## 已审结前提（不得推翻）
- 被审提交 `c5aa5be`（分支 `p4-learning-r2-contract-first`，父 `3a9f30f`），工作树 CLEAN
- BLOCKER-1（verified-only 可发布）**已 CLOSED**：`canPublish()`（`plugins/learn-core.mjs` ≈1872）是唯一授权判定，要求 `state==='APPROVED'` 且 `verification.status==='VERIFIED'`；唯一调用点 `publishToGlobal()`；唯一审批赋值点 `approve()`；全局库载入侧 fail-closed
- BLOCKER-2（磁盘/内存无界）**已 CLOSED**：`sessionStoreMaxFiles=200`（env `LEARN_SESSION_STORE_MAX_FILES`）、`sessionStoreTtlDays=30`、`MAX_IN_MEMORY_SESSIONS=64`、统一 `evictLRU()` 保护 activeSessions、节流 `PRUNE_EVERY_N_WRITES=16`
- 全量 learn regression：23 suites / 907 PASS / 0 FAIL
- 审批字段是**扁平三字段** `approvedBy` / `approvalEvidence` / `approvedAt`（`learn-core.mjs` ≈494-500），**没有** `approvals` 数组字段
- **Round 2 独立评审发现 F1（中高）**：`learn_review` 是 agent 可调用工具，`approver` 为调用方自由字符串，插件内无调用方鉴别 → agent 自调即得 APPROVED → 发布 → 全新会话召回成功，全链无人类输入。**F2（低）**：`sessionStoreMaxFiles < 64` 时因 active-session 保护实际可超限

## 硬边界（违反即失败）
1. 不激活生产 P4；2. **不修改** `~/.dsh/profiles/web/cordis.patch.yml`（其 sha256 必须始终为 `A40558ADA824884E…`、`learn` 命中恒 0）；3. 不投放生产 learn；4. 不升级 Official DSH；5. 不开始 Phase 05；6. **不 push**；7. **不 merge**；8. **不创建 PR**；9. **不覆盖/修改** Round 1/Round 2 历史证据（`..\_p4r2-review-external\EXTERNAL_REVIEW_VERDICT_R2.md` 必须保持 `F307960E74F56661…`；`EXTERNAL_REVIEW_VERDICT_R2_BLOCKERFIX_REVERIFY.md`、`_receipts\**`、`round2-probes\**` 只读）；10. 不删除任何用户文件；11. **不得为通过测试而弱化** 现有 B1/B2/security contract；12. 低风险动作自动执行，涉及生产/破坏性/权限扩大则停下报告；13. 同一方案连续失败两次必须换方案；14. **改任何文件前先建 checkpoint 可逐字节恢复**；15. 所有测试 stateDir 指向 `os.tmpdir()`，禁止写生产 stateDir；16. 不改 canonical AC（`docs/roadmap/contracts/**` 等），不修 install-plugin 漂移，不碰 P2.6 retry-policy 既有失败。

## 阶段一：只读侦察（**先不要写代码**）
完整定位：`learn_review`、`learn_verify`、`canPublish`、APPROVED 状态写入位置、`approvedBy`/`approvalEvidence`/`approvedAt`、tool registry / tool exposure；并在 Harness/Supervisor/客户端中检索所有：human confirmation、user confirmation、approval、permission、interactive command、control-plane event、trusted caller identity、tool invocation provenance、caller metadata、UI confirmation、`ask_user_question`、plan-mode 审批、sandbox approval prompt、secret-gate 面板。
必须给出证据回答：
- **A**：当前 agent 为什么能自行调用 `learn_review`（工具注册/暴露路径原文）
- **B**：插件在工具调用点**能看到哪些调用来源信息**（caller identity / session / turn / provenance 字段，逐一列真实字段名与出处）
- **C**：仓库/宿主**是否真的存在可复用的「人类来源」机制**（不要因为上一轮 reviewer 说 0 命中就假定不存在，**独立重新确认**；给出命中与未命中的检索命令与原文）
产物：`_p4r2\docs\roadmap\reports\PHASE_04_LEARNING\R2\F1_RECON.md`（含 A/B/C 结论 + 每条结论的文件:行号证据 + 可用/不可用机制清单）。**侦察结论必须决定实现路径**：宿主已有可信 human-confirmation primitive → **优先复用**；完全没有 → 实现**最小范围**的 host/control-plane approval primitive（放仓库内、设计为激活时装配，**不得**改生产配置）。

## 阶段二：权限模型（核心原则）
- **Learn 只能 consume authority，不能 mint authority**：learn 可以验证宿主提供的可信 approval attestation；**不得**把任意字符串（如 `approver="human"`）当人类身份；agent **不得**通过填字段/调普通工具/伪造 JSON 制造有效审批。
- **不得**在 learn 插件内部新建独立身份系统；**不得**把授权逻辑藏在普通 agent-callable tool 内。
- **保持单一 authority**：仍只有 `canPublish(...)` 一个逻辑入口；publish、磁盘落盘、Global Store 载入、跨会话召回资格**全部**服从同一 approval contract；Global Store load 侧继续 fail-closed。不得出现第二套 publish/approval authority。

## 阶段三：目标流程（必须等价实现）
Agent → candidate → verification → `VERIFIED_EXPERIENCE` → **pending human review**（可排队）‖ HUMAN/TRUSTED HOST CHANNEL → **可信 approval attestation** → `APPROVED`；`canPublish()` 要求 `state==='APPROVED'` ∧ `verification.status==='VERIFIED'` ∧ `validHumanApproval(candidate)` → publish。Agent 可以**请求** review，**不可以**批准自己。

**Approval 必须内容绑定（content-bound）**：至少绑定 candidate ID、candidate 内容/facts digest、approval timestamp、trusted approval source、approver/host actor identity、approval schema version；若宿主机制支持 nonce / event ID / signature / MAC / 不可变 control-plane event reference，必须使用。**批准的是"这一个具体版本的候选"**，候选内容任何实质变化 → 原 approval 自动失效 → publish fail-closed。

## 阶段四：必须做的真实攻击验证（真插件真工具真会话，禁止只读代码判断）
- **F1-A** agent 直接调旧式 `learn_review` → `DENIED`/`REQUEST_ONLY`，不得产生有效 APPROVED
- **F1-B** agent 自填 `approvedBy="human"` → `DENIED`
- **F1-C** 复制合法 approval payload 后改 approver 字符串 → `DENIED`
- **F1-D** 把 candidate A 的 approval **replay** 给 candidate B → `DENIED`
- **F1-E** candidate A 获批后修改 experience/facts/digest 再发布 → `DENIED`
- **F1-F** 只有 VERIFIED 无 human approval → `denied:not_human_approved`
- **F1-G** 只有 human approval 无 VERIFIED → `denied:not_verified`
- **F1-H** 真实 human approval + VERIFIED → `published`，且**全新会话召回成功**
- **F1-I** 未审批候选 → Global Store **0 条新增**、全新会话召回为空
- **信任通道攻击测试（本轮最关键）**：证明**即使模型完全知道 approval 数据结构，也不能自行构造一份宿主会接受的有效批准**。因为本机 agent 具备 shell/filesystem/generic execution 权限，必须**实测**它能否直接读取/复制/生成 approval authority 所依赖的 secret/token/file：**若可以 → 方案不合格**。不得用"模型正常情况下不会这么做"当安全保证。若采用进程内密钥方案，必须实测 agent 侧确实取不到（并诚实记录残余风险：例如 agent 若能向宿主进程注入代码则边界另算）。
- **存活/失效语义**：A 合法审批重启进程后仍可验证；B 跨会话仍成立；C 内容未变不因 restart 丢批准；D 内容变化旧批准失效；E verification 被 invalidated 后即使 human approval 仍在也不得 publish；F **re-verification 不得再把 APPROVED 错误降级**（除非内容变化导致审批本应失效——注意这正是上一轮的根因之一，别改回去）。

## 阶段五：F2 关闭（低优先，不扩大风险）
`LEARN_SESSION_STORE_MAX_FILES < 64` → **config validation failure**，明确 diagnostic：`minimum supported sessionStoreMaxFiles is 64`。遵循仓库既有 validation 风格，**不得**另造隐藏 clamp。边界测试：**63 → reject；64 → accept；65 → accept**。

## 阶段六：回归（目标：原 907 PASS/0 FAIL 不得退化，新增测试另计）
F1 新授权测试、B1 19P、B2 42P、learn 全量（`node tests/learn/run-learn-all-tests.mjs`）、contract gate、AC5 E2E、cross-phase suite、security suite、concurrency/bounds。既有无关失败（install-plugin 13P/2F、P2.6 retry-policy 18P/7F）**只记录，不得顺手修**。

## 阶段七：变异证明
至少一个变异针对**新身份边界**：把 `validHumanApproval(...)` 强制改 true，或绕过 trusted caller validation → **F1 测试必须 FAIL**，且至少包含「agent self approval leak」与「cross-session unauthorized recall」两类。变异后**恢复 pristine 并逐字节比较确认一致**（记录变异点、RED 输出摘要、恢复后哈希）。

## 阶段八：交付物
1. 代码（最小改动，保持单一 authority）+ 测试
2. 报告 `_p4r2\docs\roadmap\reports\PHASE_04_LEARNING\R2\F1_HUMAN_APPROVAL_BOUNDARY_FIX_R1.md`，含：根因、Authority Model Before/After、Trusted Human Channel 设计、为何 agent 无法伪造、content-binding/replay 保护、逐条负面测试结果、正面跨会话结果、变异结果、F2 结果、回归逐项命令+结果、**未覆盖范围诚实声明**、残余风险；顶部三声明 `P4_PRODUCTION_ACTIVATED = NO`、`OFFICIAL_DSH_UPGRADE = NO`、`PHASE_05_STARTED = NO`
3. **仅本地 commit**（禁止 push/merge/PR），message：`fix(learn): F1 human approval authority boundary — agent cannot mint APPROVED`
4. checkpoint 目录 + 恢复命令写进报告

## 回报（≤1000 字，结构化，不要贴大段日志）
- 侦察 A/B/C 结论（含关键证据行号）+ 你选择的实现路径与理由（复用宿主原语 or 最小 host 原语）
- 新权限模型一句话概括 + 唯一 authority 的证据（调用点计数）
- F1-A…F1-I 逐条结果（含关键 reason 字符串）
- 信任通道攻击测试结果：agent 能否取得 authority 依赖的 secret/file（实测方法与结论）
- 存活/失效语义 A–F 结果
- 变异结果 + 恢复哈希
- F2 结果（63/64/65）
- 回归：各套件 PASS/FAIL 计数（既有失败单列）
- commit SHA、报告与 F1_RECON.md 路径、checkpoint 路径、未决项/残余风险
若某条无法取证，**停下报告**，不得伪造、不得绕过测试、不得改文档措辞蒙混。