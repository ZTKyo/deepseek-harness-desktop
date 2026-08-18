# DeepSeek Harness（DSH）桌面化生态全景与官方现状调研报告

> 调研时间：2026-08-17（数据以 GitHub API / raw README / 社区讨论为准）
> 委托人背景：自建 PowerShell + WPF + WebView2 的 Windows 客户端壳，寻找宏观可借鉴方向。

---

## ① 官方现状（版本 / 发布 / 桌面端 / Web UI 能力）

### 1.1 仓库与版本
- **官方仓库**：`deepseek-ai/deepseek-harness`，默认分支 `master`，明星 ~15.8 万，MIT 协议。
  描述 "Everything is a Plugin"，基于 Cordis 驱动。
  - https://github.com/deepseek-ai/deepseek-harness
- **最新发布**：**`dsh-v0.1.0-rc.7`**，发布于 2026-08-17，**预发布（prerelease）**，且**该 Release 附带的资产数为 0（无安装包）**。全仓库目前只有这一个 Release，无稳定版。
  - 项目处于 **developer preview（开发者预览）**，README 明示“会有破坏兼容性的变更（THERE WILL BE COMPATIBILITY-BREAKING CHANGES）”。
  - API：https://api.github.com/repos/deepseek-ai/deepseek-harness/releases

### 1.2 官方分发方式与桌面端
- **官方没有任何官方桌面客户端**（Windows/macOS 均无）。仓库树里没有 desktop/electron/wpf/tauri 应用主体，官方 README/文档也只讲 CLI 与 Web UI。
- **官方推荐的分发方式就是 npm：`npx @deepseek-ai/dsh web`**，默认 Web UI 地址 `http://127.0.0.1:3080`（README 明示）。
  - https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md
- **官方 GitHub Actions 里确实有“打 EXE”的工作流（`build-exe-for-python-sdk.yml`），但那是给 Python SDK 的单文件 JSON-RPC 运行时（`dsh-jsonrpc-agent-pkg`），不是给主 harness 的桌面 App**。架构笔记《single-file-executable-sdk-runtime-distribution》明说 **“Windows is a non-goal”（Windows 不是目标）**，产物是给 Python SDK 用的 Linux/macOS 运行时 exe。
  - https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/workflows/build-exe-for-python-sdk.yml
  - https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md
- **结论**：官方把“桌面体验”全部留给社区生态（awesome 清单里光是桌面客户端就有 80+ 个），官方自己只承诺 Web UI + CLI。

### 1.3 官方 Web UI 能力（暗色主题 / 通知 / 托盘）
- **暗色主题：官方原生支持 ✅**。官方有一个专门的 `@deepseek-ai/dsh-client-ui-theme` 主题包，内置 `light / dark / system` 三态偏好，`system` 通过 `prefers-color-scheme` 解析，偏好持久化到 `$DSH_HOME/settings.yaml`；第三方皮肤走 `webServer.tapIndex` 的进程内扩展缝隙。
  - https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/README.zh.md
- **系统通知 / 托盘：官方 Web UI 不内置 ❌**。这些“桌面化”能力全靠社区桌面壳补齐（典型如 LBurny 壳把 dsh 的 `approval requested / question asked` WebSocket 事件转成 Windows 原生通知；另有 `dsh-notification`、`dsh-web-ui-notify` 等插件做“回合完成”桌面通知）。
- **凭据管理：官方有一套 credentials 缝隙（seam）**，见 §③。

---

## ② awesome 清单里桌面化/UI 相关条目汇总

两份清单都已核实在线：`fendouai/awesome-deepseek-harness`（2026-08-14 用 GitHub API 全量核验过链接、含“Clients (Desktop & TUI)”专区）与 `Dominic789654/awesome-deepseek-harness`。两份清单里桌面化项目高度重叠，以下为**去重后的精选 + 一句话点评**（带来源链接）。

