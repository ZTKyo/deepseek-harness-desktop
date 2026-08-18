# DSH 第三方桌面客户端壳 —— Electron / 一键安装 / 跨平台 类实现情报报告

> 调研对象：GitHub 上为 DeepSeek Harness（dsh）做的"桌面壳"项目中，属于 **Electron / 一键安装 / 免环境 / 跨平台** 一类的 7 个仓库。
> 委托人背景：Windows 客户端 = **PowerShell 启动脚本 + WPF 窗口 + WebView2 控件**，内嵌 dsh Web UI，附带服务守护 / 开机自启 / 托盘。本文意在对比学习他人做法。
> 调研方式：web_search 定位 README 原文 + 抓取 GitHub RAW 的 README / 配置文件 + GitHub API 元数据（default_branch / language / stars / 时间）。

---

## ⚠️ 先纠正一个前提（重要）

委托清单标题把它们统称"Electron"类，但**实际技术栈高度分化**，务必按真实实现看：

| 仓库 | 真实技术栈 |
|---|---|
| LBurny/deepseek-harness-desktop | **Tauri（Rust 内核 + 系统 WebView）**，**不是 Electron** |
| hairyf/deepseek-harness-desktop | **Tauri 2（Rust）**，**不是 Electron** |
| Skyearn/deepseek-harness-app | **原生 C# .NET Framework + WebView2**（最接近委托人的做法！） |
| RZX00/deepseek-harness-desktop | **Electron** ✅ |
| zechen666-creater/...-oneclick-pack | 免安装便携包（仓库只有教程，**无源码**；exe 行为符合 Electron 便携包） |
| fufankeji/deepseek-harness-studio | **Electron** ✅ |
| op7418/pilot-harness | **Electron** ✅ |

也就是说：**真正 Electron 的只有 3 个**（RZX00、fufankeji、op7418）；Tauri 有 2 个；原生 C# 有 1 个；便携打包 1 个。

---

## 1. LBurny/deepseek-harness-desktop（Tauri + 内置运行时）

- **来源**：https://github.com/LBurny/deepseek-harness-desktop （default: main，语言 Rust，6★，2026-08-15 创建，还在活跃迭代）
- **技术栈**：**Tauri（不是 Electron）**，Rust 核心 + 系统 WebView。前端 React 风格壳页。多平台路线已铺好：`Platform` trait 隔离平台差异，目前只出 Windows x64。
- **如何托管 dsh**：Tauri 前端（加载页/主页）通过 IPC 调 Rust 核心 → Rust `spawn`（无控制台窗口、`DSH_HOME` 隔离到应用数据目录下）→ **内置的 node.exe + `dsh web --port <空闲端口>`**，只绑 127.0.0.1；dsh 就绪后把 Web UI 载入原生窗口。安装包内置 **Node 24 + dsh + cloudflared**，零前置依赖。
- **壳功能清单**：
  - 托盘常驻：关窗默认藏到托盘（或退出，Settings 可选）；托盘菜单：打开 / 诊断 / Skills / MCP / 远程访问 / 重启服务 / 设置 / 退出。
  - **原生系统通知**：通过 dsh 的 WebSocket 通道 `/api/events.mux` 消费"审批请求 / 提问 / 完成回合"事件，窗口隐藏时转成 Windows 通知，可带内置提示音。
  - **Skills / MCP 管理面板**：启用/禁用/删除、从 codex/claude/opencode 导入、热重载。
  - **崩溃自愈**：dsh 进程被监督，指数退避重启。
  - **主题跟随 + 语言跟随**：标题栏/壳页跟随 dsh 亮/暗/系统主题；托盘与本地页跟随 UI 语言。
  - 诊断面板（服务状态/端口/PID/实时日志/一键重启/开机自启开关）、记住窗口几何、单实例（二次启动聚焦已有窗口）。
  - **手机远程访问**（亮点）：托盘一键起 Cloudflare Quick Tunnel（cloudflared 内置），壳层 token 网关代理后，扫码即可在手机访问完整 Web UI；token 每次启动随机、停止即失效，无需服务器/账号。
