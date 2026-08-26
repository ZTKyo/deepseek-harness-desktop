# P2.5 CONTEXT MEMORY — R3 RUNTIME EVIDENCE SNAPSHOT

> 快照时刻：2026-08-27（R3 证据收口轮，分支 `fix/context-memory-r3`，基线 commit 25defd0 之后）
> 性质：REAL 运行时证据原样留存（命令输出摘要 + 真实状态文件读数）。凡脚本输出均为原样摘录。

## 1. 测试套件原始结果（REAL 本地执行）

```
===== verify-context-memory.mjs（T1–T11 单元回归）=====
RESULT: 61 PASS / 0 FAIL

===== verify-r3-runtime.mjs（R3 REAL runtime，新增）=====
=== RESULT: 25 PASS, 0 FAIL ===
覆盖：R3-6 kill-switch(env CM_DISABLED / config.enabled=false / 对照组)
      missing-projection fail-open（空目录重学→投影→落盘合法→refs 闭合→幂等防抖→增量 v2）
      corrupt-projection fail-open（半截 JSON/非 JSON/schemaVersion 错误 → 判废重建→原子自愈）
      provider-switch gate（首次登记 inactive / 同路由负例不误触发 / 跨 provider 切换→active 持久化
      / detectSwitch 语义复核 / gate 开后首轮 pre-step 完成投影全链路）

===== verify-r2-real-observations.mjs（真实会话观测回归）=====
结果: 17 PASS / 0 FAIL
   store=10487 B, obs=6211 B, ratio=59.2%（<80% 阈值）
=== 服务进程（真实运行）===
  PASS 端口 3080 有监听进程
```

## 2. 活体 store 精确读数（session-34e86c7a-c982-4ded-90fa-1511021ffda7.json）

```
文件字节:        10487 B（fs.stat 权威值）
schemaVersion:   1
version:         v143 → v145（两次探针间隔内自然增长，投影持续活跃）
watermark:       554809 → 560925
active:          true
lastRoute:       null（设计使然：壳层初始化后从不回写该字段，
                 路由登记在内存 routes Map —— plugins/context-memory.mjs L89/L221-222）
lastSwitchAt:    1787751377321（约在最近一次快照前 5.0 小时；
                 仅 detectSwitch 真实命中且此前未激活时写入 —— L223-228。
                 即本活体会话真实发生过一次 provider/model 切换并触发激活持久化）
obs 条目计数:     completedActions=7 verifiedEvidence=0 keyFileChanges=24
                 failedApproaches=0 blockers=1 runtimeFacts=8 refs=64
goal:            存在，refs=[560925]
refs 结构异常:    0 / 64（每条 {v,startSeq,endSeq,at} 类型齐备；
                 startSeq=表面节点序位锚点，endSeq=源事件 watermark 锚点——两者异轴，
                 设计不变量是「endSeq 随时间单调不减」：
                 554809 → 560549 → 560925 ✅）
末 3 条 refs:     {v:143,startSeq:561746,endSeq:554809,at:1787769187407}
                 {v:144,startSeq:563089,endSeq:560549,at:1787769373528}
                 {v:145,startSeq:567674,endSeq:560925,at:1787769438762}
```

## 3. E2E 交叉验证（投影表面即插件产物）

本会话最新注入模型的上下文观察快照头：

```
[context-memory observation v145] sessionId=session-34e86c7a-c982-4ded-90fa-1511021ffda7
sourceRange=seq567674-560925
```

与 store.refs 末条 `{v:145, startSeq:567674, endSeq:560925}` **逐字段一致**——
模型实际收到的记忆快照正是本插件输出的 v145 投影。回源索引（startSeq/endSeq 锚点）
在真实运行链路上自洽闭合。

## 4. SH-R9 活体姿态最小检查（三项）

```
posture-1 凭据治理:     settings.yaml 无明文 apiKey（env 引用制）            PASS
posture-2 fail-closed:  coldstart-gate-worker.ps1 L297 ($storeProbeOk=$false 初始化)
                        L306 (仅可读且 newFatalCount=0 才置 true)            PASS（源码在位）
posture-3 状态真值:     CURRENT_STATUS.md | 02.5 | 行 =
                        IMPLEMENTATION_COMPLETE/AWAITING_REVIEW（含 be76a55 纠正注记） PASS
```

## 5. 数据三点序列（token A/B 口径，单会话估算）

| 采集时点 | store | 投影 obs | ratio | 出处 |
|---|---|---|---|---|
| R2 报告早先读数 | — | — | 58.5% | REPORT_R2 §10 |
| R2 报告正式读数 | 9766 B | 6365 B | 65.2% | REPORT_R2 §5 R2-5 |
| R3 本次读数（脚本权威） | 10487 B | 6211 B | **59.2%** | verify-r2-real-observations |

同一 <80% 判据下三次全部 PASS；数值带漂移源于采集时点不同（水位线/内容构成随任务推进变化），
非口径矛盾。合成级下限证明不变：T10 六十组肥会话 ratio=0.055（≥25% 缩减要求实达 94.5%）。
