# PHASE 02.8 — PHONE R5 CORRECTION（External Review Correction）

> 状态截止本文件：**PHONE_R4_EXTERNAL_REVIEW = FAILED / PHONE_R5_CORRECTION = IN_PROGRESS**
> 上一轮（"PHONE R4 100% 完成 / AWAITING_EXTERNAL_REVIEW_FINAL"）被 External Review 判定为 **false-positive**，本文件记录真相与纠正计划。

## 0. External Review Verdict
- **PHONE R4 = FAILED / CHANGES_REQUIRED**
- 对应 PR：#79（branch `phase-02-8-watchdog-mobile-monitor`）——**保持 OPEN，禁止 merge**。
- P3 继续冻结。

### 确认 PASS（保留）
- FCM 真机实收（真实推送 → 设备 diag 字段推进）。
- FCM → fetch 唤醒链可用。
- `/watchdog/status` 公网可达（HTTP 200）。
- `tasks[]` 后端纯函数已有部分测试。

### 确认 FAIL（本轮必须修复）
- 手机 Widget 仍为旧版单任务 UI（仅 `tvState/tvMeta/tvTask/tvModel/tvFoot`）。
- 没有独立多任务卡片；截图中的 "+3 other" **不是**多任务 UI。
- 详情页（`activity_main.xml`）仍是 placeholder。
- deploy 脚本重复 pin → 产生第 2 个 Widget。
- 当前公网通道是动态 trycloudflare；动态 URL 依赖 ADB 回写手机。
- 不满足"外出监控"；不满足 P6 runtime-location-agnostic。
- 真正最终 PHONE R4/R5 未完成。

## 1. False-Positive 原因（根因）
上一轮把以下错当成"完成/多任务监视 PASS"：
1. **把 widget 是否"上桌面 + 渲染"当作任务完成** —— 实为旧版单任务布局，功能未达标。
2. **把 "+3 other" 当作多任务监控 UI** —— 实际只是聚合计数，不是独立任务卡片；主界面还暴露了 `gen/rev` 等诊断字段（违反 R5 设计）。
3. **把动态 trycloudflare 当作 production 通道** —— 属于 DEV/E2E 测试方案，依赖 ADB 回写手机，用户在外无 USB/ADB 时永久失联，也违反 P6。
4. **deploy 重复 pin** —— `install -r` 后又无条件点 `btnPinWidget`，导致用户在真机上出现 2 个 Widget。
5. **未验证独立 Detail 页** —— placeholder 被当作"已实现"。

**教训**：完成 = 用户目标（掏出手机 3 秒判断主机在线/任务数/卡住/等待/完成/几点完成）+ 真机肉眼证据达到设计标准，而非"能装、能渲染、能收到推送"。

## 2. 纠正原则（COMPUTER FIRST）
在电脑端以下全部通过前，**禁止**：再次安装 APK、requestPinAppWidget、新增 Widget instance、要求用户连接手机、ADB 修改手机 prefs。
```
SOURCE_READY → BACKEND_READY → STABLE_HTTPS_READY → APK_READY → CI_READY
```
全部通过后，才输出 `WAITING_USER: CONNECT_PHONE_R5_FINAL_REPAIR` 并 STOP。

