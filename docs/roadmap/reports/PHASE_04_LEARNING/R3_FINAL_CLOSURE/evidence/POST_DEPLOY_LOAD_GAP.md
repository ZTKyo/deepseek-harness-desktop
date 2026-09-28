# POST_DEPLOY_LOAD_GAP — 部署已完成，但「已装载」不成立（AC2 生产取证修正）

- 报告时间：2026-09-28 07:10（本地，UTC+8）
- 阶段：P4 FINAL CLOSURE / STAGE A — AC2（research leg 修复）生产取证
- 结论一句话：**三文件生产部署确实完成了（source == deployed）；但运行中的服务进程仍在跑部署前的旧字节（deployed == loaded = FALSE）**。
  上一轮把「已装载」判定交给了「mtime < 服务启动时间」这类**代理证据**，属于误判，本报告予以修正。
- 证据文件：`evidence/POST_DEPLOY_LOAD_PROBE_PRE_RESTART.txt`（探针原始输出）、
  `evidence/post-deploy-load-gap.json`（机器可读）、探针会话 `session-071d92bf…`、`session-6ee47cc9…`、`session-6a97346a…`

## 1 事实链（全部为可复算的宿主证据）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 三文件**已部署**：`learn.mjs` bf5cfa6d…a4ffc、`learn-core.mjs` 38c1d092…700c、`learn-candidate.mjs` f732806a…4e97 在 `~/.dsh/profiles/web` 与源目录 `_p4r2-inject-fix/plugins` **字节相同** | 探针 ①；`Get-FileHash` 逐文件比对 |
| 2 | 部署前 CHECKPOINT 存在且可回退：`DSH-Client/_backup-learn-20260928-AC2deploy/`（06:50:30 创建，含 3 个旧文件 + `MANIFEST.sha256` + `_rollback.ps1`），旧哈希 6bdd3fe5… / 4fb40331… / f2185147… | 备份目录 + MANIFEST |
| 3 | 部署动作发生在 **06:50:30**（备份创建时刻）；部署后生产文件 mtime 07:04:17（本次只动 mtime 的验证动作，内容未变） | 文件时间线 |
| 4 | 运行中的服务进程 **PID 20580，启动时间 2026-09-28 00:17:35** —— **早于部署 6.5 小时** | `netstat -ano`（三次探测 PID 均为 20580）；`restart-apply-patch.log`「candidate bound to new server pid=20580」 |
| 5 | **运行时行为仍是旧版**：三次独立探针会话（06:53、07:06、07:09 各建一个新会话）调 `learn_recall` 均返回 `{"ok":true,"items":[],"considered":0,"excluded":0,"blocked":[]}`，**不含 `researchDirective` 键**；而已部署的 `learn.mjs` 在「无命中」分支必然挂该键（L1745-1756 + L1790-1814） | 官方会话日志 `~/.dsh/sessions/.../session.jsonl.zstd` 的 `tool/result` |
| 6 | **不存在热挂载**：（a）把 `learn.mjs` 的 mtime 改成 07:04:17（内容一字节未变）→ 90s 后 PID 仍 20580、行为仍旧；（b）把 `cordis.patch.yml` 的 mtime 改成 07:07:17（内容未变）→ 75s 后仍旧。dsh 包内也**没有** profile 插件/patch 的文件监视器（profile-boot 只在挂载时解析 `cordis.patch.yml`） | 上述 (a)(b) 实测 + 源码检索 |
| 7 | 生产健康（跑旧代码）未见异常：`GET /` = HTTP 200；探针会话工具面正常 | 探针 ② |

## 2 根因

DSH 的 profile 插件（`cordis.patch.yml` 中 `name: './learn.mjs'` 等）**只在服务进程启动时装载一次**，
运行中的进程不会因为文件被改写而重新 import（无 watcher、无 HMR；改插件文件或改 patch 文件的
mtime 都不触发重挂载）。因此：

- 「把字节部署到 `~/.dsh/profiles/web`」 ⇒ 只满足 **source == deployed**；
- 「生产活进程实际执行的字节 == 部署字节」 ⇒ 还需要 **一次服务重启**。

上一轮的 `_post-restart-verify.mjs` 用 `mtime < 服务启动时间` 作为「已装载」的代理证据，
在**部署后未重启**的情况下会把结论误判成「已装载」——本轮以运行时行为判定取代之。

## 3 影响面（必须如实带入后续判定）

1. **AC2 生产运行时遥测尚未成立**：不能因「文件已同步」就宣称修复在生产生效；AC2 的
   `researchDirective` 生产行为要等重启后重新取证。
2. **凡是在部署（06:50:30）之前取的生产证据，其对象都是旧代码**：包括既有报告里
   「生产负向安全重检 8 项全部 DENIED」一类条目——**需在重启后以新代码重取**，否则
   其证明力只覆盖旧字节（本报告不追溯改写历史结论，只标注时效）。
3. 生产现状**不是故障**：服务健康、GUI 正常，只是跑的是修复前的 learn 插件。

## 4 处置（本轮执行 / 下一轮续做）

- 本轮：产出本报告 + 行为判别探针 `_p4r2-inject-fix/tests/learn/production-load-probe.mjs`
  （退出码 0=新版已装载 / 3=仍旧版），并按机器既定规程用
  `DSH-Client/restart-dsh-server-delayed.ps1`（先 `-PreflightOnly` 预检，再 `-Detach -DelaySeconds 240`
  延迟重启）触发**一次**服务重启来装载已部署字节。
- 下一轮（重启后、自动续跑）：① 跑 `production-load-probe.mjs`，期望 `VERDICT=NEW_CODE_LOADED`；
  ② 用新代码重取生产负向安全 8 项；③ 复核恰 6 个 `learn_*` 工具、无重复注册、无旧 mount 崩溃签名；
  ④ 之后即到 A8 真人审批门（需真人在「审批策略=ask」的新会话里对精确 digest 做 APPROVE/REJECT）。

## 5 教训（已写入 KNOWN_ISSUES / RUNBOOK）

- **判定「已装载」只能靠运行时行为**（例：`production-load-probe.mjs`），不能靠 mtime/启动时间代理。
- 本机 DSH 架构事实：**profile 插件与 `cordis.patch.yml` 的改动必须重启服务才生效**；
  无重载接口、无文件 watcher。「部署完成」≠「修复生效」。
