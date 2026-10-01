<!-- 发布命名版（release-named artifact）｜内容重新生成于 2026-10-01T06:00:47.192Z（R2 收口；文件名保留 R1 生成时间戳以维持既有引用稳定，改名会使 R1 报告与本件负控测试中的引用失效） -->
<!-- 权威正文 = docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md -->
<!-- 权威正文 SHA256 = F805CFA8E50D2A8F4DEA2D9F34E28A4121FFA957455D92A1E80F5C8FF2DFE2E4（本文件正文与之**规范化后**相同；注释头不计入正文） -->
<!-- 命名依据：任务要求交付 P4_REMEDIATION_CLOSURE_<timestamp>.md；内容与权威正文一致，避免双份漂移 -->
<!-- R2（2026-10-01，外部评审 Finding B）：判定依据 = CANONICAL_BODY_SHA256，即把行尾规范化（CRLF → LF、单独 CR → LF）后计算的权威正文哈希；行尾风格本身不改变判定。 -->
<!-- CANONICAL_BODY_SHA256 = F805CFA8E50D2A8F4DEA2D9F34E28A4121FFA957455D92A1E80F5C8FF2DFE2E4 -->
<!-- R2（2026-10-01，外部评审 Finding D）：本文与权威正文中**历史行的手写行号指针原样保留**（D1 纪律：只标注、不改写），但定位一律改由**锚点**承担（注册表 = docs/roadmap/P4_STATUS.json → docAnchors；真实行号由 `node tools/check-doc-anchors.mjs` 当场算出，本文件不抄录任何行号）。新写入的行号式定位被 linePointerBans 阻断，负控见 tests/roadmap/test-anchor-gate-negative-control.mjs；本说明写在注释头内，不改变正文哈希。 -->
<!-- 说明：原头部「权威正文 SHA256 = …（本文件正文与之逐字节相同…）」中的「逐字节相同」表述仅在 LF 检出下成立（CRLF 检出时原始字节不同、规范化后的语义正文仍相同）；该表述由 R2 注释取代为「规范化后正文一致」，原始字节身份由 `tools/verify-release-artifact.mjs` 以 `rawFileSha256` 单独报告，**不参与判定**。注释头行数由校验器按「开头连续注释行」推导（不硬编码），正文 = 注释头之后的内容。 -->
<!-- R2 收口（2026-10-01）：权威正文新增 §21「R2 附录」（逐条处置表 / 数字钉住四基线对账表 / L23 口径更正 / 复验台账 / 未覆盖边界 / 改动清单），故本命名版随之重新生成；正文哈希见上。 -->
# P4 外部评审整改闭合报告 R1（D1–D13）

- 轮次：`p4-ext-review-remediation-r1`
- 日期：2026-10-01（本地 +08）
- 工作树：`C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-wt`（独立 linked worktree）
- 权威状态文档：`docs/roadmap/CURRENT_STATUS.md`；机读索引：`docs/roadmap/P4_STATUS.json`

> 本文所有数字都来自**实际执行**的命令输出，命令与原始输出一并给出，可逐条复现。
> 凡"未执行 / 未判定"的项一律显式标注，不用措辞掩盖。

---

## 1. 结论摘要

| D 项 | 结论 | 一句话依据 |
|---|---|---|
| **D1**（同一基线多个"当前状态"） | **已修复** | 11 个历史文档加失效标记 + 新增机读索引；校验器 **45/45 PASS**，历史保全 **14/14 文档、1800 行 PASS** | 〔⚠ **2026-10-01 R2 数字口径更正（Finding C）**：本行的 `45/45`、`1800` 是**本报告作者期**的实测值，在当前基线上**已过期**（当前数字由门当场重算，见 §21.2 对账表与 `CURRENT_STATUS.md` 的机器可核数字行）〕 |
| **D2**（"3/2/0" 数字矛盾） | **记录为需扩展 scope** | 三数字属不同时点/不同对象，非自相矛盾；未改任何 GitHub 设置 |
| **D3**（直推 main 不被拦） | **记录，未修** | 需 GitHub 侧授权（ruleset/分支保护），超出本轮授权边界；`--strict` 实测仍红（§6.2） |
| **D4**（`audit --strict` 红灯 / L3 `paths:` 死锁） | **记录，未修** | `audit-merge-enforcement --strict` **BEFORE=AFTER=exit 1**（独立重跑复现，§6.2）；L3 `paths:` 33.1%（211/638）文件在清单外，已给修复蓝图 |
| **D5–D10** | 无待办 / 已在前轮闭合 | 见 `docs/roadmap/P4_STATUS.json` 逐项 |
| **D11**（密钥审计口径错） | **已修复** | 天真的 4 个"命中"实为本程序自己的脱敏标记；修复后 **REAL SECRET = 0**，且敏感性未降低（含负对照） |
| **D12**（自愈范围表述） | **已修复** | 范围按实测收敛，措辞与实现一致 |
| **D13**（生产到底加载了哪份字节） | **已修复（可机检）** | 生产 `loaded-release.json` 登记的 **9 个插件 sha256 与磁盘逐一相符（9/9）** |

- 本轮**没有**为了让门变绿而放宽任何断言：新增/修改的门全部是**收紧**方向（见 §7、§15）。
- 本轮**没有**改动生产插件、`settings.yaml`、`cordis.patch.yml`（§17 给出未改动证明）。
- 生产在 03:27 发生过一次重启，**归因于 guardian 健康自愈**，不是本轮改动导致的（§10 给出完整证据链）。
- **P4.5 未启动、P5 未解锁、P4 未在生产激活、未自称 APPROVED**（§14 机检 45/45 PASS）；
  本轮最高状态见 §20 = **`READY FOR FINAL EXTERNAL REVIEW`**。

---

## 2. Baseline（改动前基线）

```
HEAD                    = 63bf5585c64742169c8b66ddfc2938e7de936343
branch                  = p4-ext-review-remediation-r1
origin/main             = 63bf5585c64742169c8b66ddfc2938e7de936343
tag p4-rem-closure-baseline-20261001 = 63bf5585c64742169c8b66ddfc2938e7de936343
tag p4rem-baseline-63bf558          = 63bf5585c64742169c8b66ddfc2938e7de936343
```

- 基线 = 评审所依据的 `63bf558`（= `origin/main` = 两个基线标签），**本轮的改动全部是工作树内未提交改动**，没有新提交、没有 push、没有 PR（§18）。
- 生产侧基线：运行代 `boot:8272_1790796462118`（pid 8272），9 个插件哈希见 §9。
- 取值范围：`18 files changed, 427 insertions(+), 23 deletions(-)`（`git diff --stat`）＋ 12 个新文件（§16）。

---

## 3. 既有失败隔离（A / B 分类）

**A 类（就在本轮工作树里的既有失败）= 无。**
依据：工作树 `.git` 注册时间 `03:22:27`（本轮起点），18 个被改动文件的 mtime 全部落在 `03:51–03:59` 本轮窗口内；不存在"比本轮更早、又被算作本轮改动"的文件。

**B 类（本轮之外、主检出里的既有未提交改动）= 已隔离，未吸收。**

```
09-01 21:31:30  DSH-Harness-PS.ps1                       (主检出, 独立于本轮)
09-23 05:15:41  docs\roadmap\CURRENT_STATUS.md           (主检出, 标记为既有)
```

- 这些位于主检出 `deepseek-harness-desktop`，**没有被复制进 `_p4rem-wt`**，也没有被本轮修改。

**⚠ 一个必须写清的陷阱：`main` 引用是过期的。**
本机 `main` 被 `_p4-hotfix-main` 工作树占用，本地 `main` 停在 `00d28fc`（2026-09-23），因此
`git diff main...HEAD` 会报出 **207 个文件**的假差异。**权威 main = `origin/main` = 63bf558**。
任何以本地 `main` 为基准的差异统计都是错的，本报告一律以 `origin/main` 为准。

---

## 4. 可回滚证明

