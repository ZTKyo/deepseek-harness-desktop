# F1 HUMAN APPROVAL BOUNDARY — FIX R1 交付报告

- 阶段：PHASE_04_LEARNING / R2
- 分支：`p4-learning-r2-contract-first`
- 基线提交（修复前可引用基线）：`c5aa5beb0541e8b442cedd0d435472c02fabf025`
- 修复提交：见本文末尾「提交与哈希」
- 生产激活声明：`P4_PRODUCTION_ACTIVATED = NO`｜`OFFICIAL_DSH_UPGRADE = NO`｜`PHASE_05_STARTED = NO`

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| F1（人类批准边界） | **已闭合**（在可独立复现范围内，fail-closed 且有明确拒绝码） |
| F2（`sessionStoreMaxFiles` 下限） | **已交付**（<64 为真实 config validation failure，fail-loud） |
| 回归 | **25/25 套件全绿，门槛断言 1045 PASS / 0 FAIL，exit=0** |
| 变异证明 | F1 两处变异 + F2 两处变异**全部被抓住**，恢复后逐字节一致 |
| 生产影响 | **零**（未设置该 env/键 ⇒ 仍为默认 200；未投放、未注册 learn 插件） |

**不得声称「agent 绝对无法自铸授权」。** 见 §9 诚实残余。

---

## 1. Root Cause

### 1.1 原始根因（R1 修复对象）
`learn_review` 是 **agent 可调用工具**，`approver` 为**自由字符串**，无调用方鉴别 ⇒ agent 可自铸
`APPROVED` → 发布到全局库 → 新会话召回，**全链零人类**。

### 1.2 修复过程中一度引入的第二代根因（已被独立验证者打出并已修）
为满足 §8「重启后合法批准仍有效」而把授权落盘成台账后：
- 台账链只是**公开字段的 sha256 串联，无密钥** ⇒ 任何能重写文件的调用方都可**离线重算**出 `chain_ok=true`；
- 发布判定**只查台账、不查宿主日志** ⇒ 谁能写 stateDir，谁就能造授权。

⇒ 结论：**授权锚必须是宿主写入的事实，不能是插件自己写的文件。**

### 1.3 最终定案
唯一权威 = **宿主 ApprovalService 写入的会话事件对**，台账降级为**辅证**。

---

## 2. Authority Model Before / After

| 维度 | Before | After |
|---|---|---|
| 权威来源 | agent 自填字符串 / 插件自写台账 | 宿主会话日志中的 `approval/asked` + `approval/decided` 事件对 |
| 身份鉴别 | 无 | `toolName === 'learn_review'` 且 `outcome === 'allowed-once'` |
| 内容绑定 | 无 | `asked.reason` 内的 `digest=<64hex>` 必须**等于当前候选摘要** |
| 判定点 | 单点、无复验 | **每个授权判定点**经 `ctx.sessions.get(sid)` 复验（`makeHostFactVerifier()`） |
| 失败姿态 | 放行 | **fail-closed**：`approval_host_fact_unverifiable` / `approval_host_fact_session_unavailable` / `approval_host_fact_approval_ref_not_in_host_log` |
| 台账角色 | 权威（可伪造） | **辅证**：只承载「单次消费 / 取代 / 撤销」；链**无密钥、可被纯 sha256 重算、不构成抗篡改** |
| 落盘身份 | 调用方字符串 | `HUMAN_APPROVAL_ACTOR` |

**信任边界的最小充分事实集（S7 组逐项拆解）**：以下四项**齐备**授权才成立，缺任一项即 DENY——
1. `asked` 事件存在，且 `toolName === 'learn_review'`；
2. `asked.reason` 内含 `digest=<64hex>`，且等于当前候选摘要（**内容绑定**）；
3. `decided` 事件存在，且 `outcome === 'allowed-once'`（一次性）；
4. `decided.id === asked.id`（事件对同一 id，防拼装）。

**为何工具面 / 字段面无法伪造**：插件**从不写** `approval/*` 事件（S6.0 / S7.5 静态证明：
无 `approval/*` 写入面、不暴露 mint API），且所有判定点都回到 `ctx.sessions` 复验；仅靠改台账
或自造 attestation 无法让宿主事实层放行。

---

## 3. §6 攻防矩阵（篡改矩阵，9 例）

在**独立验证者**探针下（`p6-tamper.mjs`，冻结基线）：