- **打包分发**：`pnpm tauri build` → **NSIS 安装包** `DSHDesktop_<ver>_x64-setup.exe`，按用户安装、无需管理员、支持静默 `/S` 和 `/D=目录`。约 59MB 安装器 / 297MB 安装后。用户数据在 `%LOCALAPPDATA%\DSHDesktop\`。
- **node/凭据**：自带 node；API key 由 dsh 自己的凭据机制管理（在应用数据隔离的 DSH_HOME 下）。
- **值得借鉴**：① dsh 事件(`/api/events.mux`)→系统通知的桥；② 托盘一键 Cloudflare Quick Tunnel 手机远程（壳层 token 网关）；③ 平台差异抽象到 `Platform` trait；④ 无控制台 spawn + DSH_HOME 隔离；⑤ 崩溃指数退避监督。

---

## 2. hairyf/deepseek-harness-desktop（Tauri 2，最火：519★）

- **来源**：https://github.com/hairyf/deepseek-harness-desktop （default: main，语言 Rust，**519★**，安装包号称仅 5MB 外壳）｜中文 README：https://github.com/hairyf/deepseek-harness-desktop/blob/main/README.zh.md
- **技术栈**：**Tauri 2 壳（React 前端，非 Electron）**，最小安装包、低内存、原生窗口；Windows/macOS/Linux 三平台，中英双语。相关仓库 `deepseek-harness-pkg` 负责预构建 Harness 发行包下载。
- **如何托管 dsh**：Tauri 前端是"安装状态机（setup state machine）→ 下载进度 → iframe 内嵌 dsh Web UI + 侧边栏控制"。Rust 后端 `service/download`（安装器+解压）、`service/workflow`（dsh 进程生命周期）、`task`（健康检查）。最终跑 `dsh --profile web --host 127.0.0.1 --port 3080`，`DSH_HOME=<app-data>/data/dsh`。默认**固定 3080 端口**。
- **运行时策略（核心亮点）**：首次启动自动下载内置 Node v22.22.0 + dsh 发行包；本机已有兼容 Node/Pnpm 则直接复用不污染系统。**内核自愈**：每次启动对比上游最新 Harness 版本，过期自动重新下载，GitHub 不可达时保留本地——"上游修复无需重装即可跟上"。
- **壳功能/平台**：零环境一键安装；首启 wizard 可选装推荐插件（dsh-market 插件市场）并实时看日志；安装后自动注册 `dsh` 命令（`*/bin`）；纯本地、默认关遥测。
- **打包分发**：Tauri `targets: all`，出 NSIS / macOS / AppImage。macOS **未公证**（需"仍要打开"放行一次）。开发者预览态。
- **node/凭据**：自带 node；凭据在上游 dsh 系统（`DSH_HOME`），未额外处理。
- **值得借鉴**：① **发布物不经打包器而是"安装时下载运行时 + 启动自愈 diff 上游版本"**——直接把"引入上游修复"变成日常能力，代价是首启需联网下载几百 MB；② 状态机驱动的首启装配（下载进度/失败恢复）；③ 复用本机 Node 的探测逻辑；④ iframe 内嵌 + 侧边栏壳控制模式。

---

## 3. Skyearn/deepseek-harness-app（原生 C# + WebView2，最贴近委托人）

- **来源**：https://github.com/Skyearn/deepseek-harness-app （default: master，语言 TypeScript，11★）｜Windows 壳 README：https://github.com/Skyearn/deepseek-harness-app/blob/master/apps/windows/README.md
- **技术栈**：macOS = **Swift + WKWebView**；**Windows = 原生 C#（.NET Framework 4.x）+ WebView2**，单文件 C# 用系统自带 `csc.exe` 编译，WebView2 SDK 走 NuGet 下载——**这就是"PowerShell+WPF+WebView2"思路的原生/编译版**，最值得委托人直接对照。
- **如何托管 dsh**：启动时按优先级解析 dsh 与 node：① 显式路径（注册表/参数）→② 应用旁的 bundled 安装 →③ PATH 搜索（含 npx cache）。然后 `spawn(node <dsh> web)` 为**无控制台子进程**，日志追加到 server.log；轮询等 `127.0.0.1:<port>` 可连后，WebView2 加载该 URL。端口默认 3080，可用注册表 `HKCU\Software\DeepSeek Harness\port` 改。用 `-BundleDsh` 编译时把 `@deepseek-ai/dsh` 嵌进 exe 旁。
- **壳功能清单**：
  - 托盘/任务栏图标、内嵌 UI 窗口、36px 状态栏（可右击显隐）显示服务状态+URL。
  - **保证清理（退出即释放端口）**：关窗 / Quit 按钮 / `taskkill /PID`(WM_CLOSE) → `taskkill /PID <pid> /T /F` 杀进程树 → 等端口释放（最长 6s）才退出；只动自己 spawn 的进程树。
  - **孤儿服务器回收**：被硬杀后，下次启动读取记录的 pid、校验命令行匹配、终止并重启。
  - **单实例**：命名互斥量二次启动拒绝。
  - 默认不开系统浏览器，**"Open in Browser"是显式 opt-in**。
  - 高 DPI：PerMonitorV2 manifest 保持内嵌 UI 清晰。
  - 窗口提示（hold）`showStatusBar` 等。
- **打包分发**：`build.ps1 -BundleDsh` 产出 exe + 3 个 WebView2 DLL + `dsh\` 文件夹 → 打 zip 分发（非安装器）。GitHub Release 由 `app-release.yml` 构建；mac 出 universal zip。
- **node/凭据**：`-BundleDsh` 时自带 node（`bin/node`，`NODE_BUNDLE_VERSION` 可钉，默认 v24.12.0，裁剪掉 npm/npx/corepack/docs）；`-BundleDsh` 内嵌 dsh。API key 走 dsh 自己的 `~/.dsh/.credentials.yaml`，壳不碰。
- **值得借鉴**：① 端口释放/进程树清理 + 端口校验的严谨退出语义（有无信号机制时如何干净回收）；② 孤儿服务 PID 记录 + 命令行校验再回收；③ 状态栏显示服务状态与 URL；④ 显式 opt-in 打开浏览器；⑤ Windows 下最地道的 WebView2 集成参考；⑥ `stateDir`/registry 集中的可配置项。**与委托人方案的直接可比性最高**。

---

## 4. RZX00/deepseek-harness-desktop（Electron shell，卡官方 web profile）

- **来源**：https://github.com/RZX00/deepseek-harness-desktop （default: master，语言 TypeScript，7★，2026-08-13 创建）
- **技术栈**：**Electron**（electron-builder，version ≈ 官方 latest）；是 `deepseek-ai/deepseek-harness` 的 **fork**，在不变 web runner 之上加净壳层 `apps/desktop`。
- **如何托管 dsh**：`app/main.cjs` 以子进程启动**打包好的 `dsh --profile web` closure**，等它打印出 URL 行（`/api` 路由挂载后）后，在 `BrowserWindow` 里 load 该 URL。**关键技巧**：壳用 `ELECTRON_RUN_AS_NODE` 重新执行自身 Electron 二进制作 harness runtime → **不再另外捆绑 Node，用户零安装**（这是这款最巧的一点）。端口由 dsh 默认（3080）。
- **壳功能清单**：桌面/任务栏原生窗口、内嵌 Web UI、单实例；退出时确保被杀的子进程清理。官方插件 `ui-directory-picker-native` 提供原生目录选择（用 isolated preload 的原生对话框）。工作区默认 `Documents\DeepSeek Harness`；`DSH_DESKTOP_WORKSPACE`/`DSH_DESKTOP_RUNTIME` 环境变量。
- **打包分发**：`pack.mjs`（staging closure + electron-builder）出 **NSIS 安装器 + zip 便携**（Windows）与 **DMG + zip**（mac arm64）；全部**未签名**（Windows 需"仍要运行"，mac 需去 quarantine）。支持 `--stage-only/--skip-stage` 跨主机打包（NSIS 需 Windows/Wine，DMG 需 hdiutil）。
- **node/凭据**：**不另带 node**（用 `ELECTRON_RUN_AS_NODE` 复用壳子 Electron runtime）；API key 走 dsh 自身 `~/.dsh/.credentials.yaml`，与 CLI 共享一个 key。
- **值得借鉴**：① **`ELECTRON_RUN_AS_NODE` 复用 Electron 当 Node 跑 dsh**——省掉整套 Node 运行时、包更小；② fork 官方 repo + 只加壳不改 runner 的"最小侵入"思路；③ `--stage-only` 跨平台 staging 打包流水线；④ 用环境变量做工作区/运行时切换。

---

## 5. zechen666-creater/deepseek-harness-oneclick-pack（一键打包/便携）

- **来源**：https://github.com/zechen666-creater/deepseek-harness-oneclick-pack （default: main，17★）｜中文：`README.zh-CN.md`
- **性质**：**仓库不含源码**（git tree 只有 7 个条目：两个 README、两篇教程 md、1 张预览图、1 个使用说明 txt）——本质是"**保姆级中文教程 + 预打包免安装 zip**"，分发物在 GitHub Releases。
- **技术栈**：从产物行为推断为 **Electron 便携包**（`DeepSeekHarness-win32-x64-0.1.0-rc.5.zip` ~238MB，解压即 run `DeepSeekHarness.exe`，内置 Node.js + dsh；`%APPDATA%\DeepSeekHarness\config.json` 是典型 Electron userData；"Choose Data Location"对话框 + `File→Change Data Location` 是打包版 dsh 常见交互）。**无源码可核实**——只能按发布产物行为判定。
- **如何托管 dsh / 壳功能**：曲线上同其他包——打包了 dsh 桌面构建，双击 exe 即起服务进界面。附加的差异化点是**面向零基础小白的数据位置管理**：首启"选择数据存储位置"，之后文件菜单可改并自动重启；日志 `数据目录\logs\server.log`；卸载=删文件夹。
- **分发**：GitHub Releases zip（非安装器），未代码签名（SmartScreen 需"仍要运行"），Release 备注给 SHA-256 校验。
- **值得借鉴**：① **面向"纯鼠标小白"的文档化售卖**（保姆级图文教程+校验和+FAQ），仓库本身几乎全重放在教程上而非代码；② 数据目录可选可迁移、改动即自动重启的实现思路；③ 国内镜像下载适配（描述里强调全配镜像源、免梯子）。

---

## 6. fufankeji/deepseek-harness-studio（Electron，功能最重的商业向壳，277★）

- **来源**：https://github.com/fufankeji/deepseek-harness-studio （default: main，语言 TypeScript，**277★**，赋范空间/BeyondData 出品）｜中文 README + `apps/desktop/package.json`
- **技术栈**：**Electron 43.4.0 + electron-builder 26.15.3 + electron-updater 6.8.9**；tsdown/tsc 构建；mac + Windows。
- **如何托管 dsh**：Electron 主进程拥有"Host 生命周期"——启动本地 `dsh web`、等就绪后载入 Web 工作区，退出时关闭 Host 进程。配套 `stage-runtime.ts` 预置运行时到 `extraResources`（`host/` 含 runtime-host 的 node_modules）。用 `apps/desktop` 内的 `runtime-host/` 独立 Host。
- **壳/产品功能（远超其余，是"零代码桌面增强"）**：系统托盘、单实例、外部链接处理、隔离 preload；插件发现/热点推送/AI 智能找插件、**公开插件中心**（搜索 npm dsh-plugin 生态、校验版本/完整性/兼容性后一键安装/启停/卸载）、Preset 广场、应用中心（内置 FF-LLM Wiki 应用）、视觉增强（Qwen3.8 读图）、皮肤换肤、中文 DeepSeek 控制。规划：MCP/Skills 管理、多 Agent、Git/Worktree、手机远程等。
- **打包分发（最成熟的一套）**：NSIS 安装器（Windows x64 Setup.exe，可选安装目录、桌面/开始菜单快捷方式、含自定义 `installer.nsh`）；mac 走 `hardenedRuntime + notarize: true` + target `dir`；**自动更新**：`electron-updater` + `publish provider=generic url=阿里云 OSS(ali-oss)` rc 频道。`publish:update` 脚本负责推更新。
- **node/凭据**：自带 Host runtime；凭据仍在 dsh 系统（`~/.dsh/.credentials.yaml` 由上游管理）。
- **值得借鉴**：① 完整 **electron-updater + 私有 OSS 分发/自动更新**闭环（委托人本地壳可抄这层）；② 插件中心"在线发现→校验→一键管理"的产品化壳（把"装插件"做成人人可用的 UI）；③ 主进程管线式 `stage-runtime.ts`（构建→装运行时→electron-builder）；④ 托盘 + 单实例 + preload 隔离的安全基线写法。

---

## 7. op7418/pilot-harness（Electron + CodePilot 风格 + 插件化桌面）

- **来源**：https://github.com/op7418/pilot-harness （default: main，语言 TypeScript，**119★**）｜中文：`README.zh.md` ｜壳架构：`apps/desktop/README.md`
- **技术栈**：**Electron ^40.10.6 + electron-builder ^26.8.1**；esbuild 打包 main；mac/Windows/Linux。
- **如何托管 dsh**：桌面进程启动构建好的 `@deepseek-ai/dsh` CLI 在**操作系统分配的 loopback 端口**，等其稳定输出 `dsh web:` URL 后，在 sandboxed BrowserWindow 加载；给子进程一个私有 `DSH_HOME`（Electron user-data 下），保留有界的脱敏诊断尾巴，**重启子进程而不重启桌面进程**。
- **壳/产品功能**：原生窗口、本地运行时生命周期、目录选择、**启动异常恢复页**、平台图标；**CodePilot 风格主题系统**（完整亮/暗 token 调色板 + 组件级几何，不做 agent loop 侵入）；服务商/模型管理（provider ↔ `ctx.settings`、API key ↔ `ctx.credentials`、模型路由 ↔ `ctx.llm`）。**插件优先**：主题、Worktree 侧栏、Schedule 摘要、Session 日志导出都做成标准 dsh 插件（`dsh.bundle`），普通 Web profile 一条命令即可装同一份能力——桌面上限不外溢成桌面专属逻辑。
- **打包分发（最规范的安全流水线）**：仅由 `.github/workflows/desktop.yml` 构建上传；`v*` tag 出 DMG/ZIP、NSIS、AppImage/DEB/RPM + 插件 bundle + `SHA256SUMS.txt`；macOS 用系统 `codesign` 递归签名（closure 资源多），`afterSign` 深校验；mac 正式构建导入 `MAC_CERT_P12_BASE64`/`MAC_CERT_PASSWORD`/`APPLE_TEAM_ID` secrets，失败即不发布；公证为发布责任（当前未启用→"仍要打开"）。Windows/Linux 预览包未签名。
- **安全**：renderer contextIsolation + sandbox + Node 关；顶层导航限制 loopback 源、外链开系统浏览器、权限请求默认拒绝；preload 只暴露目录选择/重启/数据目录/诊断复制/平台/版本。
- **值得借鉴**：① **OS 分配 loopback 端口**（不写死 3080，避免冲突）；② 子进程崩溃只重启子进程、主进程保活，且保留脱敏诊断尾巴；③ **把桌面扩展做成标准 dsh 插件**（`dsh.bundle`）而非桌面专属代码——极大降低维护面；④ 规范的双配置 electron-builder（adhoc CI vs release）与审计级打包门槛；⑤ 完整安全基线（隔离/沙箱/最小 preload）。

---

# 总论：对一个"PowerShell+WPF+WebView2 本地壳"的人，最值得借鉴的 Top 5 设计点（按性价比排序）

委托人已有：PowerShell 启动脚本 + WPF 窗口 + WebView2 + dsh Web UI，带服务守护/开机自启/托盘。下面 5 点按「借鉴成本低 + 收益大」排序：

**1. 严谨的"退出=释放端口 + 回收孤儿服务"语义（来自 Skyearn 原生壳）**
   这是与委托人架构同源（WebView2）且最容易被忽略的一块。Skyearn 明确做到：退出时 `taskkill /T /F` 杀**自己 spawn 的进程树**→轮询等端口释放（最长 6s）才允许退出（因 Windows 无 SIGTERM，只能硬杀但要干净）；被硬杀后，下次启动读记录的 pid、**校验命令行匹配再回收**。委托人的 PowerShell+守护方案可把"端口是否真被释放 / 残留进程回收"做成开机自检逻辑。成本极低、直接消除"端口占用/僵尸进程"类最烦问题。

**2. dsh 事件(`/api/events.mux`) → 系统通知的桥（来自 LBurny Tauri 壳）**
   LBurny 通过消费 dsh 的 WebSocket `/api/events.mux`，把"审批请求/提问/回合完成"在窗口隐藏时转成原生 Windows 通知 + 提示音。委托人的 WPF+WebView2 壳用 PowerShell 持有该 WS 事件流即可实现"后台时也别错过授权/完成"——这是把 dsh 从"开个网页"升级成"桌面产品感"的高性价比一点。

**3. 图标/菜单级"托盘 + 单实例 + 显式 opt-in 浏览器"（综合 Skyearn、fufankeji、op7418）**
   统一养成的桌面惯例：关窗→托盘常驻（或退出，可在设置选）；单实例（互斥量/二次启动聚焦已有窗口）；**"Open in Browser"做成显式按钮而非自动弹浏览器**。这三条在 PowerShell/WPF 里都是几十行内可补齐的低成本项，但把"壳的存在感"拉满。fufankeji/op7418 的 preload 隔离 + 外部链接走系统浏览器是同样的安全习惯。

**4. `ELECTRON_RUN_AS_NODE` 复用 Electron 当 Node 跑 dsh（来自 RZX00）——思路可移植为"自省复用"**
   RZX00 用 `ELECTRON_RUN_AS_NODE` 让自己 Electron 二进制同时充当 Node 运行时跑 dsh，从而**省掉整套额外 Node 安装**。对委托人而言，更有价值的迁移不是技术同款，而是"**运行时自省与自愈**"的思路：启动时探测/复用本机已有 node+dsh（不比重新捆绑差），并像 hairyf 那样"每次启动 diff 上游 dsh 版本、过期自动补"——把"引入上游修复"变成零人工维护的日常能力。这是纯增量、不破坏现有架构的增益。

**5. 把桌面增强做成"配置/插件"而非"桌面专属逻辑"，并决定是否要自动更新（来自 op7418 的插件优先 + fufankeji 的 electron-updater/OSS）**
   op7418 的核心原则是：主题栏、文件侧栏等桌面增强都做成标准 dsh 插件（`dsh.bundle`），普通 Web profile 一条命令装同一份——桌面壳只做"原生窗口/生命周期/打包"，业务能力留在 dsh 生态。对委托人：**别再往壳里堆 dsh 能力**，壳只管"窗口+守护+集成"，能力全交给 dsh 插件体系，能显著砍维护面。若想做到"改壳即更用户体验平滑"，可参考 fufankeji 的 **electron-updater + 私有 OSS/generic 分发 + rc 频道**自动更新闭环（委托人是脚本壳，可退化为"开机/启动时静默检查更新并重启"的更轻版）。

---

**一句话总结**：若只抄三点——**① 干净退出/端口释放+孤儿回收（Skyearn）；② 藏窗时把 dsh 事件变系统通知（LBurny）；③ 能力交给 dsh 插件、壳只做窗口与守护（op7418/RZX00/hairyf）**——即可在"PowerShell+WPF+WebView2"现有骨架上，以最小成本获得其他项目已验证的桌面产品体验。
