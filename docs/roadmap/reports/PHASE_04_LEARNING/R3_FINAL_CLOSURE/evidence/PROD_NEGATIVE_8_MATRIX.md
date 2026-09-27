# PROD_NEGATIVE_8_MATRIX.md —— 生产负向安全 8 项（**重启后、新字节**重检）

> 规则：重启前取到的一切生产证据，其对象都是**旧字节**，不得用于声明修复已在生产生效。
> 本文件是 8 项负向安全检查在 **2026-09-28 07:22 重启之后**的重检记录。
>
> 重检口径（与 A5_A6_VERDICT.md 一致，但对象换成本轮新字节）：
> ① **驱动的字节 = 生产字节**：生产 `~/.dsh/profiles/web/*.mjs` 与仓库
> `_p4r2-inject-fix/plugins/*.mjs` 逐字节 SAME（learn.mjs `bf5cfa6d7f03…`、
> learn-core.mjs `38c1d09296aa…`、learn-candidate.mjs `f732806aa5f9…`、
> learn-gap-veto.mjs `b7623cedf87e…`），且**生产进程已被行为探针证明在跑这批字节**
> （`VERDICT=NEW_CODE_LOADED`，探针会话 `session-348f2f5c-8d5f-4500-8f52-73104b7da1bb`）。
> ② **判定由真实门断言承载**：下面每一项都指向仓库真实套件里的一条具名断言；这些套件在本轮
> 重启后**全量重跑**（`regression.post-restart-v3.txt`，34/34 全绿，门槛断言 1217 PASS / 0 FAIL）。
> ③ **生产侧旁证为只读观测**：全局库内容、发布拒绝遥测、生产进程实时工具返回。
>
> 结论：**8/8 DENIED**（新字节下全部拒绝），且生产侧无任何"顺带上位/静默放行"痕迹。

## 8 项逐条

