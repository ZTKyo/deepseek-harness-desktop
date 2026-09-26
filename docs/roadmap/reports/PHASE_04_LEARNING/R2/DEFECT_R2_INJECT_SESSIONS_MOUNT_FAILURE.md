# DEFECT（FIXED & VERIFIED）：learn 插件 apply 期裸访问未注入的 `ctx.sessions` ⇒ 整个 web profile 启动失败

- **日期**：2026-09-26（生产事故）／2026-09-26（修复 + 挂载级门禁 + 独立复核）
- **严重级别**：P0 —— 生产 Harness 服务**完全无法启动**（不影响只启动其他 profile，但 web profile 全崩）
- **影响面**：`~/.dsh/profiles/web` 每次带 `learn` 挂载的启动都失败；服务起不来 ⇒ 用户界面白屏/无法使用
- **根因**：`plugins/learn.mjs` 的 `export const inject = ['tools']` **未声明 `sessions`**，
  而 `apply()` 里用**裸属性访问**读它：
  ```js
  const sessionsServiceAvailable = !!(ctx.sessions && typeof ctx.sessions.get === 'function');   // 旧写法 L328
  ```
  Cordis 在按 `inject` 装载插件时会安装"服务访问守卫"：对**未注入服务的裸属性访问直接抛错**
  （`cannot get property "sessions" without inject`），**而不是返回 `undefined`**。
  于是那句"防御式判空"本身就会抛，且发生在 **apply 期** ⇒ loader 逐条装载时该条目失败 ⇒
  **整棵 plugin tree 装载失败 ⇒ boot 失败**。

## 证据

### 1) 生产事故签名（修复前）
```
failed to apply loader entry learn (./learn.mjs): cannot get property "sessions" without inject
```
- 服务日志中该签名出现 **270 次**；重启事务连续 **83 次 FAILED**；期间服务始终起不来。

### 2) 独立复现（真实加载器 + 真实 profile，挂载级门禁）
事故版本（`git cat-file blob HEAD:plugins/learn.mjs`，blob `f0d10bf7…`，sha256 `c37b9280…`）在
隔离临时 profile 中启动，日志给出**致命访问点**（Cordis 自带栈）：
```
Error: cannot get property "sessions" without inject
    at new apply (file:///C:/Users/Administrator/.dsh/profiles/_mountgate-pfx3/learn.mjs:328:43)
```
⇒ 与静态判断一致：**致命点只有 L328 一处**（同文件 L331 的 `ctx.sessions` 在 `try/catch` 内，
抛出被捕获后返回 `null` ⇒ fail-closed，不会导致 boot 失败）。

### 3) 修复后（同一门禁）
- 探针捕获到**恰好 6 个** `learn_*` 工具，**无重复**：
  `learn_propose, learn_review, learn_recall, learn_promote, learn_verify, learn_status`
- 同形上下文下 `ctx.get('sessions')` 解析为 `resolved` ⇒ **F1 人类批准信任锚仍在岗**
  （没有把"起不来"换成"信任锚静默失效"）
- 无任何 loader 失败签名；web 端 HTTP 200

## 为什么既有两层验证没抓到（这才是本缺陷的真正教训）

| 既有验证层 | 做法 | 为什么漏过 |
|---|---|---|
| `tests/test-learn-plugin-contract.mjs` 等单测 | 直接 `apply(ctx, cfg)`，`ctx` 是**普通对象 mock** | mock 上没有 Cordis 的 inject 守卫 ⇒ `ctx.sessions` 只是 `undefined` ⇒ **假绿** |
| `restart-dsh-server-delayed.ps1 -PreflightOnly` | 只校验"挂载引用文件存在 + YAML 合法 + hash 一致" | 语法/引用都对，**语义/装载期异常**不在其检查面内 |
| CI（ci-level1..4） | 跑测试与冒烟，但不在真实 profile 装载路径上 | 同上：不支持"真实 loader 装载"这一层 |

**结论**：缺的是"**真实加载器下的挂载级验证**"这一层，而不是"再多写几个断言"。

## 修复

`plugins/learn.mjs`（+24/−2 行，单点改动，语义不变）：

```js
// 与下方既有的可选服务惯例 ctx.get?.('approval') 完全一致：不抛错取值
const lookupSessionsService = () => {
  try {
    return (typeof ctx.get === 'function' ? ctx.get('sessions') : null) ?? null;
  } catch { return null; }
};
const sessionsServiceAvailable = (() => {
  const svc = lookupSessionsService();
  return !!(svc && typeof svc.get === 'function');
})();
const hostSessionById = (sid) => {
  try {
    const svc = lookupSessionsService();
    if (!svc || typeof svc.get !== 'function') return null;
    return svc.get(sid) ?? null;
  } catch { return null; }
};
```