| # | 攻击 | 结果 |
|---|---|---|
| 1 | 重放旧 attestation | fail-closed |
| 2 | 改 digest | fail-closed |
| 3 | 改 `approvedAt` | fail-closed |
| 4 | 删条目 | fail-closed |
| 5 | 删文件 | fail-closed |
| 6 | 换 ref | fail-closed |
| 7 | 挂载伪造内存台账 | `approval_host_fact_unverifiable` |
| 8 | **`forge_full`**：改内容 + 伪造 grant/consume + 重写 attestation + **重算链** | `approval_host_fact_approval_ref_not_in_host_log`（**拒**） |
| 9 | `insert_dup_grant`：追加重复 grant 并重算链 | **无伪造效果**（见下） |

**第 9 例的机制级解释（此前曾被我方误判为「放行」）**：`candidateDigest` 把经验 **id 计入**摘要 ⇒
换 id 的克隆候选**永远拿不到可匹配摘要**，该攻击**无可达面**；dup grant 对原候选是**惰性**的
（其 attestation 只引用原 `recordId`）。此前观测到的「接受」是探针**自造自洽 attestation** 造成的
假阳性（且未篡改的 base 连发两次也会「通过」，该判定无区分度）。

---

## 4. 工具层单次消费 / 回放（此前最大覆盖空白，已补）

探针 `p9-shell-consume-replay.mjs` **不直连 core**，走 `apply()` 返回的**真实工具实现**
`toolSpecs['learn_review'].execute` + 壳实例自身台账的 live 授权面（与生产 publish 同一判定）：

| 项 | 结果 |
|---|---|
| 正控：工具层 approve | `{ok:true, publication:'published', state:'APPROVED'}`；台账 `[grant, consume]` 链 ok；reason 含 `digest=<64hex>` |
| **回放**：同一经验第 2 次工具层 approve | **`learn_review rejected: already_human_approved`**；台账**仍 2 条、consume 仍 1 条**（**无二次落账**） |
| 克隆候选（同内容换 id） | `approval_content_changed` |
| `dropconsume`（删 consume） | `approval_ledger_grant_not_consumed` |
| `dupconsume`（同 grant 二次消费） | `approval_ledger_grant_consumed_twice` |
| `dupgrant` / `forge` | honest → `approval_ledger_record_unknown`；attacker → `approval_content_changed` |

四例篡改的台账**链校验均 ok** ——「链完好但语义非法」正是考点：**链不是防线，语义绑定与单次消费才是**。
（探针缺陷自纠：篡改相位必须回放宿主事件，否则宿主事实层会同时拦下，拒因无法隔离到消费层。）

---

## 5. §8 生命周期 A–F（全 PASS）

| 场景 | 结果 |
|---|---|
| A 重启后合法批准仍有效 | ✅ |
| B 会话 A 批准并发布 → 会话 B 召回 | ✅（`publish ok:true`、`recall items:["exp-4efbf6c9"]`） |
| C 内容未变不丢批准 | ✅ |
| D 内容改动 → 拒 | ✅（`approval_content_changed`） |
| E verification 失效后即使人类审批仍在也拒绝发布 | ✅（`not_verified:REVALIDATION_REQUIRED`） |
| F 重新验证不误降级、仍可发布 | ✅ |

---

## 6. 变异证明（阶段七）

### 6.1 F1 伪造门（`test-learn-r3-approval-forgery.mjs`，27 断言 / 7 组）
- 无变异：**27 PASS / 0 FAIL，exit=0**
- **M1**：把 `corroborateHostFact()` 的宿主事实复验强制放行（退回「台账即 authority」）→ **exit=1，19 PASS / 8 FAIL**，含
  - agent self approval leak：S2.2 / S2.3 / S2.4 / S3.1 / S3.2 / S4.1 / S4.2
  - **cross-session unauthorized recall：S5b**（伪造条目在 hydration 实例里被认作已批准）
- **M2**：删掉 `hostApprovalRecord()` 的内容绑定要求 → **exit=1，26 PASS / 1 FAIL**（S7.4 内容未绑定被接受）⇒ 证 S7 组非空转
- 两处变异恢复后 **byte-identical = True**
- 独立验证者以**自选**变异复现同等结论：`validHumanApproval` 恒真 → 5 套件 FAIL；`verifyHostFact` 恒真 → 3 套件 FAIL；
  且其探针**在变异体上立刻得手、在真版上被拒**（非恒真判定）。
