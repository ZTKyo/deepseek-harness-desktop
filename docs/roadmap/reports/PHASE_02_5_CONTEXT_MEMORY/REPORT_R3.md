# P2.5 CONTEXT MEMORY — REPORT_R3（External Review Round 2 后证据收口轮）

> 状态：**R3 完成（REAL 证据收口 103 PASS / 0 FAIL）；PHASE 维持 IMPLEMENTATION_COMPLETE / AWAITING_REVIEW（等待 External Review Round 3 独立裁决）**
> Reviewer Verdict 背景：Round 2 = CHANGES_REQUIRED；本轮为治理纠正 + R3-1…R3-8 证据收口，**不自称 VERIFIED**——该状态仅可由外部 Reviewer 写入。
> PR：`fix/context-memory-r3` → **PR #43 MERGED（squash=`107433e`，CI 三项全绿）**；此后仅状态类 backfill。
> 上一轮：R2（REPORT_R2.md）。

## 1. 本轮目标与验收对照

| # | 要求 | 结果 | 报告节 |
|---|------|------|--------|
| 治理 | be76a559 误标 VERIFIED → 回退 AWAITING_REVIEW，历史保留 | ✅ commit 25defd0 | §2 |
| R3-1 | REAL provider-switch 验证 | ✅ 升级：真实门禁测试 6 项 + **活体会话自然激活**（active=true / lastSwitchAt 持久化） | §5 |
| R3-2 | REAL token A/B 数据更新 | ✅ 三点序列补第三读数 59.2%；严格跨天 A/B 保持 PARTIAL | §6 |
| R3-2b | completion quality A/B 更新 | ⚠️ PARTIAL 如实保持（机制级对比，无跨会话质量度量系统） | §7 |
| R3-3 | 5-class recall 断言精确 seq 引用 | ✅ 17 PASS + **v145 会话头逐字段交叉闭环** | §8 |
| R3-4 | corrupt-projection fail-open | ✅ 三类损坏 6 PASS（判废重建→原子自愈） | §10 |
| R3-5 | missing-projection fail-open | ✅ 9 PASS（空目录重学→投影→落盘→防抖→增量） | §9 |
| R3-6 | kill-switch / rollback 双通道 | ✅ env+config 双停用 + 卸载回滚语义 7 PASS | §11 |
| R3-7 | runtime evidence snapshot | ✅ docs/roadmap/evidence/R3_RUNTIME_EVIDENCE.md | §15 |
| R3-8 | SH-R9 live posture 最小检查 | ✅ 三项 PASS | §13 |
| 附加 | R2 数据矛盾解释（65.2% vs 58.5%） | ✅ 已解释并固化口径 | §14 |

## 2. 治理纠正记录（Close，commit 25defd0）

- be76a559 曾在 CI 未绿/未合并前将 PHASE 状态写为 `VERIFIED` —— 违反「VERIFIED 仅由外部 Reviewer 写入」。
- 25defd0：回退为 `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`，**保留误标历史**（不重写历史），
  CURRENT_STATUS.md 加纠正注记（⚠️ be76a55 曾误标 VERIFIED…）。
- 本报告延续同一纪律：**merge 后仅做 SHA backfill，状态仍为 AWAITING_REVIEW**。

## 3. 证据分级定义

- **REAL**：真实运行环境中直接观测（真实服务/store 文件/活体进程/真实切换）。
- **SYNTHETIC**：单元测试构造的受控场景。
- **PARTIAL**：部分维度已证、其余如实标注缺口，不伪造。

## 4. 证据分类总表

| 条目 | 分级 | 一句话依据 |
|---|---|---|
| 单元回归 T1–T11 | SYNTHETIC 全量 | 61 PASS / 0 FAIL |
| R3 runtime 门禁（missing/corrupt/gate/kill-switch） | SYNTHETIC（真实文件系统 IO） | 25 PASS / 0 FAIL |
| 真实会话观测回归（17 项断言打真 store） | REAL | 17 PASS / 0 FAIL，store=10487 B 实测 |
| provider-switch：机制覆盖 | SYNTHETIC | 门禁四测面 + 负例 |
| provider-switch：自然激活 | **REAL** | 活体 active=true / lastSwitchAt=1787751377321 持久化 |
| token A/B | PARTIAL（REAL 估算×3 点 + SYNTHETIC 下限） | §6 |
| completion quality A/B | PARTIAL | §7 |
| 5-class exact-source recall | REAL + E2E 闭环 | v145 快照头 ⇔ store.refs 逐字段一致（§8/§15 §3） |
| SH-R9 live posture | REAL | 三项实测（§13） |

