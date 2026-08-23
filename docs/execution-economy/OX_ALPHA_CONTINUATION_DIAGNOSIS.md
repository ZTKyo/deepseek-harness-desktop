# OX_ALPHA_CONTINUATION_DIAGNOSIS

**日期**：2026-08-21
**分类**：NORMAL（诊断 + 隔离实验 + Policy 测试）
**Scope**：只诊断、不修改 Router、不实现 Helper、不 merge PR #3

---

## 1 Executive Summary

一句话回答"为什么 ox-alpha 需要用户手动发送'继续'"：

**真实会话证据显示：用户遇到的"中断/需要继续"实际发生在 DeepSeek / MiMo 上（ox-alpha 从未在这些 turn 中实际执行），真实原因是 429 限流中断 + 一次 DeepSeek 的 premature finalization（说"要写报告"就结束 turn）；而受控 A/B 实验证明：ox-alpha 本身不会 premature stop，它的问题是"极慢"（每步 90-120s），但在注入 CONTINUATION DISCIPLINE Policy 后，同一任务从 10 分钟未完成（5/13 步）变为 3 分 15 秒完成（13/13 步），且 Test #2 可复现。**

## 2 Real Session Evidence

### 2.1 session-90fab800（最初 ox-alpha 接入会话，10 turns）

| Turn | 实际模型（request/header） | turn/end | 性质 |
|---|---|---|---|
| 1 | commandcode/deepseek-v4-flash | aborted(user) | 用户手动停止（44min 任务被停） |
| 2 | bai/deepseek-v4-flash | **error** | **400: "reasoning_content in thinking mode must be passed back"**（OpenRouter DeepSeek thinking replay 错误） |
| 3 | commandcode/deepseek | aborted(user) | 用户主动停止（问路由问题） |
| 4 | openrouter/xiaomi/mimo-v2.5 | completed | 回答路由问题 |
| 5-9 | 未记录/其他 | completed | 后续任务 |

用户"继续"×3（seq 13089-13091）出现在 **turn 1 被用户自己停止之后**，不是模型 premature stop。
**整个会话 request/header 从未出现 stealth/ox-alpha。**

### 2.2 session-da8a53dd（Execution Economy 会话，17 turns，用户报告"中断/继续"）

| Turn | 实际模型 | turn/end | lastAsst | 备注 |
|---|---|---|---|---|
| 1 | openrouter/deepseek + openrouter/mimo | completed | **future-tense YES**（"Now I'll write the complete postmortem report"→ turn 停，报告未写出） | **premature finalization 实例（模型=DeepSeek）** |
| 2-5 | (none) | completed | turn4 YES 其余 NO | 用户追问中断原因 |
| 6 | (none) | completed | NO | assistant 引用 **llm/retry code=429 Overloaded** |
| 7-13 | (none) | completed | NO | 讨论 fallback/限流/接入 |
| 14 | (none) | aborted(user) | - | 用户手动停止 |
| 15-17 | (none) | completed | NO | 执行接入 |

**核心证据：**
- 用户"中断"的真实事件 = **429 Overloaded（限流）**（turn 6 明确引用）
- 唯一一次 premature finalization（turn 1 说"要写报告"就停）= **DeepSeek** 执行
- **没有任何 turn 的 header 是 ox-alpha**

## 3 Actual Route / Model Identity

- 真实会话：**从未有 ox-alpha 实际执行**（90fab800 和 da8a53dd 的 request/header 均为 deepseek/mimo）
- 受控实验：每个 Run 的 request/header **确认实际模型**（Run A/C/D = stealth/ox-alpha；Run B = deepseek-v4-flash-0731）——实验模型身份可靠

## 4 Fallback Hypothesis

**FALLBACK RELATION: NOT RELATED（对 premature stop）；PARTIALLY RELATED（对 429 中断）**

- 用户怀疑"ox-alpha 没有 fallback 导致中断"。真实会话的"中断"是 **429 限流**（provider failure）——**这类中断确实会被 fallback 缓解**（fallback 到别的 provider/model）。
- 但受控实验证明 ox-alpha **不 premature stop**（它一直工作到预算超时）——**fallback 与 premature finalization 无关**（主模型没失败，fallback 不触发，也不应触发——§32：不能把正常 stop 当 provider failure）。
- 结论：**429 中断 → fallback 相关（可缓解）；premature finalization → fallback 无关**。

## 5 complex-task-orchestrator Analysis

**ORCHESTRATOR_EXPLICIT_PAUSE_RULE = NO**

- 读取了 complex-task-orchestrator 的 SKILL.md 和 workflow-contract.md：
  - "Keep execution moving after an isolated failure"
  - "Continue with independent steps when one branch fails"
  - "Stop only when continuing would be unsafe, would need new authority, or no evidence-based alternative remains"
- **无任何"阶段完成后等待用户"、"每阶段 return"、"progress report 后暂停"的要求**。
- 结论：orchestrator 不是 premature stop 的原因（甚至要求继续执行）。

