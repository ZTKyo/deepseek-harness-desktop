# 生产部署前预检（PRE-DEPLOY PRE-FLIGHT）—— P4 AC2 研究腿

> **⚠ 2026-10-01 时效标注（P4 External Review remediation, D1）**
> 本文是 2026-09-30 canonical 封条**之前**的历史快照；审计基线 `main@63bf5585c64742169c8b66ddfc2938e7de936343`。
> 文内 `P4 ≠ VERIFIED` / `AC6 = PARTIAL` / `AC10 = PARTIAL` 等判定**已被取代**。
> **当前唯一权威口径**见 `docs/roadmap/CURRENT_STATUS.md` 的「2026-10-01 External Review remediation」段。
> 本文下方正文**逐字保留历史原样**，未作任何改写或删除。

**日期**：2026-09-28 ｜ **分支**：`p4-final-b1b2-fix` ｜ **性质**：只读生产 + 临时目录挂载判定（**未部署、未重启、未改 yml**）
**一句话**：把"部署完成后的生产应该长什么样"在**真实 loader** 上先挂一次 —— 结论 **PASS**，且证明
**只部署那 3 个文件是"最小必要集"**（只部署 `learn.mjs` 会直接把生产 boot 打崩，已实证）。

---

## 1 为什么需要（本轮新发现的风险，属"证据不足"而非"代码有问题"）

先前只核对"仓库 vs 生产三文件 DIFF"，**没有**核对**整个相对导入闭包**。本次补算：

`plugins/learn.mjs` 的本地相对导入闭包 = **6 个文件**，其中与生产**不同**的有 **4 个**：

| 闭包文件 | 仓库 sha | 生产 sha | 判定 | 最近一次改动来源 |
|---|---|---|---|---|
| `learn.mjs` | `bf5cfa6d7f03` | `6bdd3fe5b68b` | **需部署** | `175d61d` P4 R2 AC6 |
| `learn-core.mjs` | `38c1d09296aa` | `4fb40331b607` | **需部署** | `175d61d` P4 R2 AC6 |
| `learn-candidate.mjs` | `f732806aa5f9` | `f218514751c5` | **需部署** | `f790916` AC6 真 E2E 缺陷修复 |
| `failure-classifier-core.mjs` | `f780150783a1` | `2a00a17f463a` | **⚠ 有差异但范围外** | `f44e822` **P2.6** R1.2/R3 CI lane |
| `context-memory-core.mjs` | `e68fbd173340` | `e68fbd173340` | 相同 | — |
| `learn-gap-veto.mjs` | `b7623cedf87e` | `b7623cedf87e` | 相同 | — |

两个**相反方向**的风险由此浮现：

1. **范围外变更**：`failure-classifier-core.mjs` 的差异来自 **P2.6**（另一个工作流），与本轮 P4/AC2 无关。
   若按"让闭包全部一致"去部署，就会**顺带把 P2.6 推上生产**（用户明确要求范围外改动须先确认）。
2. **半新半旧**：若只部署 3 个文件、而新 `learn-core.mjs` 恰好依赖新分类器的新导出，生产会进入
   "部分新部分旧"状态 —— 正是 2026-09-26 那次生产 boot 失败事故的同一类（`DEFECT_R2_INJECT_SESSIONS_MOUNT_FAILURE.md`）。

⇒ 唯一可靠做法：**按候选组合造一个"生产同形候选目录"，在真实 loader 上先挂一次**，而不是靠推理。

## 2 做了什么（复用既有门禁，不新建第二套）

新增薄封装 **`tests/learn/deploy-preflight.mjs`**（~200 行，**协调者**，判定权仍属既有 `tests/learn/mount-gate.mjs`）：

1. 计算入口的相对导入闭包（仓库源），逐文件与生产比对 sha256；
2. 按 **显式** `--deploy` 造候选目录：**生产当前文件铺底 + `--deploy` 文件的仓库版本覆盖**
   ⇒ 候选 = "部署完成后生产应有的样子"（逐字节核对来源）；
3. 闭包内**有差异但未列入 `--deploy`** 的文件标为 `STALE_BY_DESIGN`，并打印其**最近一次改动的提交**，
   供人工确认"确实与本轮无关"；
4. 调既有 mount-gate：真实 loader / 真实 Cordis inject / 隔离 `DSH_HOME` / 只借依赖不 boot 生产；
5. verdict = PASS **仅当** 哈希核对全 OK **且** mount-gate `exit 0`。

**不做**：不写生产目录（只在 `os.tmpdir()` 造候选）、不重启服务、不改 `cordis.patch.yml`、
不支持"全部同步"（`--deploy` 必填，防手滑）。

**刻意不进 CI**：预检需要**真实生产 profile** 存在（无则 `exit 2`），而 CI runner 没有生产 profile
⇒ 放进 CI 只会制造假红。它属于**人工部署流程**的门（`RUNBOOK.md` 第 0 步），不是提交时的门。
仓库 CI 的套件是**显式列举**（无 glob 扫描 `tests/*.mjs`），因此新增本文件不会改变 CI 行为。

## 3 证据

### 3.1 正向（本轮计划部署集）⇒ **PASS**

