# OPENROUTER_EXACT_MODEL_PRESERVATION_REPORT

**日期**：2026-08-21
**分类**：NORMAL（局部 Router bug fix）
**分支**：fix/openrouter-exact-model-preservation（从 main @ 3f4208c7 独立创建）
**Base**：main @ `3f4208c7c01b9bdf437de421809c098f6d778ee4`

---

## 1 Executive Summary

**显式选择 `stealth/ox-alpha` 之所以被改写为 deepseek：`deriveRequestedMode()` 把非 auto/qwen/deepseek/mimo 的明确模型 id 一律归为 "auto"，随后 `route()` 的 auto 规则（Rule 6 default / Rule 4 complex）把它路由成 deepseek。已修复：现在显式 concrete model id 走 exact passthrough（KNOWN_ROUTING_MODES allowlist 之外的模型保留原样直达 Provider），真实 Harness runtime 验证 request/header + request/context 均为 `openrouter / stealth/ox-alpha`，不再改写。**

## 2 Git / PR State

- branch：`fix/openrouter-exact-model-preservation` @ HEAD 基于 main `3f4208c7`
- base：main（未触碰）
- PR：待创建（→ main，不 merge）
- main SHA：`3f4208c7c01b9bdf437de421809c098f6d778ee4`（未变）
- PR #3（execution-economy-v1）：OPEN，未 merge，本任务独立、未触碰

## 3 Bug Reproduction

```
请求: provider=openrouter, model=stealth/ox-alpha
→ deriveRequestedMode("stealth/ox-alpha") = "auto"（不匹配 ALIASES）
→ route({requestedMode:"auto", ...}) → Rule 6 default → selected_model=deepseek
→ final: provider=openrouter, model=deepseek/deepseek-v4-flash-0731
```

复现证据（route() 直接调用）：
```
requestedMode=auto → selected_model: deepseek | rule: default | reason: cannot classify
```

真实运行时（修复前）：`request/header provider=openrouter model=deepseek/deepseek-v4-flash-0731`
**BUG_REPRODUCED = PASS**

## 4 Root Cause

| 项 | 值 |
|---|---|
| ROOT_CAUSE_FILE | `~/.dsh/profiles/web/openrouter-router.mjs`（deriveRequestedMode）+ `openrouter-router-core.mjs`（route Rule 0） |
| ROOT_CAUSE_FUNCTION | `deriveRequestedMode()`（router.mjs L176-182）+ `route()`（core L188-248） |
| ROOT_CAUSE_BRANCH | deriveRequestedMode 的 `return "auto"` fallback（L181）；route() 的 Rule 0 unknown→deepseek（L204） |
| ROOT_CAUSE_BEHAVIOR | explicit unknown concrete model → deriveRequestedMode 归为 auto → auto 路由选择其他模型 |

**额外发现的 latent bug**：route() L204 `decision(..., "deepseek")` 传字符串给 chain 参数 → `chain.map is not a function` crash（unknown alias 路径从未被安全测试）。

## 5 Correct Semantics

- **Routing aliases**（Router 可解释）：`auto` / `deepseek` / `qwen` / `mimo`（KNOWN_ROUTING_MODES allowlist）
- **Explicit model IDs**（必须保留）：`stealth/ox-alpha`、`vendor/future-model` 等 concrete provider-owned model id

**EXPLICIT MODEL IDENTITY INVARIANT**：
> 用户显式请求 concrete provider-owned model id 且无 cross-model fallback policy 时，Router 不得 silently substitute another model。

## 6 Implementation

最小修改（2 个文件，非硬编码 ox-alpha）：

1. **openrouter-router-core.mjs**：
   - 新增 `KNOWN_ROUTING_MODES = Set(["auto","qwen","deepseek","mimo"])`
   - `route()` Rule 0 开头：requestedMode 非空且非 KNOWN_ROUTING_MODES → `decision(explicit, explicit, "explicit_model_passthrough", ..., [explicit], explicit)`（exact passthrough，selected_model_id 用原值）
   - `decision()` 支持 `explicitId` 参数 + chain 非数组容错（修复 latent crash）
2. **openrouter-router.mjs**：
   - `deriveRequestedMode()`：unknown 但非空的 model 返回原值（不再归为 auto）；空/auto 才返回 "auto"

**未修改**：fallback 链、quota、昂贵保护、capability 检查、provider identity、Reliability、PR #3。

## 7 Unit Tests（tests/router/test-exact-model-preservation.mjs，9 项全 PASS）

| TEST | 输入 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | requestedMode=stealth/ox-alpha | 保留 stealth/ox-alpha | stealth/ox-alpha (explicit_model_passthrough) | PASS |
| 6 | requestedMode=vendor/future-model | 保留原值（不转 auto） | vendor/future-model | PASS |
| 2 | auto + complex task | deepseek（不变） | deepseek (default) | PASS |
| 3 | deepseek alias | deepseek/deepseek-v4-flash-0731 | 同 | PASS |
| 4 | mimo alias | xiaomi/mimo-v2.5 | 同 | PASS |
| 5 | qwen alias | qwen/qwen3.7-flash | 同 | PASS |
| 7 | requestedMode="" | auto 默认路由 | auto/deepseek | PASS |
| + | KNOWN_ROUTING_MODES 含 4 模式 | — | — | PASS |
| + | 不含 ox-alpha（无硬编码） | — | — | PASS |