## 6 Turn-End Mechanism

- **TOOL_CONCLUDES_TURN = NO**（无工具显式请求结束 turn 的证据）
- **Harness limit = 排除**（agent.cordis.yml 无 maxSteps/maxTurns；dsh-agent-loop 无 step 限制）
- turn/end reason 在真实会话中：completed / aborted(user) / error(400)
- 真实 premature finalization 实例（turn 1 da8a53dd）：assistant 输出 future-tense 过渡句 → turn/end completed → **报告正文未产出** → 用户必须发"继续"。模型 = DeepSeek。

## 7 DeepSeek vs ox-alpha Control（受控 A/B）

同任务（13 步文件操作）、同 preset（autonomous）、同 workspace 结构、唯一变量 = 模型/route：

| Metric | Ox-alpha (Run A) | DeepSeek (Run B) |
|---|---|---|
| Actual Provider | openrouter-continuation-test-* | openrouter-continuation-deepseek-* |
| Actual Model | **stealth/ox-alpha** ✅ | **deepseek-v4-flash-0731** ✅ |
| Wall Clock | 10min 预算耗尽 | **80s** |
| Tool Calls | 6 | **10** |
| Steps | 150 | 46 |
| Turn End | TIMEOUT（未完成 5/13） | **completed（13/13）** |
| Premature Stops | **0**（一直工作） | 0 |
| DoD Complete | NO | **YES** |
| Provider Errors | 0 | 0 |
| Fallback Triggered | 0 | 0 |
| Scope Creep | NO | NO |

**结论：MODEL_SPECIFIC_CONTINUATION_DIFFERENCE = PASS（但方向是"速度"而非"premature stop"）**
ox-alpha 不 premature stop，但**极慢**（每步 90-120s vs DeepSeek ~8s），导致 10 分钟预算内完不成任务。

## 8 Harmless Baseline Test

Run A（ox-alpha，无 Policy）：10 分钟只完成 5/13 步，最后输出进度报告，turn 未结束（被我方 10 分钟预算终止）。**Baseline = FAIL（未完成 DoD），但原因 = 速度慢，非 premature finalization。**

## 9 Continuation Policy

Session-local 注入（不改 AGENTS.md）的 CONTINUATION DISCIPLINE（核心）：
- DoD 未完成时禁止 progress-only/future-tense 结尾
- 下一步可执行 → CALL THE TOOL NOW
- PROGRESS + TOOL EXECUTION 允许；PROGRESS INSTEAD OF EXECUTION 禁止
- 最终回复仅在 DoD 完成 / 需要用户 / 真实阻塞时允许
- 不要求用户输"继续"；遵守 Execution Economy（STOP when DoD done）

## 10 Policy Test #1（Run C）

| Metric | Ox-alpha + Policy |
|---|---|
| Actual Model | **stealth/ox-alpha** ✅（19 headers） |
| Wall Clock | **3m15s** |
| Tool Calls | 12 |
| Turn End | **completed（13/13 步）** |
| DoD Complete | **YES** |
| Premature Stops | 0 |
| Manual Continue Required | **NO** |
| Future-tense 结尾 | NO（正式报告） |
| Provider Errors | 0 |
| GUI/Screenshot/Vision | 0 |
| Scope Creep | NO |

**Test #1 = PASS**（Manual Continue=NO, Premature Stops=0, DoD=YES, Todo=0）

## 11 Policy Test #2（Run D — 可复现性）

新 workspace、新 route、内容 GAMMA/DELTA（防 replay）：

| Metric | Ox-alpha + Policy #2 |
|---|---|
| Actual Model | **stealth/ox-alpha** ✅（42 headers） |
| Wall Clock | ~3m30s |
| Tool Calls | 14 |
| Turn End | **completed（13/13 步）** |
| DoD Complete | **YES** |
| Premature Stops | 0 |
| Manual Continue Required | **NO** |
| Provider Errors | 0 |
| Scope Creep | 轻微（最后写了 completion-notify flag，无害；已在报告标注） |

**Test #2 = PASS → REPRODUCIBLE POLICY FIX**

## 12 Before / After

| Metric | Ox-alpha Baseline | DeepSeek Control | Ox-alpha + Policy #1 | Ox-alpha + Policy #2 |
|---|---|---|---|---|
| Actual Model | ox-alpha | deepseek | ox-alpha | ox-alpha |
| Wall Clock | 10min(未完成) | 80s | 3m15s | ~3m30s |
| Tool Calls | 6 | 10 | 12 | 14 |
| Premature Stops | 0 | 0 | 0 | 0 |
| Manual Continue | N/A(预算停) | NO | NO | NO |
| DoD Complete | NO | YES | YES | YES |
| Turn End | TIMEOUT | completed | completed | completed |
| Provider Errors | 0 | 0 | 0 | 0 |
| GUI/Vision | 0 | 0 | 0 | 0 |
| Scope Creep | NO | NO | NO | 轻微 |

