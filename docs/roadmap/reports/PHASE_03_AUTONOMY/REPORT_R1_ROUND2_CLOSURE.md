# P3 AUTONOMY R1 — Round 2 收口报告（F1 闭环 + CI Gate + 状态回填）

- 日期：2026-09-21
- 分支：`p3-autonomy-r1-round2-closure`（自 `origin/main` @ `6d0623627c4b38f6b870ef03fe9ed776186c9e09`）
- 性质：**治理收口 + 独立复核**；本报告不新增任何生产代码
- 前置事实（已核实）：
  - R1（PR #75，`466abc9`+`69ade9b`+`9274418`）已合入 main
  - **R1C 修复（PR #76，`5e9d470` → mergeCommit `e19c3e6`）已合入 main**：宿主侧确定性证据复核 `hostVerifyEvidence()`（注入 io、fail-closed）
  - **Round 2 CI gate 经 PR #86（`ac50a20` → mergeCommit `e16372a`，2026-09-12）已合入 main**
- 本轮目的：把 P3 从「R1 verdict 待裁决」推进到合同要求的 **`AWAITING_EXTERNAL_REVIEW Round 2`**，并把 Round 2 的证据链与状态**落到 main**，交由外部评审裁决。

---

## 0 TL;DR

1. **Round 1 唯一 Blocker（F1）已闭环且可复现**：`autonomy_verify` 不再信任模型自述的 `file_hash` / `system_api` 证据串；伪造、错配、缺失、目录、prose 一律 fail-closed 降级 `UNVERIFIED`（零里程碑、零 checkpoint），PASS 记录带 `HOST-VERIFIED` 前缀。**旧缺陷（真实文件不存在也能 PASS 并派生 `verificationState=VERIFIED`）已不可复现。**
2. **负向 verifier 回归已进 CI gate 且是必需门禁**：main 的 `.github/workflows/ci-level2.yml` 含 step **`P3 AUTONOMY host-verifier fail-closed gate`**，同时 gate 两个套件（core + 生产路径集成），任一非零即 `throw` ⇒ Level 2 失败。该 job 即 GitHub 上 PR #90 显示为 **pass（7m22s）** 的 `Reliability state machine tests`。
3. **本轮对 main 的确切代码重跑证据（非引用旧报告）**：
   - `tests/autonomy/test-autonomy-state-core.mjs` → **104 PASS / 0 FAIL**（exit 0）
   - `tests/autonomy/test-ec-autonomy-deployed.mjs` → **67 PASS / 0 FAIL**（exit 0，打真实 `plugins/execution-continuity.mjs`）
   - 被验文件与 main blob **hash 一致**：`git hash-object plugins/execution-continuity.mjs` = `git rev-parse origin/main:plugins/execution-continuity.mjs` = `6d8a1746a4e5e9082d1139f79f1eeb8f1ae1c24f`
4. **部署面一致**：生产 `~/.dsh/profiles/web/execution-continuity.mjs` 与 `origin/main` **逐字节相同**（126860 B，sha256 `041aad8d4510c33dc3e3671a3ae2b407d18cf9a25db1f75bef7604255ab9c848`）⇒ R1C 修复已在运行面生效，无部署漂移。
5. **状态**：`AWAITING_EXTERNAL_REVIEW`（**Round 2**）。**不做 self-VERIFIED**，**不进入 Phase 04**。

---

## 1 Round 1 Blocker（F1）闭环证据

### 1.1 Blocker 原文（Reviewer Round 1）

> `autonomy_verify` 可接受模型伪造的 `file_hash` / 命令输出字符串，在真实文件不存在时仍写入 PASS 并派生 `verificationState=VERIFIED`。

### 1.2 闭环机制（main 实测锚点）

| 检查 | 结果 | 证据（main） |
|---|---|---|
| 宿主复核函数存在 | 有 | `plugins/autonomy-state-core.mjs` 含 `hostVerifyEvidence`；L367 注释「system_api 的记录 ⇒ 宿主复核已成功（证据文本带 HOST-VERIFIED 前缀）」 |
| 工具面在记 PASS 前调用它 | 有 | `plugins/execution-continuity.mjs:2173` 构造 `HOST-VERIFIED (${hostResult.detail}): ${evText}`；L2140-2173 为绑定门禁 + 宿主复核链路 |
| 绑定门禁（R1C-2） | 有 | L2155 `target_unbound`；L2157-2162 `target_binding_mismatch`（file→canonical 路径比对；api→port/path/expectStatus/expectContains 全等） |
| 软证据不可 PASS | 有 | 工具描述明载 `SOFT-EVIDENCE RULE`：git/browser_state/screenshot/ai_judgment 一律记 `UNVERIFIED` + `SOFT-EVIDENCE` 前缀，不建里程碑 |
| prose / 不可核验证据 | 有 | 一律 fail-closed 记 `UNVERIFIED`，`verificationState` 永不由其派生 `VERIFIED` |
| system_api 回环限定 | 有 | 仅 `127.0.0.1`，**只发 GET** |
| 部署面与仓库一致 | 一致 | 生产与 main 逐字节相同（§0.4） |