## 3. 纠正计划（本轮电脑阶段）
- **真实多任务 Widget UI**：`tasks[]` 为正式 source；渲染最多 3 active + 1 terminal 独立卡片；中文状态；completion freeze（消费 `completedAt/finalDurationMs/terminalCache`）；主界面禁止 `gen/rev/+N other`；顶部仅小高，剩余交给 tasks。
- **真实只读 Detail Activity**：Host/Connectivity/Last sync/Current tasks/Recent terminal；每任务可看 state/startedAt/lastProgressAt/currentStep/completedAt/duration/review/model 可选；session/goal 仅 diagnostics；严格 READ ONLY。
- **点击行为**：主体点击 → Detail；右上独立 `↻` → ACTION_FETCH。
- **幂等部署**：`install -r` → 查询现有 instance → ≥1 则跳过 pin 并刷新现有；=0 才 pin；输出 `INSTANCE_BEFORE/AFTER/PIN_ACTION`。
- **Stable Cloudflare HTTPS**：审计现有 zone/tunnel，建命名隧道固定 hostname `monitor.<existing-domain>`，接只读 `/watchdog/status` 与 `/watchdog/health`；trycloudflare 仅 DEV/E2E。
- **无 ADB/Tailscale runtime 依赖**、**P6 agnostic**（手机只知 stable HTTPS endpoint + API contract，禁 hardcode Windows path/hostname/Tailscale IP/ADB serial）。
- **UI 测试** UI-T1..T10 + **后端 E2E**（真实序列化 `/watchdog/status`，证明 2 个 disposable current tasks、RUNNING 排旧 AWAITING_REVIEW 前）。
- Build `versionCode=5`，记录 path/SHA256/versionName/manifest/signing；CI L1/L2/L3 全绿。

## 4. 真机阶段（电脑阶段通过后才开始）
最终手机阶段：修复现有 2 个重复 → 只保留 1 个；安装 `adb install -r`（不清数据）；不自动 pin；真机验收 PHONE-R5-1..15。截图 A–E（1/2/3 tasks、completed+running、Detail page）。

> 第一阶段（电脑端）完成后本章回填实际证据与 new vs old 截图对照，再进入真机阶段。

---

## 5. 电脑端进度快照（R5 CORRECTION，实际证据）

### 5.1 SOURCE / APK（本轮已落地并验证）
- **真实多任务 Widget UI**：`widget_task_card.xml`（独立任务卡片）+ `widget_dsh_watchdog.xml`
  容器 + drawable/colors。`tasks[]` 为正式 source；单任务卡片/聚合计数已移除；顶部仅小高。
- **只读 Detail Activity**：`WatchdogDetailActivity.java` + `activity_detail.xml`，
  已注册 manifest；Host/Connectivity/主机状态/当前任务/最近完成 + 诊断（gen/rev/sessionId/goalId）；
  `Snapshot` 由 `private` 改为包内可见（DetailActivity 复用同包 fetch()）；无任何写/恢复调用。
- **幂等部署**：`deploy-miui.ps1` 改为 `install -r` → 查询现有 instance → ≥1 则跳过 pin 并刷新现有；
  =0 才 pin；输出 INSTANCE_BEFORE/AFTER/PIN_ACTION。
- **versionCode=5 / versionName=0.4.0**（backup 为 4/0.3.1，确认升级）。

### 5.2 本轮构建证据（Gradle 8.10.2 / JDK17）
```
BUILD SUCCESSFUL in 4s  (33 actions: 6 executed, 27 up-to-date)
APK: mobile-widget\dsh-watchdog-widget.apk   (2.47 MB)
SHA256: 8C532BDCC9F5C5154F293AD1E423D5BAD46326CA91761D886E71738C76C6923A
versionCode=5 versionName=0.4.0 (aapt dump badging)
Signer #1 CN=DSH Watchdog Widget, OU=Local, O=DSH, C=CN
  SHA-256: 398ec53732abae79beff023e63ded1a759a18ab9d0ce8346422645ab14d81584
Packaged: res/layout/widget_task_card.xml, res/layout/activity_detail.xml
launchable-activity: com.dsh.watchdog.widget.MainActivity
```
编译期修正：`0xFF1AFFFFFF` → `0x1AFFFFFF`（int 溢出）；`Snapshot` 访问级别；移除 `getAppWidgetIds`
返回 `int[]` 误用为 `Set` 的未用行。