## 5. R3-1 REAL provider-switch gate（较 R2 的实质升级）

**机制面（脚本 `verify-r3-runtime.mjs`，真实文件系统 IO）**：

1. 首次路由登记 → 仅记录 prev，`active=false` 不误触发；
2. 同路由重复观测（负例）→ 不触发（语义：auto rewrite ≠ switch）;
3. 跨 provider/model 切换 → gate 激活，`active=true` 写盘持久化；
4. detectSwitch 语义复核与"gate 开启后首轮 pre-step 即完成投影全链路"。

**活体面（REAL，新证据）**：R2 时如实记录"真实会话未自然发生 switch"。**R3 期间本活体会话
真实发生了一次切换并持久化激活标记**：store `active=true`、`lastSwitchAt=1787751377321`
（约最近快照前 5.0 小时），且该字段仅在 `detectSwitch(prev≠new)` 命中且此前未激活时写入
（`plugins/context-memory.mjs` L223–228）。随后 watermark 持续推进（486785 → 554809 → 560925，
refs 46 → 64 条），证明激活后投影链路持续工作。

**字段语义澄清（修正 R2 表述）**：`lastRoute:null` 为设计使然——壳层初始化空 store 后从不回写
该字段（路由登记在内存 routes Map，L89/L221–222）；它与"是否发生过切换"无关。R2 中
"lastRoute=null 属正常"的表述以此为准精确化。

## 6. R3-2 REAL token A/B（三点序列；严格跨天保持 PARTIAL）

| 读数 | ratio | 判据 |
|---|---|---|
| R2 早先 | 58.5% | <80% PASS |
| R2 正式 | 65.2%（9766/6365 B） | <80% PASS |
| **R3 本次** | **59.2%（10487/6211 B）** | <80% PASS |

- 三点同口径（单会话估算：obs 字节/store 字节）带内漂移，源于水位线与内容构成随任务推进变化。
- 合成级下限不变：T10 六十组肥会话 ratio=0.055（≥25% 缩减要求，实达 94.5%）。
- **如实保持**：严格跨天同任务 A/B 仍未获取，属 polish 级证据增量，不阻塞验收。

## 7. completion quality A/B（如实 PARTIAL）

- 机制级 OFF/ON 对比已有：OFF=原始表面（无界增长）；ON=v145 快照头实测注入 bounded 观察
  （E2E 闭环见 §8）＋ T10 有界性合成证明。
- 跨会话"完成质量"指标需要独立的评测系统（评分器/对照协议），按红线**不在 P2.5 内新造第二套
  系统**；此项作为对外部 Reviewer 的明确缺口声明，而非默认达成。

## 8. R3-3 5-class exact-source recall（REAL，17 PASS + E2E 闭环）

对真 store 的五类断言全部通过：①用户原话(goal, refs=[560925]) ②错误原文(blockers, 有 refs)
③工具输出(completedActions=7, 全有 refs) ④文件变更(keyFileChanges=24, 全有 refs)
⑤时间线(refs=64, endSeq 单调 554809→560549→560925)。结构异常条目 0/64。

**E2E 闭环（新增强证据）**：本会话模型实际收到的观察快照头
`[context-memory observation v145] … sourceRange=seq567674-560925` 与 store.refs 末条
`{v:145,startSeq:567674,endSeq:560925}` **逐字段一致**——投影表面即插件产物，锚点索引在真实链路自洽。
原样留档：evidence/R3_RUNTIME_EVIDENCE.md §2–§3。

## 9. R3-5 missing-projection fail-open（9 PASS，真实缺失场景）

stateDir 为全新空目录（store 文件真实不存在）：缺失 → 从 raw 学习 → 第 1 次投影成功 →
version/v1 与 refs 闭合合法落盘 → 幂等防抖（同区间不重复投影）→ 内容增量推进 v2。
原始 append-only 会话全程只读未被触碰。