- **语义不变**：取不到服务 ⇒ `sessionsServiceAvailable=false` ⇒ 复验器不可用 ⇒ 授权 **fail-closed**。
- **刻意不把 `sessions` 写进 `inject`**：本插件按设计容许宿主没有该服务（fail-closed 降级）；
  写进 `inject` 会把"可选降级"升级为 **boot 期硬依赖**（对照 execution-continuity 曾因把
  `compaction` 写进 inject 造成 boot 硬依赖而被回退的历史处置）。

## 新增验证层：挂载级门禁 `tests/learn/mount-gate.mjs`

真实 dsh profile 启动 + 真实 loader + 真实 inject 语义下挂载候选插件，**双向自证**：

```
# 反例自证：事故版本必须被抓住
node tests/learn/mount-gate.mjs --plugin <事故版本 learn.mjs> --expect fail --slug pfx3 --port 3104
# 修复验证：修复版必须通过
node tests/learn/mount-gate.mjs --plugin <repo>/plugins/learn.mjs --expect pass --slug fix3 --port 3105
```

断言：A1 无 loader 失败签名；A2 探针捕获恰好 6 个 `learn_*` 工具且无重复；
A3 同形上下文 `ctx.get('sessions')` 可解析；A4 无工具面告警；A5 全程生产 3080 PID 未变。