- 两个回滚点标签都指向 **HEAD 本身**（= 基线），因此"回到基线"不需要 `git revert`，只需丢弃工作树改动。
- 本轮改动**全部未提交**，且只落在 linked worktree `_p4rem-wt` 内 →
  回滚 = `git -C _p4rem-wt checkout -- . && git -C _p4rem-wt clean -fd`（或直接删除该 worktree），
  **不影响 `origin/main`、不影响主检出、不影响生产**。
- 撤销风险等级：**低**。本轮未删除、未覆盖任何既有文件内容；对历史文档的改动是**追加式**的，
  并有机器校验锁死（§5 的历史保全门：HEAD 版本每一非空行必须仍是工作树某行的**严格前缀**）。

---

## 5. D1 修复：每个基线只有一个"当前状态"

**做了什么**

1. 给 11 个登记在册的历史文档加"失效/非当前"标记（净变化：新增 85 行、删除 15 行，均为标记与说明行）。
2. 新增机读索引 `docs/roadmap/P4_STATUS.json`（5611 B）：登记每个审计文档的当前状态与权威归属。
3. 新增两个**机检门**并接入 CI（`.github/workflows/ci-level1.yml` 现有 job 追加 2 个 step）：
   - `tests/roadmap/validate-p4-status-consistency.mjs` — 索引与权威文档**双向**一致；登记文档必须带失效标记；未登记文档不得重复已被取代的结论。
   - `tests/roadmap/verify-history-preserved.mjs` — 每个登记文档的 HEAD 版本每个非空行必须是工作树某行的严格前缀（"只批注，不重写"）。

**实测证据**

```
### D1 status consistency validator
  PASS  F2 P4 production not activated
  PASS  F3 PHASE_05 not started
  PASS  F4 PHASE_04.5 not started
  ASSERTIONS: 45  PASS: 45  FAIL: 0          => exit=0

### D1 history-preserved verifier
  DOCUMENTS: 14  PASS: 14  FAIL: 0  HEAD LINES CHECKED: 1800
  NOTES: 59 table-separator row(s) exempted from the prefix rule
  HISTORY PRESERVATION: PASSED (historical text intact; changes are additive only)   => exit=0
```

**判定：PASS。** 而且"历史没有被改写"不是承诺，是**逐行机检**的结果（1800 行）。

〔⚠ **2026-10-01 R2 数字口径更正（Finding C）**：上面这个 fenced 块是**当时**的原始输出，**逐字保留**；
其中 `ASSERTIONS: 45` 与 `HEAD LINES CHECKED: 1800` 属**本报告作者期基线**，在当前基线上已过期
（原因：D1 时效标注按纪律追加在历史行行尾 ⇒ HEAD 行数增加；R2 新增断言 ⇒ 断言数增加）。
当前数字**不在文档里手写**，而由 I1–I3 当场重算——判据与对账表见 §21.2。〕

---

## 6. D2 / D3 / D4 状态：三处"需授权或扩权"的缺口（记录，未修）

### 6.1 D2 —— `3 / 2 / 0` 不是同一基线的矛盾，而是三个不同时点/对象的度量

评审看到的"3 / 2 / 0"不是同一基线的矛盾，而是**不同时点/不同对象**的三个度量：

| 数字 | 含义 | 来源 |
|---|---|---|
| 3 | 当前必需 context 数 | 线上 protection 实测 |
| 2 | **闭合前**的历史值（当时只有 L1/L2） | `CURRENT_STATUS.md:46-47` 自述 |
| 0 | `main` HEAD 上**永远 0 个 check-run**（没有 push→main 触发） | 线上 `check-runs` 实测 |

**为什么不在本轮修：** 要真正消除歧义需要动 GitHub 侧设置（ruleset / 分支保护 / 触发面），
这属于**新的授权边界**，本轮只做"判定 + 记录"（依据：任务 §16 的边界要求）。

### 6.2 D3 / D4 —— 治理缺口与 `audit-merge-enforcement.mjs --strict` 实测（**BEFORE = AFTER = exit 1**）

D4 在外部评审口径下 = **`audit-merge-enforcement.mjs --strict` 为红灯**（存在"红门能到达 main"的路径）。
本轮**独立重跑复现**，并与基线逐字对照（**不引用文档结论，自己跑**）：

| 对象 | 命令 | 结果 |
|---|---|---|
| 基线 `63bf558`（独立 worktree `_p4rem-closure/.../wt`） | `node tests/learn/audit-merge-enforcement.mjs --strict` | **exit 1** |
| 本轮工作树（全部改动之后） | 同上 | **exit 1** |

两次输出的关键原文（一致）：
```
main rulesets     : []（无：直推 main 无人拦）
[NOT-BLOCKED] 直推 → main（1 个门 registry 缺必需 context / 2 个门不在 push→main 触发 / 3 个门无 ruleset 强制）
直推 → main：**红门能到达 main**（6 条：workflow 不在 push→main 触发、且无 ruleset 强制 PR / 必需检查）
⇒ 结论：缺口不在"门假"（门确实在跑、变异证明也证明它变红），而在**承载（required 列表）/
  绕过（enforce_admins、无 ruleset）**没堵住。
--strict：存在能让红门到达 main 的路径 ⇒ exit 1
```

> ⚠️ **必须区别于聚合器假红（§12.2）**：**这个 `exit 1` 是真红，不是格式误判**——
> 它是本轮唯一"如实保留的红色结果"，报告**没有把它洗成绿色**。

**判定与边界**：

- **D4 未修**（`--strict` 保持 exit 1）；**D3 未修**（`push → main` 无任何 workflow 触发 + 无 ruleset 承载 ⇒ 直推不被拦）。
- 原因：修它需要在 **GitHub 侧**创建 ruleset / 增加 `push` 触发 / 改分支保护 = **新的授权边界**，超出本轮授权。
  修复顺序铁律：**先修 D4（覆盖清单）再修 D3（承载）**，蓝图见
  `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/D3_D4_MERGE_GATE_GOVERNANCE_20261001.md` §6。
- **防造假三条件**（蓝图 §4 已自证，本轮复核仍成立）：① 审计器**字节未变**；
  ② 本轮**未创建/删除任何 GitHub 规则**；③ 本轮**未把 `--strict` 包进任何 workflow**——
  不制造"看起来已经拦住"的假象。
- 本轮治理相关改动的方向**全部是收紧**；`--strict` 的红色结果**未被掩盖、未被放宽断言换绿**（§17 未改动清单可证）。

---

## 7. D11 修复：密钥审计口径（本轮最重要的"防假绿"修复）

**缺陷**：前一轮的密钥统计把**本程序自己的脱敏产物**当成密钥。被复现的实例：
`uri-credential` 模式会匹配自己写下的标记，形如 `postgres://[REDACTED:uri-credential]@host`
⇒ 一个**已经干净的**文件会让门**永久变红**（假阳性）。

**修复纪律**（写进代码注释，防后人放宽）：
- **片段级**处理，绝不做**整行跳过**；
- 不删除任何家族、不弱化任何模式；
- 标记白名单只允许**真实家族名**，因此手写的 `[REDACTED:sk-…]` **不能**用来掩盖真 key；
- `MARKER_FAMILIES` 刻意放在 `PATTERNS` 之外，避免影响既有的"家族对等性"断言切片。

**实测证据**

```
PRODUCTION STORE naive/pre-fix RAW SECRET-shaped match total = 4 over 60 files
PRODUCTION STORE redaction-aware: 4 raw / 0 real

--- REDACTION-AWARE SECRET AUDIT ---
RAW MATCH = 4   REDACTION PLACEHOLDER = 4   REAL SECRET = 0
INVARIANT raw==ph+real = HOLD            FILES SCANNED = 62
VERDICT: REAL SECRET COUNT = 0

=== D11 redaction-aware secret audit — regression ===
families under test: 19      ASSERTIONS: 116  PASS: 116  FAIL: 0
```

- 负对照（**敏感性没有被改弱**）：`[CASE B3] marker 与真密钥同处一行 ⇒ real ≥ 1`；
  `[CASE C] 每个家族仍能被检出`。
- 结论：**修掉的是假阳性，不是检测能力**。

---

## 8. D12 修复：脱敏自愈范围的表述与实现一致

