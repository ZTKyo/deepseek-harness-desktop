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

- 运行中服务在文件部署后需要重启才加载新代码（ESM 插件启动时 import）；本次部署前后 hash 一致故无需重启
- explicit passthrough 把模型验证完全交给 Provider 层——若 Provider 对未知模型返回模糊错误，用户看到的是 Provider 错误而非 Router 信息（可接受，fail-closed 优先）
- multi-relay fallback（同模型跨中转）未实现（deferred）

## 15 Deferred

- Multi-relay ox-alpha fallback（同逻辑模型跨 Provider，独立任务）
- 429 / Provider availability 处理
- Continuation Discipline 持久化（Continuation Diagnosis 已验证 POLICY_ONLY_SUFFICIENT，独立落地）
- Execution Economy behavioral enforcement（PR #3）
- Model Lab / Router architecture redesign

---

## 17 Persistence Seal（2026-08-21 追加）

**BEFORE PERSISTENCE SEAL**：修复仅存在于本机 runtime profile（`~/.dsh/profiles/web/`），测试依赖 `file:///C:/Users/Administrator/...` absolute path，不可复现部署。

**AFTER PERSISTENCE SEAL**：修复已升级为 repository-owned + CI-tested + 可部署 + 可回滚。

### 17.1 Repository Canonical Source

| 文件 | 位置 | 状态 |
|---|---|---|
| openrouter-router-core.mjs | `docs/execution-economy/plugins/` | canonical（repo tracked） |
| openrouter-router.mjs | `docs/execution-economy/plugins/` | canonical（repo tracked） |

- **canonical hash == runtime hash**（1A09C1BD... / 08C80BBD...，两文件均一致）
- 无机器特定路径：修复了 router.mjs 的 `C:/Users/Administrator` 硬编码 → `os.homedir()`（行为不变）
- 无 secret

### 17.2 Portable Unit Test

- `tests/router/test-exact-model-preservation.mjs`：import **repo canonical source**（`docs/execution-economy/plugins/`，repo-relative 解析）
- 从 repo root `node tests/router/test-exact-model-preservation.mjs` 直接可跑
- **零机器依赖**：无 `C:\Users\...`、无 `~/.dsh`、无 OpenRouter key、无 live server
- 9/9 PASS

### 17.3 CI Integration

- `.github/workflows/ci-level1.yml` 新增 step `OpenRouter exact-model preservation tests`
- 保留原 required check 名（Static + secret + syntax gate），Branch Protection 无需重配
- CI 在 clean checkout 上执行 portable test（纯 router 逻辑，deterministic）

### 17.4 Deployment Mechanism

- `deploy-router-fix.ps1`（repo tracked，极薄 transactional）：
  - snapshot（pre-deploy copy + hash）
  - stage + `node --check` 语法验证
  - transactional replace（same-dir temp + Move-Item；**不是 OS-level atomic rename**，见 Rollback Seal）
  - verify（runtime hash == canonical hash）
  - 持久化 rollback point（manifest + snapshot，跨进程可用）
- 复用 `$env:USERPROFILE`（无硬编码用户路径）
- 不覆盖整个 profile，只部署 2 个 router 文件

### 17.5 Runtime Deployment + Verification

- 部署后 runtime hash == canonical（1A09C1BD / 08C80BBD）
- 真实 identity probe：`request/header` + `request/context` = **openrouter / stealth/ox-alpha**（IDENTITY_PASS）
- primary snapshot/restore 确认 `commandcode/auto` 不变

### 17.6 Rollback / Redeploy Drill

1. 模拟 bug 状态（从旧 backup 恢复 → hash 04DF37/4607F4 ≠ 修复版）
2. `deploy-router-fix.ps1` 重新部署 → hash = canonical（1A09C1/08C80B）✅
3. `-Rollback` → 恢复到 snapshot（hash 一致）✅
4. 最终状态：**FIX DEPLOYED**（canonical == runtime）✅

### 17.7 Reinstall / Recovery Procedure

如果 `~/.dsh/profiles/web/` 被删/被覆盖：

```powershell
git clone https://github.com/ZTKyo/deepseek-harness-desktop.git
cd deepseek-harness-desktop
powershell -File deploy-router-fix.ps1   # canonical → runtime
# 若服务在跑：重启 3080（加载新代码）
```

### 17.8 Persistence Evidence

```
Canonical Source:    docs/execution-economy/plugins/ (repo)
Runtime Destination: $env:USERPROFILE/.dsh/profiles/web/
Deployment Method:   deploy-router-fix.ps1 (transactional)
Unit Test Source:    repo canonical (portable, 9/9 PASS)
CI Test:             L1 step added (exact-model preservation tests)
Runtime Identity:    openrouter / stealth/ox-alpha (request/header + context)
Rollback:            PASS (hash-restored)
Redeploy:            PASS (bug state → canonical)
Final Runtime State: FIX DEPLOYED
```

## 16 Final Verdict（更新）

**READY TO MERGE PR #4**

