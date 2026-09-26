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

## 遗留建议（**未执行**，需用户决定）

把本门禁接入 `DSH-Client/restart-dsh-server-delayed.ps1` 的 preflight 作为 **可选项**
（如 `-MountGate`）：在真正切换/重启前先用隔离 profile 试挂载一次，可把"起不来"挡在重启之前。
代价：每次多约 20–40 秒、期间临时启动一个隔离实例。**因为涉及生产重启关键路径，本次未擅自改动**，
仅作为建议列出。
