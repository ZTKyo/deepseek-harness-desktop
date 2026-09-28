# AC2 研究腿生产闭环证据（RESEARCH_FULFILLED）

- 取证时间：2026-09-28T17:25Z（本机纪元毫秒 1790616xxx）
- 取证方式：**生产服务内的真实工具调用**（`learn_recall` / `learn_propose` / `learn_verify` / `learn_status`）+ 对生产经验库的**只读**抽取
- 会话：`session-76de1ca9-0a7a-4ad4-97b1-750a3dabbaf8`
- 经验库：`%LOCALAPPDATA%\DSHHarness\state\learn\session-76de1ca9-0a7a-4ad4-97b1-750a3dabbaf8.json`（777,101 B，schemaVersion=2）
- 原始记录（机器可读）：同目录 `AC2_STORE_RAW.json`（由 `_ac2-store-extract.mjs` 只读生成，脚本不含任何写 store 的代码路径）

## 1. 结论文档（先看这个）

**AC2 的机制在生产里真实闭环了**：一条研究腿由"晚于开腿、且通过确定性验证"的经验关闭，
并留下 `RESEARCH_FULFILLED` 遥测。**但它不是由本次研究产出的那条经验关闭的**（见 §4 缺口）。

## 2. 生产审计链（全部为生产遥测原文，按时间序）

| # | 纪元毫秒 | 事件 | 对象 | 原文 detail |
|---|---|---|---|---|
| 1 | 1790615617362 | `EXPERIENCE_LOOKUP_MISS` | — | `no experience coverage for: GitHub 分支保护 required_status_checks 与 enforce_admins：如何让 CI 质量门不被管理员绕过（API 字段与坑）` |
| 2 | 1790615617383 | `RESEARCH_REQUESTED` | — | `bounded research leg opened: leg_f8ed41e3 risk=LOW kind=NEW_SKILL maxAttempts=3 subject=…（同上）` |
| 3 | 1790616141869 | `VERIFICATION_FAILED` | `exp-a35e8739` | `deterministic verification FAILED: invalid_or_non_machine_checkable_evidence` |
| 4 | 1790616289949 | `VERIFIED` | `exp-e84b6350` | `deterministic verification PASS (method=session_outcome)` |
| 5 | 1790616289963 | `RESEARCH_FULFILLED` | `exp-e84b6350` | `research leg(s) closed by verified experience: leg_f8ed41e3 (method=session_outcome)` |
| 6 | 1790616289978 | `GLOBAL_PUBLISH_DENIED`（全局库） | `exp-e84b6350` | `refused publish: not_human_approved:VERIFIED_EXPERIENCE` |

研究腿对象（`learn_status` 原文，腿本体 `persistence=in_memory_only`，不落盘）：

```json
{"legId":"leg_f8ed41e3","subjectKey":"cand_f8ed41e3","source":"task_no_experience_coverage",
 "riskClass":"LOW","candidateKind":"NEW_SKILL","attemptsUsed":1,"maxAttempts":3,
 "exhausted":false,"openedAt":1790615617362,"fulfilledAt":1790616289963,"fulfilledBy":"exp-e84b6350"}
```

`learn_status` 计数变化（闭环前后各一次真实调用）：

| 计数 | 闭环前 | 闭环后 |
|---|---|---|
| `RESEARCH_FULFILLED` | 0 | **1** |
| `EXPERIENCE_LOOKUP_MISS` | 1 | 1（开腿事实保留） |
| `VERIFIED` | 10 | **11** |
| `byState.VERIFIED_EXPERIENCE` | 1 | **2** |
| `GLOBAL_PUBLISHED` | 0 | 0（全局库 count 仍为 1） |

## 3. 确定性验证到底验了什么（不是自述）

`exp-e84b6350` 的证据是 `session_outcome`，由插件在**官方原始会话事件**上现场取证：

```json
{"class":"session_outcome","sessionId":"session-76de1ca9-…","window":[1090082,1090217],
 "anchors":[1090082,1090084,1090215,1090217],"toolCalls":2,"toolSuccesses":2,"toolFailures":0,
 "factsDigest":"96ce1634","observedAt":1790616226292}
```