## 8 Real Harness Validation

Prompt: `Reply exactly: OK`，provider=openrouter，model=stealth/ox-alpha（临时 mutate agent-default-model + finally restore）：

```
=== request/header ===
  provider=openrouter model=stealth/ox-alpha
=== request/context ===
  provider=openrouter model=stealth/ox-alpha
turnEnd: completed（ox-alpha generation 完成）
```

**IDENTITY TEST PASS**（修复前：provider=openrouter model=deepseek/deepseek-v4-flash-0731）
（UI/GUI/Vision 未使用，纯 runtime events 证据）

## 9 Fail-Closed Identity Test

不存在的 model id `vendor/definitely-not-real-ee-test`（临时 mutate + finally restore）：

```
turnEnd: error
message: "pi-ai provider \"openrouter\" has no configured model \"vendor/definitely-not-real-ee-test\""
code: UNKNOWN_MODEL
```

**FAIL-CLOSED PASS**：Router 未静默切换为 auto/其他模型；explicit id 保留到 Provider 解析层，Provider 如实报 UNKNOWN_MODEL（§12 要求：显式模型失败应 FAIL CLEARLY）。

## 10 Regression

| 项 | 结果 |
|---|---|
| stable openrouter catalog | 5 项不变（auto/qwen/deepseek/mimo/ox-alpha） |
| primary | commandcode/auto（restore 后确认） |
| auto 行为 | 不变（complex→deepseek, simple→qwen 逻辑保留） |
| deepseek/mimo/qwen aliases | 不变（单元测试 PASS） |
| trial/临时 route | 无残留 |
| credential | 未读取/未打印 |

## 11 Reliability Regression

| 检查 | 结果 |
|---|---|
| COMMIT_READY | PASS（ProcessIdentity/ApiReady/EventsMux/EventsHost/Renderer/StableWindow 全绿） |
| Guardian | PASS（Scheduled Task Running，heartbeat 21:57:56 正常） |
| Sessions | 可读 |
| Safe Mode / Transaction / Verified Last Good / Tool Offload | 未触碰 |

## 12 CI

- 本任务代码修改位于本机 `~/.dsh/profiles/web/`（运行插件层，不在仓库），CI L1/L2 不直接覆盖
- 仓库新增 `tests/router/test-exact-model-preservation.mjs`（本机验证脚本，import 本机 router；CI 不执行因依赖本地路径）
- PR 创建后 CI L1（syntax/secret）应 pass（新文件为纯 mjs，无 secret）

## 13 Files Changed（本任务）

本机（`~/.dsh/profiles/web/`，运行生效）：
- `openrouter-router-core.mjs`（KNOWN_ROUTING_MODES + passthrough + decision explicitId）
- `openrouter-router.mjs`（deriveRequestedMode 保留 unknown）

仓库（`_release-staging`，PR 内容）：
- `tests/router/test-exact-model-preservation.mjs`（新增，单元测试）
- `docs/execution-economy/OPENROUTER_EXACT_MODEL_PRESERVATION_REPORT.md`（本报告）
- 备份：`~/.dsh/profiles/web/_backup-openrouter-router*-exactmodel-*.mjs`

## 14 Remaining Risks

- 本机修复在服务重启后生效（已验证）；未来若 dsh 重装/覆盖 profile，需重新应用补丁（本机配置层，非仓库代码）
- explicit passthrough 把模型验证完全交给 Provider 层——若 Provider 对未知模型返回模糊错误，用户看到的是 Provider 错误而非 Router 信息（可接受，fail-closed 优先）
- multi-relay fallback（同模型跨中转）未实现（deferred）

## 15 Deferred

- Multi-relay ox-alpha fallback（同逻辑模型跨 Provider，独立任务）
- 429 / Provider availability 处理
- Continuation Discipline 持久化（Continuation Diagnosis 已验证 POLICY_ONLY_SUFFICIENT，独立落地）
- Execution Economy behavioral enforcement（PR #3）
- Model Lab / Router architecture redesign

## 16 Final Verdict

**READY FOR REVIEW**

验收核对：
- BUG_REPRODUCED ✅（复现证据 + 修复前真实 header）
- ROOT_CAUSE_CONFIRMED ✅（deriveRequestedMode + route Rule 0）
- minimal fix ✅（2 文件，KNOWN_ROUTING_MODES 泛化，无 ox-alpha 硬编码）
- explicit ox-alpha preserved ✅（单元 + 真实 header）
- unknown explicit model 不变 auto ✅（fail-closed UNKNOWN_MODEL）
- auto/deepseek/mimo/qwen 不变 ✅（单元测试）
- stable catalog 不变 ✅ / primary 不变 ✅
- 无 credential leak ✅ / 无永久测试 route ✅
- Reliability PASS ✅ / CI 待 PR 触发
- PR scope clean（仅 tests + docs；实现在本机 profile 层）✅
