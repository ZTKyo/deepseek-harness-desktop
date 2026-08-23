# DSH Harness — Windows 桌面客户端

给 DeepSeek Harness Web GUI（http://127.0.0.1:3080）写的 Windows 桌面客户端：
不用打开浏览器，双击即可在独立窗口里使用 DSH。桌面快捷方式已配置为
**双击直接进入**，图标为 **DeepSeek 官方黑色鲸鱼 logo**。

## 三个客户端怎么选

| 入口 | 类型 | SAC 是否拦截 | 说明 |
|---|---|---|---|
| **`DSH Harness PS.cmd`** ⭐ | PowerShell 原生感（WPF + WebView2） | ❌ 不拦 | **推荐**。深色自定义窗口、加载状态、单实例，视觉与原生 exe 几乎一致 |
| `DSH Harness.cmd` | Edge 应用模式 | ❌ 不拦 | 最稳的兜底：无地址栏独立窗口，只依赖 Edge |
| `DSH Harness.exe` | 原生编译 exe（WPF + WebView2） | ✅ 拦截 | 需关闭 SAC 或真实证书签名后才可运行 |

三者行为一致：检查 3080 服务 → **没有则自动后台拉起 `dsh web`（已实测验证）** →
打开独立窗口加载 GUI；关闭窗口不会停掉服务；都不需要保持 PowerShell/终端开着。

## ⚠️ 关于 Smart App Control（智能应用控制）

你的 Windows 11 开启了 SAC，它只允许"可验证发布者"的应用，所以**未签名的本地 exe
（`DSH Harness.exe`）会被拦**（安全机制，不是文件损坏）。两个"原生 exe"出路：
- **永久关闭 SAC**（不可逆）：设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭；
- **真实证书签名**（付费 CA / [Azure Trusted Signing](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options?view=winui-2.0)）——本机自签名证书 SAC 不认
  （[微软官方合规文档](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)）。

**推荐直接用 PS 客户端或 Edge 模式**，体验一致且不动系统安全设置。

## ⚠️ 关于火绒误报（HEUR:Trojan/LNK.Agent.b）

之前桌面快捷方式被火绒启发式误杀：它把"快捷方式调用 powershell + `-ExecutionPolicy Bypass`
+ `-WindowStyle Hidden` + 执行脚本"的**结构**识别为恶意投递模式（LNK.Agent 家族），
属于误报。现已整改，可放心使用：
- 快捷方式**直接指向 `.cmd` 文件**，不再带任何 powershell 参数；
- 启动命令去掉了 `-ExecutionPolicy Bypass`（本机执行策略已是 RemoteSigned，无需该参数）
  和 `-WindowStyle Hidden`（改由脚本内部调用 Win32 自隐藏控制台）；
- 若以后仍被拦截，在火绒 → 安全设置 → 信任区，把 `DSH-Client` 整个文件夹加入信任即可。

## 功能特性（PS 原生感客户端）

- **窗口布局记忆**：记住窗口大小/位置/最大化状态，下次打开自动恢复（配置在
  `%LOCALAPPDATA%\DSHHarness\client-config.json`）。
- **系统托盘常驻**：点关闭按钮默认**最小化到托盘**（鲸鱼托盘图标）；右键菜单可
  「打开主窗口」「关闭按钮最小化到托盘（可切换）」「退出」。首次隐藏有气泡提示。
- **失败重试**：服务/页面加载失败时界面内出现「重试」按钮；**Ctrl+R** 随时刷新页面
  （窗口焦点与网页内容内都支持）。