### 1.3 负向回归覆盖（main 上实跑，逐条点名）

`test-ec-autonomy-deployed.mjs` 的 **I15–I19** 直接覆盖 Round 1 Blocker 的各条绕过路径，全部 PASS：

| 用例 | 断言 | 结果 |
|---|---|---|
| **I15** | 软证据 PASS → 降级 `UNVERIFIED` + `SOFT-EVIDENCE` 前缀；`verificationState` 保持 `UNVERIFIED`；**不产生里程碑/checkpoint** | PASS |
| **I16** | **unbound → `target_unbound`，且「即使证据本身完全有效」也不得 PASS**；无 `VERIFIED`/里程碑；事后声明绑定（write-once，PASS 前）→ 绑定 + 真实证据 → PASS → `VERIFIED` | PASS |
| **I17** | **另一个真实文件的真 hash → `target_binding_mismatch` → `UNVERIFIED`**；对已绑定文件的证据 → PASS；file_hash 打到 api 绑定的准则 → `UNVERIFIED` | PASS |
| **I18** | api 绑定：spec/绑定不匹配 → **发请求前**即 `UNVERIFIED`（确定性）；绑定匹配 + 真实回环 → PASS → `VERIFIED` | PASS |
| **I19** | 绑定 write-once：把已设 index 改绑到不同 target → `immutable_criteria_binding:0`；重复声明**完全相同**的绑定 → 幂等接受 | PASS |

`test-autonomy-state-core.mjs` 的绑定校验负向面同样全绿，含：
`relative path rejected`、`unknown field on file binding rejected`、`port=0 rejected`、`port=70000 rejected`、
`api path without leading slash rejected`、`expectStatus=99 rejected`、`unknown kind rejected`、
`re-binding index 0 to a different target rejected`、`length != criteria count rejected`、
`null bindings when set -> rejected`、`bindings without criteria ever set -> bindings_require_criteria`、
`file binding path canonized (case/resolution normalized)`、`re-declaring the IDENTICAL bindings accepted (idempotent)`。

### 1.4 结论

**F1 已闭环，且闭环方式为「宿主侧确定性复核 + fail-closed 降级」，不依赖模型自述。**
旧的「伪造证据也能 PASS → VERIFIED」路径在当前 main 与生产面上均不可复现。

---

## 2 CI Gate（本轮的真实治理增量）

### 2.1 main 中的门禁原文

`.github/workflows/ci-level2.yml`（origin/main）：

```yaml
      # P3 AUTONOMY R1 final CI closure: host-side deterministic evidence
      # verification is already implemented in autonomy-state-core.mjs and
      # exercised through execution-continuity.mjs. Keep this as a required
      # step: either suite failing makes Level 2 fail, and the integration
      # suite uses a repo-local production module rather than a runner profile.
      - name: P3 AUTONOMY host-verifier fail-closed gate
        shell: pwsh
        env:
          DSH_AUTONOMY_EC_PATH: ${{ github.workspace }}/plugins/execution-continuity.mjs
        run: |
          node tests\autonomy\test-autonomy-state-core.mjs
          if ($LASTEXITCODE -ne 0) { throw 'P3 AUTONOMY core verifier suite failed' }
          node tests\autonomy\test-ec-autonomy-deployed.mjs
          if ($LASTEXITCODE -ne 0) { throw 'P3 AUTONOMY production-path integration suite failed' }
          Write-Host 'PASS P3 AUTONOMY host-verifier fail-closed gate'
```

**门禁语义**：两个套件**都必须**通过，任一非零即 `throw` ⇒ Level 2 失败。
且集成套件通过 `DSH_AUTONOMY_EC_PATH` 指向**仓库内生产模块**（`plugins/execution-continuity.mjs`），
而非 runner 的 profile ⇒ CI 可移植、且验证的是真实生产代码。

### 2.2 该门禁的线上实证

GitHub PR #90 的 check `Reliability state machine tests` = **pass（7m22s）**，
即上述 Level 2 job（含本 gate）在真实 runner 上通过。

### 2.3 血缘澄清（避免重复劳动与误记）

Round 2 的 CI 接线曾有**两次尝试**，本报告如实记录：

| 尝试 | 分支 / 提交 | 结局 |
|---|---|---|
| 第一次 | `p3-autonomy-r1-round2-ci-gate` / `a6184eb`（2026-09-02，自 `1a03c0b`）——含 `REPORT_R1_ROUND2_CLOSURE.md` 初版 | **从未合并**；已落后 main 25 个提交，**被第二次取代** |
| 第二次（生效） | `p3-autonomy-r1-ci-closure` / `ac50a20` → **PR #86 mergeCommit `e16372a`**（2026-09-12） | **已合入 main**，落地 §2.1 的 gate |

