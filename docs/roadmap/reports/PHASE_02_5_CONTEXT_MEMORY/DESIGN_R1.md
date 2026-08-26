# P2.5 CONTEXT MEMORY — Minimal V1 Design（R1）

> 依据：`AUDIT_R1.md`（全部 VERIFIED）。目标：最小、可回滚、零 authority 重叠。
> 新增文件仅 4 个：`plugins/context-memory-core.mjs`、`plugins/context-memory.mjs`、
> `tests/context-memory/verify-context-memory.mjs`、本设计文档 + 报告。
> 配置变更仅 2 处：autonomous 预设 compaction 组插一行；cordis.patch.yml 不动（插件从预设挂载）。

## 1. 组件

### context-memory-core.mjs（纯函数，零 IO，可单测）

| 导出 | 职责 |
|---|---|
| `estimateTokens(text|message)` | chars/4 兜底估算（tokenMeter 缺失时） |
| `selectProjectionRange(surfaceNodes, events, opts)` | 在 Recent Window 之前选出可安全替换的连续区段：起点对齐 user/message；终点不得是"带未配对 tool-call 的 assistant/message"，且范围后继节点不得是其 tool-call 落在范围内的 tool/result（向内收缩直至干净）；返回 `{startSeq, endSeq, nodeSeqs}` 或 null |
| `buildObservation(events, nodeSeqs, prevObs)` | 增量把区段事件投影为结构化 Observation：goal / completedActions / verifiedEvidence / fileChanges / failedApproaches(含原因) / blockers / runtimeFacts / remainingWork；每条目携带 `refs:[seq]`；合并进 prevObs（幂等） |
| `reflect(obs, caps)` | 有界归纳：去重动作（同文件+同类合并）、已解决 blocker 折叠为一行、failedApproaches 保留最近 N 条、总字符 ≤ caps.totalChars（默认 6000）、各段条目 ≤ caps.perSection（默认 24）。纯函数、确定性输出 |
| `renderObservationText(obs, meta)` | 渲染为注入文本：标题行 `[context-memory observation vN]`+sessionId+sourceRange+版本；分节文本；尾部 Recall 指引（"精确原文按 seq 回源 session log"）；**不渲染任何 secret 形态字段** |
| `detectSwitch(prevRoute, nextRoute, requestedMode)` | 切换判据：provider 变化，或 model 变化且 requestedMode!=='auto'（W-B 判据）；首见路由不算切换 |
| `validateStore(raw)` | store JSON 结构校验；损坏返回 null |

### context-memory.mjs（插件壳，IO + 钩子）

```
apply(ctx, config):
  if (config.enabled === false || process.env.CM_DISABLED === 'true') return {};   // 单开关
  state = { stores: Map(sid->store), routes: Map(sid->route), installing: WeakSet }
  // ── 钩子1: pre-step（compaction 组内，offload 之后 compaction-basic 之前）──
  ctx.on('agent/pre-step', async ({agent, signal}, next) => {
    try {
      sid = agent?.session?.id; session = agent?.session
      store = loadStore(sid) ?? rebuildFromLog(session) ?? emptyStore(sid)   // fail-open 三级
      maybeProject(session, store, ctx)   // 见 §2 流程；全程 try/catch，异常→跳过
    } catch {}                               // 永不 throw（fail-open）
    return next()
  })
  // ── 钩子2: provider-switch 观察者（双保险挂载，WeakSet 去重）──
  const installObserver = (agent) => { agent.ctx?.on?.('agent/request', obsHandler) }
  try { ctx.on('agent/request', obsHandler) } catch {}
  try { ctx.on('agent/created', (_c,_e,p)=>installObserver(p?.agent)) } catch {}
  obsHandler = async (payload, next) => {
    resolved = await next()
    try { route = {provider:resolved?.provider, model:resolved?.model}
          mode = payload?.config?.model ?? payload?.model      // 请求侧原始 model（判 auto）
          prev = routes.get(sid); routes.set(sid, route)
          if (detectSwitch(prev, route, mode)) store.active = true; persist }
    catch {}
    return resolved }

export const _test = {...core fns, maybeProject}   // 单测入口
```

## 2. maybeProject 流程（每 step 前，幂等有界）

```
nodes = session.surface.nodes; events = session.events
if nodes.length <= recentWindow(40): return                    # 太短不动
if !store.active && estSurfaceTokens(nodes) < activationThreshold(50000): return   # 未激活只等待
range = selectProjectionRange(nodes, events)                   # Window 之前的安全区段
if !range or range ⊆ alreadyProjected(store.watermark): return # 增量：无新区段即退出
obs = buildObservation(events, range.nodeSeqs, store.obs)
obs = reflect(obs, CAPS)                                       # 有界收敛
text = renderObservationText(obs, {sid, range, v: store.version+1})
meter = ctx.get('tokenMeter')
prune = {shadowedRange:{start,end}, shadowedSeqs:range.nodeSeqs,
         ...(meter? {shadowedTokenCount: sum(estimateMessage)} : {})}
session.append('compaction/prune', prune)                      # shadow-price 先例
session.append('user/message', createUserMessage({content:[{type:'text',text}],
    source:{kind:'plugin',plugin:'context-memory',form:'snapshot',
            sections:[{name:'context-memory',text}]}}),
    {surfaceOp:{op:'replace',start:range.startSeq,end:range.endSeq},
     sourceEventSeqs: range.nodeSeqs})                          # 官方回源协议
store.version++; store.obs=obs; store.watermark=range.endSeq
store.refs.push({v, startSeq, endSeq, nodeSeqs})               # Recall 索引（保留最近 K 条）
persistStore(store)                                            # 原子写 tmp+rename
```