- 前轮文档把"自愈范围"写得比实现宽。本轮按**实测范围**收敛措辞，使其与代码/线上行为一致。
- 证据：`docs/evidence/P4_D11_D13_REMEDIATION_20261001/SECRETSCAN_TREE_CLASSIFICATION.txt`（本轮新增）
  给出"扫描对象 → 命中 → 真实密钥"的逐条分类，不用形容词代替事实。

---

## 9. D13 修复：生产"到底加载了哪份字节"可机检

```
generation = boot:8272_1790796462118   loadedAt = 2026-09-30T19:27:50Z   pid = 8272
plugin count = 9
=> match=9   mismatch=0   missing=0
```

- 生产 `loaded-release.json` 登记的每个插件 sha256 与 `~/.dsh/profiles/web/<name>` **磁盘实际哈希逐一相符**：
  **9/9 相符、0 不符、0 缺失**。
- 意义：把"生产跑的是哪份代码"从口头承诺变成**可随时复核的哈希事实**（同一命令可重复执行）。

---

## 10. 生产重启状态（**必须说清楚的一件事**）

**事实：本机 3080 生产在本轮窗口内重启过一次，发生在 `03:27:15`，由 guardian 的健康自愈触发。**

完整证据链：

```
guardian.log:
  03:22:42 health DEGRADED (owner=ok, failures=1, window=0s,  errorClass=api_unready) - no restart (RH1)
  03:25:29 health DEGRADED (owner=ok, failures=1, window=0s,  errorClass=api_unready) - no restart (RH1)
  03:26:12 health DEGRADED (owner=ok, failures=2, window=43.5s, errorClass=api_unready) - no restart (RH1)
  03:26:55 health RECOVERY_ELIGIBLE (failures=3, window=85.8s) - incident + confirm before restart
  03:27:03 incident bundle written: ...\incidents\incident-20261001-032703-762.json
  03:27:15 RESTART: health recovery_eligible owner=ok: consistent unready: failures=3 window=85.8s

restart-apply-patch.log:
  03:27:20 restart begin (port 3080)     03:27:37 DSH loopback free: True
  03:28:37 candidate bound to new server pid=8272 generation='639264220621263697_8272'
  03:29:41 COMMIT_READY: True stage=COMMIT_READY / restart committed (stable window + COMMIT_READY)
```

**归因与边界**

1. 触发者是 **guardian**（连续 3 次 `api_unready`，窗口 85.8s，先写 incident bundle 再重启），**不是**本轮为了"让改动生效"而重启。
2. 本轮**没有**任何需要重启才能生效的改动：`plugins/**` 在 git 里**零改动**；
   `cordis.patch.yml` mtime `01:42:17`（本轮之前）；`settings.yaml` mtime `22:37:38`（更早）。本轮改动集中在 docs/tests。
3. **取证纪律（重要）**：重启前（`03:29:41` 之前）采集到的一切生产证据，其对象都是**旧字节**，
   不能用来声明"新代码已在生产生效"。本报告中生产侧证据均采自 `03:29:41` 之后，且以 `loaded-release.json` 的代与哈希为准（§9）。
4. 重启后稳定性：新代 `8272` 通过 30s 稳定窗口 + `COMMIT_READY` 才提交，`restart-budget.json` 记录
   `lastReason=delayed-restart, hourAttempts=1, lastSuccess=03:29:41`。
5. **生产字节 = 仓库 HEAD 字节（字节级核实）**：生产 `~/.dsh/profiles/web/` 的 4 个 learn 插件
   SHA256 与仓库 `wt/plugins/`（HEAD `63bf558`）**逐个相同**：
   `learn.mjs 5C4EE78CA2DE` / `learn-core.mjs DCF2A2AE05E1` / `learn-candidate.mjs 2B4D38532300` /
   `learn-gap-veto.mjs B7623CEDF87E` ⇒ 就 learn 插件面而言**生产 = HEAD**（这也解释了
   ac1 在"生产目标/仓库目标"两条线同分：本来就是同一份字节）。本轮**未改** `plugins/**`，
   因此该结论对改动后仍然成立。
6. **观测者效应：无**。整个审计窗口内 3080 服务 `pid=8272` 全程未变（非"审计把生产搞重启了"）；
   窗口内 guardian 仅记一次 `04:13:34 health DEGRADED (failures=1, errorClass=api_unready) - no restart (RH1)`。
   ⚠️ 排错提示：`Get-NetTCPConnection -LocalPort 3080` 里另一个 Listen 属于 **`tailscaled`**，
   取"第一个 listener"会误读 PID（终审时首轮即读错，已更正）。

> 结论：**生产重启与本轮改动无因果关系**（无插件/patch/配置改动），但**确实发生过**，
> 因此这里如实记录，而不是按"未重启"一笔带过。

---

## 11. Secrets 审计（红线项）

| 扫描对象 | 结果 | 命令 |
|---|---|---|
| 本轮工作树（全树） | `RAW MATCH=0  REAL SECRET=0  SECRET SCAN PASSED` exit=0 | `node tests/reliability/secret-scan-check.mjs .` |
| 生产学习存储 | `RAW MATCH=4  PLACEHOLDER=4  REAL SECRET=0`，不变式 HOLD，62 文件 | `node tests/reliability/redaction-aware-secret-audit.mjs` |

**本轮自查发现并修掉的一个自身问题（如实记录）**：
首次对工作树扫描时报出 `REAL SECRET=15`（exit=1）。逐条定位后确认：**15 条命中全部落在我自己创建的临时取证文件
`_sessdump.jsonl`**（5.4 MB，会话内容转储，属本轮调查临时产物，非交付物）。
该文件把会话内容带进仓库，既会**让仓库通过不了自己的密钥门**，也是**不该出现的内容落地**。
处理：删除该临时文件 → 重扫 **0/0 PASS（exit=0）**。分类证据保留在
`docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/SECRETSCAN_TREE_CLASSIFICATION.txt`。

**红线遵守**：本报告、日志、证据文件**没有任何密钥明文**；扫描器输出按"只保留 `family @ 文件:行`、
丢弃命中文本"的方式落盘（脱敏纪律）。

---

## 12. 回归测试（真实断言数，不是测试文件数）

**运行方式**：由独立后台工作单元在**隔离 worktree** `_p4rem-closure/regression-count-audit/wt`（封存基线 `63bf558`）
中实跑，逐套件落盘日志，再做"打印断言数 vs 自报断言数"对账。

```
logs analysed: 44 | registry entries: 43 | registry entries never run: 4
--- FINAL RECONCILIATION (HEADLINE, 权威口径) ---
registryEntries = 43          wiredInCi = 23               excludedWithReason = 20
logsAnalysed = 44             suitesWithOwnAssertionLines = 31
suitesExitOnly = 7            suitesGreenVacuous = 3       suitesExitOnlyButCanFail = 4
suitesThatCannotTurnRed = 4   nonZeroExitRuns = 3
totalOwnAssertPassLines = 1286        totalForeignAssertLines = 19
countBasisSelfReport = 31     countBasisPerLine = 1
⇒ 自有断言 PASS = 1286，FAIL = 0；打印行合计 1305（= 1286 自有 + 19 外来）

suite                                            exit  kind            printed   reported     reconcile
test-learn-core.mjs                              0     gate            505P/0F   505P/0F      EQUAL
test-learn-ac1-secret-families.mjs                0     gate             0P/0F    43P/0F       NO-LINES(aggregate only)
test-learn-ac5-gap-veto.mjs                       0     gate            44P/0F    44P/0F       EQUAL
test-learn-r2-b2-bounds.mjs                       0     gate            45P/0F    45P/0F       EQUAL
test-learn-ac6-real-promotion-e2e.mjs             0     gate            46P/0F    27P/0F       EQUAL(+foreign lines)
run-learn-real-e2e.mjs                            0     gate            65P/0F    65P/0F       EQUAL
run-learn-real-gap-e2e.mjs                        0     gate            20P/0F    20P/0F       EQUAL
_ac10-registry-mutation-proof.mjs                 0     mutation-proof  10P/0F    10P/0F       EQUAL
_ac2-mutation-proof.mjs                           0     mutation-proof  10P/0F    10P/0F       EQUAL
...（共 37 套件，完整表见 consolidate-report.txt）
```

