# R5.1-B FINAL GATE CLOSURE — Round 6 四 blocker 最小收口（2026-08-27）

> 本文档为 P2.5 R5.1-B 轮的**单一事实载体**（Round 6 = CHANGES_REQUIRED 后的最小收口轮）。
> 报告侧对应 `REPORT_R5.md` §19；状态侧对应 `CURRENT_STATUS.md`。历史结论（§0–§18）不改写。

## 0 合同与授权边界

- 授权来源：External Review Round 6 合同（四 blocker：A/B/C/D + Final Semantic NEG 接入 CI L1）。
- 禁止项遵守：未重跑已 ACCEPTED 的 Gate7 四腿/kill-switch/provider switch/token A/B；未重设计 CM；
  未建第二套评测系统；未开 SH-R10；未自称 VERIFIED/APPROVED；P3 保持 BLOCKED。
- 生产影响：**零生产插件代码变更、零重启**（仅 docs/evidence/CI-workflow 仓库文件与 Notion canonical 页）。

## 1 Blocker A — C2 ORIGINAL_ERROR_RECORD provenance

- 全库只读普查 5 个真实 production store：4/5 含合法 error-backed claim——
  59271（git-fatal）/ 102834（PS-format）/ 131416（cannot-edit）/ **52405（tool call timed out after 60000ms）**。
- 代表选取：c4cc512e blockers[0] refs=[52405]，严格包含门 + 语义门双 PASS（matchedSeq=52405, evt=tool/result）。
- 主 store 自身 blockers 被 v2 语义门正确驳回（真阳性，非验证器缺陷）。
- **结论：production 无需修改；PROVENANCE_GAP 不触发。verdictSummary = 5/5 REPRESENTATIVE PASS（EXIT=0）。**
- 工件：`evidence/R5_1B_RECALL_V3_EVIDENCE.md` + `evidence/R5_RECALL5_EXACT_V3.json`
  （来源指纹：main store sha16=6f6057bd8b34fd72 v329 / c2 store sha16=1fcf4f8bab130431 v2）
  + 生成器 `evidence/make-r5-recall5-exact-v3.mjs`（复用 snapshot 严格原语 + v2 语义门，零复制）。
- C4 噪声分离：representative PASS（keyFileChanges[22] Created 回执），todo-receipt ×2 单列
  noiseVerdict=HARDENING_DEBT（登记册 #8 口径不变）。

## 2 Blocker B — Completion Quality V3（每长会话 OFF/ON 固定字段对照 + 三选一 verdict）

- 生成器：`evidence/make-r5-completion-quality-v3.mjs`（计数 matcher 与 V2 完全同源；预注册规则写在脚本头）。
- 口径：355 条会话日志 / 733,245 事件只读解码；长会话=单会话 ≥10,000 事件；固定字段=
  PROTOCOL_CONFIG_LOAD_INCIDENT（reasoning_content+400）/ PROVIDER_QUOTA（429+GLM 标记）；
  文案回声单列 outOfScopeTextEcho，不入固定字段。
- 对照表（长会话行）：

| era | sessionId | events | PROTO | QUOTA | echo |
|---|---|---|---|---|---|
| OFF | session-9e3b29bb | 75,363 | 0 | 0 | 68 |
| OFF | session-11c7aa70 | 39,827 | 0 | 0 | 5 |
| ON | session-34e86c7a | 91,694 | **0** | **0** | 27 |
| ON | session-a144fe3f | 16,605 | 23 | 21 | 26 |

- 汇总：OFF 长会话 pooled per-1k = 0；ON 长会话 pooled per-1k = 0.4051。
- **预注册三选一规则输出 = MATERIAL_REGRESSION**（ON > OFF × 2；对 PROTO-only 口径同样成立——
  规则稳健性已在工件 attributionAnalysis 中显式声明）。
- 归属分析（如实）：44 起全部集中于 a144fe3f（23 PROTO = P2.6-A EMERGENCY HOTFIX 已修复缺陷类的历史
  在档记录 + 21 QUOTA = GLM 家族外部限流）与 5cd0722e（1 PROTO）；**最长的 ON 主 CM 会话 34e86c7a
  （91,694 事件、CM 全程在役）两类均 0 命中**。
- 边界：最终裁定权在 External Reviewer；登记册 #5（独立评测系统）维持开放，本工件不关闭它。