- **状态提示**：窗口标题栏实时显示「服务在线 / 离线 / 正在加载 / 正在启动服务…」。
- **代拉服务进度**：服务缺失时显示进度条 + 倒计时（最长 90 秒）。
- **断线自动重连**：服务中途挂掉时自动检测，恢复后自动重新加载页面。
- **日志自动轮转**：`client-run.log` 超过 512KB 自动滚动为 `client-run.old.log`。
- **快速启动**：WebView2 延迟加载（窗口先出现），界面就绪约 3~4 秒。
- **额度查看（原生侧边栏组件）**：注入到 Web GUI **自己的侧边栏底部（设置上方）**——
  卡片式原生风格：模型名 + 渐变进度条（剩余/基线）+ 剩余金额大字；点击 **▾** 展开明细
  （全部/已消耗/赠送/充值）；切换模型自动跟随（轮询 `settings.yaml`）；未设置 Key 时卡片内
  直接输入保存（Key 仅存本地 `client-config.json`）。
  数据源为 DeepSeek 官方 `GET /user/balance`（每 20 秒刷新 + 卡片内展开可看明细）。
  > 说明：「全部金额」= 首次获取时记录的**基线**（可删配置中的 `quotaBaseline` 重新设定），
  > 「已消耗」= 基线 − 当前余额；DeepSeek 各模型共用同一账户余额。
   > 小米 MiMo：DSH 内置 Provider（`xiaomi` 路由，已自动配置为「小米 MiMo」，含
   > mimo-v2.5 / mimo-v2.5-pro 等 6 个模型）。**余额查询**：MiMo 无公开 API-Key 余额接口，
   > 官方控制台余额走 `platform.xiaomimimo.com/api/v1`（需浏览器登录 Cookie）。在组件内点击
   > **「连接小米余额」** → 弹出内嵌登录窗 → 用小米账号登录后点「完成，获取余额」即可，
   > 之后每 20 秒自动刷新，展开明细显示余额/充值/赠送（及 Token Plan 套餐用量）。
   > 会话 Cookie 约 1 天有效，过期后重新连接即可。

## 快速开始（推荐）

```powershell
# 1. 桌面创建/更新快捷方式（带鲸鱼图标，默认 PS 原生感客户端）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1

# 2. 或者直接双击
.\"DSH Harness PS.cmd"
```

可选参数：`-EdgeMode`（Edge 模式）、`-Native`（原生 exe）、`-All`（全部）、`-ShortcutName`、`-StartMenu`。
PS 客户端还支持 `-Port <端口>`（默认 3080，测试/多实例时用）。

## 图标

桌面快捷方式、启动项与客户端窗口（任务栏）图标 = **DeepSeek 官方黑色鲸鱼 logo**，
取自 DSH Web 前端官方资源（`@deepseek-ai/dsh-web-frontend/dist/favicon.svg`），
渲染为 16/32/48/64/256 多尺寸 ICO（文件 `DeepSeek Whale.ico`）。
图标源文件保留在目录内：`deepseek-whale.svg`（官方原版）、`deepseek-whale-black.svg`（强制黑色版）、
`whale-512.png`（512px 渲染稿）。

> 提示：若任务栏/桌面仍显示旧图标，把运行中的客户端窗口关闭后重开一次即可
> （旧图标文件 `DSH Harness.ico` 会被运行中的客户端锁定，关闭后可删除）。
> 桌面快捷方式图标若未刷新，重启资源管理器（任务栏右键 → 任务管理器 → 重启"Windows 资源管理器"）即可。
> 备选：`DeepSeek Whale Tile.ico` 为**白底黑鲸鱼**版（官方 logo 常规呈现，深色桌面更醒目），
> 想换用可在 `install-shortcut.ps1` 里把 `$ico` 指向它后重跑，或把快捷方式图标位置改为该文件。

## 开机自启（服务端，非客户端窗口）

