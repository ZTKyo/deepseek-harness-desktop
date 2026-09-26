# REVIEW_R2_INDEPENDENT — 独立复核（第二复核人）

复核对象：commit 9470091（plugins/learn.mjs、tests/learn/mount-gate.mjs）｜工作树 HEAD=d9ee4f5（clean）；只读复核，未改任何 worktree 文件，仅新增本文件。

## 1 结论
**PASS（有保留）**：修复真实有效（事故版可复现为 FAIL、修复版 A1–A4 全 PASS），但门禁对"learn 内部 sessions 接线"不敏感、生产侧 PID 证据取错进程（见 §5）。

## 2 三次独立运行的客观产物（原样引用，未复跑）
- rv-pfx（`%TEMP%\dsh-mountgate-rv-pfx-*\result.json`，expect=fail，事故版）：signal=failure-signature；learnTools=0；injectSignature=true；生产 3080 PID before=5648 after=5648（不变）。
- rv-fix（`%TEMP%\dsh-mountgate-rv-fix-*\result.json`，expect=pass，sha256=a5fae28281014ede…）：verdict=PASS；A1–A4 全 PASS；6 个 learn_* 工具无重复；sessionsViaGet=resolved；生产 3080 PID before=5648 after=5648（不变）。
- rv-neg（`%TEMP%\dsh-mountgate-rv-neg-*\result.json`，阴性对照 pluginSha=4c96e1608e1279db…，把 ctx.get('sessions')→'sessionsX'）：expect=pass 但 **verdict=PASS（全绿）**；生产 3080 PID before=5648 after=5648（不变）。
  ⇒ 门禁对该类"内部接线回归"不敏感（A3 只证明宿主可解析、A2 只数工具个数）。

## 3 diff 审计（plugins/learn.mjs）
- 改动量 +24/−2（git show 9470091）：新增 `lookupSessionsService()`（try + ctx.get 兜底）、availability 判定改用它、`const svc = ctx.sessions` → `lookupSessionsService()`；其余为注释 ⇒ 改动最小。
- 语义未变：取不到服务 ⇒ sessionsServiceAvailable=false ⇒ 批准信任锚 fail-closed，与旧版失败方向一致；刻意不把 sessions 写进 inject（避免升级为 boot 硬依赖）。
- `node --check plugins/learn.mjs` → exit=0（通过）。

## 4 同类裸访问静态扫描（plugins/*.mjs：inject 声明 vs ctx.<name>）
- 未发现第二个"apply 期裸访问未注入服务"的同类致命点；生产日志 450 条 `without inject` 全部归因 entry=learn（84 次 sessions 型 + 6 次 tools 型）。
- 只登记为潜在运行期隐患（非 apply 期致命）：`plugins/execution-continuity.mjs:601` 的 `ctx.llm?.providers`（llm 未在 inject）、同文件 `:1974` 的 `(ctx && ctx.llm)` 裸兜底。
- 已确认安全：execution-continuity.mjs:254–271（ctx.get + try/catch 取 compaction）、model-selection-guard.mjs:38/44（try/catch）、runtime-capacity-adapter.mjs:16（try/catch）、secret-gate.mjs:89（仅注释）。

## 5 与实现方结论不一致 / 未验证
- **不一致① 门禁敏感性**：实现方称阴性对照(sessionsX)得 `verdict FAIL` 且"抓到的正是 A3"；我独立复跑得 PASS（全绿）、A3 仍 resolved。机制：A3 查的是探针自己的 `ctx.get('sessions')`，与 learn 内部接线无关，只有改探针本身才会让 A3 变红。旁证：HEAD d9ee4f5（23:46:30 "record mount-gate coverage boundary"）已记录同一结论，与我的实测一致。
- **不一致② 生产 PID 取错进程**：门禁比较的 "3080 生产 PID"=5648，实测 5648 是 **tailscaled**（监听 Tailscale 地址），不是 dsh 服务；dsh loopback 监听者在本窗口由 26980→3780（22:55:37，guardian health-recovery 重启 + 运维重启事务，与我的门禁运行无因果关系）⇒ "PID 不变"这项证据实际是空检查。
- **状态修正**：生产 `~/.dsh/profiles/web/learn.mjs` 仍是事故内容（git blob f0d10bf，仅换行 CRLF 变体 sha256=36642349…），且 profile 内所有 yml 已无 learn 引用 ⇒ 当前生产未挂载 learn，修复尚未上线。
- **未验证**：① learn 在真实宿主里的 sessions 接线语义（门禁观察不到，属合同测试层职责）；② 合同测试对 sessionsX 变体的敏感性（本次未跑，门禁注释称须在 harness 内运行才有效）；③ 实现方 270/83 数字的原始口径（我实测：learn 归因失败 90 次、`failed to apply loader entry` 282 行；另有 4 次 webserver=EADDRINUSE，属既存无关类）。