⇒ 第一次尝试携带的收尾报告**未能进入 main**（main 中不存在任何 Round2 报告文件，已核实）；
本报告即为补上该缺口，并按第二次的实际血缘重写，避免记录失真。

---

## 3 本轮独立验证证据（可复现）

在**干净的 main 工作树**（`HEAD == origin/main`，工作树 clean）中执行：

| 套件 | 命令 | 结果 |
|---|---|---|
| core 负面回归 | `node tests\autonomy\test-autonomy-state-core.mjs` | **104 PASS / 0 FAIL**，exit 0 |
| 生产路径集成 | `$env:DSH_AUTONOMY_EC_PATH="<repo>\plugins\execution-continuity.mjs"; node tests\autonomy\test-ec-autonomy-deployed.mjs` | **67 PASS / 0 FAIL**，exit 0 |

**证据有效性核对**（防止「跑的不是 main」）：

| 文件 | `git hash-object`（工作树） | `origin/main` blob | 判定 |
|---|---|---|---|
| `plugins/execution-continuity.mjs` | `6d8a1746a4e5e9082d1139f79f1eeb8f1ae1c24f` | `6d8a1746a4e5e9082d1139f79f1eeb8f1ae1c24f` | **一致** |
| `plugins/autonomy-state-core.mjs` | — | — | 一致（SAME as main） |
| `tests/autonomy/test-autonomy-state-core.mjs` | — | — | 一致（SAME as main） |
| `tests/autonomy/test-ec-autonomy-deployed.mjs` | — | — | 一致（SAME as main） |

**部署面核对**：生产 `~/.dsh/profiles/web/execution-continuity.mjs`
= 126860 B，sha256 `041aad8d4510c33dc3e3671a3ae2b407d18cf9a25db1f75bef7604255ab9c848`
= `origin/main` 同文件规范化后 sha256 **完全相同** ⇒ 无部署漂移。

> 说明（诚实记录）：本轮先在一处**非 main 分支**的工作副本上跑过一次同样的套件（结果同为 104/0、67/0），
> 但经 hash 核对发现该副本的 `execution-continuity.mjs` 与 `test-ec-autonomy-deployed.mjs`
> **不同于 main**，故该次结果**不作为证据**，已在干净 main 工作树上重跑（即上表）。

### 3.1 CI 独立复核（真实 runner，非本机）

本报告所在分支已开 **PR #91**，其 GitHub Actions 三个必需 check **全部 pass**：

| Check | 结果 | Run |
|---|---|---|
| Static + secret + syntax gate | **pass**（1m13s） | `35657983892` |
| DSH boot + readiness smoke | **pass**（6m9s） | `35657984125` |
| **Reliability state machine tests**（含 `P3 AUTONOMY host-verifier fail-closed gate`） | **pass**（7m13s） | `35657984203` |

意义：第三个 check 即 §2.1 的 P3 门禁 job，它在**真实 GitHub runner** 上对**本分支确切代码**
执行了 core ＋ 生产路径集成两套件（经 `DSH_AUTONOMY_EC_PATH` 指向仓库内生产模块），
且**任一非零即 throw**。因此「104/0 ＋ 67/0」不只在开发机成立，在干净 CI 环境同样成立。

---

## 4 状态与边界

| 项 | 值 |
|---|---|
| Phase 03 状态 | **`AWAITING_EXTERNAL_REVIEW`（Round 2）** |
| Round 1 verdict | `CHANGES_REQUIRED`（2026-08-30）— 唯一 Blocker = F1 |
| Round 2 内容 | F1 闭环（R1C，已合入 #76）+ 负向回归进 CI gate（#86，已合入） |
| self-VERIFIED | **无**（评审通过前不放行 `VERIFIED`） |
| 状态 backfill | **未做**（按 P3 合同：仅 External Review APPROVED 后才允许 backfill / VERIFIED） |
| Phase 04 | **未自行推进**（本轮不触碰 P4 边界；P4 的解锁权在 Reviewer） |
| 生产变更 | **无**（本轮为治理/文档收口；R1C 生产面早已于部署时生效且与 main 逐字节一致） |
| 服务重启 | **无**（本轮不需要重启；无生产代码变更） |

---

## 5 请求外部评审裁决（Round 2）

请 Reviewer 就以下两点裁决：

1. **F1 是否接受为已闭环**（依据 §1 的机制锚点 + §1.3 的 I15–I19 负向覆盖 + §3 的 main 上实跑证据）。
2. **P3 是否可判 `APPROVED`** → 若 APPROVED，则据 P3 合同允许状态 backfill / `VERIFIED`，并**解锁 P4**。

本轮**到此 STOP**，不自行推进 Phase 04。
