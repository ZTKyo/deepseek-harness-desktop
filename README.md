# 🐋 DeepSeek Harness Desktop — 把 Agent 装进系统托盘的原生级桌面体验

> **One desktop shell to rule your DeepSeek Harness.** Native-feel WPF + WebView2 client,
> deep self-healing server supervision, system-wide event toasts, one-click updates,
> Windows Credential Manager vault, and a mobile-remote tunnel — all in a double-click.

**你没有看错 —— 这是一个给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的 Windows 桌面客户端。**
不是浏览器套壳，不是网页收藏夹，而是一个**有托盘、有自愈、有通知、会替你打架**的原生级桌面壳。

> ⚠️ **非官方项目**：本项目为个人独立开发，与 DeepSeek 官方无关联。DeepSeek 及其 logo 商标归其权利人所有，本工具仅作本地封装使用。

---

## ⭐ 为什么要用它？因为命令行很酷，但托盘更香

别人还在终端里敲 `npx dsh web`，你已经拥有：

| 能力 | 一句话 |
|---|---|
| 🖥️ **原生感窗口** | WPF + WebView2 自绘深色窗口，3-4 秒就绪，登录态与浏览器隔离 |
| 🚀 **一键起飞** | 双击即用；服务没起？客户端自动帮你后台拉起，独立脱离任何终端 |
| 🛡️ **深度自愈** | 服务半死/僵尸进程霸占端口？启动前自动识别并回收，`拉不起来` 成为历史 |
| 🔔 **事件通知桥** | 任务完成、需要你回答、等待审批 —— 直接变成 Windows 系统通知，不需要盯网页 |
| 🚏 **托盘满配** | 最小化到托盘、右键「在浏览器打开」「复制地址」「检查更新」「退出并停止服务」 |
| ⬆️ **自动更靛** | 上游 dsh 有新版本？启动静默检测 + 托盘一键升级（绝不悄悄乱装） |
| 🔐 **凭据安全** | API Key 存进 **Windows 凭据管理器**（系统保险箱），旧格式自动迁移 —— 领先官方一步 |
| 📱 **手机远程** | 托盘一键启 VPS 反向隧道 / Tailscale，躺床上也能指挥你的 Agent |
| 📊 **额度驾驶舱** | 侧边栏原生组件，DeepSeek / MiMo / OpenCode Go 三商余额与用量一目了然 |

---

## 🚀 快速开始

```powershell
# 1. 安装 DeepSeek Harness（如果你还没有）
npm i -g @deepseek-ai/dsh

# 2. 下载本项目，双击
DSH Harness PS.cmd
```

没了。窗口出现，服务在线，鲸鱼已经住在你任务栏。

- 习惯 Edge？`DSH Harness.cmd`（SAC 安全、零依赖）。
- 想要原生 exe？`build.ps1` 一键编译，或取 Releases 里的安装包。
- 想变成正式桌面程序？`install-shortcut.ps1` 装快捷方式 / 开机自启。

## 🧰 那一堆聪明的模块

```
DSH-Client/
├─ DSH Harness PS.cmd           ⭐ 推荐入口：WPF + WebView2 原生感客户端
├─ DSH-Harness-PS.ps1           主客户端（运行时构建窗口 / 托盘 / 额度组件）
├─ DSH Harness.cmd              Edge 应用模式（SAC 安全兜底）
├─ dsh-clean-reclaim.ps1        🛡️ 深度自愈：回收半死/僵尸 DSH 监听进程
├─ dsh-event-notify.mjs         🔔 事件桥：/api/events.mux → Windows 通知
├─ dsh-credential-manager.ps1   🔐 Windows 凭据管理器存取 + 旧格式迁移
├─ dsh-vps-tunnel-loop.ps1      📱 VPS 反向 SSH 隧道（自动重连）
├─ dsh-guardian.ps1             值守：防睡眠/防崩溃/防卡死自启
├─ dsh-process-identity.ps1     进程指纹：只杀"证实的 dsh"，绝不误伤
├─ dsh-readiness.ps1            分层就绪探针（API + WebSocket 双重）
├─ quota-widget.js              📊 注入侧边栏的三商额度组件
├─ build.ps1                    重新编译原生 exe（无 SDK 也能编）
└─ docs/research/               三份 DSH 桌面化生态调研报告 📚
```

## 🛡️ 可靠性：我们是怎么"修好拉不起来"的

以前是不是遇到过：服务崩了、自动重启也起不来、端口被死进程霸占，最后只能求爷爷告奶奶？

这套客户端的答案是一条**安全的自愈链**：

1. **进程指纹识别**（`dsh-process-identity.ps1`）：命令行 + 运行时台账双因子确认"这是不是我们的 dsh"，宁可放过、绝不误杀。
2. **启动前回收**（`dsh-clean-reclaim.ps1`）：发现端口被"证实的僵尸 dsh"占用且 API 长期不就绪 → 精确停止 → 等端口释放 → 再拉起。
3. **分层就绪验证**（`dsh-readiness.ps1`）：不只是 HTTP 200，而是 API RPC + 两条事件流全都通才算 `client_ready`。
4. **守护值守**（`dsh-guardian.ps1`）：防 Modern Standby 睡眠冻结、崩溃自动拉起、卡死自动重启、健康告警直发你手机（可选）。

## 🔐 安全与隐私

- API Key 不落明文：客户端用 **DPAPI / Windows 凭据管理器**加密存储，仅当前 Windows 用户可解。
- 本地服务只监听 loopback；隐私数据都在你自己的机器。
- 本项目**不含任何硬编码的主机/账号/密钥**（发布前已全量扫描清理）。

## ⚖️ 免责声明

本客户端为开源学习/自用向项目（MIT），可用但无担保。它不做任何 DeepSeek 官方承诺，不收集任何遥测。使用即同意你自己为你的 Agent 负责——它很强，但踩坑请自己背锅。🤝

## 📚 附赠：三份硬核调研报告

`docs/research/` 下躺着三份对 **80+ 个 DSH 桌面项目**的调研：
- `ds-desktop-shells-report.md`（Electron/Tauri 壳 7 仓解剖）
- `ds-native-shells-report.md`（原生/轻量壳 8 仓解剖 + Top 5 借鉴）
- `DSH桌面化生态调研报告.md`（官方现状 + 社区最佳实践 + 宏观路线）

看完你会发现：**你这套壳的路线，正是社区公认的黄金范式。**

---

*Built with 💙 for the DSH community. Star if it saved your evening.*