### 头部/值得注意的桌面项目（按知名度）
- **[anywhere-labs/deepseek-harness-desktop ⭐11.3k]** — 生态里最火的“桌面体验”（插件形态）；生命周期设计（Generation/回滚/有序退出）被人专门写文分析。来源：fendouai 清单 → https://github.com/anywhere-labs/deepseek-harness-desktop
- **[LBurny/deepseek-harness-desktop（DSHDesktop）]** — **与委托人方案最接近的现成思考样板**：Tauri + 内置 Node 24 + dsh，NSIS 安装包；托盘常驻、原生通知、崩溃指数退避自动重启、单实例、主题/语言跟随、Cloudflare Quick Tunnel 手机远程、Skills/MCP 热管理、诊断面板。是“薄壳托管官方服务”派代表作。
  - https://github.com/LBurny/deepseek-harness-desktop
- **[xiincs/deepseek-harness-desktop（Tauri2 三端）]** — 明言“走系统浏览器内核（WebView2），不自带 Chromium → 包小、开得快”；关窗进托盘、崩溃自愈、Windows exe 已签名+自动更新（mac/Linux 无自动更新）。
  - https://github.com/xiincs/deepseek-harness-desktop
- **[hairyf/deepseek-harness-desktop ⭐416]** — Tauri2 三端，5MB 级安装包；首次启动自举 Node+harness，**自愈核心**（每次启动 diff 上游最新 release 自动更新，GitHub 不可达时用本地缓存）。参考其 `deepseek-harness-pkg` 预构建包思路。
  - https://github.com/hairyf/deepseek-harness-desktop
- **[sdkwork-ai/deepseek-harness-desktop]** — 生态里工程最完整的一份“官方 web profile 桌面发行”：**通过 Electron IPC 管 UI、不开 HTTP 端口**（避免端口冲突）；共享 `~/.dsh`；GitHub Releases 发 exe/dmig/deb/rpm + SHA256SUMS；Windows/Linux 支持自动下载+安装器交接；明确写“RC 未签名 → 会触发 SmartScreen / Gatekeeper”。其官方频道最新 `dsh-v0.1.0-rc.12`。
  - https://github.com/sdkwork-ai/deepseek-harness-desktop （桌面安装指南：…/docs/user/guide/desktop.md）
- **[Ruler4396/dsh-launcher ⭐132]** — 轻量 Windows 启动器：登录静默自启 + **最小 WebView2 窗口**（不加完整浏览器）。最贴近“薄壳”思路。
  - https://github.com/Ruler4396/dsh-launcher
