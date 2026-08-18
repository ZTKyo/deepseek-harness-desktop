# DSH 第三方桌面客户端壳 —— 原生 Windows / WPF / 轻量嵌入式浏览器 类实现情报报告

> 调研对象：GitHub 上为 DeepSeek Harness（dsh）做的"桌面壳"项目中，属于 **原生 Windows 桌面壳 / WPF / 轻量嵌入式浏览器** 一类的 8 个仓库。
> 委托人背景：Windows 客户端 = **PowerShell 启动脚本 + WPF 窗口 + WebView2 控件**，内嵌 dsh Web UI，附带服务守护（约 45 分钟无写入自动重启服务）/ 开机自启 / 系统托盘 / 单实例 / 日志。本文意在对比学习他人做法，尤其关注"原生壳"怎么做得更精巧。
> 调研方式：web_search 定位 README 原文 + 抓取 GitHub RAW 的 README / 关键源码（XinXie-Condex 的 `windows/*.cs`、xiaowei2025cqu23phy 的 `src/main/*.ts`、ningbainb 的 `docs/desktop.md`）。

---

## ⚠️ 先纠正一个前提（重要）

委托清单标题把它们统称"原生 Windows 壳 / WPF-WinForms"，但**实际上 7 个是 Electron（Chromium），只有 1 个是真正的 C# WPF + WebView2 原生壳**。务必按真实实现看：

| 仓库 | 真实技术栈 |
|---|---|
| SnowCrescenter-tech/dsh-desktop | **Electron 43**（非原生） |
| Meditationacm/dsh-desktop | **Electron（深度 fork，重写前端）** |
| CCMu04/DSHDesktop | **Electron**（加载官方 web） |
| **XinXie-Condex/DeepSeek-Harness-Desktop** | **C# WPF + WebView2（.NET 8）——唯一真正原生 WPF 壳** ★ |
| Links2008/DeepSeek-Harness-Desktop | **Electron** |
| huangj17/deepseek-harness-desktop | **Electron（跨平台）** |
| ningbainb/deepseek-harness-desktop | **Electron（功能最重）** |
| xiaowei2025cqu23phy/dsh-desktop | **Electron + `<webview>` 内嵌标签**（最接近"嵌入式浏览器"概念）★ |

> **关键结论**：委托人的"PowerShell+WPF+WebView2"技术栈在这 8 个里没有完全重合实现。最接近的是 **XinXie-Condex**（WPF+WebView2，但用编译型 .NET 8 / C# + Inno Setup，而非 PowerShell 脚本即时运行）；其次是 **xiaowei2025cqu23phy**（Electron `<webview>` 标签内嵌页面，逻辑上最接近"WebView2 内嵌 Web 页面"）。
> 因此本文分两块看：唯一真正的原生壳（XinXie-Condex）直接对照委托人的写法；其余 7 个 Electron 壳的"精巧设计点"（托盘 / 单实例 / 服务托管 / 自启 / 更新）**与 UI 框架无关、跨技术栈可迁移**，是委托人最该借鉴的部分。

---

## 1. SnowCrescenter-tech/dsh-desktop（Electron，文档最规范）