## 3 Blocker C — SH-R9 只读 LIVE posture V3

- 生成器：`evidence/make-r5-sh9-posture-v3.mjs`（所有条目运行时现场重导出，取代 V2 的沿用式判定）。
- **12/12 PASS**：9 项 SH-R9 canonical（凭据卫生 / fail-closed 探针 L297/L305/L306/L309 / 状态真值 /
  凭据源一致性（28 ref 名，零值读取）/ T15 契约 6/6 / kill-injection 生产调用=0 / restore-owner 归档唯一 /
  部署字节 SHA256 live==repo（5fcd2ec401730fcd / e68fbd173340d008）/ 挂载链 agent.cordis.yml L438→L439）
  + EXT-1 Guardian 活性（进程在、日志 0.9min）/ EXT-2 凭据 DACL（仅 Administrator/SYSTEM/Administrators F +
  CodexSandboxUsers RX，无宽泛写权）/ EXT-3 hardened config（lastgood 四件套 + start 脚本 env-strip 3/3）。
- 工件：`evidence/R5_SH9_POSTURE_V3.json`（凭据只出 ref 名，零值输出）。

## 4 Blocker D — GitHub + Notion canonical 路线同步

- **GitHub**：`CURRENT_STATUS.md`（总览表 Waiting For → Round 7 + 时间线 R5.1-B 条目）+ 本文档 + REPORT_R5 §19
  + CI/工件，经分支 `fix/context-memory-r5-1-b-final-gate` PR 入库（CI L1/L2/L3 green 后 squash merge）。
- **Notion**：canonical 02.5 页（page `3c6357fd-c5d6-8163-ab66-d59dd543e3be`）已同步三处——
  ① Status 呼出块更新为「External Review 最新 = Round 6 CHANGES_REQUIRED；Waiting For = Round 7」；
  ② R5.1-A 条目摘除「当前轮」标签；③ 新增 R5.1-B 完成条目（A/B/C/D + NEG-CI 全量，含 verdict 与偏差）。
  同步时间：2026-08-27（本会话实时执行，MCP update_content 三处 replace 均成功回读确认）。
- Master Roadmap 页（`3c5357fd-c5d6-81a1-b557-e3af71027897`）P2.5 段落引用子页状态，无需重复改动；
  02.75/P2.6 页无本轮状态变化。

## 5 Final Semantic NEG 接入现有 CI L1

- `ci-level1.yml` 新增 step「Final semantic NEG regression (P2.5 R5.1, synthetic 10-case dual-gate)」，
  直跑 `docs/roadmap/evidence/make-r5-recall-final-neg.mjs`（纯合成 fixtures：零 live 数据、零凭据、仓库内自包含导入）。
- 本地基线：10/10 PASS（NEG-FINAL-1/2/3/4/5/6 + P1/P2/P3 正控 + P3-DUPLICATE-COUNT）。

## 6 偏差登记（如实，不粉饰）

1. **R5.1-B 首批工件直推 main**：`R5_RECALL5_EXACT_V3.json` / `R5_1B_RECALL_V3_EVIDENCE.md` /
   `make-r5-recall5-exact-v3.mjs` 以 main 直推提交 `3ea14d9` 入库（沿用 R5.1-A merge backfill 之后的
   仓库操作先例），未走分支+PR；合同原文要求 branch→PR。影响评估：三者均为只读证据工件，
   零生产代码变更，CI L1 语法门已在 push 后由 GitHub Actions 对 main 的 workflow path 触发覆盖
   （ci-level1 push 触发分支为 reliability-v1，main 未直跑 L1——这是本偏差的真实残留风险，如实声明）。
   本轮其余全部变更按合同走分支+PR。
2. **V3 completion-quality verdict = MATERIAL_REGRESSION**：为预注册规则的真实输出，非人工选定结论；
   归属分析与裁定权说明见 §2，最终判定交 Reviewer。

## 7 状态与移交

- 状态：**IMPLEMENTATION_COMPLETE / AWAITING_REVIEW / Waiting For = External Review Round 7**；P3=BLOCKED 不变。
- Round 7 输入建议：对 §2 的 verdict 口径（预注册规则 vs 归属上下文）作出 Reviewer 裁定；
  对 §6.1 偏差作出是否要求补 PR 的裁定。