- **[steven-kid/deepseek-harness-desktop ⭐153]** — 极简跨平台薄壳、开箱即用。
- **[Deepseek-Harness-EAC ⭐692 / myYangyunfan/dsh_desktop ⭐426]** — 内置 Node+dsh、一键启动的 Windows 客户端；EAC 还带 10 套 UI 皮肤（“皮肤/外观”是社区高频诉求）。
- **[oh-dsh（hust-open-atom-club）⭐237 / oh-dsh-desktop ⭐? macOS 工作台]** — 社区“一站式发行”（TUI+桌面+Web UI 分层装；macOS 原生 PTY 工作台）。
- **[deepseek-harness-studio（fufankeji）⭐224]** — 零代码桌面端，Windows/macOS，内置插件中心+视觉增强。
- **[Deepseek-Harness-Desktop（ChisaAlter）⭐109 / ningbainb ⭐77]** — Electron 壳 + **主题/背景图自定义**、免损加载完整 Web UI+插件+皮肤+技能坞。
- **[wuyuzi-luo/dsh-desktop]** — Windows 托盘常驻、Skills/MCP 管理面板、自订皮肤、**自动更新**、一键安装。
- **[wess09/DeepSeekHarnessDesktop ⭐51 / Links2008 ⭐v2.1]** — Windows 打包工具 / 含原生通知+平滑窗口控制+内置运行时+自动更新、跟踪官方 master 分支的 Windows 发行。
- **[deepseek-harness-desktop（Easyhoov）⭐3]** — “进程内方式”：宿主组合在 Electron 主进程内启动、**零端口 + IPC 桥**（与 sdkwork 同样的“不开 HTTP 端口”流派）。
- **[Moresyl/dsh-studio / dsh-desktop（s3yf1337）/ RAFOLIE ⭐Tauri2】** — Tauri 壳：托盘、单实例、OS 通知、**只建议不自动更新的 updater**、原生对话框、拖拽、（RAFOLIE）单便携 exe。
- **[huchunlinnk/deepseek-desktop]** — “AI 养 AI”的 Tauri 壳：每天一个 DSH agent 跟踪上游、强 128 插件对齐门、自动开 PR（自维护对抗上游漂移的极客方案）。

### UI / 外观 / 锦上添花类（Web GUI 层）
- 主题/皮肤：`dsh-theme-kit`（32 预设主题）、`BeiZi6/dsh-theme-plugin`（走官方 `webServer.tapIndex` 缝隙）、`dsh-neu-theme`、`dsh-skin`（npm）、`ink5897/dsh-theme-kit`。
- 额外面板/体验：`dsh-smooth-stream`（丝滑流式显示）、`dsh-minigames`（摸鱼小游戏）、`dsh-custom-background`、`whale-girl`/`dsh-pet`/`dsh-plugin-pet-rs`（桌宠，含托盘/置顶/SSE 状态推送）、`dsh-web-notification`/`dsh-notification`（回合完成桌面通知）、`dsh-web-attention-badge`（标签页通知角标）、`dsh-cost-meter`（按回合美元成本徽章）、`dsh-git-branch-switcher`、`dsh-drag-and-drop`。
- 远程/多端：`xgone/dsh-remote`（账号+OTP+角色鉴权远程访问）、`dsh-telegram-channel`（手机 Telegram 遥控）、`dsh-mobile-shell`（Android/iOS WebView 薄壳 + token 守卫代理）、`dsh-tailscale-sync`。

> 双清单交叉结论：桌面化是当下 DSH 社区**最热赛道之一**，但**没有一个官方认可的“标准客户端”**；技术栈以 **Electron**（最成熟、最多）与 **Tauri/WebView2**（更小、更新）两大流派为主，少量用 WinForms+WebView2 / Go+Wails。委托人“PowerShell+WPF+WebView2”属“纯 Windows + 系统内核”流派，社区讨论中属被认可路线（见 §③）。

---

## ③ 社区痛点与最佳实践

权威出处：官方 **GitHub Discussion #767《可以搞一个 harness 的桌面应用程序》**（社区关于桌面端的核心讨论，含完整设计权衡），以及 sdkwork、LBurny、xiincs 三份工程化 README。
- https://github.com/deepseek-ai/deepseek-harness/discussions/767

### 3.1 如何优雅托管 node 服务（核心痛点）
共识做法（讨论 #767 + LBurny + sdkwork）：
- **检测到已有 Harness 在跑就直接复用**，不要重复起端口；**崩溃则自动恢复**（LBurny 用指数退避监督重启；xiincs “崩溃自愈”）。
- **端口冲突**是 Windows 第一大坑 → 两种解法都有社区实践：
  - 派系 A（用端口）：绑定 `127.0.0.1` 上的**空闲端口**（LBurny 起 `dsh web --port <free>`），并处理防火墙弹窗；
  - 派系 B（无端口）：**通过 Electron/Win API 的 IPC 桥直连，不开 HTTP 端口**（sdkwork、Easyhoov）——彻底绕开端口/防火墙问题。
- **数据目录沿用 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`）**，与 CLI 版互通（profiles/settings/credentials/sessions 全共享），这是桌面与 CLI “一键切换互不冲突”的关键（xiincs/sdkwork 均如此）。
- 建议**锁定稳定版 / 跟踪官方发布通道**，因为上游在 developer preview、破坏兼容变更频繁；sdkwork 采用“GitHub Latest 指向最高 SemVer tag”的语义化对齐。

### 3.2 WebView2 缓存/集成问题
- 社区普遍**用系统 WebView2/Tauri 而非自带 Chromium**，理由是“包小（不用扛 100+MB Chromium）、开得快”（xiincs 明言）——这正是 WPF+WebView2 的天然优势。
- 最佳实践（讨论 #767 明确）：**渲染进程禁用 Node.js 集成**（用 WebView2 的隔离设置，别开 `NodeIntegration`），**服务只监听 127.0.0.1**、不对外开放端口——既是安全也是防缓存侧信道。
- 注意 Windows 特有细节：**端口冲突、防火墙弹窗、任务栏图标、路径斜杠、Win10/11 兼容性**（讨论 #767）。WebView2 若缺失需自动安装（LBurny 内置静默装 WebView2）。

### 3.3 自动更新
- 社区普遍**基于 GitHub Releases 做自动更新**（sdkwork：启动后检查 release channel、Windows/Linux 支持自动下载+安装器交接；xiincs：Windows exe 已签名+自动更新，mac/Linux 只提示去发布页）。
- 两种立场都有：**自动下载安装器交接**（sdkwork/xiincs） vs **“只建议不自动装”的 suggest-only updater**（s3yf1337）。自用壳建议取“检查+提示+手动确认”的低风险路线。
- 上游版本锁定 vs 跟随：hairyf 做“自愈核心”（启动 diff 上游自动更新，GitHub 不可达回退本地）；links2008/huchunlinnk 跟踪官方 master。**自用场景更稳妥是锁定 rc 版本、手动升级**（讨论 #767 建议锁定稳定版）。

### 3.4 凭据 / key 的安全存放（关键，与委托人强相关）
官方 credentials 子系统现状与权威结论（官方文档）：
- 官方是“引用不落地”设计：settings/`cordis.yml` 只存 **env 变量名引用**，值由 provider 管理，按需每次解析（改 key 下一个请求即生效，无需重启）。
  - https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/credentials.md
- 官方本地 provider **`dsh-credentials-local`** 把明文写进 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`），用 `0700` 目录 + `0600` 文件 + 原子写 (`dsh-atomic-write`) 保护。
  - **官方文档明确承认的安全边界与待办**：文件权限只能挡住“其他 OS 用户”，**挡不住同用户（同 UID）的模型子进程**——bash/文件工具与 dsh 同用户，可读此文件；官方把“OS keychain provider（Windows 凭据管理器 / macOS 钥匙串，模型进程完全读不到）当作 deferred answer（暂缓项）**。
  - https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md
- **给委托人的强信号**：官方自己都说“OS-keychain provider 才是最终答案”。**WPF 壳可以在凭据存放上领先官方**——把 API key 放进 **Windows 凭据管理器（Credential Manager / DPAPI）**，而非明文 yaml，即可实现“模型进程读不到的真正边界”。
- 另有社区第三方安全审计（Discussion #454，防御性研究：DSH 插件模型安全）+ 官方 security 文档，佐证“凭据安全存放入口是桌面客户端的差异化价值点”。
  - https://github.com/deepseek-ai/deepseek-harness/discussions/454

---

## ④ 给“自用为主、PowerShell+WPF+WebView2 壳”的宏观路线建议

社区共识 + 官方现状给出了明确的方向优先级（按投入-价值排序）：

1. **服务托管与生命周期（最值得投入，第一优先）**
   - 复用已跑实例 + 崩溃指数退避自动重启 + 单实例（LBurny/xiincs 标配）；绑定 `127.0.0.1` 空闲端口并处理防火墙/端口冲突。
   - 跟随官方做法：数据/凭据继续走 `~/.dsh`，保证与浏览器版/CLI 完全互通。
   - 这是“自用壳”最痛、最稳的收益点——先把“关窗不退出、后台常驻、崩了自己起”做扎实。

2. **凭据安全（成本低、差异化最强，强烈建议投入）**
   - 官方明说 OS-keychain 是 deferred answer → **在 WPF 壳里把 key 存进 Windows 凭据管理器 / DPAPI**，就补上了官方还没做的“模型进程读不到”的真正边界。
   - 顺带比官方更安全：WebView2 渲染禁用 Node 集成、UI 只回环访问本地服务。

3. **自动更新与版本锁定（中等投入，自用可简化）**
   - 自用场景建议：锁定一个经过验证的 `rc` 版本 + 手动一键升级（读上游 release/GitHub API），不必做全自动下载安装器交接（那是给多端发布准备的）。
   - 保持“打开时检查 + 提示手动确认”的 suggest-only 低风险路线即可。

4. **签名 / SmartScreen（自用可延后，若要分享他人再补）**
   - 社区所有未签名产物都明确标“RC 未签名 → SmartScreen/Gatekeeper 会弹”。**自用**可不管；**若将来发出去**，Windows 需要代码签名证书否则装包体验很差。先不投入。

5. **多端（自用可延后；轻量可选）**
   - 值得“低成本尝鲜”的是**手机远程**：LBurny 用 Cloudflare Quick Tunnel（cloudflared 内置、随机 token、出站连接、开箱即用）把 Web UI 推到手机；或 `dsh-tailscale-sync` / Telegram 通道。自用可通过 Tailscale 更私密。真正的 macOS/Linux 端（LBurny 已用 `Platform` trait 留口）对自用 Windows 客户说投入偏高，延后。

6. **外观/通知（锦上添花，看心情）**
   - 官方 Web UI 已原生支持暗色/亮色/system，**不用为“暗色主题”单独开发**；若想要更多，走官方 `webServer.tapIndex` 的主题缝隙接入第三方皮肤即可。
   - “回合完成通知”可用 `dsh-notification` 类插件，也可在壳里监听 `approval requested / question asked` 事件转系统通知（LBurny 做法），自用体验提升明显且实现简单。

### 一句话总结
> **官方没有、短期内也不像会给桌面客户端**（主打 npm + Web UI，开发者预览期迭代极快），桌面化是社区最热赛道且已验证出“薄壳托管官方服务 + 复用 `~/.dsh` + 启停自愈 + WebView2 系统内核”这一黄金范式。委托人现有 PowerShell+WPF+WebView2 路线完全站得住（社区明确认可“纯 Windows 用 .NET+WebView2 系统集成更自然”）；最有性价比的下一步是：**把服务托管/自愈 + Windows 凭据管理器存储(领先官方) + 手机远程**三件事做扎实，暗色主题与外观交给官方/社区插件。

---

## 信息来源 URL 清单

**官方**
- 仓库：https://github.com/deepseek-ai/deepseek-harness
- README（EN/ZH）：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md · …/README.zh.md
- Web UI 指南：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md
- Release（GitHub API）：https://api.github.com/repos/deepseek-ai/deepseek-harness/releases
- Python SDK 单文件 exe 工作流：…/.github/workflows/build-exe-for-python-sdk.yml
- 单文件 exe 架构笔记：…/.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md
- 凭据子系统：…/docs/subsystems/credentials.md
- 本地凭据 provider：…/packages/credentials/credentials-local/README.md
- 官方主题包：…/packages/client/ui-theme/README.zh.md
- 官方 Discussion #767（桌面应用讨论）：https://github.com/deepseek-ai/deepseek-harness/discussions/767
- 官方 Discussion #454（社区第三方安全审计）：https://github.com/deepseek-ai/deepseek-harness/discussions/454

**awesome 清单**
- fendouai/awesome-deepseek-harness：https://github.com/fendouai/awesome-deepseek-harness
- Dominic789654/awesome-deepseek-harness：https://github.com/Dominic789654/awesome-deepseek-harness

**社区桌面项目（代表性）**
- https://github.com/LBurny/deepseek-harness-desktop
- https://github.com/hairyf/deepseek-harness-desktop
- https://github.com/xiincs/deepseek-harness-desktop
- https://github.com/sdkwork-ai/deepseek-harness-desktop （安装指南 …/docs/user/guide/desktop.md）
- https://github.com/anywhere-labs/deepseek-harness-desktop
- https://github.com/Ruler4396/dsh-launcher
- 其余（EAC / myYangyunfan / oh-dsh / studio / Easyhoov / wuyuzi-luo / s3yf1337 等）见 §②内联链接
