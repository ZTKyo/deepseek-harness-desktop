# R5.1-A 最终证据修正（Final Evidence Correction）— 2026-08-27

> 承载文档说明：本文件是 P2.5 外审 Round 4 → R5 证据收口之后的 **R5.1-A 轮证据修正单一载体**。
> 触发：活体复跑发现两条 R4 时代评审认定的缺口在新的双门架构下的具体表现形式，
> 以及验证器自身的两个判定假阴性缺陷。本轮只修「证据层正确性」，不改生产插件语义、
> 不扩架构、不开第二套系统（SH-R9 posture 复核 9/9 PASS，无 STOP 项）。

## 0 一页结论

| # | 缺陷 | 层级 | 判定 | 处置 |
|---|---|---|---|---|
| C8-MASK | `SECRET_RX` 分隔类吞换行 → 掩码跨行不对称（事件侧 `KEY::<NL>parsed` 打码、声明侧不打码），strict 门对**存在完备回源证据**的声明误报 `FAIL_text_not_supported_by_own_ref` | 验证器假阴性 | 确认为生成器/验证器缺陷，非 store 数据缺陷 | 修正正则（分隔/值类排除 `\r\n`）；负例新增回归；STRICT 活体腿复跑 **7/7 ALL-PASS** |
| C4-PATH | `FILE_PATH_RX` 无法跨越含空格目录名 token 化 Windows 绝对路径（工作区真名即含空格：`...\\sdeepseek harness\\...`），导致 DSH 标准写文件回执 `<path>…</path> Created file` 被语义门误判 `FAIL_no_file_op_signature` | 双门生成器假阴性 | 同上 | 新增 `<path>…</path>` 标签包路径分支；负例 NEG-FINAL-6 回归通过 |
| RESIDUE | 「P2.5→P3 残留 / 过时字段」全库复查 | 文档路由 | **无残留**：docs/roadmap 下 9 处「进入 P3」命中全部为合规否定句（未开始/禁止跳转）；CURRENT_STATUS.md L13/L28 状态字段为 AWAITING_REVIEW 正值 | 无需修改存量；仅追加本轮变更日志 |
| STORE-NOISE | 生产 store 的 keyFileChanges 含 todo-receipt 噪声 2 条、blockers 含无错误措辞的目录清单 1 条 | 数据质量真阳性 | 双门如实拦截（`FAIL_false_file_evidence_todo_noise` / `FAIL_claim_lacks_error_evidence`）——这正是 Round 4 要的双门鉴别力 | 如实落档；生产投影分类策略修订不在本轮授权内（不重设计约束） |

## 1 C8 掩码不对称：定位与修复

现象：活体 strict 腿首轮 6/7，唯一失败项 `runtimeFacts[7]`
`t="top-level-shape: version:: | refs:: | MIMO_API_KEY::"`，引用事件 seq=880805 明确包含该原文。

逐层对比（修复前 / 后）：

```
norm(claim) = "top-level-shape: version:: | refs:: | MIMO_API_KEY::"
norm(event) 修复前 = "top-level-shape: version:: | refs:: | MIMO_*** key names: has ZHIPU: false"
                              ← SECRET_RX 第三分支 ["'\s:=]+ 吞掉 :: 后的 \n，把下一行 "parsed" 当作凭证值打码
norm(event) 修复后 = "top-level-shape: version:: | refs:: | MIMO_API_KEY:: parsed key names: has ZHIPU: false"
```

修复（cm-r5-recall-verifier-snapshot.mjs L47）：`Bearer\s+` → `Bearer[^\S\r\n]+`；
第三分支标签后分隔类 `["'\s:=]+` → `["'\t :=]+`。同行的真实凭证仍被完整打码；
仅禁止掩码器把「键名冒号」与「下一行普通词」桥接成伪凭证值。

## 2 C4 空格路径假阴性：定位与修复

事件 seq=1012213 抽取文本：

```
<path>C:\Users\Administrator\Desktop\sdeepseek harness\_release-staging\docs\roadmap\evidence\R5_P25_FINAL_GATE_EVIDENCE.md</path>
<type>file</type>
<content>\nCreated file\n</content>
```