验收核对（含 Persistence Seal）：
- REPO_CANONICAL_SOURCE ✅（docs/execution-economy/plugins/，hash 与 runtime 一致）
- NO_MACHINE_ABSOLUTE_PATH ✅（os.homedir 替换，测试 repo-relative）
- PORTABLE_UNIT_TEST ✅（clean checkout 可跑，9/9）
- CI_EXECUTES_UNIT_TEST ✅（L1 新 step）
- TRANSACTIONAL_DEPLOYMENT ✅（deploy-router-fix.ps1）
- ROLLBACK ✅（hash 恢复验证）
- REDEPLOY ✅（bug 状态 → canonical）
- RUNTIME_IDENTITY ✅（openrouter/stealth/ox-alpha）
- EXPLICIT_OX_ALPHA ✅ / UNKNOWN_EXPLICIT_FAIL_CLOSED ✅
- AUTO_REGRESSION ✅ / ALIASES_REGRESSION ✅
- CATALOG_UNCHANGED ✅（5 项） / PRIMARY_UNCHANGED ✅（commandcode/auto）
- SECRET_HYGIENE ✅ / COMMIT_READY ✅ / GUARDIAN ✅
- CI_L1 / CI_L2 待最终 push 确认
- PR_SCOPE ✅（canonical source + test + CI hook + deploy script + report）

---

## 18 Rollback Seal（2026-08-21 追加）

### 18.1 Audit Finding（独立复核发现）

Persistence Seal v1 的 rollback **过度声明了 PASS**。独立复核发现：

1. **旧 rollback bug**：`deploy-router-fix.ps1` 每次运行都创建**新的随机 snapshot**（`router-fix-snap-<guid>`）。独立执行 `-Rollback` 时，它会先备份"当前状态"再恢复这个新备份——**实际恢复的是当前状态本身，不是上一次 deploy 前的状态**。跨进程 rollback 无效。
2. **失败路径可能不恢复**：部分失败分支（如 hash mismatch）只 `exit 1`，没有真正恢复整个 deployment 前状态。
3. **"atomic" 表述过度**：`Copy-Item -Force` 被描述为 atomic，实际不是 OS-level atomic replace。

### 18.2 Rollback 修复

`deploy-router-fix.ps1` 重写：

- **持久 manifest**：`$HOME/.dsh/transactions/router-fix/current.json` 记录 transaction_id / status / files（existed、sha256、snapshot path）。
- **持久 snapshot**：`$HOME/.dsh/transactions/router-fix/snapshots/<txn-id>/` 保存 pre-deploy 文件。
- **跨进程 rollback**：`-Rollback` 读取 committed manifest → 定位 snapshot → 恢复 exact pre-deploy 状态（含 ABSENT 文件 → 删除）。**绝不**在 rollback 时重新备份当前状态。
- **两文件一体 transaction**：任一文件 stage/replace/verify 失败 → 自动恢复两文件到 pre-deploy（无 partial deployment）。
- **transactional replace**：same-dir temp + Move-Item；文档如实写 **transactional replace**（非 OS-level atomic rename）。
- **测试隔离**：`-RuntimeRoot` / `-StateRoot` / `-CanonRoot`（CI/测试用，默认生产行为不变）。
- **fail-closed**：manifest 缺失 / snapshot 缺失 / 未 committed / 未托管文件名 → `ROLLBACK REFUSED`。

### 18.3 Cross-Process Rollback Test（真实三进程）

```
PROCESS 1: OLD(04DF37/4607F4) → deploy → FIXED(1A09C1/08C80B) → exit
PROCESS 2: -Rollback（新进程）→ EXACT OLD(04DF37/4607F4) → exit
PROCESS 3: deploy（新进程）→ EXACT CANONICAL(1A09C1/08C80B) → exit
```

`tests/router/Test-RouterDeployRollback.ps1`（CI 执行，隔离 root）：
- T1 deploy → canonical（manifest 持久化）PASS
- T2 跨进程 rollback → exact OLD PASS
- T3 跨进程 redeploy → canonical PASS
- T4 stage 失败注入（坏第二文件）→ 两文件都未替换 PASS
- T5 absent-file 语义（deploy over absent → rollback 删除）PASS

### 18.4 Failure Injection

- **partial-replace 失败注入（T4，2026-08-22 修正）**：`-InjectReplaceFailure` 测试专用 seam 在**第一个文件 replace 成功后、第二个文件 replace 前**抛 terminating error（生产绝不启用）。验证：
  - A replace 成功 → 注入失败 → 部署 exit 非零
  - **A hash == OLD A**（自动 rollback）
  - **B hash == OLD B**（从未被 replace）
  - **无 *.new-<txn> temp residue**（catch 中清理）
  - 输出明确 `DEPLOY FAILED | ROLLBACK PASS`
- replace 阶段文件操作全部 `-ErrorAction Stop`（真实失败必进 catch，无静默 partial）
- catch 显式 `$allOk = $true` 初始化；每文件恢复后验证 hash/ABSENT
- 早期注入（stage 语法错误）仍验证：失败时 runtime 未被触碰

### 18.5 Acceptance Matrix

| 项 | 结果 |
|---|---|
| PERSISTENT_ROLLBACK_POINT | PASS（manifest + snapshot 持久化） |
| CROSS_PROCESS_ROLLBACK | PASS（独立进程找到 committed snapshot） |
| EXACT_PRESTATE_RESTORE | PASS（hash 逐文件验证） |
| ABSENT_FILE_RESTORE | PASS（T5：部署后 rollback 删除） |
| PARTIAL_FAILURE_RECOVERY | PASS（T4：两文件都保持 old） |
| DEPLOY_HASH_VERIFY | PASS（runtime == canonical） |
| REDEPLOY | PASS（T3） |
| RUNTIME_IDENTITY | PASS（openrouter/stealth/ox-alpha） |
| PRIMARY_UNCHANGED | PASS（commandcode/auto） |
| CATALOG_UNCHANGED | PASS（实时 before/after 一致） |
| COMMIT_READY | PASS |
| GUARDIAN | PASS |
| CI_L1 / CI_L2 | 待最终 push 确认 |