- **收尾复跑（对 F2 改动之后的当前树，2026-09-26 00:48:45）**：重跑（另有一次 00:38:28 复跑，数值完全相同；以证据文件记录为准） `_f1-r1-mutation-proof.ps1`，
  pristine `learn-core.mjs` SHA256=`B5BD39771F4C6195743C6B7272BDDD9A91DF15249939C2F8C6E827800F8C1196`（post-F2）
  → M1 **19P/8F**（exit 1）、M2 **26P/1F**（exit 1）、无变异 **27P/0F**（exit 0），两处变异恢复后
  **byte-identical = True**。⇒ F1 信任锚在 F2 改动之后**仍然成立**；证据文件
  `_f1-r1-forgery-mutation-evidence.txt` 已随之重新绑定当前代码哈希（不再是 F2 之前的 98A49D4B…）。

### 6.2 F2（`test-learn-r2-f2-store-min.mjs`，19 断言 / A–D 四组）
- BASELINE exit=0，19P/0F（连跑 3 次一致，非 flaky）
- **M1**（`learn.mjs` 载入改回修复前 `envPosInt(...,1)`，63 重新被静默接受）→ exit=1，14P / **5 FAIL**（B4 B5 B6 D1 D2）
- **M2**（`learn-core.mjs` 的 MIN 改回 1）→ exit=1，10P / **9 FAIL**（A1 A2 A4 A5 B4 B5 B6 D1 D2）
- RESTORED：三文件 SHA256 与变异前**逐字节一致**，复跑 19P/0F ⇒ 总判定 **PASS**
- 脚本：`_f1-r1-mutation-proof.ps1` / `_f2-mutation-proof.ps1`（自带 finally 恢复校验）

---

## 7. F2 交付细节（`sessionStoreMaxFiles` 下限）

**修复语义（fail-loud，非 fail-silent）**：
- 合法（≥64 整数）→ 原样采用；
- 非法（<64 或非整数/布尔/null）→ **config validation failure**：诊断真实写入 `ctx.logger.warn`
  **并**计入实例级 `configValidationLog()`（可取证），有效值落到**最小受支持值 64**；
  诊断逐字声明「requested value rejected, not silently clamped」。
- **取值依据**：64 = 插件既有 per-session 内存口径（`learn.mjs` `MAX_IN_MEMORY_SESSIONS = 64`）；
  磁盘上限低于该口径即自相矛盾。

**代码锚点**：`learn-core.mjs` L82 `MIN_SESSION_STORE_MAX_FILES = 64`、L87-88 诊断契约、
L100-121 `validateSessionStoreMaxFiles()`（稳定错误码 `session_store_max_files_not_an_integer` /
`session_store_max_files_below_minimum`）；`learn.mjs` L270-298 fail-loud 载入层
（`readSessionStoreMaxFiles()`，env 与 config 同一校验口径）、L1734-1740 取证 API `configValidationLog()`。

**三值实测**：`63 → 拒绝（有效值 64、诊断真实存在）`；`64 → 接受`；`65 → 接受`。
（修复前对照：63/64/65 三值均 `validation_present:false`、`config_validation_log:[]` ⇒ 63 曾被静默接受；
该对照在修复前由源码注释同步记录：`learn.mjs` L272-274「此前下限写作 1 ⇒ 63 被静默接受（实测：三值 63/64/65 均无任何校验痕迹）」。）

**诊断逐字契约**（测试按逐字比对锁死，改名即测试红）：
- 常量：`learn-core.mjs` L87-88 `SESSION_STORE_MAX_FILES_MIN_DIAGNOSTIC`
  = `minimum supported sessionStoreMaxFiles is 64`
- 63 触发时的完整诊断原文（数组两条 = API 直供面 + `logger.warn` 面，逐字相同）：
  `LEARN_SESSION_STORE_MAX_FILES: config validation failure: sessionStoreMaxFiles=63 is not supported; minimum supported sessionStoreMaxFiles is 64 (requested value rejected, not silently clamped); effective sessionStoreMaxFiles = 64 (minimum supported)`

**三值原始输出**（证据文件 `_f2-bounds-raw-output.txt`，**UTF-16LE** 编码的原始 stdout 捕获；原样转写）：

| requested | `validation_present` | `config_validation_log` | `effective_max_files` | `requested_value_was_accepted` |
|---|---|---|---|---|
| **63** | **`true`** | 上述诊断（2 条） | **64** | **`false`** |
| 64 | `false` | `[]` | 64 | `true` |
| 65 | `false` | `[]` | 65 | `true` |

三值均带 `anchor_present_verbatim: true`（判定锚点 `minimum supported sessionStoreMaxFiles is 64`
逐字存在于输出中）；原始文件另附单行 JSON 供机器比对。

**生产生效值零变化**：`~/.dsh/settings.yaml` 与 `cordis.patch.yml` 均无该键/env ⇒ 仍为默认 **200**。

---