## 13 Root Cause

**TOP 1 ROOT CAUSE: I. OTHER（多重机制，但都不是"ox-alpha 特有 premature finalization"）**

按证据拆解：
1. **用户感知的"中断"主要 = 429 Overloaded 限流中断**（真实会话 turn 6 证据）→ 这由 provider 限流引起，fallback 可缓解
2. **一次真实 premature finalization**（da8a53dd turn 1）→ 模型是 **DeepSeek**，不是 ox-alpha
3. **ox-alpha 的实际问题 = 极慢**（每步 90-120s）→ 慢到用户以为"停了"，或任务超时/被停后用户发"继续"
4. **Router 模型身份问题**（已知 separate issue）：主 openrouter route 下 ox-alpha 会被 deriveRequestedMode 当 auto 改写 → 用户以为在跑 ox-alpha，实际是 deepseek/mimo

**FALLBACK RELATION: PARTIALLY RELATED**（429 中断可被 fallback 缓解；premature finalization 无关）
**ORCHESTRATOR RELATION: NOT RELATED**（orchestrator 要求继续执行，无暂停规则）
**ROUTER RELATION: SEPARATE ISSUE**（模型身份改写是独立问题，本实验用独立 route 绕开）

## 14 Policy Fix Verdict

**POLICY_ONLY_SUFFICIENT**

- Test #1 PASS + Test #2 PASS = **REPRODUCIBLE POLICY FIX**
- CONTINUATION DISCIPLINE（session-local 注入）让 ox-alpha 从"10 分钟未完成"变为"3 分钟完成 13 步"
- **NO THIN GUARD REQUIRED**（Policy 已足够；§36 的 turn-stopping guard 设计不需要实现）

## 15 Recommended Persistent Fix

建议把以下核心（约 12 行）加入 AGENTS.md / Agent Instructions（不包含完整测试 Prompt）：

```markdown
## CONTINUATION DISCIPLINE
- DoD 未完成时，禁止以 progress-only / planning-only / future-tense 消息结束 turn。
- 下一步可用工具执行 → 立即调用工具，不要只报告进度。
- 最终回复仅在：DoD 全部完成 / 需要用户独占信息或授权 / 真实阻塞且无安全 fallback 时给出。
- 禁止要求用户输入"继续"；低风险可逆动作不请求确认。
- DoD 完成后立即 STOP（服从 Execution Economy）。
```

> 说明：本修复同时缓解"premature finalization"（DeepSeek 也受益）和"ox-alpha 慢导致的任务中断感"。429 限流需要 fallback 配置（separate）；Router 模型身份需独立处理。

## 16 Separate Issues

1. **openrouter router model mapping**（已知）：`deriveRequestedMode()` 只认 auto/qwen/deepseek/mimo，主 openrouter route 下显式选 ox-alpha 会被改写成 auto→deepseek。需独立阶段处理 Router。
2. **Execution Economy behavioral compliance**（PR #3 FAIL）：新 Agent 加载 Policy 但未遵守 FAST 预算。独立问题，不在本阶段。

## 17 Stable State Verification

| 项 | 结果 |
|---|---|
| agent-default-model | commandcode/auto（exact restore）✅ |
| stable openrouter provider | 未改 ✅ |
| stable catalog | auto/qwen/deepseek/mimo/ox-alpha 5 项不变 ✅ |
| existing routes | 9 个不变 ✅ |
| trial/continuation routes | 全部清理，无残留 ✅ |
| temp workspaces | 已清理 ✅ |
| credential | 未读取/未打印 ✅ |
| completion-notify flag | 无污染 ✅ |
| restart | 无 ✅ |

## 18 Final Verdict

```
ROOT CAUSE: 多重机制 —— ①用户感知的"中断"主要是 429 限流（fallback 可缓解）；
           ②一次真实 premature finalization 发生在 DeepSeek 上（非 ox-alpha 特有）；
           ③ox-alpha 的实际问题是极慢（每步 90-120s），非 premature stop；
           ④Router 模型身份改写是 separate issue
FALLBACK RELATION: PARTIALLY RELATED（429 中断可缓解；premature stop 无关）
ORCHESTRATOR RELATION: NOT RELATED
DEEPSEEK CONTROL: PASS（80s 完成 13 步，无 premature stop）
OX-ALPHA BASELINE: 未完成（10min 仅 5/13 步，因慢非因 premature stop）
OX-ALPHA POLICY TEST #1: PASS（3m15s 完成 13 步，无人工继续）
OX-ALPHA POLICY TEST #2: PASS（可复现，~3m30s 完成 13 步）
POLICY FIX: POLICY_ONLY_SUFFICIENT（NO THIN GUARD REQUIRED）
RECOMMENDED PERSISTENT FIX: ~12 行 CONTINUATION DISCIPLINE 加入 AGENTS.md
  （同时缓解 premature finalization 与 ox-alpha 任务中断感；429 与 Router 独立处理）
```