边界保证：
- 只 replace `selectProjectionRange` 选出的 Window 之前区段 → 最近上下文永远原样（Recent Window）
- 表面恒只有一个 Observation 快照节点（旧节点被新范围替换时自然 supersede）→ bounded surface
- store 大小上限（refs 环形保留 64 条、obs 受 reflect caps）→ bounded persistence
- 不碰：compactNow/threshold、request-error retry、ec/recovery-requirement、router 决策、goal 状态

## 3. Store schema（%LOCALAPPDATA%\DSHHarness\state\context-memory\<sid>.json）

```json
{ "schemaVersion": 1, "sessionId": "...", "version": 3,
  "active": false, "watermark": 120,
  "lastRoute": {"provider":"...","model":"..."},
  "obs": { "goal": "...", "completedActions":[{t, refs:[seq]}], "verifiedEvidence":[...],
           "fileChanges":[...], "failedApproaches":[{t, why, refs}], "blockers":[...],
           "resolvedBlockers":["..."], "runtimeFacts":[...], "remainingWork":[...] },
  "refs": [{"v":2,"startSeq":10,"endSeq":96,"nodeSeqs":[...]}] }
```

损坏处理：validateStore null → rebuildFromLog（从 raw events 确定性重建 watermark 之前投影）→ 再失败 → emptyStore（fail-open raw 直通）。

## 4. Provider-switch activation 语义

- 观察者记录每次请求最终 route；`detectSwitch` 判真 → `store.active=true` 并立即持久化。
- 激活后下个 pre-step 即执行投影（"先激活已生成、尚未替换进上下文的 Observation"）。
- P2.5 全程只读 route 结果，绝不设置/建议/改写任何路由字段 ⇒ Router 仍是唯一 Model Authority。

## 5. R1 验证清单 → 测试映射

| R1 要求 | 测试/验证 |
|---|---|
| raw Session truth 不变 | T1：投影后原事件 seq 寻址不变、内容 deepEqual、append-only 计数只增 |
| 单开关完全关闭 | T2：enabled:false / CM_DISABLED → 无监听器注册、模拟多轮零表面变化 |
| projection 损坏 fallback raw | T3：store 写坏 JSON → 重建成功；重建源也坏 → 空投影直通且任务继续 |
| source refs 可回源（≥5 类） | T4：错误原文/tool 输出/file patch 行/user 原话/时间线顺序 各取 1 例由 refs 回到原始 event |
| restart 后可恢复 | T5：新插件实例加载既有 store 续跑 watermark；缺文件→重建路径 |
| 真实 provider switch 后连续 | T6：模拟 route 变化→active 置位→下轮投影生效；auto 常规重写不触发。真实切换在 runtime 验证阶段实测（无法自然触发则如实标注 partial/synthetic） |
| memory bounded | T7：对抗性增长输入下 reflect 输出恒 ≤ caps；表面 Observation 节点数恒 ≤1；store refs ≤64 |
| no duplicate authority | T8：源码静态断言（不含 compactNow/request-error retry/ec emit/goal 写/router 写）+ 运行时服务访问探针 |
| context rot | T9：失败方案进入 obs.failedApproaches 后，投影文本含"已判定失败"标记；reflection 合并不复活过期方案 |
| rollback | T10：删预设一行/置 enabled:false → 行为与 main 基线一致（T2 同源验证） |
| Token A/B | runtime 阶段：usage.inputTokens 对比（真实长任务优先；不足则 synthetic 标注） |

## 6. 部署与回滚

- 部署：两文件拷贝至 `~/.dsh/profiles/web/`（备份 `_backup-context-memory-*-<ts>` 若覆盖同名——全新文件无覆盖）；
  autonomous 预设 compaction 组插入一行：
  ```yaml
      - id: context-memory
        name: './context-memory.mjs'
        config:
          enabled: true
          recentWindowNodes: 40
          activationThresholdTokens: 50000
  ```
- 生效需服务重启一次（delayed-restart，提前预告用户）。
- 回滚 = 删除该行（或 enabled:false）+ 可选删除两个插件文件；零数据迁移、零 schema 变更；
  store 文件残留无害（无消费者）。raw session 从未被修改（append-only 保证）。

## 7. 明确不做（V1 禁止清单对照）

vector DB ✗｜独立 daemon ✗｜Task/Goal DB ✗｜第二 recovery loop ✗｜第二 router ✗｜自动学习 ✗｜
新框架/依赖 ✗（纯 node:std）｜P3 内容（自主决策/自驱动循环）✗