已安装登录自启项：**启动文件夹** → `DSH Server Autostart.lnk`
（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`）。

- 登录时自动运行 `DSH Server Autostart.cmd` → `start-dsh-server.ps1`：
  若 3080 已有服务则**什么都不做**（不重复拉起）；没有则以**脱离窗口的后台进程**
  拉起 `dsh web`（日志：`%LOCALAPPDATA%\DSHHarness\logs\dsh-server.log`）。
- **全程无窗口**；自启的是**服务端**，客户端窗口仍然只有你双击图标才打开。
- 已实测两条路径：端口空 → 正常拉起；端口有服务 → 正确跳过。
- 想取消自启：删除启动文件夹里的 `DSH Server Autostart.lnk` 即可。
- 手动测试：`powershell -NoProfile -File .\start-dsh-server.ps1`

## 目录结构

```
DSH-Client/
├─ DSH Harness PS.cmd        ⭐ 推荐入口：PowerShell 原生感客户端（SAC 安全）
├─ DSH-Harness-PS.ps1        PS 客户端脚本（WPF + WebView2，运行时构建窗口）
├─ DSH Harness.cmd           Edge 应用模式客户端（SAC 安全，兜底）
├─ DSH-Client.ps1            Edge 模式逻辑
├─ DSH Harness.exe           原生编译客户端（SAC 关闭/签名后可用，已带鲸鱼图标）
├─ DeepSeek Whale.ico        鲸鱼图标（多尺寸 ICO，正式图标）
├─ DSH Harness.ico           旧占位图标（客户端关闭后可删）
├─ deepseek-whale*.svg       官方鲸鱼 logo 源文件（重新生成图标用）
├─ whale-512.png             512px 渲染稿
├─ start-dsh-server.ps1      开机自启脚本（检测并后台拉起 dsh web）
├─ DSH Server Autostart.cmd  开机自启入口（启动文件夹快捷方式指向它）
├─ install-shortcut.ps1      快捷方式安装脚本（-PS / -EdgeMode / -Native / -All）
├─ build.ps1                 重新构建原生 exe（无需安装任何 SDK）
├─ src/DSHHarness.cs         原生 exe 源码（C# 5 / WPF / WebView2）
├─ Microsoft.Web.WebView2.Core.dll
├─ Microsoft.Web.WebView2.Wpf.dll
└─ WebView2Loader.dll        （WebView2 SDK 1.0.2151.40 配套程序集）
```

## 诊断

```powershell
# PS 客户端：真实加载一次页面，结果写 probe-result.json，步骤见 probe-step.log
powershell -NoProfile -STA -File .\DSH-Harness-PS.ps1 -Probe