## 8. §9 回归（本轮实测）

| 命令 | 结果 |
|---|---|
| `node tests/learn/run-learn-all-tests.mjs` | **exit=0，套件 25/25 全绿**（门槛 20 / 观测 5），**门槛断言 1045 PASS / 0 FAIL** |
| `node tests/learn/test-learn-r3-approval-forgery.mjs` | 27P / 0F，exit=0 |
| `node tests/learn/test-learn-r2-f2-store-min.mjs` | 19P / 0F，exit=0（连跑 3 次一致） |
| `run-learn-contract-scenarios.mjs` | 36P / 0F |
| `test-learn-r2-b1-approval-gate.mjs` | 19P / 0F |
| `test-learn-r2-b2-bounds.mjs` | 45P / 0F（断言数已由 42 增至 45） |

**环境噪声说明**：首轮全量回归中 `run-learn-real-e2e`（`ZSTD_error_memory_allocation`）、
`redteam-r3-quality`、`run-learn-contract-scenarios` 三套件曾崩溃；三者**单独重跑均 exit=0**，
重跑全量 25/25 全绿 ⇒ 判定为**环境内存压力**（当时空闲约 9.16GB），**非回归**。

**测试语义变化**：① 新增 `test-learn-r3-approval-forgery.mjs`（信任锚回归门，7 组，已登记进 ORDER）；
② 新增 `test-learn-r2-f2-store-min.mjs`（F2 边界门，已登记）；③ `run-learn-all-tests.mjs` ORDER
新增两行；④ `_real-session-harness.mjs` 等改为提供宿主 approval 服务替身与 `asked/decided` 事件对
（与插件消费接口一致）；⑤ F2 套件新增 `%TEMP%` 自清理（只删自己 mkdtemp 出的 `f2-*` 目录）。

---

## 9. 诚实残余（**不得删减、不得淡化**）

1. **宿主会话存储完整性是信任根**：复验器信任**宿主会话存储**的完整性。若某调用方具备
   `~/.dsh/sessions` 下会话 jsonl 的**原始文件写权限**（直接改文件后由宿主重新载入），它可以植入
   §2 那套四项齐备的事件对 ⇒ 复验会成立。该边界**不在 learn 插件权限面内**：插件从不写
   `approval/*` 事件（S6.0 / S7.5 静态证明），工作区红线亦禁止直接改 `~/.dsh/sessions`。
   **生产实证未做**（红线文件只读 + spec 禁止触碰生产状态）⇒ 该存储完整性由宿主/运维负责。
   **⇒ 不得声称「agent 绝对无法自铸授权」。**
2. **不能自证「答复者是人类」**：插件能自证「宿主 approval 服务答复了并写了会话事件」，
   **不能自证答复者是人类**。若某部署把审批配成自动应答 / 由非人类回答，APPROVED 仍可能在无人类
   的情况下铸出。
3. **无真人审批的端到端实证**：本会话「审批提示被禁用（需审批的动作自动拒绝）」，因此正向腿
   建立在「模拟诚实宿主」接缝上（接口与插件消费的一致），**真人 E2E 未做**。
4. **与宿主同用户的 OS 级攻击者**：需 OS 级隔离（独立账户 + ACL 或宿主侧密钥签章）才能完全关闭，
   **属插件边界之外**。
5. **F2 语义**：非法值被拒后**有效值落到 64**（而非保持 200）；该选择是「拒绝请求值 + 明确诊断 +
   最小受支持值」的组合，已由诊断文本逐字声明，**非静默钳制**。

---

## 10. 未覆盖范围

- 真人审批端到端（见 §9.3）；
- `~/.dsh/sessions` 原始文件级攻击的生产实证（见 §9.1）；
- 生产环境激活与投放后的行为（本轮**未激活**，四项开关全 NO）；
- `test-learn-r2-b2-bounds.mjs` 在 `%TEMP%` 残留 `b2-*` 目录的清理（非本轮范围，已记录）。

---

## 11. 证据索引

