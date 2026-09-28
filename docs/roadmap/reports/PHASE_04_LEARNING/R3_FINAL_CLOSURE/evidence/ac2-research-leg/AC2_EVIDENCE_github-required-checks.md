# AC2 研究腿证据包：GitHub「必需状态检查」为什么不等于发布门（fail-open 链）

- 研究腿：`leg_f8ed41e3`（生产会话内由 `learn_recall` MISS 开出，trigger=`task_no_experience_coverage`，bounded maxAttempts=3）
- 取证时间：2026-09-29 01:16 +08:00（全部结论均为**当时** live API 返回值，不是记忆）
- 被研究对象：`ZTKyo/deepseek-harness-desktop`（PUBLIC）
- 研究动机（真实需求）：本轮任务 AC10 要把"真实 E2E 成为真正的发布门"，需要先弄清"必需状态检查/管理员豁免"到底怎么配置才不会 fail-open。

---

## 一、官方 API 事实（docs.github.com，2026-09-29 查证）

- 必需的 context 名 = **check-run 的名字**；官方字段说明：`contexts` 为字符串列表，`checks` 为带 `app_id` 的更细粒度形式（`app_id` 省略时自动绑定"最近提供过该检查的 App"，`-1` 表示显式允许任何 App）。
- `enforce_admins`（boolean or null，**required**）：`true` = 对仓库**管理员**同样强制所有已配置限制；`null` = 关闭。
- 另有独立端点 `POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins`（设置需要有 admin/owner 权限且分支保护已启用）。
- 来源：<https://docs.github.com/en/rest/branches/branch-protection>

## 二、该仓库 live 状态（原文见同目录 `live-*.json`）

| 项 | 实测值 | 取证命令 |
|---|---|---|
| `required_status_checks.strict` | `true` | `gh api repos/<R>/branches/main/protection` |
| `required_status_checks.contexts` | `["Static + secret + syntax gate", "Reliability state machine tests"]` | 同上 |
| `required_status_checks.checks[].app_id` | `15368`（GitHub Actions App） | 同上 |
| `enforce_admins.enabled` | **`false`** | 同上 |
| `required_pull_request_reviews` | **字段不存在**（= 不强制走 PR） | 保护 JSON 顶层字段枚举 |
| `rulesets` | `[]`（未使用 rulesets 机制） | `gh api repos/<R>/rulesets` |
| `allow_force_pushes` / `allow_deletions` | `false` / `false` | 同上 |

## 三、五个已验证结论

**结论 1（context 的真实来源）**：必需 context = 工作流里 **job 级 `name:`** 字段，不是 job id、也不是 workflow 名。
证据：`ci-level1.yml:10-11` = `static-gate:` + `name: Static + secret + syntax gate`；`ci-level2.yml:10-11` = `state-machine-tests:` + `name: Reliability state machine tests`；而上表两个必需 context 与这两行**逐字相等**。
推论（可直接致错的坑）：**改了 job 的 `name:` 就会静默解除必需检查绑定**——PR 不再被拦，而 CI 里看不出任何报错。

**结论 2（谁能绕过）**：`enforce_admins=false` ⇒ 具备 admin 权限者（本例仓库唯一操作者 ZTKyo，`permissions.admin=true`）不受这些限制约束。

**结论 3（触发条件缺口，最关键）**：提供这两个必需 context 的两个工作流**只在 PR→main 与 push→`reliability-v1` 时触发**，**不在 push→main 时触发**。
证据：`ci-level1.yml:3-7`、`ci-level2.yml:3-7` 均只有 `pull_request: branches:[main]` + `push: branches:[reliability-v1]`。
⇒ **直推 main 时这两个"必需检查"根本不会运行**；配合结论 2、4，直推 main 可完全绕过质量门。

**结论 4（PR 也不是强制的）**：保护配置里没有 `required_pull_request_reviews` ⇒ 不强制走 PR，owner 可直推 main。

**结论 5（红灯 ≠ 阻断，有实证事故）**：PR #97（上一轮 P4 修复，`mergedAt=2026-09-26T16:46:07Z`，mergeCommit `171f1b40`）当时有三条检查：
- `DSH boot + readiness smoke` → **FAILURE**
- `Static + secret + syntax gate` → SUCCESS（必需）
- `Reliability state machine tests` → SUCCESS（必需）

**该 PR 仍然被合并进 main**。⇒ 只有被列入 `required_status_checks` 的名字才具备阻断力；其余检查即使红灯也只是"信息"。

## 四、据此得到的正确修复与验证（可复算）

```bash
# 让必需检查对管理员同样生效（fail-closed）
gh api -X POST repos/ZTKyo/deepseek-harness-desktop/branches/main/protection/enforce_admins
# 复算验证（必须回读到 true）
gh api repos/ZTKyo/deepseek-harness-desktop/branches/main/protection -q .enforce_admins.enabled
```
另外两条本文档没有直接改（超出本次研究腿范围，仅报告）：
1. 若要"直推 main 也过门"，需给 ci-level1/ci-level2 增加 `push: branches:[main]` 触发；
2. 若要"必须走 PR"，需启用 `required_pull_request_reviews`；
3. 任何 job `name:` 变更后，必须回读 `required_status_checks.contexts` 确认绑定未断（结论 1）。

## 五、证据文件与复算方式

同目录归档（均为 live API 原文，未删改）：
- `live-branch-protection.json` — main 保护配置原文（含 `enforce_admins.enabled=false`）
- `live-rulesets.json` — rulesets 原文（`[]`）
- `live-check-runs.txt` / `live-head.txt` — main head 及其 check-run
- `live-pr97-checks.json` — PR #97 的检查清单与结论（含 FAILURE 仍合并的事故原文）

复算命令（任一条都可独立重跑并得到与本文档一致的观察）：
```bash
R=ZTKyo/deepseek-harness-desktop
gh api repos/$R/branches/main/protection
gh api repos/$R/rulesets
gh pr view 97 --repo $R --json statusCheckRollup,mergedAt,mergeCommit
sed -n '9,12p' .github/workflows/ci-level1.yml   # 或直接读 job 级 name:
```

## 六、边界（诚实声明）

- 本文档只证明**机制**：必需检查的绑定来源、管理员豁免、触发缺口、红灯可被合并。它**不**推断合并者的主观意图（PR #97 的合并可能是知情决定）。
- 全部结论都可由上面命令当场复算；未使用任何记忆中的"经验值"。
- 本轮只读研究，未修改仓库任何保护配置（`enforce_admins` 的变更属后续 AC10 步骤，不在本证据包范围内）。