`FILE_PATH_RX` 第一分支 `[A-Za-z]:\\[^\s"'\x60]+\.\w{1,5}` 在 `sdeepseek harness` 的空格处截断，
第二分支只认仓库相对正斜杠路径 ⇒ 两侧都不匹配 ⇒ `strong=false`。
但 OP_MARKER_RX 本可命中 `Created file` —— 缺的就是路径侧签名。

修复（make-r5-recall5-exact-v2.mjs FILE_PATH_RX 追加第三分支）：
`<path>[A-Za-z]:[^<]*?\.[A-Za-z0-9]{1,5}</path>` —— 仅当回执使用 DSH 标准标签包裹时放宽；
自由文本中的带空格裸路径不会因此逃过严格门（NEG-FINAL-5 保持驳回）。

## 3 复跑结果（修正后）

| 门 | 结果 |
|---|---|
| STRICT 活体腿（make-live-fixtures 重解码 25MB 真实日志） | **7/7 类 ALL-PASS** + timeline PASS + chain PASS（before=1027575 < watermark=1033417，storeVersion=329） |
| 双门精确门（v2） | C1 PASS · C2 FAIL(1 项，真阳性) · C3 PASS · C4 FAIL(2 项 todo 真阳性) · C5 PASS；verdictSummary=`3 PASS + 2 FAIL`，note 如实记录失败 |
| 链路 | PASS_raw_side_effect_chain（before=1012213 写文件回执 → target=1027575 目标指令 → after=1029605，dups=0） |
| 负例套件 | **10/10 ALL EXPECTATIONS MET**（新增 NEG-FINAL-6 空格路径写回执回归） |
| SH-R9 posture V2 | **9/9 PASS**（settings.yaml plaintext suspect=0；agent.cordis.yml mount=L438 id=context-memory） |

## 4 工件清单（本轮新增/更新）

- `evidence/R5_RECALL_STRICT_LIVE_20260827.json`（覆盖更新：修正后 strict 7/7）
- `evidence/R5_RECALL5_EXACT_V2.json`（新增：双门精确门如实判定）
- `evidence/R5_RECALL_FINAL_NEG.json`（更新：10 用例）
- `evidence/R5_SH9_POSTURE_V2.json`（新增：post-R5.1 复核）
- `evidence/R5_COMPLETION_QUALITY_V2.json`(新增：固定字段失败核算,全库 355 日志只读扫描)
- 脚本：`cm-r5-recall-verifier-snapshot.mjs`（SECRET_RX 修正）、`make-r5-recall5-exact-v2.mjs`（FILE_PATH_RX 修正）、
  `make-r5-recall-final-neg.mjs`（+NEG-FINAL-6）、`cm-r5-make-live-fixtures.mjs`（导入名对齐快照改名）、
  `make-r5-sh9-posture.mjs`（输出名参数化）、`make-r5-completion-quality-v2.mjs`（新增）

## 5 完成质量 V2 固定字段要点（详见对应 JSON）

- 全库 355 条会话日志、728k+ 事件只读解码。以 generatedAtUtc=`2026-08-27T12:59:16Z` 快照为准：
  `PROTOCOL_CONFIG_LOAD_INCIDENT`=22、`PROVIDER_QUOTA`=17、`outOfScopeTextEcho`=814（均为事件级计数）。
  快照语义：活跃会话在本轮工作期间持续追加事件，总数随时间自然增长——工件以 generatedAtUtc 为准，
  文档引用不再另行追改。四条 R4 A/B era 长会话两类均 **0 命中**；纯 "rate limit" 文案回声
  （无字面 HTTP 码）单列，不并入任一固定字段。
- 工件零原文输出（仅计数与整数 seq 样本），secret 零落盘。

## 6 边界与治理不变声明

- 未改 `plugins/context-memory{,-core}.mjs` 生产代码；未触碰 Official Core；未重启 3080 服务；全程零生产文件写入。
- 状态维持 **AWAITING_REVIEW / Waiting For=External Review Round 4 之后重新审核**；P3=BLOCKED 不变。
