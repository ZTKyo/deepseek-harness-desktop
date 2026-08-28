# OX-ALPHA MULTI-RELAY SAME-MODEL FALLBACK — 最终报告

**日期**：2026-08-22
**分支**：`feature/ox-alpha-multi-relay-fallback`（从 main HEAD `ab2e70c` 创建）
**状态**：核心完成，PR 待审。本任务只做 same-model provider failover，未触碰 PR #3/#4、
Continuation Policy、Model Lab、Router 重构。

---

## 1 审计结论（先审计、不先改）

对候选 relay 逐个实测（`docs/execution-economy/probe/ox-relay-audit.mjs`，
每 relay ≤1 次 models 探测 + ≤1 次真实生成 "Reply exactly: OK"，走路由器 OpenClash 代理）：

| Relay | /models 是否列出 stealth/ox-alpha | 真实生成 | 判定 |
|---|---|---|---|
| openrouter（openrouter.ai/api/v1） | ✅ 420 模型含 ox-alpha | 200，respModel=stealth/ox-alpha，~1s | **SUPPORTED** |
| commandcode（api.commandcode.ai/provider/v1） | ✅ 57 模型含 ox-alpha | 200，respModel=stealth/ox-alpha，~2-4s | **SUPPORTED** |
| agentrouter（agentrouter.org/v1） | ❌ 仅 3 模型 | — | UNSUPPORTED |
| opencode-zen（opencode.ai/zen/go/v1） | ❌ | — | UNSUPPORTED |
| zenmux（zenmux.ai/api/v1） | ❌ 164 模型无 ox-alpha | — | UNSUPPORTED |
| bai（api.b.ai/v1） | ❌ | — | UNSUPPORTED |

**结论**：真实支持 ox-alpha 的 relay 只有 2 个 → 按任务 §12，最终为 **2-provider fallback**
（ox-relay-a=OpenRouter → ox-relay-b=Command Code）。不为了"必须三个"造假，
不拿其他模型冒充 ox-alpha，不绕过付费/认证/access restriction。

---

## 2 架构（最薄一层，复用现有机制）

不新建 Fallback Controller / Universal Router / Model Lab / Agent Router。
只新增两个文件 + 一个配置模板，完全复用 DSH 现有机制：

- `docs/execution-economy/plugins/ox-relay-core.mjs` —— 纯模块（无网络/无随机）：
  失败分类（canonical code 优先，message 兜底）、relay 链决策、观测记录构建、fail-closed 错误。
- `docs/execution-economy/plugins/ox-relay-failover.mjs` —— 宿主插件：
  - `agent/request`：只关心 `model === stealth/ox-alpha` 的请求；若已 armed 下一 relay，
    只改 provider（model 原样）；其他模型一律不干预。
  - `agent/request-error`：先 `await next()` 让 dsh-llm-retry 先做同模型同 provider bounded
    retry；放弃后才按失败类别决策：
    - RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT → 推进下一 relay（真实 provider failure 白名单）
    - AUTH / QUOTA / UNKNOWN_MODEL / INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED /
      EMPTY_RESPONSE / ABORTED → 一律不 fallback，如实报错
    - 链耗尽 → 抛 fail-closed 错误（含 "all ox-alpha relay attempts exhausted" + 各 provider failure kind）
- `docs/execution-economy/config/ox-relay-providers.yaml` —— provider profile 模板
  （ox-relay-a / ox-relay-b，apiKeyEnv 引用、`retryPolicy: maxRetries: 1` 防双重重试爆炸，
  模型 id 精确 `stealth/ox-alpha`）。
- `deploy-ox-relay.ps1` —— 事务式部署 + 持久跨进程回滚（与 deploy-router-fix.ps1 同构）。

**Same-Model Invariant**：logical/requested/final model 恒为 `stealth/ox-alpha`，
fallback 只允许 provider 改变。PR #4 的 deriveRequestedMode / KNOWN_ROUTING_MODES /
explicit_model_passthrough 零改动（回归测试 9/9 PASS）。

---

## 3 测试证据