- **来源**：https://github.com/SnowCrescenter-tech/dsh-desktop （default: main，Electron 43，MIT；README 单文件中英双语，另附交互式文档站 `website/`）
- **技术栈**：Electron 43 壳 + 内置 Node v24.19.0；通过 `@deepseek-ai/dsh@0.1.0-rc.6` 起 Web UI，**写盘 `--profile desktop --port 0`**。
- **如何托管 dsh**：主进程 = 运行时监督器（supervisor），拉 `dsh --profile desktop --port 0`，**等就绪行 `dsh web: http://127.0.0.1:<port>`**，解析到后才把 Web UI 载入内容区；超时则显示带重试按钮的错误视图。API Key 存 `<DSH_HOME>/.env`（只落本机）。首启是一条编排好的流水线（单实例锁 → Key 引导 → 写 profile → 拉起 CLI → 等就绪）。
- **壳功能清单**：
  - **无边框窗口**：36px 自绘标题栏 + **实时状态点**（青=本地服务运行中 / 灰=启动中 / 红=出错）；Windows 11 圆角由 DWM 原生渲染。**用沙箱化 `WebContentsView` 承载官方 Web UI**（非同一 window），壳层标题栏与官方 UI 分层解耦。
  - **系统托盘**：常驻后台；单击唤回主窗口；右键菜单：打开主界面 / 开机自启(复选) / 关于 / 退出。关窗默认最小化到托盘。
  - **原生通知**：标准 Windows 通知样式；系统不支持时自动降级为托盘气泡。
  - **单实例**：获取单实例锁，重复双击唤出已有窗口。
  - **开机自启**：注册表 Run 键（可选，登录后后台静默启动）。
  - **端口 0 自动分配**：每次启动让系统挑空闲端口，天然不撞 3080。
  - **自动更新**：安装版后台静默检查+下载，就绪弹原生通知 + 托盘"重启并更新"，退出时完成安装；便携版无安装器则跳 GitHub Releases。
- **打包分发**：NSIS 安装版 + 便携 zip；**未签名**（README 详列 SmartScreen / 各杀毒加白名单办法）。支持中文路径安装。
- **亮点**：① WebContentsView 分层的无边框壳（自绘标题栏 / 主题与官方 UI 完全解耦）；② 状态点颜色驱动 = 极简高效的服务健康可视化；③ 端口 0 自动分配思路（省端口冲突处理）；④ 单文件双语 README + 完整文档站。数据在 `%USERPROFILE%\.dsh`（`DSH_HOME` 可覆盖）。

---

## 2. Meditationacm/dsh-desktop（Electron 深度 fork，重写前端）

- **来源**：https://github.com/Meditationacm/dsh-desktop （default: master，Electron，MIT，版本 0.1.0-rc.5）
- **技术栈**：**Electron fork，以 Cordis 插件组装**；Main 启动 `my-desktop` profile（dsh-base + dsh-desktop-app）；渲染层 Vite 入口 + `packages/client-*` UI 插件——它是**重写前端**的 deep fork，而非简单套官方壳。
- **如何托管/通信**：**preload IPC RPC，`file://` 加载、不监听 HTTP 端口**——与其它壳最大的不同：不跑 `dsh web` HTTP 服务，直接把 Host 能力做成 IPC Remotes（Client 只经 Host API 通信，不直接 import Host 运行时）。数据目录 `%APPDATA%\@deepseek-ai\dsh-desktop\harness`（`DSH_HOME`，与品牌名解耦：改品牌不会搬走用户数据）。
- **壳功能清单**：依赖 Cordis 插件生态（api proxy、原生目录选择器、plugin-inventory）；打包链末端跑隔离实例门禁（冷启动 / UI 骨架 / 文件日志 / **单实例** / **无 HTTP 监听** / 退出无残留）。
- **打包分发**：Windows x64 NSIS，`apps/release/`。
- **亮点**：① 插件化分层纪律（新行为优先做成 Cordis 插件 + `cordis.patch.yml`，不改 agent-loop 核心）；② `file://`+IPC 不走 HTTP 的低暴露路线（少一个端口面）；③ 备忘移除 `dsh web`/HTTP/ACP/SDK，只留桌面智能体外壳。对委托人参考价值在"分层与可插拔"，而非套壳方式。

---

## 3. CCMu04/DSHDesktop（Electron 加载官方 web，增强插件最完整）