```
node tests/learn/deploy-preflight.mjs --deploy learn.mjs,learn-core.mjs,learn-candidate.mjs \
     --port 3098 --slug dplpf --json <out>
```
原始日志 `evidence/PRE_DEPLOY_PREFLIGHT_FORWARD.txt`、结构化报告 `evidence/pre-deploy-preflight-forward.json`。

- 候选哈希核对 **PASS**（3 个取 repo 版、3 个取 prod 版，逐字节 OK）；
- mount-gate：`PASS A1`（无 loader 失败签名）、`PASS A2`（**恰好 6 个 `learn_*` 工具**、无重复）、
  `PASS A3`（`sessions` 经 `ctx.get` 可解析）、`PASS A4`（无工具面告警）；
  `injectSignature(事故签名)=false`；
- **`learn.mjs` 三方哈希相等**：仓库源 `bf5cfa6d7f03` = 候选 `bf5cfa6d7f03` = 宿主实际**加载**的
  `sha256 bf5cfa6d…a4ffc`（即 `source == deployed(候选) == loaded`）；
- **生产未被触碰**：`127.0.0.1:3080` 监听者 `before=20580:node after=20580:node untouched=true`；
- verdict `PASS`，`exit 0`。

### 3.2 负控 1：故意只部署 `learn.mjs`（半新半旧）⇒ **FAIL（必须）**

```
node tests/learn/deploy-preflight.mjs --deploy learn.mjs --port 3096 --slug nc1
```
原始日志 `evidence/PRE_DEPLOY_PREFLIGHT_NC1_PARTIAL.txt`。

- `FAIL A1 no loader failure signature`；`FAIL A2 ... (got 0)`；`signal=failure-signature`；
- 根因（门禁捕获原文）：
  `failed to import loader entry learn (./learn.mjs): The requested module './learn-candidate.mjs' does not provide an export named 'classifyResearchRisk…'`
- 意义（**本轮最硬的结论**）：**3 文件集是最小必要集** —— 单独部署 `learn.mjs` 会让生产在挂载期直接崩，
  与 2026-09-26 事故同类。这条使"分批部署/只补一个文件"的做法被**实证否决**。
- 同时证明预检**会变红**（不是橡皮章）。

### 3.3 负控 2：内容坏但能加载（突变工具名）⇒ **FAIL（必须）**

把仓库 `plugins/` 复制一份，仅把 `name: 'learn_status',` 改为 `name: 'learn_statusX',`，以该拷贝为源跑预检。
原始日志 `evidence/PRE_DEPLOY_PREFLIGHT_NC2_MUTANT.txt`。

- `PASS A1`（能加载）但 `FAIL A2 probe captured exactly 6 learn_* tools (got 6)` —— **名称锁抓住**；
- 意义：预检不只判"能不能起来"，也判"工具面是否与合同一致"。

三次运行 verdict：**PASS / FAIL / FAIL**（`hashCheck` 三次均 PASS，gateExit 0/1/1）。

### 3.4 消费者闭环（防"改一半"）

- 仓库 `plugins/` 内除 learn 家族互相导入外，**无**其他插件导入 `learn-core.mjs` / `learn-candidate.mjs`；
- 生产 profile 同样只有 learn 家族内部导入；`cordis.patch.yml` **仅**挂 `- id: learn / name: './learn.mjs'`（L310-311）；
- ⇒ 换 3 个文件内容即完成，**无需改 yml、无需新增挂载点**（与 RUNBOOK 配方一致）。

## 4 结论与边界（诚实披露）

- **PASS 的含义**：按 RUNBOOK 配方（3 文件）部署，挂载期**不会崩**、工具面仍恰好 6 个、生产当前进程不受影响。
- **PASS 不等于已部署**：生产 profile 仍是旧副本 ⇒ **AC2 生产运行时遥测仍不存在**；`A8 真人审批门` 仍开；
  **`P4 ≠ VERIFIED` 不变**。部署属"改生产挂载位"，**待用户同意**后执行。 〔⚠ 2026-10-01 时效标注：本行判定已过时，见 docs/roadmap/CURRENT_STATUS.md「2026-10-01 External Review remediation」段〕
- **不部署 `failure-classifier-core.mjs`** 是**刻意的范围决定**（P2.6 范围外）；其差异已在预检里标为
  `STALE_BY_DESIGN` 并附最近提交，后续任一工作流要推它时按各自流程走。
- 预检**未覆盖**：`--keep` 之外的运行期行为（部署后的真实遥测、watcher 拾取时延）—— 那些要在部署后按
  RUNBOOK 验证段取证（新建会话看 `learn_status` / `researchDirective` / 遥测事件）。

## 5 复现与回滚

```
# 预检（部署前必跑；在 _p4r2-inject-fix 下）
node tests/learn/deploy-preflight.mjs --deploy learn.mjs,learn-core.mjs,learn-candidate.mjs --port 3098 --slug dplpf
# 预期：--- verdict: PASS ---   exit 0
```
回滚：预检本身**不改生产**，无常驻副作用；候选目录留在 `%TEMP%\dsh-deploypf-*`（可删）。
真正的部署回滚见工作区 `RUNBOOK.md` 该节（`_backup-learn-<ts>\` 覆盖回旧版 ⇒ watcher 热挂载生效）。