## 10. R3-4 corrupt-projection fail-open（6 PASS，三类损坏）

半截 JSON / 非 JSON 文本 / schemaVersion 错值三类损坏均：判废不抛出 → 按空骨架重建 →
原子写自愈回盘 → 插件继续工作。配合 T3 单测（corrupt rebuild/fail-open 5 项）双保险。

## 11. R3-6 kill-switch 双通道 + rollback

- `CM_DISABLED=1`（env）→ apply() 返回空对象：钩子零注册；
- `config.enabled=false` → 同样整体不挂载（卸载即回滚语义，挂载行移除则状态自动消失）；
- 对照组：默认开启 → maybeProject 测试面可用；
- 回滚预案继承 R1/R2（preset 开关 → 延迟重启；完整 git checkout main + 删两插件文件；
  raw session 任何情况下不可被本插件删除）。

## 12. 回归矩阵（REAL 本地执行，三套件）

```
verify-context-memory.mjs        RESULT: 61 PASS / 0 FAIL   (T1–T11)
verify-r3-runtime.mjs            === RESULT: 25 PASS, 0 FAIL ===（新增）
verify-r2-real-observations.mjs  结果: 17 PASS / 0 FAIL     （真 store 断言）
─────────────────────────────────────────────────────────
合计 103 PASS / 0 FAIL
```

实现注记：verify-r3-runtime.mjs 修复了初版的隐式会话 id 依赖（显式传入 sid），
避免运行环境差异导致的假阳性——修复过程即本轮唯一代码改动点，其余为纯文档。

## 13. R3-8 SH-R9 live posture 最小检查（REAL，三项）

1. 凭据治理：settings.yaml 无明文 apiKey（env 引用制）✅；
2. fail-closed 结构化探针仍在部署源码：coldstart-gate-worker.ps1 L297（初始 false）/
   L306（仅 store 可读且 newFatalCount=0 才 true）✅；
3. 状态真值：CURRENT_STATUS.md `|02.5|` 行 = IMPLEMENTATION_COMPLETE/AWAITING_REVIEW
   （含 be76a55 纠正注记）✅。

## 14. R2 数据矛盾解释（Close）

65.2% vs 58.5% 并非矛盾：两者是**不同时点的同口径单会话估算**，任务推进中水位线与内容构成
变化导致比值漂移；判定判据统一为 <80%，三点序列（58.5/65.2/**59.2**）均在阈内且下限由
T10 合成级背书。口径已在 evidence 快照 §5 固化，后续轮沿用同一公式，消除歧义。

## 15. 观测快照指针

`docs/roadmap/evidence/R3_RUNTIME_EVIDENCE.md` —— 含全部命令输出摘录、活体 store 精确读数、
E2E v145 交叉验证、SH-R9 posture 结果、token 三点序列表。报告引用一律指向该文件，不在正文重复粘贴长输出。

## 16. 遗留问题（如实清单）

1. **严格跨天 token A/B 未获取**（保持 PARTIAL）：已有三点 REAL 估算 + 合成级 94.5% 缩减证明。
2. **completion quality 跨会话 A/B 未建立**（保持 PARTIAL）：需独立评测系统，红线禁止本轮私建。
3. lastSwitchAt 只持久化激活时刻，不持久化 prev→new 具体路由对（登记表在内存，重启即失）。
   属观测粒度限制非缺陷；如 Reviewer 要求，可在后续轮评估轻量持久化（新增字段，向后兼容）。

## 17. 结论与回滚预案

- 结论：Review Round 2 要求的八项证据 R3 全部收口（103 PASS / 0 FAIL + 两项 PARTIAL 如实在档 +
  活体自然激活这一超出预期的 REAL 增强）；治理正确性恢复（VERIFIED 仅可由外部裁决写入）。
  **PHASE = IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**，等待 External Review Round 3。
- 回滚三路径：①preset `enabled:false` → 延迟重启（分钟级止血）；②git checkout main +
  删除 profiles/web 两插件文件；③store 残留无害（纯 JSON 观测数据，可整目录删除）。