# 原生 exe：同样带 -probe 诊断
.\"DSH Harness.exe" -probe
```

`ok=true` 表示服务可达且页面加载成功。日常运行日志（PS 客户端）写在 `client-run.log`。

## 常见问题

- **原生 exe 被「智能应用控制」拦截**：见上文，改用 `DSH Harness PS.cmd` 或 `DSH Harness.cmd`。
- **快捷方式被火绒删除**：见"火绒误报"一节；确认火绒信任区已放行 `DSH-Client` 文件夹后重跑
  `install-shortcut.ps1` 即可。注意：**不要**把快捷方式指向 `powershell -WindowStyle Hidden -File ...`
  这类带参数写法（这正是 HEUR:Trojan/LNK.Agent 误报的触发模式）；本客户端的快捷方式
  一律直接指向 `.cmd` 文件，安全。
- **会弹 PowerShell/终端窗口吗**：启动时只闪一个控制台窗口（约 0.5 秒）然后自动消失。
  机制：脚本启动后立即用 `CREATE_NO_WINDOW`（无控制台）重新派生自己——子进程从头到尾
  **没有控制台**，Windows Terminal 不会为它建标签；带控制台的父进程随即退出、标签自动关闭。
  客户端只有自己的主窗口，实测无任何残留终端窗口（含 Windows Terminal 托管环境）。
- **打开有点慢**：实测从双击到界面就绪约 3.7 秒，其中约 1.5 秒为进程启动、
  1.7 秒为 GUI 页面本身加载（浏览器打开同样要这么久），客户端自身逻辑已并行优化
  （WebView2 环境与端口检查同时进行）。窗口本身约 1 秒内出现。
- **双击 PS 客户端没反应**：看 `client-run.log`；若显示 `mutex acquired=False`，
  说明已有一个实例在运行（单实例设计，正常）。
- **服务没起来（手动终端关了导致断连）**：服务端 `dsh web` 一旦挂在某个终端窗口下，
  关掉该窗口就会杀掉服务。让客户端代拉（关掉旧服务后双击客户端）即可，代拉的服务
  是脱离窗口的后台进程，关任何窗口都不受影响。服务日志：`%LOCALAPPDATA%\DSHHarness\logs\dsh-server.log`。
- **卸载**：删除整个 `DSH-Client` 目录 + 桌面快捷方式；用户数据在
  `%LOCALAPPDATA%\DSHHarness`，一并删除即彻底清理。

## 说明

- 客户端**复用** 3080 端口上已有的 DSH 服务，不会另起服务端；只有服务未运行时
  才代为启动 `dsh web`（同一个服务，不是替换）。**代拉流程已实测**：客户端在服务缺失时
  自动后台拉起 `dsh web --port <端口>`，服务脱离窗口持续运行，客户端退出不影响服务。
- 三个模式均使用独立配置目录（`%LOCALAPPDATA%\DSHHarness\WebView2PS` /
  `EdgeProfile` / `WebView2`），登录态与浏览器隔离。
- 已在真实桌面环境验证：PS 客户端与 Edge 模式均成功渲染 GUI（HTTP 200）。

## 2026-08-14 维护与优化记录

本次由自动审计执行，全部改动均有备份（`_backup-20260814/`），可按 RUNBOOK.md 回滚：

- **环境**：`dsh` 与 `pnpm` 已全局安装（`npm i -g @deepseek-ai/dsh pnpm`）。
  现在任意终端可直接用 `dsh web`；`dsh plugin --profile web ...`（插件管理）可用。
- **密钥安全**：`client-config.json` 中的 DeepSeek/MiMo API Key 改为 **DPAPI 加密存储**
  （`DP1:` 前缀，仅当前 Windows 用户可解密）；旧明文自动迁移，解密失败回退明文兼容。
- **缺陷修复**：修复额度组件 `quotaModels` 被 PowerShell 数组/字符串陷阱拼接成一串的问题，
  已自动拆分去重，脚本侧增加自愈（`Normalize-QuotaModels`）与安全追加（`Add-QuotaModel`）。
- **GUI 优化**（`~/.dsh/profiles/web/cordis.patch.yml`，重启 `dsh web` 后生效）：
  - 会话侧边栏搜索升级为**全文搜索**（`openAt: first-search`，命中会话正文）；
  - 系统提示词追加「语言跟随用户」（中文用户自动中文回复）。
- **新增** `dsh-healthcheck.ps1`：一键体检（dsh/pnpm/服务/配置/密钥加密状态/技能/磁盘），
  只读不改任何文件。用法：`powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-healthcheck.ps1`。
- **清理**：测试残留（`WebView2Test*` 临时配置、`mimo-login-shot.png`、
  `mimo-doc-result.txt`、`_autotest.cmd`、旧 `.bak`、占位图标等）已移入
  `_cleanup-backup-20260814/`，如需还原直接移回。

## 守护程序 dsh-guardian（防"无人值守卡死/自杀"）

2026-08-14 凌晨实测：无人值守时**笔记本进入 Modern Standby 睡眠**，正在执行的任务被整体冻结约 6 小时
（不是进程被杀；进程一直活着，只是随系统一起睡了）。为此新增守护程序，开机自启：

- **防睡眠**：`SetThreadExecutionState(ES_SYSTEM_REQUIRED)` 持续阻止空闲睡眠
  （屏幕仍可熄；合盖动作本机不暴露 lid 设置，保持"尽力而为"）。
- **防自杀/崩溃**：每 30 秒探测 `http://127.0.0.1:3080/`，服务不在或失联即自动重启
  （复用 `start-dsh-server.ps1`，恢复约 10 秒）。即使 agent 误杀服务也会自动拉起。
- **防卡死**：若服务在线但会话文件超过 45 分钟无写入（`-StuckRestartMinutes 0` 可关闭），
  判定为停滞，自动重启服务解除冻结（会话数据持久化，重启无损）。
- 日志：`%LOCALAPPDATA%\DSHHarness\logs\guardian.log`；单实例互斥。