- **来源**：https://github.com/CCMu04/DSHDesktop （default: main，Electron，MIT，Windows 10/11 x64）
- **技术栈**：Electron 壳，**直接加载官方 `dsh web`（随机回环端口），不改官方源码/前端**；默认共用 `~/.dsh`（遵循 `DSH_HOME` 规则）。安装包自带匹配版本 DSH + 官方 Node + pnpm。
- **如何托管 dsh**：启动官方 DSH Web 服务并加载到隔离 Electron 窗口；**先探活随机空闲端口**（仅监听 `127.0.0.1`）；后端运行在安装包内置官方 Node（koffi/node-pty 不能用 Electron-as-Node，故后端独立进程）。
- **壳功能清单**：
  - **原生窗口 + 简洁标题栏**；**会话头部空白区可拖动窗口**；单实例；外部链接安全打开（非本地链接走系统浏览器）。
  - **隐藏控制台**：静默隐藏 PowerShell / Command Prompt / conhost 窗口（不破坏 Windows ACL 沙箱）；派生 opener 子进程时清除 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`，避免污染 VS Code 等被打开应用。
  - **9 个内置 `dsh-desktop-*` 插件**（多插件结构，按内容指纹部署）：`workbench` 工作台（对话页右侧文件/Git 分栏，页签 `[|]` 开关、拖拽调宽、按会话记忆）、`files` 文件台、`git` Git 面板、`ui` 视觉增强（设置抽屉/会话日志导出/统计栏整宽，配置持久化 `~/.dsh/desktop-ui.json`，支持试穿）、`features` 聚合、`updates` 检查更新、`context-menu` 右键菜单、`notify` 完成提醒、`tray` 托盘命令桥。
  - **完成提醒（亮点）**：回复完成 / AI 调起询问且窗口不在前台时，右下角系统通知，点击直达对应聊天窗口（含最小化恢复）。
  - **Git Bash 按需内置**：极简模式依赖 bash，启动时探测应用数据便携版 → 系统 Git → 都没有则弹窗说明并征询后自动下载 PortableGit 到应用数据目录（不修改系统、免管理员、7 天不重复询问、失败 1 天内重试）。
- **打包分发**：electron-builder，NSIS 标准安装包 + 便携版；运行时缓存按包增量更新；`npm run dist` 先同步 npm 最新 DSH 再打包，`dist:offline` 锁定版本离线重建；block map 增量更新；构建走 npmmirror 镜像（墙内可构建）。
- **亮点**：① 内嵌工作台（文件/Git 面板与对话并存）——在官方 UI 之上做增强；② 完成/审批通知点击直达；③ 隐藏控制台而不破沙箱；④ 按需内置 Git Bash 的"探测→征询→自动下载"流程；⑤ 严格回环白名单 + 关闭 Node 集成 + 上下文隔离。

---

## 4. XinXie-Condex/DeepSeek-Harness-Desktop（★ 唯一真正原生 C# WPF + WebView2，最贴近委托人）

- **来源**：https://github.com/XinXie-Condex/DeepSeek-Harness-Desktop （default: main，C#/.NET 8，Windows + macOS 双平台；本结论基于抓取的 `windows/*.cs` 源码）
- **技术栈**：**C# WPF + WebView2（.NET 8，`net8.0-windows`，`Microsoft.Web.WebView2` NuGet）**；macOS 版为 Swift + SwiftUI + WKWebView（同仓库双平台）。内置 `runtime/node.exe` + `runtime/bundle/node_modules/@deepseek-ai/dsh`。**与委托人最接近的（WPF+WebView2）实现，但用编译型 .NET/Inno Setup，不是 PowerShell 脚本即时运行。**
- **如何托管 dsh（`ServerManager.cs`，可直接抄）**：
  - **先探活复用**：HTTP GET `http://127.0.0.1:<port>/`，`IsSuccessStatusCode` 即复用已有服务；否则才自拉——服务和壳解耦，不抢端口、不误杀用户自己开的 dsh。
  - **拉起**：`ProcessStartInfo{CreateNoWindow=true, RedirectStandardOutput/Error=true}`，ArgumentList=`web --port <port>`，工作目录 `runtime/bundle`，注入 `DSH_DESKTOP=1`（`DSH_HOME` 可覆盖）。
  - **就绪等待**：25 秒内每 300ms 轮询 HTTP，进程已退出则中断；超时抛"服务器启动超时"。
  - **日志**：stdout/stderr 逐行追加到 `%LOCALAPPDATA%\DeepSeek\server.log`（带锁，时间戳前缀）。
  - **退出清理**：`p.Kill(entireProcessTree:true)` 杀掉**只由本 App 拉起的**整棵进程树；外部已有服务不动。`Dispose()=>Shutdown()`。
  - **无崩溃自愈 / 无重启守护**（委托人已实现得更完善）。
- **壳功能清单**：标准 WPF 窗口 + 全窗口 WebView2（`<wv2:WebView2 x:Name="WebView"/>`，1200×800，MinWidth 1000）；启动约 5 秒鲸鱼动画 SplashWindow（`Task.Delay(5s)` 保证动画放完再切主窗口）；`target=_blank` 交给系统默认浏览器（`NewWindowRequested` 拦截 + `UseShellExecute`）。**托盘 / 单实例 / 开机自启 / 无边框：WPF 源码里都没有**——这是它与委托人差距最大的地方。
- **打包分发**：Inno Setup 安装器（装 Program Files / 桌面 / 开始菜单 / 卸载程序）+ 绿色 zip；GitHub Actions 自动构建与发布（push `windows/**`→build-windows.yml；`win-v*` 标签→release-windows.yml）；本地 `dotnet publish -c Release`（`EnableWindowsTargeting` 支持跨平台编译）。防篡改 SHA256 校验只在 macOS 实现，Windows 未做。
- **端口/数据**：默认 3080，`DSH_DESKTOP_PORT` 可改；数据 `%USERPROFILE%\.dsh`。
- **亮点**：① 先探活复用已有服务 + 只清理自己拉起的进程；② 启动动画与服务启动并行（尽早拉起，UI 等就绪，`DelegateChain` 保证至少播 5 秒）；③ 超时+退出码就绪判断。**整体比委托人方案简单**——印证委托人的托盘/单实例/守护已远超该壳，可借鉴处主要在"服务进程生命周期管理"的规范性。

---

## 5. Links2008/DeepSeek-Harness-Desktop（Electron 直角无边框，发布链路极自动化）

- **来源**：https://github.com/Links2008/DeepSeek-Harness-Desktop （default: main，Electron，MIT）
- **技术栈**：Electron 壳，fork 上游 `master`（**锁定提交记录在 `upstream-lock.json`**，GitHub Actions 每日检查上游变化、未变则停止，可复现构建）。内置 Node 与 Harness 运行时。
- **如何托管 dsh**：内置独立 Node + Harness；保留用户 `~/.dsh`（不打包本机隐私数据）；完整后端进程清理。
- **壳功能清单**：
  - **无边框系统直角窗口** + **红黄绿三色窗口控件**（克制按压反馈 + 原生最大化/还原）；无启动动画的即时窗口。
  - **单实例启动**。
  - **任务完成通知**：每次任务真正完成时发 Windows 系统通知，点击可返回结果。
  - **弹跳根除**：删除壳层对 `--dsh-sidebar-width` 的逐帧写入（与 better-sidebar 撞名的死代码）；窗口控件位置加 **152–184px 滞回带 + 250ms 消抖**，界面不再左右弹跳。
  - **插件冷启动治理**：禁用启动即崩溃循环的 `dsh-memory` 插件（曾每次阻塞插件加载 0.5–2s）；默认关闭宠物/任务看板/皮肤中心；文件侧栏唯一化。
  - **Mica 云母修复脚本** `apply-mica-fix.ps1`（修复云母模式统计栏缓存命中的显示偏移）。
- **打包分发 / 更新**：`npm run build:installer`（electron-builder + NSIS + 7-Zip + GitHub CLI）；**发布链路全自动验收**（测试 → 安装包完整性 → `latest.yml` SHA-512 → `app-update.yml` → 隔离安装 → AppID → HTTP 200 → 运行时版本 → 端口清理 → 卸载）。**显式声明自动检查/构建/发布只走 GitHub Actions + Node + electron-builder，不调用 GPT/Codex/OpenAI API**。**未签名**（SmartScreen 提示，README 引导核对 SHA-256）。
- **亮点**：① 弹跳根除/滞回带+消抖（精致 UI；Electron 窗口控件与侧栏动画时序冲突）；② 任务完成系统通知点击返回；③ 上游锁定提交号 + 状态文件 + 每日同步的自动化发布链路；④ 冷启动治理。

---

## 6. huangj17/deepseek-harness-desktop（Electron 跨平台，双轨更新 + upstream submodule）

- **来源**：https://github.com/huangj17/deepseek-harness-desktop （default: main，Electron，MIT，macOS AS/Intel + Windows x64 + Linux AppImage/deb，跨平台）
- **技术栈**：Electron 壳；**macOS 打磨标题栏 + 红绿灯，Windows 用标准系统边框**（不追求无边框）。
- **如何托管 dsh**：Main 进程起 `@deepseek-ai/dsh` on `127.0.0.1`（仅回环）→ 在隔离 BrowserWindow 打开官方 Web UI → 退出时停掉本地进程。数据在系统用户数据目录。
- **壳功能清单**：**运行时更新与客户端版本分开管理**——运行时只装官方 `@deepseek-ai/dsh` npm 版本（校验后激活、保留内置 fallback），客户端更新=重装安装包；启动后与每 6 小时分别检查 npm（运行时）与 GitHub releases（客户端）；浏览器窗口用上下文隔离 + 沙箱 + 关 Node 集成 + 外链走系统浏览器。
- **打包分发**：macOS AS/Intel 双 DMG（ad-hoc 签名、未公证）、Windows Setup + 便携 zip、Linux AppImage + deb；tag 构建在原生 macOS/Windows/Linux runner 上冒烟 + 校验 + 自动发布。
- **亮点**：① **双轨更新**（运行时 vs 客户端）设计清晰，且运行时更新=装官方已验证 npm + 内置回退；② `upstream/` 作为 git submodule 独立跟踪官方源码（`git submodule update --init --remote --checkout`），贡献纯净；③ smoke 测试分层（runtime / updater / packaged）。**Windows 标准系统框**的做法值得注意：并非所有壳都追求无边框。

---

## 7. ningbainb/deepseek-harness-desktop（Electron，功能最重：皮肤/QQ/MSH/任务板）

- **来源**：https://github.com/ningbainb/deepseek-harness-desktop （default: main，Electron，BSD-3-Clause，当前 2.3.0）
- **技术栈**：Electron 壳，`--profile desktop --port 0` 起官方 DSH，随机回环端口 + HTTP 就绪探针，Electron 窗口加载该 URL。独立 `desktop` profile（不覆盖既有 DSH 配置），监听仅回环。
- **如何托管 dsh**：随机回环端口 + HTTP 就绪探针；**优雅停止 + 有界自动重启**；**关键文件预检**（启动前检查关键文件完整性，安装不完整时停止重启循环并给出"重新安装"提示）；日志脱敏与轮转；崩溃恢复；窗口状态恢复；严格导航与权限策略；与官方 Web 端共存（端口回退）。
- **壳功能清单（最全）**：
  - **原生标题栏跟随亮/暗主题**（0.1.5 起）；0.1.7 加 32px macOS 风格磨砂玻璃窗口栏；全屏弹窗避开标题栏安全区；窗口几何持久化；单实例；原生菜单。
  - **11 款皮肤**（XP Luna / Minecraft / Blue Fantasy / 鲸吟 / 初音 Miku / 交易终端 / QQ2008 …，先试穿再应用）；皮肤配置试穿即时生效、退出完全还原。
  - **移动端远程**：扫码配对（或复制链接），手机 PWA 查看/新建会话、收发消息、切模型与思考强度；配对令牌一次性限时、可吊销；二维码默认局域网，可开启 cloudflared 公网隧道。
  - **QQ 机器人**：扫码绑定，私聊/群聊接入；AppSecret 用 **Windows 系统凭据保护加密**（`safeStorage`），只经子进程环境注入、不落渲染页/日志/明文 patch。
  - **任务看板**（cron 定时执行）、**Git 图谱**、**SSH 远程运维**（xterm Web 终端 + SFTP + 端口转发 + Agent 直连）、实时令牌统计、鲸鱼娘桌宠（全局 Shell Overlay）。
  - **排队消息可靠续传**（取消后 FIFO 队列自动恢复、不丢不乱序）；模型 API 有界退避重试；思考区吸顶折叠。
- **打包分发 / 更新**：更新检查走 GitHub Release 稳定版，中英双语更新说明、用户确认下载、任务栏进度、二次确认安装；**退出时完整回收 DSH 子进程**（减少安装程序误报文件占用）。**未签名**。**升级预检精细化（2.3.0）**：识别外部 PowerShell/CMD/Node 宿主、`-EncodedCommand`、Windows 8.3 短路径并规范长路径；**只在命令行明确引用旧安装根路径时才归因清理**（严格清理边界，不误杀官方 Web 端/无关进程），句柄访问受限时回退 WMI、力杀后等退出再退避重试。
- **性能**（Windows 11）：warm 就绪约 2.8–3.0s；首次冷 Windows 文件扫描约 25s。
- **亮点**：① 升级清理的"严格归因边界+短路径识别+EncodedCommand 解码"（防误杀的安全清理范本）；② 原生标题栏跟随主题；③ 凭据用系统凭据保护加密并只经子进程 env 注入；④ 覆盖升级不搬走既有 `DSH_HOME`/profile/社区 bundle/皮肤/桌宠/加密凭据。

---

## 8. xiaowei2025cqu23phy/dsh-desktop（★ 最接近"嵌入式浏览器"，服务托管最完整 + AI 屏保）

- **来源**：https://github.com/xiaowei2025cqu23phy/dsh-desktop （default: master，Electron + TypeScript，自定义许可证：禁商用/须开源）
- **技术栈**：**Electron + TypeScript，用 `<webview>` 标签内嵌 harness Web UI**（渲染层经典脚本无打包器：`index.html` 控制条 + `<webview>`）——Electron 里最接近委托人"WebView2 内嵌 Web 页面"的范式。**同时不依赖官方 `dsh web` 套壳，而是自实现 HTTP RPC 协议**（`POST /api/<method>` 一元 + `GET /api/events.mux` SSE 事件流）。
- **如何托管 dsh（`HarnessManager`，service 托管最完整，可直接借鉴）**：
  - **三模式**：`auto`（先探测已运行实例接入，没有则托管启动）/ `external`（只连外部地址）/ `managed`（始终托管，可自定义命令 `npx @deepseek-ai/dsh web --port {port}`）。
  - **分级探活**：`portProbe` 区分"端口是 dsh"还是"被其它程序占用"（抓根页面找 `__DSH_BOOT__` / deepseek / dsh 标记），给出精确错误而非笼统失败。就绪轮询 90s 超时，每 800ms `probe`。
  - **崩溃自愈**：进程退出且非用户主动 → 指数退避重启（1s→2s→…上限 30s）。
  - **Windows 陷阱处理**：npx/pnpm/yarn 是 `.cmd/.bat` 批处理，直接 spawn 会 ENOENT，Windows 走 `shell:true`（cmd 解析）；kill 用 `taskkill /T /F` 杀整棵进程树。日志环形缓冲（最多 400 条）。
  - **事件流断线重连 + 外部实例自动接管**：用户关掉自己的 harness 终端后桌面端自动接管拉起。
- **壳功能清单**：
  - **单实例**：`requestSingleInstanceLock()`；重复启动把屏保请求 / 唤窗转发给已有实例（`second-instance` 解析 argv）。
  - **托盘**：动态刷新（状态标签+地址作菜单头，随 harness status/log 事件重建菜单）；含"开机自动启动"复选（`app.setLoginItemSettings({openAtLogin})`）、"立即启动 AI 屏保"、更新提示、打开 Web UI。
  - **AI 屏保（最原创亮点）**：空闲 N 分钟自动全屏显示 agent 实时工作画面（思考/文本流/工具调用，SSE 流式增量渲染）；**任务超时守卫**（默认 10 分钟超时自动停止，防失控循环烧 CPU）；**注册为系统屏保**：写 `HKCU\Control Panel\Desktop\SCRNSAVE.EXE`（免管理员，注册前备份原设置、取消时恢复），Windows 用 `/s` 参数拉起直接全屏；**防循环弹出**（5 分钟退出冷却：system/idle 起源 5 分钟内拒绝再拉起，用户主动不受限）；可"保留任务后台继续 / 下次续跑上次任务"；主进程输入兜底（任何 keyDown/mouseDown/mouseWheel 都退出，不依赖渲染进程 JS 状态）。
  - **手机 PWA 遥控**：局域网网关（默认 3082，Bearer token + RPC 白名单 + 文件浏览白名单）；QQ / Telegram 机器人（审批内联按钮、48h 主动推送窗口）；`--remote-debugging-port=9222` + CDP 调试；`--ss-debug` 调试屏保。
- **打包分发**：electron-builder，NSIS 安装版 + 便携 zip；隐私：卸载时不删 `%APPDATA%` 配置/壁纸（`deleteAppDataOnUninstall=false`）。
- **亮点**：① harness 分层托管 + 端口分级诊断 + 指数退避自愈（可平移给 PS 守护）；② AI 屏保 & 系统屏保注册（差异化杀手锏）；③ 自实现 HTTP RPC 协议（不依赖 `dsh web` 套壳）；④ 托盘动态刷新 + 单实例 argv 转发；⑤ 三端独立壁纸 + 拼豆像素滤镜。

---

## 九、对已有"PowerShell + WPF + WebView2 壳"的人最值得借鉴的 Top 5 设计点（按性价比排序）

> 委托人已具备：PS 启动脚本 + WPF + WebView2 + 45min 无写入自动重启守护 + 开机自启 + 托盘 + 单实例 + 日志。以下五项是在此清单之上"性价比最高"的精巧做法，全部可跨技术栈迁移到 PowerShell / WPF。

**① 先探活复用已有服务，只清理"自己拉起的进程"（XinXie-Condex / xiaowei2025cqu23phy）——零成本，命中率最高**
启动时先 HTTP GET `http://127.0.0.1:<port>/`：能通就复用，不通才自己拉起 dsh；退出时 `Kill(entireProcessTree)` 只杀自己 spawn 的进程树，**绝不误杀用户自己开在终端的 dsh**。可改用 PS 版（启动前 `Test-NetConnection` / HTTP 探活决定是否拉起，退出记 PID 按进程树清理），根治"互抢端口、重复拉起、杀错进程"通病。

**② 端口 0 自动分配（SnowCrescenter / CCMu04 / ningbainb）——一行参数，根治端口冲突**
用 `dsh --profile <x> --port 0` 让系统每次挑空闲回环端口，从就绪行解析 URL 填进 WebView2，彻底告别 3080 被占。若委托人能接受不再固定暴露 3080，这是最低成本的一劳永逸。

**③ 服务健康可视化：状态点 + 分级探活 + 精确错误（SnowCrescenter 状态点 / xiaowei 端口分级）**
- 标题栏 / 托盘一个动态状态点（青=运行 / 灰=启动 / 红=出错）——实现极简但体验极好；
- 探活升级为"区分是 dsh 还是被别的程序占用"（抓页面 `__DSH_BOOT__` 标记），给精确错误而非笼统"端口失败"；
- 崩溃重启加**指数退避**（1s→2s→…上限 30s）+ 90s 就绪超时判定（xiaowei 完整实现可平移）。

**④ 完成 / 审批通知"点击直达"（CCMu04 / Links2008 / ningbainb）**
不只是"任务完成弹通知"，而是**点击通知回到对应聊天窗口 / 工作区**（CCMu04 实现点通知直达、含最小化恢复）。委托人已有托盘与日志，加"任务完成→系统通知→点击聚焦到 WebView2 正在看的会话"是高频价值点——只需 Web UI 会话完成时触发（走 WebView2 JS bridge 或 harness 事件桥）。

**⑤ 更新链路：后台下载 + 重启即装，且"运行时与客户端分离"（SnowCrescenter / Links2008 / huangj17）**
后台静默检查 / 下载新版本，就绪后托盘"重启并更新"，退出时完成安装（NSIS）。尤其 huangj17 把"DSH 运行时"和"壳本身"分开更新（运行时只装官方已验证 npm 版本 + 保留内置回退；客户端更新=重装安装包）——厘清"是 Harness 变了还是壳变了"很有帮助。

**⑥（附赠，成本最高）AI 屏保 + 移动端遥控（xiaowei2025cqu23phy）——差异化杀手锏**
空闲全屏展示 agent 实时工作画面 + 任务超时护栏 + 注册为系统屏保（`SCRNSAVE.EXE`，HKCU 免管理员，注册前备份/取消恢复）+ 5 分钟防循环冷却。它是 8 个项目里唯一的原创亮点；但依赖实时事件流渲染，在 WPF+WebView2 里需自实现 SSE/事件桥，工作量大于前五项，属"锦上添花"而非性价比之选。

---

## 附：8 个仓库速记对照

| 仓库 | 框架 | 一句话定位 |
|---|---|---|
| SnowCrescenter-tech/dsh-desktop | Electron | 无边框+自绘标题栏+WebContentsView 分层+状态点，文档最规范 |
| Meditationacm/dsh-desktop | Electron(deep fork) | 重写前端，`file://`+IPC 不走 HTTP |
| CCMu04/DSHDesktop | Electron | 内嵌官方 web+工作台增强+按需 Git Bash，插件化最完整 |
| **XinXie-Condex/DeepSeek-Harness-Desktop** | **C# WPF+WebView2** | **唯一真正原生 WPF 壳，最贴近委托人栈，但功能最简单** |
| Links2008/DeepSeek-Harness-Desktop | Electron | 直角无边框+红黄绿控件+任务完成通知+极自动化发布 |
| huangj17/deepseek-harness-desktop | Electron(跨平台) | 双轨更新+upstream submodule，Windows 标准系统框 |
| ningbainb/deepseek-harness-desktop | Electron | 功能最重(皮肤/QQ/任务板)，升级清理精细化 |
| **xiaowei2025cqu23phy/dsh-desktop** | Electron(`<webview>`) | **最像"嵌入式浏览器壳"，AI 屏保+自实现 RPC+服务托管最全** |

> 全部资料来自各仓库 GitHub README（抓取 GitHub RAW）+ 关键源码（XinXie-Condex `windows/*.cs`、xiaowei2025cqu23phy `src/main/{harness,tray,screensaver,index}.ts`、ningbainb `docs/desktop.md`）。各仓库 URL 见上文各节标题。本次为纯网络调研，未在本地运行任何仓库代码。