**隔离设计**（不干扰生产）：
- 新建临时 profile `~/.dsh/profiles/_mountgate-<slug>/`，只声明基座 bundles
  `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，patch 里只挂 **探针 + 候选插件**
  ⇒ 不会连带拉起第二个 telegram 轮询/守护等生产插件；
- 候选插件**整个插件目录**拷入（相对依赖闭包完整）；`stateDir` 指向临时目录；
- 结束删除临时 profile（`--keep` 可保留）；杀进程前校验命令行含本门禁 profile 名且不含 3080。

**两个实测坑（写进门禁以免后人重踩）**：
1. `ctx.logger.info` **不落到进程 stdout** ⇒ 不能用插件自己的 diag 行做判定；
2. 崩溃/告警日志常在**进程退出之后**才落盘 ⇒ "HTTP 200 就立刻读日志"会产生**假 PASS**。
   门禁因此改为"等决定性信号（探针文件 / 失败签名 / 进程退出）再判定，并多等一拍复查日志"。

## 覆盖边界（阴性对照实测结论，⚠️ 勿误读）

本门禁经**阴性对照**（把修复版的 `ctx.get('sessions')` 改坏成 `ctx.get('sessionsX')`）实测确认：

| 断言 | 覆盖面 | 敏感性证据 |
|---|---|---|
| A1 无 loader 失败签名 / A2 恰好 6 个 `learn_*` 工具无重复 | **装载/boot 失败类**（本次事故类） | ✅ 两个独立坏变体均被抓：①事故版本（inject 守卫抛错、0 工具）②人为语法坏版本（import 失败、0 工具） |
| A3 宿主 `sessions` 服务可解析 | 仅"装载级前置条件"（宿主服务在本 profile 上下文可取到） | ⚠️ **对 learn 自身 sessions 接线不敏感**：`sessionsX` 坏版本下 A3 仍 `resolved` 全绿（A3 是探针自己查 `ctx.get`，与 learn 内部无关；A2 只数工具个数） |

⇒ **本门禁证明的是"这个插件能不能挂载、工具面是否完整"，不证明"插件内部接线语义正确"**。
"内部接线语义回归"属 `tests/` 合同测试层职责（如 `test-learn-r2-b1-approval-gate.mjs`）；
本次**未验证**该合同测试对 `sessionsX` 变体的敏感性——在裸 shell 运行它会因缺少真实宿主会话
而以 `approval_host_fact_session_unavailable` 失败（两个版本一样，因此不能用来区分），
必须在 harness 内运行才有效。这条边界如实记录，避免后人把本门禁的 PASS 当成"接线正确"的证据。

**副产品证据（fail-closed 语义在修复后依然成立）**：在无真实宿主会话的上下文里，修复版的
`learn_review` 批准被**拒绝**，错误为
`approval_attestation_selfcheck_failed:approval_host_fact_session_unavailable`
⇒ "取不到宿主事实 ⇒ 不可复验 ⇒ 拒绝授权"的设计没有被本次修复改变。

## 独立复核与处置（第二复核人 + 修复后复验）

由**独立复核者**（另一 agent 实例，只读复核、不改 worktree 文件）出具
`REVIEW_R2_INDEPENDENT.md`：**结论 PASS（有保留）**——修复真实有效（事故版可复现 FAIL、
修复版 A1–A4 全 PASS、diff 仅 +24/−2、`node --check` exit=0、未发现第二个 apply 期同类致命裸访问）。
它同时指出三处偏差，处置如下：

| 复核意见 | 判定 | 处置 |
|---|---|---|
| ① 门禁对"learn 内部 sessions 接线"不敏感（阴性对照 `sessionsX` 得全绿 PASS 而非 FAIL） | **成立** | 已在 `d9ee4f5` 的「覆盖边界」小节如实降级，与复核者独立复跑结论一致 |
| ② 门禁里的"生产 3080 PID"抓到的是 **tailscaled**(5648) 而非 dsh 本体 ⇒ "PID 不变"是**空检查** | **成立**（实测确认：3080 上另有 tailscaled 在 Tailscale 地址上代理监听） | 已修：只取 `127.0.0.1` 监听者并带进程名（`pid:proc`）；复验证据见下表 |
| ③ 生产 `learn.mjs` 仍是事故内容、profile 已无 learn 引用 ⇒ 生产**当前未挂载 learn**、修复尚未上线 | **成立**（生产件 sha256=`36642349a4ab0efa`，本次未改动生产任何文件） | 属预期：修复在 PR 分支，合并/上线是独立步骤；"未挂载 ⇒ 无活动故障"如实记录 |

**意见②的修复与复验证据**（修复后重跑，隔离端口 3110/3111）：

| 运行 | 候选件 sha256 | verdict | 关键字段 | 生产侧 |
|---|---|---|---|---|
| 修复件 | `a5fae28281014ede…` | PASS | A1–A4 全 PASS；6 个 learn_* 无重复；`injectSignature=false` | `3780:node → 3780:node` untouched=true |
| 忠实事故件（`git show 63f27b8:plugins/learn.mjs`） | `c37b9280ca9cfe84…` | PASS(expect=fail) | 抓到 `cannot get property "sessions" without inject`；0 工具；`injectSignature=true` | `3780:node → 3780:node` untouched=true |

⇒ **被审产品件 `plugins/learn.mjs` 自复核定稿后逐字节未变**（sha256 仍 `a5fae28281014ede…`）；
本轮改动仅限**测试与文档**（门禁证据字段、依赖预检、A5 文档降级为"记录项"）。

**顺带修掉的一个门禁假阳性风险**：候选目录若缺兄弟插件，boot 会因"别的文件缺失"失败，而
`--expect fail` 仍判"抓到了"。已加**相对依赖闭包预检**（实测：候选只放 `learn*` 时报
`learn-core.mjs -> ./context-memory-core.mjs`、`learn-gap-veto.mjs -> ./failure-classifier-core.mjs`
并以 ENV_ERROR(exit 2) 退出，不再假阳性）。

产物留存：`docs/roadmap/reports/PHASE_04_LEARNING/R2/evidence/`（脱敏后入库）——
`gate-fixed-pass-result.json`、`gate-accident-caught-result.json`、`gate-incomplete-dir-enverror.txt`、
`reviewer-rv-{pfx,fix,neg}-result.json`。

**CI 说明（既存失败，与本次改动无关）**：PR 的 `DSH boot + readiness smoke` 失败，但属**既存失败**——
最后一次成功是 2026-09-21（`p3-autonomy-r1-round2-closure`），其后自 09-22 `main` 起连续 6 个分支
同一作业全失败；且本次改的 `learn.mjs` **不在该作业的插件清单**（清单仅含 completion-notify /
keepalive-patch / model-selection-guard / execution-continuity / context-memory / supervisor-bridge）。
分支保护的必需检查为 `Static + secret + syntax gate` 与 `Reliability state machine tests`，**两项均 PASS**，
故不阻塞合并。另：22:55:37 生产 3080 上的一次重启由 guardian/运维事务触发，与本门禁运行**无因果**
（门禁只跑隔离端口，且 kill-guard 只杀命令行含本门禁 profile 名者）。

## 遗留建议（**未执行**，需用户决定）

把本门禁接入 `DSH-Client/restart-dsh-server-delayed.ps1` 的 preflight 作为 **可选项**
（如 `-MountGate`）：在真正切换/重启前先用隔离 profile 试挂载一次，可把"起不来"挡在重启之前。
代价：每次多约 20–40 秒、期间临时启动一个隔离实例。**因为涉及生产重启关键路径，本次未擅自改动**，
仅作为建议列出。

**另一条更根本的防复发建议（同样未执行）**：把仓库内 mock 式测试的 `ctx` 换成**带 inject 守卫的
假 ctx**（访问未注入服务即抛错），从根上消除"mock 假绿"。本次未动，因为它的影响面是**全部**
mock 式测试——很可能一次暴露多处同类裸访问（属于结构性问题、需要独立任务与自己的验证），
按纪律只报告不顺手改造。