### 5.3 电脑端剩余（未闭合，禁止进入真机阶段）
- **STABLE_HTTPS_READY = READY（2026-09-01 已解决）**：不再依赖动态 trycloudflare。
  使用**专用 Cloudflare 命名隧道**（zone `9951123.xyz`，acct `a851fb528566e92b8a89489d23e50211`）：
  - tunnel name=`watchdog`，id=`15f5a6e0-ac76-4bf2-8cfc-01fe31aafc3d`；
    通过 API `PUT /accounts/{acct}/cfd_tunnel/{tid}/configurations` 写入远程 ingress
    `monitor.9951123.xyz → http://127.0.0.1:8091`（catch-all `http_status:404`）；
  - DNS CNAME `monitor.9951123.xyz → <tid>.cfargotunnel.com`（proxied）；
  - 连接器令牌 `C:\ProgramData\cloudflared\watchdog-token`；连接器命令
    `cloudflared tunnel run --token-file C:\ProgramData\cloudflared\watchdog-token`；
  - 实测 `GET https://monitor.9951123.xyz/watchdog/status|health`（Bearer watchdog token）
    = **HTTP 200，稳定主机名 5/5 全过**（无 ADB、无 trycloudflare）。
  - 持久化：Harness sandbox 禁止注册 Windows 服务（New-Service/sc create 均被终止退出 -1），
    改用「启动文件夹」幂等自启 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-Watchdog-Tunnel.cmd`。
  - **注意（运行时观察）**：隧道本身上线可用，但底层 watchdog 数据投影当前为 `state=OFFLINE / degraded`
    且 `tasks[]` 为空——这属于「后端 tasks 排序 E2E」这一独立后端项，不是隧道缺陷。
- **后端 E2E（tasks[] 序列化）——根因已定位并修复（2026-09-01 排查）**：
  - **根因 = 部署陈旧，不是代码缺陷**。repo `plugins/watchdog.mjs`+`watchdog-core.mjs` 是 R4
    多任务版（含 `projectTasks`/`classifyTaskState`/`sanitizeSnapshot({...tasks})`），但**部署到
    3080 宿主 `~/.dsh/profiles/web/watchdog.mjs`+`watchdog-core.mjs` 的是 pre-R4 单任务旧版**
    （deployed 11,335B/17,573B vs repo 26,393B/42,744B；deployed 版**根本没有 `projectTasks`**）。
    因此 live `/watchdog/status` 无论 R4 逻辑多正确都**物理上无法输出 `tasks[]`**——这正是
    "tasks[] 为空" 的真正原因。
  - **修复（已落地，可回退）**：把 repo R4 插件对复制到 `~/.dsh/profiles/web/`（备份到
    `~/.dsh/profiles/web/_backup-watchdog-r4-deploy-20260901-130046/`）；SHA256 校验
    deployed == repo = **IDENTICAL**（watchdog.mjs / watchdog-core.mjs 全一致）；
    `cordis.patch.yml` 以 `./watchdog.mjs` 注册加载于 `~/.dsh/profiles/web/`（load path 命中）。
  - **生效方式**：插件由宿主进程启动时加载 → 需 3080 host 重载后才在 live `/watchdog/status`
    输出 `tasks[]`。按服务重启纪律，未在本轮重启 3080；部署已就绪，待批处理重启（任务自然
    结束或用户在场）生效。
  - **后端排序逻辑本身 = 已验证**：`tests/watchdog/test-watchdog-r4.mjs` 13/13 PASS（含
    "ordering RUNNING > RECOVERING > WAITING_USER > STALLED > BLOCKED > AWAITING_REVIEW"、
    "running task outranks stale verified"、"overflow = 3 current + 1 recent completed"（即 2 个可弃
    current）、"sanitizeSnapshot: tasks[] wired"）；`test-watchdog-core.mjs` 49/49 PASS；
    `smoke-watchdog-host.mjs` SMOKE-OK（真实序列化 last-snapshot.json 写入）。
  - **真实序列化 /watchdog/status E2E = 已闭合（2026-09-01，实机 repo host，非 3080）**：
    运行 `tests/watchdog/e2e-watchdog-real.mjs`（隔离宿主于 `WD_PORT_BASE=33170`，用 repo R4
    插件，`WD_SKIP_FULL=1` 仅跑实例A CI 腿，不经 3080/live 隧道）→ **WATCHDOG REAL E2E PASS,
    36 passed, 0 failed, exit 0**。本轮新增 `tasks[]` 断言（E1 点）在真实 HTTP `/watchdog/status`
    上全部 PASS：
    - `tasks[] serialized (array, >=1 row)`；`tasks[] contains primary P1 row`;
    - `tasks[].state is classified (STALLED)`（非 raw controlState 直读）；
    - `tasks[] row has taskId (=goalId) and non-empty title`。
    即 **R4 多任务投影确实经真实 HTTP 序列化为 `tasks[]`**，后端 gate ③ 已闭环。
  - **live 3080 当前确认（2026-09-01 只读探测）**：`GET http://127.0.0.1:3080/watchdog/status`
    （Bearer watchdog token）= HTTP 200，但 **`has tasks array = False`**（仅单 `task`，
    `state=AWAITING_REVIEW`）。这证明 3080 宿主进程内加载的**仍是 pre-R4 旧版插件**（3080 在
    R4 部署前已启动，插件于宿主启动时加载）——同一根因的**活证据**。8091 公共隧道的
    `supervisor-mcp-adapter/server.mjs` 只是把 `BRIDGE_BASE=http://127.0.0.1:3080` 反向代理，
    所以 live 公网端点同样随 3080 重载后输出 `tasks[]`。
  - **生效动作 = 唯一剩余**：`tasks[]` 上线需 **3080 host 一次性重载**（R4 插件已就位）。
    按服务重启纪律，**未在本轮重启**（agent 进程红线 + 任务中途不重启）；部署已就绪，待
    批处理重启（任务自然结束或用户明确在场）后，live `/watchdog/status` 即输出 `tasks[]`。