| 证据 | 路径 |
|---|---|
| F1 伪造门套件 | `tests/learn/test-learn-r3-approval-forgery.mjs`（27 断言） |
| F1 变异证据 | `_f1-r1-mutation-proof.ps1` / `_f1-r1-forgery-mutation-evidence.txt` |
| F2 边界套件 | `tests/learn/test-learn-r2-f2-store-min.mjs`（19 断言） |
| F2 变异 / 回归 / 三值 | `_f2-mutation-proof.ps1` / `_f2-mutation-evidence.txt` / `_f2-full-regression-evidence.txt` / `_f2-bounds-raw-output.txt` |
| 工具层消费/回放证据 | `%TEMP%\_vfy-probes\_EVIDENCE-shell-consume-replay.md` / `_p9-evidence-raw.txt`（独立验证者产出） |
| 独立验证者探针（**已随本次提交持久归档**） | `_p4r2-evidence/verifier-probes/`（`p6-tamper.mjs` / `p6-trust.mjs` / `p8-lifecycle.mjs` / `p9-shell-consume-replay.mjs` / `p-dup-impact.mjs` / `p-f2-bounds.mjs` / `_vfy-*.ps1` / `_vfy-*.mjs` / `_REPORT-R3-verifier.md` / `_REPORT-R4-verifier.md` 等 **18** 个文件，已逐字节校验一致） |
| F2 三值原始输出 | `_f2-bounds-raw-output.txt`（**UTF-16LE** 编码的原始 stdout 捕获） |

**证据持久化说明**：`%TEMP%\_vfy-probes\` 属易失目录（可能被系统清理、不进版本库），故本轮已将其
整体复制为 `_p4r2-evidence/verifier-probes/` 随提交归档；正文保留 `%TEMP%` 原始路径以便与验证者
当时的运行环境对照，两份内容逐字节一致。另：`_f2-bounds-raw-output.txt` 为 **UTF-16LE**，部分工具
（含 read/ripgrep 类）会判其为 binary，请用 `Get-Content -Encoding Unicode` 或 UTF-16 解码读取。
| 回滚点 | `_f1-checkpoint-20260925-230246/`、`_f2-checkpoint-20260926-001832/` |

---

## 12. 提交与哈希

- 修复提交：`见 git log 首行 fix(learn): F1 human approval authority boundary — agent cannot mint APPROVED`
- `plugins/learn.mjs` SHA256：`36642349A4AB0EFADBB7A52A3EFA30D654FF4C7DAD749F0457426F89A291ACAC`
- `plugins/learn-core.mjs` SHA256：`B5BD39771F4C6195743C6B7272BDDD9A91DF15249939C2F8C6E827800F8C1196`
- 回退方式：`git checkout -- .`（回 `c5aa5be`），或按 §11 回滚点目录覆盖对应文件。

---

## 13. R5 独立对抗复核（全新上下文复评者，对象 `6b73f4e`，后续两笔仅文档/证据提交）

- **判定：PASS（有条件）** —— 无新增 BLOCKER / 高危；交付自述的残余与未覆盖范围**诚实且准确**。
- 复核者独立实测（非照抄）：全量 **25/25 套件、1045 门槛断言 PASS / 0 FAIL**；源码 SHA256 与报告逐字节一致；`git status` 干净。
- 自建探针 H 组 5/5 PASS（APPROVED 不因机器 PASS/FAIL 被降级、PROPOSED→VERIFIED_EXPERIENCE、台账簿记齐备、二次消费被拒）；I 组证明审批后改 `sourceEventSeqs` 或 `body` → `approval_content_changed`（**审批后偷换来源不可能**）。
- **G 组：把 §9.1 残余推进到生产召回链路**（此前标注"生产实证未做"）——**G1** 同时具备「插件 stateDir 写 + 宿主会话存储写」并植入 `asked`/`decided` 事件对时**确实可零人类召回**（`recalledIds=["exp-a4cbc474"]`）；**G2** 去掉植入的宿主事件对即 `recalledIds=[]`（fail-closed）⇒ 只改插件侧被挡住，**交付对残余作用域的描述准确，未夸大也未低估**。
- **F-R5-1（LOW，不阻塞）**：`learn_propose` 契约声明须携带 `sourceEventSeqs` 回源锚点，但提案面只校验**非空**，发布面不回源核对 seq 是否真实存在。**不可利用**：公开面产生的经验其 `verificationEvidence` 只可能是 `session_outcome`（该类**会**回源核对，实测 `anchors_not_found_in_session`），故伪造锚点永远到不了 `VERIFIED`、到不了发布（实测 `not_verified:UNVERIFIED`）；触达它需手写 store，与 §9.1 属同一信任边界 ⇒ **属契约措辞问题**。
- **F-R5-2（INFO）**：台账链为无密钥纯 sha256、可被完整重算 ⇒ **链本身不抗篡改**；真防线是 attestation↔台账四重交叉绑定 + 宿主事实复验（交付注释已如实说明）。
- 探针与原始输出已归档：`_p4r2-evidence/verifier-probes/`（`_REPORT-R5-verifier.md`、`rev-probe*.mjs`、`rev-probe*-out.txt`、`rev-probe4-result.json`）。