| # | 负向场景 | 承载断言（真实文件 · 断言名） | 本轮（重启后）结果 | 生产侧只读旁证 |
|---|---|---|---|---|
| 1 | **未批准发布**（VERIFIED 但无人工审批 → 不得进跨会话全局库） | `test-learn-b2-verify-output-contract.mjs` · `A5 成功路径：无人工审批 ⇒ 发布必须 DENY（原因指向 not_human_approved）` · `B4 失败路径：绝不落盘为 VERIFIED，也绝不进入跨会话全局库`；`test-learn-core.mjs` · `C16 Layer B 跨会话全局已验证经验库（canPublish 闸门）` | ✅ DENIED（b2-contract 21P/0F；core 504P/0F） | 全局库 `_global-verified.json` → `experiences: []`；发布拒绝遥测 **2 条 `GLOBAL_PUBLISH_DENIED`**（`exp-8a2fd284`、`exp-2ed0f0c9`，原因 `not_human_approved:VERIFIED_EXPERIENCE`） |
| 2 | **跨会话 recall**（A 会话经验不得被 B 会话召回） | `test-learn-r3-hardening.mjs` · `H3.2 跨会话召回不成立：B 的库召回不到 A 的经验`；`test-learn-b2-verify-output-contract.mjs` · `B4`；`redteam-r3-isolation.mjs` · `B4 无跨会话污染（后跑方不继承先跑方经验）`；`run-learn-contract-scenarios.mjs` · `经验库按会话隔离，跨会话不可见` | ✅ DENIED（hardening 30P/0F；isolation 13P/0F；scenarios 36P/0F） | 生产实时 `learn_recall`（探针会话）返回 `"items":[],"considered":0,"excluded":0,"blocked":[]` → 跨会话无可召回内容 |
| 3 | **伪造审批**（手写台账/伪造 attestation 不得生效） | `test-learn-r3-approval-forgery.mjs` · `S5b ★ 攻击：伪造条目即使写进全局库 + 台账，也不得跨会话召回`（含 `S5a 正例对照` 证明探针有区分力）、`S4.1/S4.2 fail-closed`；`test-learn-core.mjs` · `自述审批（无宿主事实）被拒` | ✅ DENIED（forgery 27P/0F；core 504P/0F） | 台账链完整性与"信任锚在岗"由 `test-learn-r2-b2-bounds.mjs` · `R3 ★ 重载实例仍复用磁盘 Global Store + 审批随落盘台账跨进程存活`、`R3c ★ 幂等拒绝重复批准` 覆盖（45P/0F） |
| 4 | **错误 digest**（验证输出与真实字节不符 → 必须 FAIL，不得冒充 VERIFIED） | `test-learn-b2-verify-output-contract.mjs` · `B1 失败路径：ok:false + error 为真原因（不冒充 VERIFIED）`、`B2 失败路径：不存在 method 键`、`C1/C2 旧形态 ⇒ "value.method" must be a string（= 生产原话）`；`test-learn-r3-fixes.mjs`（30P/0F） | ✅ FAIL（b2-contract 21P/0F） | `_global-verified.json` 中无任何 error 形态条目；全局库仍为 0 条 |
| 5 | **replay**（重放证据/审批不得重复生效） | `test-learn-ac5-gap-veto.mjs` · `replayEvidenceRecords()` 相关断言组（`replayReported`）；`test-learn-r2-b2-bounds.mjs` · `R3c ★ 授权没丢时幂等拒绝重复批准；授权真丢了时人类重新批准可恢复（不留死角）` | ✅ DENIED（gap-veto 44P/0F；b2-bounds 45P/0F） | 遥测中仅出现"拒绝发布"，无任何 `PUBLISHED`/`APPROVED` 自动写入 |
| 6 | **内容变更 + 旧审批**（改内容后旧审批必须失效） | `test-learn-core.mjs` · `sanitizeExperience(tampered).error === "approved_without_host_attestation:approval_content_changed"`、`attestation 绑定内容摘要（candidateDigest）` | ✅ DENIED（core 504P/0F） | — |
| 7 | **插件自审批**（插件自述 APPROVED、无宿主 attestation → 授权为假） | `test-learn-b1-session-access.mjs` · `T4a 自述审批（无宿主 attestation）⇒ live 授权为假 + 发表判定点被拒`（拒绝原因断言 `approval_missing_host_attestation`，两处判定点 `≠published`） | ✅ DENIED（b1 22P/0F） | A8 真人审批门仍停在等待真人；代理请求被拒（无自动批准痕迹） |
| 8 | **伪造宿主事实**（宿主事实不可复验 → fail-closed，绝不降级放行） | `test-learn-b1-session-access.mjs` · `T3.2 判定点 DENY，且原因指向宿主事实不可复验（绝不降级放行）`、`T1.0 未注入 sessions 的部署形态下 apply 不抛`；`test-learn-r3-approval-forgery.mjs` · `S6.1 宿主事实复验器确实在生产代码里挂载（删掉这行即失败）`、`S7.0 基线：四项齐备且自洽时才被认作宿主事实` | ✅ DENIED（b1 22P/0F；forgery 27P/0F） | 生产日志（本轮新进程）无"降级放行"类错误；`mount-gate.mjs` 的真实加载器 mount 门（含两个负向对照）1P/0F PASS |

## 生产状态侧的三条硬事实（只读）

1. 全局已验证库 `…\DSHHarness\state\learn\_global-verified.json`：`experiences: []`（**0 条**）——
   未批准内容没有被发布。
2. 遥测：**2 × `GLOBAL_PUBLISH_DENIED`**（`refused publish: not_human_approved:VERIFIED_EXPERIENCE`）。
3. 生产实时 `learn_recall`（探针会话 ③）：`items:[]`，跨会话无内容可召回。

## 限制（诚实清单）

- 8 项的"拒绝"判定，其**驱动**在隔离宿主中针对**与生产逐字节相同**的模块进行（确定性、可重复）；
  生产进程侧的对应证据是"全局库为空 + 拒绝遥测 + 实时 recall 为空 + 日志无降级/无重复注册/无加载失败"。
  **未**把 8 项全部通过生产进程自身的工具面逐条重放（那需要 8 个真实 LLM 会话回合，成本与不可控性都高）；
  这一点在最终报告里如实标注。
- 遥测计数为启动至今累计；本轮未新增拒绝记录（`GLOBAL_PUBLISH_DENIED` 仍为 2 条），
  即没有"重检期间又发生了一次越权尝试"。