### 3.1 确定性测试（CI，无真实 key）`tests/router/test-ox-relay-failover.mjs`
**64/64 PASS**，覆盖任务 §17 T1-T9：
- T1 A success → 不 fallback ✅
- T2 A fail → B success ✅
- T3 A fail → B fail → C success（3 链注入）✅
- T4 A/B/C 全失败 → fail closed（错误含 exhausted marker + provider=kinds，无其他模型）✅
- T5 每次 attempt model 恒为 stealth/ox-alpha ✅
- T6 UNKNOWN_MODEL 不跨模型/不跨 provider fallback ✅
- T7 AUTH/QUOTA 按定义处理（不静默切换）✅
- T8 retry 有上限（llm-retry 预算内不 arm；单次失败只 arm 一次）✅
- T9 primary/settings 隔离（turn 复位、session 隔离、dispose 清空）✅

### 3.2 部署回滚测试（CI，隔离）`tests/router/Test-OxRelayDeployRollback.ps1`
5 组跨进程用例全 PASS（deploy/rollback/redeploy/注入半替换失败回滚/absent 文件语义）。

### 3.3 真实端到端（live probe，需真实 key，不进 CI）`tests/router/live-ox-relay-fallback.mjs`
**12/12 PASS**（隔离 test seam：真实插件 + 真实 relay + 注入死端点）：
- TRIAL B：ox-relay-a 指向 `http://127.0.0.1:9`（真实连接拒绝 = TRANSPORT）
  → 插件推进 ox-relay-b → **真实生成 200，respModel=stealth/ox-alpha**（3.9s）
  → runtime events 证明 attempt1(A,TRANSPORT,next=B) → attempt2(B,成功)。
- TRIAL T1：健康 relay 单次 attempt 成功，**零 fallback 事件**（§11 NORMAL_COMPLETION_NO_FALLBACK）。

### 3.4 回归
- PR #4 exact-model preservation：9/9 PASS（未改动其代码）
- CI L1 本地全量门禁：PS1/JS/YAML 语法、secret scan、gitignore 断言 —— 全 PASS

---

## 4 验收对照（任务 §20）

| 项 | 结果 |
|---|---|
| PROVIDER A (ox-relay-a / OpenRouter) | **SUPPORTED** |
| PROVIDER B (ox-relay-b / Command Code) | **SUPPORTED** |
| PROVIDER C | **UNSUPPORTED**（如实缩短为 2-provider chain，§12） |
| SAME-MODEL IDENTITY | **PASS** |
| A → B FALLBACK | **PASS**（真实端到端） |
| A → B → C FALLBACK | **N/A**（无真实第三 relay，不造假） |
| NORMAL COMPLETION NO FALLBACK | **PASS** |
| ALL PROVIDERS FAIL CLOSED | **PASS** |
| PRIMARY UNCHANGED | **PASS（本任务未写 settings.yaml）**，附外部事实：任务期间
  agent-default-model 于 2026-08-22 01:42:13 被外部改为 bai/deepseek-v4-flash
  （本会话首个 request/header 证实任务开始时为 openrouter/stealth/ox-alpha；
  非本任务改动，未回滚，待用户确认） |
| CI | **PASS**（ci-level1 新增两项 ox-relay 测试） |
| PR | **READY FOR REVIEW** |

**实际成功的 fallback chain**：`stealth/ox-alpha : ox-relay-a (OpenRouter) → ox-relay-b (Command Code)`

---

## 5 文件清单

新增：
- `docs/execution-economy/plugins/ox-relay-core.mjs`
- `docs/execution-economy/plugins/ox-relay-failover.mjs`
- `docs/execution-economy/config/ox-relay-providers.yaml`
- `docs/execution-economy/probe/ox-relay-audit.mjs`
- `tests/router/test-ox-relay-failover.mjs`
- `tests/router/live-ox-relay-fallback.mjs`
- `tests/router/Test-OxRelayDeployRollback.ps1`
- `deploy-ox-relay.ps1`
- 本文档

修改：
- `.github/workflows/ci-level1.yml`（新增 2 个测试步骤）

未改动：PR #3/#4 全部文件、settings.yaml、cordis.patch.yml、运行中服务、其他 relay 配置。

## 6 部署说明（用户决定是否启用）
1. `powershell -File deploy-ox-relay.ps1`（事务式部署插件文件到 ~/.dsh/profiles/web/）
2. cordis.patch.yml 注册 `ox-relay-failover`（见脚本输出）
3. settings.yaml `llm-pi-ai.providers` 增加 ox-relay-a/b（模板：docs/execution-economy/config/）
4. 重启 dsh 服务生效；`-Rollback` 可随时还原