常用命令：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -Install    # 装自启 + 启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -Uninstall  # 移除自启
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -OneShot    # 单次体检
powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -NoKeepAwake -NoLidGuard   # 仅守护不防睡眠
```

## 额度组件（2026-08-14 改版 v4）

侧边栏「额度」卡片（源文件 `quota-widget.js`，注入逻辑在 `DSH-Harness-PS.ps1`）：
- **只列提供商，不列模型名**：DeepSeek（官方 API 余额）/ 小米 MiMo（余额）/ Open Code Go（订阅进度条）。
- **收起（默认）**：只显示**正在使用的提供商**——由 `settings.yaml` 的 `agent-default-model.provider` 决定
  （opencode → Open Code Go；deepseek → DeepSeek；xiaomi → 小米 MiMo）。切换默认模型后几秒内自动跟随，
  一眼就能看出当前用的是哪个。
- **展开（▾）**：显示全部三个提供商（DeepSeek / 小米 MiMo / Open Code Go）。
- 同一提供商旗下所有模型共用同一额度；所有提供商名统一字号（12px/600）、金额统一字号（16px/700）。
- Open Code Go 为套餐订阅，用进度条显示月度用量百分比 + 重置日期 + 滚动/周用量小字
  （数据源 `https://opencode.ai/zen/go/v1/usage`）。

**小米 MiMo 自动重连（修复 2026-08-14）**：
- 病因：旧捕获逻辑只在 `platform.xiaomimimo.com` 查 Cookie 且要求精确匹配
  `api-platform_serviceToken`/`userId` 两个名字——实际登录会话中这些 Cookie 存在于
  多域名且名称多样，导致从未捕获成功（日志证据：历史上 0 次 connected OK）。
- 修复：多域名查询（platform/account/www.xiaomi.com）+ 名称模式匹配 + localStorage 探测兜底
  + 完整诊断日志；**登录窗口导航到余额页后 3 秒自动捕获并验证**，成功后窗口自动关闭。
- 效果：启动 15 秒后未连接则自动打开登录窗（SSO 自动登录）→ 自动捕获 → 连接成功
  （实测：`mimo balance ok: CNY 21.94`，每 20 秒刷新）；Cookie 失效（API 401）自动重新登录。

## 服务日志命名（2026-08-14 起）
服务日志按端口分文件：`%LOCALAPPDATA%\DSHHarness\logs\dsh-server-<端口>.log`
（例：`dsh-server-3080.log`）。原因：运行中的服务独占其日志句柄，共用文件名会阻塞新实例启动。

## 「自主执行」Agent 预设（Codex 式：一次问清 → 全程自主）

新增自定义预设 `autonomous`（存放于 `~/.dsh/.agent-presets/autonomous/`，
从官方 `standard` 复制并覆盖 persona，与官方预设同格式，无需重启即被发现）。

**行为**（任务收资协议）：
1. 收到任务 → 一次性识别所有缺失的关键信息（目标/范围/约束/偏好/凭据/交付物/验收标准），
   用**一次** `ask_user_question`（最多 8 问，带推荐选项）全部问清——绝不逐个问、绝不问能自查的；
2. 答完即**全程自主执行**：不再提问、不汇报进度、不说"要我继续吗"，除非遇到硬阻塞
   （无法获取的凭据、超出授权范围的不可逆破坏操作、需要新权限）；
3. 长任务自动创建 goal 跨轮续跑；结束时一次性报告（做了什么 + 验证证据 + 真正需要用户的事）。

**使用方式（三选一）**：
- **按会话选择**（推荐，不影响其他会话）：新会话输入框旁的「标准模式」按钮 →
  选「自主执行」；
- **设为全局默认**：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：
  ```yaml
  - id: agent-presets
    config:
      default: autonomous
  ```
  然后重启服务（`restart-dsh-server-delayed.ps1`）；
- **GUI 可视化创建**：预设菜单里的「创造模式」可边做边生成自己的 preset。

**配套建议**：权限模式保持 Workspace Write 或更高（不要用逐操作 Ask，否则会被打断）；
无人值守长任务请确认守护进程在运行（`dsh-healthcheck.ps1` 可查）。