验证结果：`status=VERIFIED, method=session_outcome, verifiedAt=1790616289910, reverifyCount=1,
lastReverifyResult=PASS` —— 复算器按同样口径从 `window` 内的原始事件重新抽取工具结果并逐项比对
（`factsDigest=96ce1634`）。工具返回 `{"ok":true,…,"publication":"denied:not_human_approved:VERIFIED_EXPERIENCE"}`。

## 4. 缺口（AC2 的真问题，必须留在案上）

**同一次生产会话里出现了两组对照，缺口是决定性的：**

| 路径 | 经验 | 机器可校验证据 | learn_verify 结果 |
|---|---|---|---|
| 插件自动候选（`maybeLearn` → `propose()`，含 `verificationEvidence`） | `exp-e84b6350` | `session_outcome`（window 1090082-1090217, digest 96ce1634） | **PASS** → 关腿 |
| **宿主工具 `learn_propose`**（title/body/tags/sourceEventSeqs） | `exp-a35e8739`（本次研究结论本身） | **无**（`verification: null`） | **FAIL: invalid_or_non_machine_checkable_evidence** |

1. **宿主工具产不出可验证经验**：`learn_propose` 不接受/不生成任何机器可校验证据，
   所以**模型自己"研究出来的结论"永远无法通过 `learn_verify`**。能通过验证的经验只能来自
   插件自动候选路径（其标题往往是原始会话片段，如 `exp-e84b6350` 的标题就是一句推理文本）。
2. **闭环与会话内容无关**：`fulfillResearchLegs()` 的判定只看"经验创建时间晚于开腿 + 验证通过"，
   **不校验经验主题是否等于腿的主题**。因此本研究腿实际是被一条与 GitHub/CItance 无关的
   `correction` 类自动候选关掉的 —— 机制闭环成立，但"研究是否真的做完了"并未被证明。
3. 腿本体 `persistence=in_memory_only`：进程重启后腿对象消失，只剩遥测审计痕（本次两条遥测已落盘）。

### 本次研究本身（真实产出，未闭环）

研究结论落在独立证据文件里（可复算，非自述）：
`AC2_EVIDENCE_github-required-checks.md`（含 `gh api …/branches/main/protection` 原始 JSON 要点、
workflow 触发条件、PR #97 在 `DSH boot + readiness smoke`=FAILURE 时仍被合并的行为证据）。

结论原文（作为经验 `exp-a35e8739` 已入库，状态 PROPOSED/UNVERIFIED）：
配置了 required checks ≠ 门真的拦得住 —— 必须同时核对 ① required contexts ② strict
③ `enforce_admins` ④ 是否有 ruleset ⑤ workflow 触发条件 ⑥ 历史 PR 的 mergeCommit 行为证据。

## 5. 本文件不证明什么（边界）

- 不证明研究结论已被系统采纳：它是 PROPOSED，且在该证据文件被消费前无法通过 `learn_verify`。
- 不证明 `RESEARCH_FULFILLED` 内容可信：它只证明"有一条晚于开腿的经验通过了确定性验证"。
- 不涉及跨会话发布：`GLOBAL_PUBLISHED=0`，全局库 count=1 未变；验证通过并不授予发布权（B1 不变量，
  同一秒的 `GLOBAL_PUBLISH_DENIED` 是负控）。

## 6. 复算方法（第三方可重跑）

```powershell
# 1) 只读抽取生产经验库中的腿相关记录
node "_p4r2-final-closure\ac2-evidence\_ac2-store-extract.mjs"
# 2) 生产侧实时计数（经服务工具，非文件读）
#    learn_status → RESEARCH_FULFILLED / researchLegs[].fulfilledBy
```

## 7. 出处（会话 seq）

`1039394`/`1041627`/`1041631`（派只读研究子代理取 GitHub 真实状态）、`1049371`（子代理返回的
protection 事实表）、`1050154`（结论：contexts 2 个 / strict=true / enforce_admins=false / 无 ruleset）、
`1067914`（web_search 交叉核对 API 语义）、`1074143`（研究证据文件落盘）、`1074505`（该文件 SHA256）。