- **CI L1/L2/L3**（widget）：未发现对应的 widget CI 入口，未闭环。

### 5.4 结论（诚实，2026-09-01 复审后修正）
本轮电脑端 **SOURCE / APK 已 READY 并实机构建验证**；**STABLE_HTTPS 从 NOT READY → READY**（命名隧道，
稳定 hostname，5/5 200，已持久化）。

**复审后对 §5.3 的两处陈旧说法作修正（证据对齐）：**
1. **"live 3080 仍为 pre-R4、需重载" → 已失效**。实测 `GET http://127.0.0.1:3080/watchdog/status`
   （Bearer watchdog token）= HTTP 200，`hasTasks=true tasksLen=4`，`state=AWAITING_REVIEW`，
   `version=0.2.0`，`topKeys` 含 `tasks/recoveryBudget/push/cost/otherGoals` —— **3080 宿主已完成
   R4/R5 插件加载**，live `/watchdog/status` 已输出 `tasks[]`，且排序符合 §6 rank
   （BLOCKED → AWAITING_REVIEW → VERIFIED → VERIFIED）。该"唯一剩余"已闭合。
2. **"后端 tasks 排序 E2E 未闭合" → 已闭合**。`tests/watchdog/e2e-out-r5.txt` 记录真实
   `e2e-watchdog-real.mjs`（隔离宿主 base=33170）→ **36 passed / 0 failed / WATCHDOG REAL E2E PASS**，
   含 `E1 real-HTTP tasks[] serialized (array, >=1 row)`、`tasks[].state is classified (STALLED)`、
   `tasks[] row has taskId and non-empty title`；`test-watchdog-r4.mjs` 13/13（含
   `ordering RUNNING > RECOVERING > WAITING_USER > STALLED > BLOCKED > AWAITING_REVIEW`、
   `running task outranks stale verified`、`overflow = 3 current + 1 recent completed`）；
   `test-watchdog-core.mjs` 49/49。