> ⚠️ **口径说明（勿混用）**：上面这个引用块是**44 份日志时点**的对账原文（原样引用，未改动）。
> 之后又加入了 runner 自己的聚合日志 ⇒ 日志 45 份、**外溢行变为 58 行**（AC6 的 19 行 +
> runner 逐套件报表 39 行）。**权威的"自有断言"数不变，仍是 1286**；三种口径的完整对照见 **§12.1**。
> 本报告的结论一律以 **1286（自有）/ 0 FAIL** 为准，不使用易混的"打印合计"。

- **权威口径：套件自有断言 PASS = 1286、FAIL = 0**；另有外来/外溢行 58（19 + 39，已剔除，
  全部来自 AC6 打进 stdout 的行与 runner 自己的报表，**不含任何断言失败**）。
- 对账口径逐行标注：`EQUAL`（打印=自报）/ `NO-LINES`（只打印聚合结论）/ `EXIT-ONLY`（以 exit 为判定）。
- **能力审计**（门是否真能变红）：43 个登记套件中 **39 可变红 / 4 不可变红 / 3 个"绿而空转"**；
  7 个以 exit 判定、31 个有自有断言行。4 个不可变红套件已具名（§19 第 4 条）。
- 原始对账产物已**复制进仓库**（评审可直接复核）：
  `docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/REGRESSION_COUNT_AUDIT/`
  ├ `consolidate-report.txt`（逐套件 打印 vs 自报 对账表）
  ├ `audit-summary.json`（每套件 exit / 耗时 / 断言数 / CI 步骤）
  ├ `fail-path-report.txt` + `fail-path-audit.json`（43 套件"能否变红"能力审计）
  ├ `results-batch.txt`（逐套件 exit + 耗时）
  ├ `ci-coverage-report.txt` / `ci-coverage.json`（CI 覆盖对账）
  └ `named-suite-evidence.txt`（每套件段落与断言行摘录）
  └ `FINAL-AUDIT.json` / `final-reconciliation.txt`（最终口径：1286 自有断言 / 39 可变红 / 4 不可变红）
  └ `FINAL-AUDIT.md`（293 行终审报告）+ `logs/`（45 份原始逐套件日志，含 EXIT/ELAPSED/TIMEOUT/CWD）