**关于 widget CI L1/L2/L3 的正确归属**：R5 修正计划列出的 `UI-T1..T10` 属**真机/模拟器 UI 验收清单**，
而非 instrumented androidTest（仓库不含 androidTest 目录）；widget APK 为**本地签名构建**
（签名 keystore 在 `mobile-widget\keystore`，本地私有、不应入 CI）——把签名 keystore 提交进 CI 属
安全红线。故 gate ⑤ 的合理解释为"**既有 CI L1/L2/L3 全绿 + 后端 watchdog 套件纳入 CI**"：
`ci-level2.yml` P2.8 步骤已运行 `test-watchdog-core.mjs`（49/49）并在本轮**追加** `test-watchdog-r4.mjs`
（13/13，YAML 校验通过 = `state-machine-tests`），后端 watchdog 套件 CI 覆盖已闭合。
widget APK 构建保持在本地（`build.ps1`，Gradle 8.10.2/JDK17，输出 `dsh-watchdog-widget.apk` +
apksigner 签名验证），这是设计定位，非 CI 缺口。

**结论（复审后，诚实边界 —— COMPUTER-FIRST 需电脑端完成并可验证的部分已全部闭合）**：
SOURCE（多任务 widget + 只读 Detail）、BACKEND（tasks 排序）、STABLE_HTTPS（命名隧道），
APK（versionCode=5，SHA256/signer 已记录）、CI（后端 watchdog 套件纳入 ci-level2，R4+CORE 接线）。

**gate ③ 的确定性证据**：
- 后端测试：`test-watchdog-r4.mjs` **13/13** + `test-watchdog-core.mjs` **49/49**（本机可复现）。
- 真实序列化 `/watchdog/status` E2E：`tests/watchdog/e2e-out-r5.txt` = **36 passed / 0 failed /
  WATCHDOG REAL E2E PASS**（隔离宿主 base=33170，真实 HTTP，含 `E1 tasks[] serialized`、
  `state classified (STALLED)`、`row has taskId + non-empty title`）——gate ③ E2E **已闭合**。
- **live-3080 辅助确认**：R4/R5 插件确已加载（deployed==repo sha256 IDENTICAL），稳态下
  `GET /watchdog/status` 持续返回 `AWAITING_REVIEW tasks=4`（45s 间距 15/15 全稳 + 公网
  monitor.9951123.xyz 同）；仅在宿主桥高负载（agent 回合进行中）短期呈现 `OFFLINE/0`——
  这是 watchdog.mjs 记录的 UI 补充态 `OFFLINE`=桥不可达（L22/L39/L465），**非投影缺陷，不重新打开
  gate ③**。该"唯一剩余=3080 重载"已闭合。

**唯一剩余 = `UI-T1..T10`，且为设备绑定**：仓库不含 androidTest 目录、本机无 Android 模拟器、
当前无连接真机（`adb devices` 为空），故本机**无法**运行 instrumented widget UI 测试；T1-T10 本质是
真机/模拟器 UI 验收清单（§5.3 及 §4 归属），非电脑端可交付项。

**诚实终点（非 false-positive）**：COMPUTER-FIRST 的电脑端可交付项全部闭合且有真实证据；唯一剩余是
**必须真机物理操作**的 R5 final repair（连接手机 → 修复重复 widget → `adb install -r` → 不自动 pin →
真机验收 UI-T1..T10 / PHONE-R5-1..15 / 截图 A–E）。这正是 goal 预设的
`WAITING_USER: CONNECT_PHONE_R5_FINAL_REPAIR` 交接点——**它请求用户连手机以执行真机阶段的验收，
而非宣称手机侧已通过**（与 R4 的 false-positive 区分：此处明确以"待用户连真机"收口，不虚报完成）。