```

### 12.1 三个"都真、但口径不同"的断言数（禁止混用）

| 口径 | 数字 | 覆盖 | 是什么 |
|---|---|---|---|
| 逐行**自有**断言 PASS（权威） | **1286** | 43 项全量 | 套件自己打印的 `PASS` 行，外来行已剔除 |
| 逐项**自报**合计（去重） | **1306** | 43 项全量 | 套件结尾自报摘要相加（ac1 等"成功即静默"只能取自报） |
| runner 自算门槛断言 | **1240** | 仅 31 个门槛套件 | `run-learn-all-tests.mjs` 只统计门槛类，不含 7 个 exit-only |

**三者不等源于口径与覆盖面不同，不是任一方算错**；外溢行（别的套件打进本套件 stdout 的行）
共 **58 行**（ac6 的 19 行 + runner 逐套件报表 39 行），已从 1286 中剔除。

### 12.2 聚合层**假红**（"空转假绿"的镜像问题）——**已知项 R9 的再次实测**

> 诚实标注：这**不是本轮新发现**。工作区记忆 `KNOWN_ISSUES.md` 的 **R9「回归运行器
> NO-SUMMARY 分类假警报」（2026-09-30 实测）** 已记录同类问题；本轮做的是**独立复现 + 量化**。

`node tests/learn/run-learn-all-tests.mjs --timeout=600000` → **765.4s，EXIT=1**，自报
`套件 36/39 全绿；门槛断言 1240 PASS / 0 FAIL`，并列出 3 个"失败套件"。逐个查证后：

| 被 runner 判为失败 | runner 的理由 | 实体真相 |
|---|---|---|
| `test-learn-ac6-real-promotion-e2e.mjs` | `NO-SUMMARY` | 摘要写成 `27 PASS / 0 NA / 0 FAIL`，中间夹 `0 NA`，runner 的 4 种数字格式都不认 ⇒ **解析假红**（本体 exit=0） |
| `audit-merge-enforcement.mjs` | `NO-SUMMARY` | 它输出的是 **JSON 报告**（含真实 `gitHead`），全文无 PASS/FAIL 字样 ⇒ 它本来就是"产出审计 JSON 的工具" |
| `ac6-e2e-lock.mjs` | `NO-SUMMARY` | 互斥锁助手，0.2s 无输出 |

⇒ **3 个"失败"全部是聚合器的格式误判，没有一个是真实断言失败。** 判定式是
`ok = code===0 && fl===0 && kind!=='NO-SUMMARY'`，且 runner 不数行、只认自报摘要。
**任何把"runner 失败套件 3 个"当真实回归证据的账本，结论会反向错**——这与"空转假绿"
是同一问题的两端。本轮新增的**具体格式缺口**：`27 PASS / 0 NA / 0 FAIL` 这种"夹 NA"的摘要
是 R9 当时的 4 种数字格式都没覆盖的一种。修法建议（源码改动，本轮**只报告不改**）：
摘要正则增加 `N PASS / M NA / K FAIL`、把"产出型工具/助手"显式归 tool/helper 按退出码判定、
登记表 `kind` 增加 `evidence/probe/tool/helper`。

**3 个非零 exit 的分类（都已由"正确参数化重跑"解决，非本轮回归）**

| 套件 | 首次 | 重跑 | 分类 |
|---|---|---|---|
| `mount-gate.mjs` | exit=2（未挂载上下文） | 参数化后 exit=0，4P | 调用上下文问题 |
| `deploy-preflight.mjs` | exit=2（未挂载上下文） | `deploy-preflight-real.txt` exit=0 | 调用上下文问题 |
| `run-learn-contract-scenarios.mjs` | exit=1（打印 14P/0F，无 FAIL） | `*-retry.txt` exit=0，36P/0F EQUAL | 宿主争用下 flaky（重跑一次即 PASS） |

**本轮自身改动的定向回归（在交付树 `_p4rem-wt` 上实跑）**

| 套件（本轮改动） | 交付树结果 | 基线对照 | 判定 |
|---|---|---|---|
| `tests/learn/test-learn-core.mjs`（+注释 9 行） | **505 PASS / 0 FAIL**，exit=0 | 基线 505P/0F | **等价**（注释改动确为惰性） |
| `tests/reliability/secret-scan-check.mjs`（+44 行 D11） | 全树 `0 raw / 0 real`，exit=0 | 基线对同一对象为**假阳性红** | 收紧且变绿合理 |
| `tests/reliability/redaction-aware-secret-audit.mjs`（新增） | **116/116 PASS**，exit=0 | — | 新增门全绿 |
| `tests/roadmap/validate-p4-status-consistency.mjs`（新增） | **45/45 PASS**，exit=0 | — | 新增门全绿 |
| `tests/roadmap/verify-history-preserved.mjs`（新增） | **14/14 文档、1800 行 PASS**，exit=0 | — | 新增门全绿 |
| `tests/learn/validate-gate-registry.mjs`（元门，验证未被本轮破坏） | **15 PASS / 0 FAIL**，exit=0 | 基线同 | **未被破坏** |

**判定：核心/相关测试 PASS；未发现由本轮改动引入的失败。** 分类口径：
CRITICAL = 本轮门与一站式学习回归 → 全 PASS；RELATED = 上述 3 个非零 exit → 重跑 PASS（1 例 OOM、2 例缺参数）；
PRE-EXISTING = 3 个数据产出型 + 1 个锁类套件不可变红（记录，不修，§19 第 4 条）；
聚合层另有 **3 处格式假红**（§12.2，非真实失败，本轮只报告不改）。

---

## 13. 人工闸门 runner 评估（human-gated vs automatable）

**问题**：D11/D12 语境下的两个真实会话 runner（`run-learn-real-e2e.mjs`、`run-learn-real-gap-e2e.mjs`）
是否会**停在人工审批**上、从而不可自动化？

**实测方式**：在交付树上直接实跑两者，记录 exit code、耗时与尾部输出。

```
### tests\learn\run-learn-real-e2e.mjs        exit=0   elapsed=391.9s  →  P4 LEARN R1 REAL-SESSION E2E: 65 PASS / 0 FAIL
### tests\learn\run-learn-real-gap-e2e.mjs    exit=0   elapsed=  3.4s  →  P4 LEARN R2 REAL-GAP E2E: 20 PASS / 0 FAIL
```

（同套件基线对照：`run-learn-real-e2e.mjs` 398.91s / 65P0F、`run-learn-real-gap-e2e.mjs` 5.56s / 20P0F → 与本轮交付树结果一致。）

实测尾部输出（证明"真的跑到了业务断言"，而不是提前退出）：

```
PASS  experience-store target allowed          PASS  unknown target denied (fail-closed)
PASS  null/empty target denied                 PASS  raw secret NEVER written to disk
PASS  secret redaction applied in stored body  PASS  kill switch registers NO hooks
PASS  LEARN_DISABLED=true registers NO hooks   PASS  malformed sessions do not throw (fail-open)
P4 LEARN R1 REAL-SESSION E2E: 65 PASS / 0 FAIL
PASS  ★ 真实数据上合格签名可被生产资格判定接受（≥1）
PASS  合格签名数不超过达标签名总数（无膨胀）
PASS  候选库中无"空签名"泄漏（否决面未被绕过）
P4 LEARN R2 REAL-GAP E2E: 20 PASS / 0 FAIL
```

**判定：二者均**不**停在人工审批，可自动化（exit=0，无需人工输入）。**
机制说明（源码级）：两个 runner 通过 `tests/learn/_real-session-harness.mjs` 的 `mkHostApproval()`
注入**宿主 ApprovalService 并带进程内应答器**，因此审批路径在测试内被"设备化"，不是靠人点。
审计口径：本轮对 `tests/` 的改动仅 2 个文件（+9 / +44 行，均为注释与 D11 口径），
**没有任何 approval/answerer 接线被改动**（`git diff -- tests/` 可证），因此不存在"为让门变绿而偷偷放行审批"。

---

## 14. P4.5 / P5 是否被启动

```
PASS  F2 P4 production not activated
PASS  F3 PHASE_05 not started
PASS  F4 PHASE_04.5 not started
```

- 由 `tests/roadmap/validate-p4-status-consistency.mjs` 机检（45/45 PASS）。
- **P4.5 未启动、P5 未启动、P4 未在生产激活**——与任务边界一致。

---

## 15. 新增的门（本轮新增的"会挡人的东西"）

| 新增件 | 作用 | 实测 |
|---|---|---|
| `tests/roadmap/validate-p4-status-consistency.mjs` | D1 状态一致性（双向 + 标记 + 未登记不得重复结论） | 45/45 PASS |
| `tests/roadmap/verify-history-preserved.mjs` | D1 历史保全（逐行前缀） | 14/14、1800 行 PASS |
| `tests/reliability/redaction-aware-secret-audit.mjs` | D11 三口径密钥审计（raw / placeholder / real） | REAL=0、不变式 HOLD |
| `tests/reliability/test-redaction-aware-audit.mjs` | 上述审计器的回归（19 家族 + 负对照） | 116/116 PASS |
| `tools/check-l3-paths-coverage.mjs` | D4 覆盖分析（只读，量化 `paths:` 死锁） | exit=0，211/638 (33.1%) 在清单外 |
| CI：`ci-level1.yml` 追加 2 个 step | 让 D1 的两个门**真的会在 PR 上跑** | 沿用该文件既有 inline-step 约定 |

> 说明：D1 两个门是接进 `ci-level1.yml`（该文件本来就以 inline step 形式挂纯 node 校验），
> **不是**接进 AC10 的 `tests/learn` 登记表，因此登记表条目数不变、元门仍 `15 PASS / 0 FAIL`。

---

## 16. 改动文件

**修改（tracked，18 个，`427 insertions / 23 deletions`）**

```
.github/workflows/ci-level1.yml                                        (+31, D1 两个门接入)
docs/roadmap/CURRENT_STATUS.md                                         (权威状态收敛)
docs/roadmap/reports/PHASE_04_LEARNING/REPORT_R1.md
docs/roadmap/reports/PHASE_04_LEARNING/CONTRACT_RECONCILIATION_R1.md
docs/roadmap/reports/PHASE_04_LEARNING/INDEPENDENT_DELTA_REVIEW_R1.md
docs/roadmap/reports/PHASE_04_LEARNING/R2/RELEASE_EVIDENCE_INDEX.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/A10_CONTRACT_MATRIX.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/AC2_RESEARCH_LEG_CLOSURE.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/AC6_REAL_PROMOTION_CLOSURE.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/AC10_GATE_REGISTRY_AND_REAL_E2E_IN_CI.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/P4_FINAL_VERDICT.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/PRE_DEPLOY_PREFLIGHT.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/POST_RESTART_LOAD_AND_REGRESSION.md
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/POST_RESTART_STATE_AND_READINESS.md
RELIABILITY_HOTFIX_RH2_R1_REPORT.md
RELIABILITY_RH2_R11_OVERNIGHT_REPORT.md
tests/learn/test-learn-core.mjs                                        (+9, 仅注释/口径)
tests/reliability/secret-scan-check.mjs                                (+44/-2, D11)
```

**新增（untracked，71 个文件 = 15 个交付文件 + 56 份回归对账产物）**

```
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md  ← 本报告（权威正文）
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/P4_REMEDIATION_CLOSURE_20261001-0425.md    ← 发布命名版（正文逐字节相同，机检见 §20.1）
docs/roadmap/P4_STATUS.json                                      (5611 B, D1 机读索引)
docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/evidence/D3_D4_MERGE_GATE_GOVERNANCE_20261001.md (18401 B)
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/D11_NAIVE_VS_AWARE.txt
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/D11_PRODUCTION_AUDIT.txt
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/D11_REGRESSION.txt
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/HUMAN_GATED_RUNNERS.txt
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/SECRETSCAN_TREE_CLASSIFICATION.txt
docs/roadmap/evidence/P4_D11_D13_REMEDIATION_20261001/REGRESSION_COUNT_AUDIT/  (8 份对账产物, 见 §12)
tests/reliability/redaction-aware-secret-audit.mjs               (11164 B)
tests/reliability/test-redaction-aware-audit.mjs                 (10098 B)
tests/roadmap/validate-p4-status-consistency.mjs                 (10916 B)
tests/roadmap/verify-history-preserved.mjs                       (3954 B)
tools/check-l3-paths-coverage.mjs                                (4192 B)
tools/verify-release-artifact.mjs                                (交付物完整性校验：命名版正文==权威正文 + 头部哈希同步；含负对照)
```

**删除（1 个，本轮自查处置）**：`_sessdump.jsonl`（我自己的临时会话转储，5.4 MB，含密钥形状内容，见 §11）。

---

## 17. 未改动文件（防止"顺手改了不该改的"）

以下**一行未改**（可 `git status --porcelain` / `git diff --stat` 复核）：

- `plugins/**` —— **零改动**（本轮无任何需要重启才生效的插件改动，见 §10）。
- `src/**`、`supervisor-mcp-adapter/**`、`mobile-widget/**` —— 零改动。
- `.github/workflows/ci-level2.yml`、`ci-level3.yml`、`ci-level4.yml` —— 零改动
  （D4 的 `paths:` 死锁**只是记录**，没有偷偷放宽过滤条件来"变绿"）。
- `~/.dsh/settings.yaml`（mtime 22:37:38）、`~/.dsh/profiles/web/cordis.patch.yml`（mtime 01:42:17）—— 未改。
- 生产学习存储、会话日志 —— 只读（审计为只读读取）。

---

## 18. Git 交付状态

- `HEAD == origin/main == 63bf558`：**本轮没有产生提交**，也没有 push、没有开 PR。
- 分支 `p4-ext-review-remediation-r1` 已存在（linked worktree 检出），本轮改动位于其上但**未提交**。
- 这是**刻意的**：评审要求 C1–C13 原样保留，本轮只做"整改 + 证据"，是否落 PR 属于**新的授权动作**。
- 若要交付：`git add` 本轮改动 → commit → push 分支 → 开 PR（会触发 L1/L2/L3/L4 航道）。
  **其中 D4 未修**：若 PR 的文件集恰好全部落在 L3 `paths:` 清单外，则该 PR 永远拿不到必需 context
  "DSH boot + readiness smoke"（由 `tools/check-l3-paths-coverage.mjs` 量化，exit=0）。

---

## 19. 遗留问题（如实列出，未修）

1. **D2** —— 需 GitHub 侧授权的口径统一（ruleset / 触发面），本轮判定并记录，**未执行**。
2. **D4** —— L3 workflow 级 `paths:` 死锁：33.1%（211/638）文件在清单外；修复铁律是
   **先修 D4 再修 D3**（蓝图见 `D3_D4_MERGE_GATE_GOVERNANCE_20261001.md` §6），本轮**未执行**。
3. **D3** —— `push → main` 无任何 workflow 触发 + 无 ruleset 承载 ⇒ 直推不被拦。**未执行**（授权边界）。
4. **4 个"不会变红"的套件**（既有事实，非本轮引入，具名自 `FINAL-AUDIT.json`）：
   `tests/learn/redteam-r3-labels.mjs`、`tests/learn/redteam-r3-probe.mjs`、
   `tests/learn/redteam-r3-injection-positions.mjs`、`tests/learn/ac6-e2e-lock.mjs`。
   前三者属**数据产出型**（无 exit 判定，`suitesGreenVacuous = 3`），第四个是锁/元数据类。
   若要求"每个门都能变红"，需另立 scope（本轮不改）。
5. **登记表 4 条从未实跑**（`registry entries never run: 4`）——既有事实，来源与归属见
   `consolidate-report.txt` 对账表。
6. **`run-learn-contract-scenarios.mjs` 在宿主高负载下 flaky**（首次 exit=1，报
   `Allocation error : not enough memory` 即 **OOM**，打印 14P/0F 无 FAIL；重跑 118.74s → 36P/0F PASS）。
   根因是**资源而非断言**；建议后续加超时/隔离说明，避免被误读成真实回归。
7. **`git diff main...HEAD` 陷阱**：本地 `main` 停在被 `_p4-hotfix-main` 占用的 `00d28fc`，
   任何以本地 main 为基准的差异统计会虚报 207 个文件。已在 §3 显式标注。
8. **仓库自带 runner 的 3 处假红未修**（§12.2，属源码改动，本轮只报告不改）。
9. **"接线 ≠ 门"**：CI 接线的 23 项里有 3 个死门 ⇒ CI 中**真正能变红并被执行的 = 20 项**。
   全局"能变红"= 39/43。若要求"接线的门都必须能变红"，需另立 scope。
10. **门登记表在生产侧没有任何消费者**：全库只有 `validate-gate-registry.mjs` 与
    `_ac10-registry-mutation-proof.mjs` 读 `gate-registry.json`（都在 tests 内）；
    `~/.dsh/profiles/web/*.mjs` 中对 `gate-registry` 的命中**全是注释**。
    ⇒ 生产侧唯一健康判断是 `dsh-guardian.ps1`（进程/健康探针级），它不读登记表。
    **"看门狗等价"当前不成立**，登记表的门语义只在 CI 成立；若期望部署面也被登记表约束，
    需新建机制（架构变更，需决策，本轮未做）。

---

## 20. 最终判定

**本轮最高状态 = `READY FOR FINAL EXTERNAL REVIEW`（达到任务设定的上限；不自称 APPROVED、不擅自解锁 P5）。**

**补救本身判定：PASS**（带 3 项显式记录未修项：D2 / D3 / D4）。

- D1 / D11 / D12 / D13 **已修复且有机器可检证据**；D5–D10 无待办；
  D2 / D3 / D4 已**判定 + 记录 + 给出蓝图**（§6），**未执行**（需新授权边界）。
- 回归：**自有断言 1286 条 PASS / 0 FAIL**（三种口径对照见 §12.1；`--strict` 的真红见 §6.2，未被洗绿），
  本轮自身改动另有 6 项定向实测全 PASS（含基线对照 505 = 505）。
- 无假绿：新增/修改的门方向都是**收紧**；本轮无任何"为通过而放宽断言"的改动；
  未通过的 3 个非零 exit 已按"调用上下文 / 宿主争用"分类并由重跑证实，**不冒充全绿**。
- 边界：未动 GitHub 设置、未动生产插件与配置、未开 PR、未启动 P4.5/P5。

### 20.1 交付命名与可复核性（release artifact）

- **权威正文**：`docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/EXTERNAL_REVIEW_REMEDIATION_CLOSURE_R1.md`
- **发布命名版**（任务指定的 `P4_REMEDIATION_CLOSURE_<timestamp>.md`）：
  `docs/roadmap/reports/PHASE_04_LEARNING/R3_FINAL_CLOSURE/P4_REMEDIATION_CLOSURE_20261001-0425.md`
- **二者关系**：命名版 = **前 4 行注释头**（记录权威正文路径 + 生成时 SHA256 + 命名依据）+ **权威正文全文**；
  正文**逐字节相同**（生成时已机检 `IDENTICAL`）⇒ 不存在"两份内容各自漂移"。
- **复核方法（机检，任何人可重跑）**：
  ```
  node tools/verify-release-artifact.mjs
  ```
  → `RELEASE ARTIFACT INTEGRITY: IDENTICAL` 且 `exit=0` 即一致；不一致（正文漂移 / 头部 SHA256
  过期 / 缺命名版）会打印 `DRIFT` 并 **exit=1**。
  该脚本**已做负对照验证**（不是"永远绿"）：① 给命名版追加一行 → 报 `body-drift`、exit 1；
  ② 把头部哈希改成全 0 → 报 `header-hash-stale`、exit 1；恢复后回到 `IDENTICAL`、exit 0。
- **防漂移约定**：命名版头部第 3 行记录**权威正文的 SHA256**。若日后再次编辑权威正文，
  **必须重新生成命名版**，否则头部哈希与新正文不符 → 校验器立刻报 `header-hash-stale`
  （这是刻意留下的"防漂移"信号，而不是靠人记得）。
- 诚实项：生产在 03:27 由 **guardian 健康自愈**重启过一次（§10），本轮**未**因此重启服务；
  我自己的临时会话转储文件曾被密钥门抓到并已删除（§11）。

---

### 复现命令（全部只读或自校验）

```powershell
cd 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4rem-wt'
git rev-parse HEAD; git rev-parse origin/main; git status --porcelain | Measure-Object
node tests/roadmap/validate-p4-status-consistency.mjs      # 45/45 PASS, exit 0
node tests/roadmap/verify-history-preserved.mjs            # 14/14, 1800 lines, exit 0
node tests/reliability/redaction-aware-secret-audit.mjs    # REAL SECRET = 0
node tests/reliability/test-redaction-aware-audit.mjs      # 116/116 PASS
node tests/reliability/secret-scan-check.mjs .             # 0 raw / 0 real, exit 0
node tests/learn/validate-gate-registry.mjs                # 15 PASS / 0 FAIL
node tools/check-l3-paths-coverage.mjs                     # D4 量化, exit 0
```

---

# 21. R2 附录 —— 第二轮整改（外部评审 Round 3 后，2026-10-01）

> **本节定位**：§1–§20 是 **R1 封条报告原文**，**逐字保留、未改写**；本节是 R2 的**追加式**整改记录（只增不改）。
> **本节不含"当前数字"**：唯一当前数字口径在 `docs/roadmap/CURRENT_STATUS.md` 的「【数字口径·机器可核】」行，
> 由校验器 I1–I3 当场重算比对（原因见 §21.2）。
> **冻结对象**：R2 的评审对象 = 分支 `p4-final-remediation-r2` 上的冻结提交，其 SHA 由
> `FINAL_EXTERNAL_REVIEW_MANIFEST.md` 的 Round 4 节固定（本节写入时该 SHA 尚未产生，故不在此处写死）。

## 21.0 一句话结论

Round 3 评审的 **2 条"封条前应修"（A、B）**、**4 条精度问题（C/D/E/F）**、**1 条"写了但没人跑"（G）**
已全部闭环；**每条整改都配一个可被证伪的负控**，且**每条控制都有 CI 归属**（由断言 H7 要求"存在 **且** 被某 workflow 调用"）。
**D2 / D3 / D4 仍未修**（均需 GitHub 侧授权或扩权，超出本任务授权范围）；
`tests/learn/audit-merge-enforcement.mjs --strict` 仍**诚实 exit 1**（不洗绿）。

## 21.1 逐条处置

| 发现 | 评审定性 | R2 处置 | 机检证据（可重复运行） | 可证伪性（负控） |
|---|---|---|---|---|
| **A** | 封条前应修：D1 门对"逐条 AC 裁决"不设防 | 新增**逐条 AC 裁决平价**：权威文档的逐条 AC 表 ↔ `P4_STATUS.json` 的 `acVerdicts` **双向**比对 | `validate-p4-status-consistency.mjs` 的 H1–H4；把 `acVerdicts.AC10` 篡改为 `FAIL` ⇒ 门红 | `tests/roadmap/test-p4-status-per-ac-consistency.mjs`（11 断言，临时镜像注入） |
| **B** | 封条前应修：交付物校验器判决随换行符配置翻转 | 判决改为**对 LF 归一化字节**求哈希（CRLF 检出不再翻转判决） | `tools/verify-release-artifact.mjs`：同一内容 LF/CRLF 两检出均 `IDENTICAL`/exit 0；正文漂移 ⇒ `DRIFT`/exit 1 | `tests/roadmap/test-release-artifact-verifier.mjs`（14 断言：漂移 / 过期哈希 / CRLF / LF / 还原） |
| **C** | 精度：自述数字陈旧且无门钉住 | **钉住数字**：文档只留一行机器可核声明；由 **I1/I2/I3** 当场重算比对（删声明行 ⇒ fail-closed 红） | 断言数 90 = 门**运行时**断言总数；14 / 1961 / 59 = `verify-history-preserved.mjs` 当场重算 | `tests/roadmap/test-finding-c-number-pinning.mjs`（17 断言：过期断言数 / 过期行数 / 删除声明行） |
| **D** | 精度：A10 文首标注的手写行号**整体偏移 +34** | **锚点取代手写行号**：注册锚点表（19 个）+ 行号指针**封禁块**（历史行按 `git show HEAD:<file>` 冻结豁免） | `tools/check-doc-anchors.mjs` → `DOC ANCHORS: 19 RESOLVED: 19 BANS: 2 FAIL: 0` | `tests/roadmap/test-anchor-gate-negative-control.mjs`（3 断言：裸新行号 ⇒ 红 / 带锚点 ⇒ 绿 / 块外 ⇒ 不误报） |
| **E** | 精度：D12 括号描述过宽（数字对不上） | 描述改为**点值 + 可比对照**；并给出可复算的 store census；A10 的 AC1「存量 2 命中」经复算判定为**度量假阳性**并更正 | `tools/learn-store-census.mjs --self-test`（14 断言）；`evidence/E_D12_STORE_CENSUS_20261001.md` 原始输出 | `tests/roadmap/test-finding-e-negative-control.mjs`（14 断言：去掉"非常数"限定 ⇒ H5 红；伪造 census 期望 ⇒ H2 红） |
| **F** | 精度（对抗检查通过）：D11 掩码未削弱检测能力 | **不加码**：如实声明该门是"防**误**提交的回归门"，不是"防恶意提交者"的门 | `evidence/` 内的对抗检查记录 | 结论为"无需修改"，故**不新增控制**（该判定已在 Round 3 台账登记，避免默认它需要一个假控制来自证） |
| **G** | 无 CI 归属：交付物校验器"写了但没有任何航道会跑" | 交付物校验器 + 其负控 **以及** A/B/C/E 四套控制**全部接入** required workflow | H7 断言"每个控制存在 **且** 被某 workflow 调用"；`.github/workflows/ci-level1.yml` 内的步骤名可现场核对 | E 负控的**注入 C**：删掉某一接线行 ⇒ H7 PASS→FAIL；还原 ⇒ 绿 |

**"控制"总台账（5 套，全部有 CI 归属）**：
`test-p4-status-per-ac-consistency.mjs`（A，11 断言）、`test-release-artifact-verifier.mjs`（B，14）、
`test-finding-c-number-pinning.mjs`（C，17）、`test-anchor-gate-negative-control.mjs`（D，3）、
`test-finding-e-negative-control.mjs`（E，14）。

## 21.2 Finding C 详述：数字为什么"不写"而"算"

**评审原话**：权威文档自述 `43 断言 / 1420 行 / 55 豁免`，门实测 `45 / 1934 / 59`，**且无门钉住这三个数字**。

R2 **没有**把 `43` 改成 `45`（那只是把"过期日期"往后推一次）。R2 消灭的是**"手写数字"这一类别**：

1. 文档只保留**一行**数字声明（`CURRENT_STATUS.md` 的「【数字口径·机器可核】」行）；
2. **I1** = 该行必须存在且形状合法（**删除该行 ⇒ fail-closed 直接红**）；
3. **I2** = 声明的断言数 == **本门运行时断言总数**（不是 `check()` 调用点个数——D3/H7 这类断言按行/按套件展开）；
4. **I3** = 声明的历史保全数字 == **当场重跑** `verify-history-preserved.mjs` 得到的三个数。

**四个基线的对账表（本节数字均为封条方实测，不是转述）**：

| # | 基线 | 断言数 | HEAD 行数 | 表格分隔行豁免 | 判定 |
|---|---|---|---|---|---|
| 1 | 权威文档 R2 前的自述（更早基线） | 43 | 1420 | 55 | **过期**（无门钉住 ⇒ Finding C 的原始现象） |
| 2 | 本 R1 报告内自述（§1/§5 等处 `45/45`、`1800`） | 45 | 1800 | 59 | 断言数与豁免数在其**作者期**成立；**行数在封条时已过期** |
| 3 | Round 3 评审实测（对象 `74adf93`） | 45 | 1934 | 59 | **正确**；封条方在 `74adf93` 逐项复现（同为 45 / 1934 / 59） |
| 4 | **R2 当前基线**（`main@63bf558` + R2 整改） | **90** | **1961** | **59** | 由 I1–I3 **当场重算** = 唯一当前口径 |

**行数 1800 → 1934（+134）的原因**：D1 时效标注按纪律**追加在历史行行尾**（保证历史行原文仍是该行严格前缀），
这些新增非空行计入 HEAD 行数 ⇒ 本报告里的 `1800` 在写下时是真的、在封条时已过期。
**这正是 Finding C 的普遍规律**：文档自身被追加内容也会让手写数字过期。

**断言数 45 → 90 的原因**：R2 新增 I1–I3、H7 泛化（控制存在 **且** 有 CI 归属）、逐条 AC 裁决平价等断言。
因为 I2 认的是**运行时总数**，"写代码时顺手加断言"**不会再让文档过期**。

**一次现场验证（本轮自证）**：R2 收口时新增锚点 `doc.cNumberPinning`（锚点表 +1 ⇒ 运行时断言总数 89→90），
`validate-p4-status-consistency.mjs` 立刻红：`FAIL I2 … declared=89 runtime=90`。
把声明值更正为 90 后回绿（`ASSERTIONS: 90  PASS: 90  FAIL: 0`）。
⇒ 这**不是**事故，正是该机制的设计意图：**数字一旦漂移，门当场说话，而不是等人发现**。
（本条与 §21.5 的台账一并记录，避免把"门抓到自己"当成没发生。）

⇒ 本节**因此不复述任何当前数字**，只给基线与判据；当前数字请运行本文档 §21.5 的两条命令当场取。

## 21.3 Finding G 详述：控制不能"写了没人跑"

评审发现 B 附带指出：`tools/verify-release-artifact.mjs` 是"交付物与权威正文一致"这一结论的**唯一凭据**，
但它**没有接入任何 workflow** ⇒ 该结论当时**只在本地成立**。
R2 的处置：把"交付物校验器 + 它的负控"与"A/B/C/E 四套控制"**一并接入 required workflow**，
并把断言 **H7 泛化**为"每个控制文件**存在** **且** 被**某个** workflow 调用"（存在但没人跑 ⇒ 红）。

## 21.4 口径更正：关于「L23 指针失效」这句话（诚实登记）

Round 3 的一份评审记录里出现过一句「`AC6_REAL_PROMOTION_CLOSURE.md` **L23** 指向 `A10_CONTRACT_MATRIX.md:33` 并称裁决 PARTIAL（**指针已不再解析到所引原文**）」。
封条方对这**两层意思分别复算**，结论**不合并**，而是分开登记：

1. **"L23"这个行号定位只在旧修订成立。** 实测：在 `main@63bf558`（加时效标注前）该行确在**第 23 行**；
   在本轮评审对象 `74adf93`（加了 6 行时效标注后）该行已移到**第 29 行**。
   ⇒ **"L23"作为定位已经在文档中停止使用**，改用锚点 `AC6.a10pointer`（真实行号由 `tools/check-doc-anchors.mjs` 当场算出）。
2. **"指针不再解析到所引原文"这一层成立，但性质是 D（行号定位不可靠），不是"结论丢了"。**
   被引目标 `A10_CONTRACT_MATRIX.md` 自身在加标注后**整体偏移 +34**，因此它那个**行号式**指针
   已不再落在 AC6 的 PARTIAL 裁决行上；该文件里的"当前状态"块（锚点 `A10.currentStatus`）本身解析正常。
3. **而"该指针失效 ⇒ 结论无从复核"这一更强版本不成立**（不可复现）：被引的裁决原文与它的取代事实
   都在仓库内可定位（锚点解析通过），所以这是**定位方式**的问题，不是**证据缺失**的问题。

⇒ 处置：`docs/roadmap/CURRENT_STATUS.md` 的 D1 索引第 4 行原话**逐字保留**（D1 纪律），
但在表后新增一段 **R2 更正**，写明上面三点；`P4_STATUS.json` 的对应 `note` 同步更正。
**这条更正不改任何裁决，只改"这句话该怎么读"。**

## 21.5 复验台账（R2；命令 + 实际结果）

**A 组——门与控制的完整电池**（`_p4rem-closure/probes/_r2-full-gate-battery.mjs`，日志 `_p4rem-closure/r2-regression/gate-battery.log`）：

```
PASS  GATE  p4-status-consistency            exit=0
PASS  GATE  history-preserved                exit=0
PASS  GATE  doc-anchors                      exit=0
PASS  GATE  l3-paths-coverage                exit=0
PASS  GATE  learn-store-census --self-test   exit=0    (14 assertions  PASS: 14  FAIL: 0)
PASS  GATE  verify-release-artifact          exit=0
PASS  CTRL  anchor-gate-negative-control     exit=0    (the ban is falsifiable, not decorative)
PASS  CTRL  finding-b-release-artifact       exit=0    (EOL style never changes the verdict; real content drift always does)
PASS  CTRL  finding-e-negative-control       exit=0    (14 assertions  PASS: 14  FAIL: 0)
PASS  CTRL  p4-status-per-ac-consistency     exit=0    (Finding A controls 11/11)
PASS  CTRL  finding-c-number-pinning         exit=0    (17 assertions  PASS: 17  FAIL: 0)
VERDICT: ALL GATES GREEN
```

**B 组——与 R2 改动相关的回归面**（`_p4rem-closure/probes/_r2-regression-battery-b.mjs`，日志 `_p4rem-closure/r2-regression/gate-battery-b.log`）：

```
PASS            redaction-aware-secret-audit (REAL SECRET = 0)      exit=0
PASS            test-redaction-aware-audit  (116 PASS / 0 FAIL)      exit=0
PASS            secret-scan-check . (0 raw match / 0 real secret)    exit=0
EXPECTED-RED    audit-merge-enforcement --strict (D4 未修 = 诚实红)   exit=1
PASS            validate-gate-registry (AC10 registry)               exit=0
PASS            test-learn-core (505 PASS / 0 FAIL)                  exit=0
PASS            YAML syntax (6/6 files parse ok)                     exit=0
PASS            node --check (changed .mjs)                           exit=0
VERDICT: ALL GREEN (with 1 honestly-expected RED recorded)
```

**C 组——learn 全量回归 + 真实数据门 + 运行时装载探针**：
对象 = **本冻结提交的干净工作树**；原始输出入库为
`evidence/R2_POSTFREEZE_REGRESSION_20261001.md`（在 R2 冻结提交内，与该提交同字节对象）。

**刻意保留的红**：`tests/learn/audit-merge-enforcement.mjs --strict` = **exit 1**（D4 未修，需 GitHub 扩权），
本附录**不把它写成 PASS**，也不为它加任何"豁免"。

## 21.6 诚实边界（本轮**没有**做到的事）

1. **D2 / D3 / D4 未修**：分别需要 GitHub 侧的"证据目录入库决策 / 分支保护与 ruleset 变更授权 / L3 门 `paths` 清单扩权"，
   均超出本任务授权。`--strict` 因此**仍红**。
2. **R2 的改动面不触碰运行时**：`plugins/**`、`tests/learn/**` 的运行时逻辑、审批架构、经验库、goal 恢复、
   非 learn 插件漂移均未改动；因此本轮的"相关回归"不以"生产重启"为前提。
3. **I 组断言防的是"无意漂移"，不是"两侧同时被改成同一个错值"的对抗性篡改**——后者由仓库层评审与分支保护承担。
4. **控制套件的执行环境**：全部为本地/CI 可重复运行；其中 B/C/E 三套通过**临时镜像**注入，
   保证"注入缺陷"不会污染仓库本身（也因此它们能在只读 CI 环境里跑）。

## 21.7 本轮改动清单（相对 `main@63bf558`）

| 文件 | 性质 | 说明 |
|---|---|---|
| `tests/roadmap/validate-p4-status-consistency.mjs` | 修改 | 新增 I1–I3（数字钉住）、H7 泛化（控制存在 **且** 有 CI 归属）、逐条 AC 裁决平价 |
| `tests/roadmap/test-p4-status-per-ac-consistency.mjs` | 新增 | Finding A 负控（11 断言） |
| `tests/roadmap/test-release-artifact-verifier.mjs` | 新增 | Finding B 负控（14 断言） |
| `tests/roadmap/test-finding-c-number-pinning.mjs` | 新增 | Finding C 负控（17 断言） |
| `tests/roadmap/test-anchor-gate-negative-control.mjs` | 新增 | Finding D 负控（3 断言） |
| `tests/roadmap/test-finding-e-negative-control.mjs` | 新增 | Finding E 负控（14 断言） |
| `tools/check-doc-anchors.mjs` | 新增 | 锚点解析 + 手写行号封禁（19 锚点 / 2 封禁块） |
| `tools/verify-release-artifact.mjs` | 修改 | 判决改为 LF 归一化（Finding B） |
| `tools/learn-store-census.mjs` | 新增 | 可复算的 store census（Finding E） |
| `.github/workflows/ci-level1.yml` | 修改 | 5 套控制 + 交付物校验器 + 其负控接入 required workflow（Finding G） |
| `docs/roadmap/P4_STATUS.json` | 修改 | `docAnchors` / `linePointerBans` / `_r2Remediation` / `supersededDocs` note 更正 |
| `docs/roadmap/CURRENT_STATUS.md` | 修改 | 追加 R2 数字口径更正段 + 数字声明行 + D1 索引第 4 行 R2 更正段 |
| `docs/roadmap/reports/.../evidence/{D_DOC_ANCHORS,E_D12_STORE_CENSUS,R2_CONTROL_HARDENING,C_NUMBER_PINNING}_20261001.md` | 新增 | 四份原始输出证据 |
| `docs/roadmap/reports/.../P4_REMEDIATION_CLOSURE_<ts>.md` | 重新生成 | 发布命名版（正文 = 本文件，含本节；哈希可在文件头核对） |
| `FINAL_EXTERNAL_REVIEW_MANIFEST.md` | 修改 | Round 3 原记录**逐字保留**于附录 A，正文改写为 Round 4 评审要点 |
