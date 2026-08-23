# AI_CONTEXT.md — Harness AI 入口（最简）

> Phase 01（SAVE）建立。任何 AI/Agent 接手本仓库时**先读本文件**。
> 状态入口：docs/roadmap/CURRENT_STATUS.md（执行位置恢复）。

## Mission

DeepSeek Harness Windows 桌面化项目：以 DSH（DeepSeek Harness Web GUI @ 127.0.0.1:3080）
为核心，提供原生感 WPF+WebView2 客户端、深度自愈（guardian/execution-continuity）、
事件通知、凭据保险箱、一键更新与移动端通道。
本仓库 = 该系统的 **canonical 源码与文档仓库**。

## Current Golden

- **DSH 版本**：`0.1.1-rc.2`（官方 @deepseek-ai/dsh）
- **Golden 快照**：`NEW_LOCAL_GOLDEN_P1_HARDENED`（2026-08-23，含 HASHES.txt，可回滚）
- **部署目录**：`DSH-Client/`（Live Deployment Target；guardian/start-dsh-server 由此运行）
- **插件部署目标**：`~/.dsh/profiles/web/`（由 `plugins/` 部署）

## Authority Map（单一 Authority 原则）

| 职责 | 唯一 Authority | 位置 |
|---|---|---|
| 运行时插件源码 | `plugins/` | 本仓库 plugins/（部署到 ~/.dsh/profiles/web/） |
| 部署/守护脚本 | 仓库根 *.ps1/*.cmd | 同步自 DSH-Client/（Live 真实版本） |
| 执行状态 | `docs/roadmap/CURRENT_STATUS.md` | 唯一状态入口 |
| 阶段报告 | `docs/roadmap/reports/PHASE_XX_*/REPORT_R*.md` | 不可覆盖 |
| Golden 快照 | DSH-Client/_release-staging/NEW_LOCAL_GOLDEN_P1_HARDENED | 可回滚基线 |
| Notion Roadmap | 《🛠️ 待优化项目》 | 外部审核入口 |
| 旧实现/历史证据 | `docs/_archived/` | 只读，不引用 |

## Critical Invariants

1. **不丢原始任务**：任何修复完成必须 RETURN_TO_PHASE_CHECKLIST，不因新 Bug 跑偏。
2. **不因未验证阶段污染下一阶段**：Phase 未外部 APPROVED 禁止推进。
3. **不双 Authority**：同一功能只保留一个真源；发现双份立即收口。
4. **Live 优先**：以真实机器/Git/Notion/当前 Runtime 为准，不以聊天记忆为准。
5. **Secret 红线**：不泄露/打印/提交 API Key、Token、Cookie、SSH 私钥、密码。
6. **可回滚**：任何写操作前 checkpoint；Golden 可回滚。
7. **禁止 force push / rewrite history**。
8. **报告不可覆盖**：REPORT_R1 → R2 → R3…，永远不覆盖旧报告。

## Read Next

1. `docs/roadmap/CURRENT_STATUS.md` — 当前执行位置与恢复指令
2. `plugins/README.md` — 插件 canonical 清单与部署映射
3. `docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R1.md` — Phase 01 完整审计
4. `DSH-Client/RUNBOOK.md`（若在部署机上）— 操作手册

## 变更日志

- 2026-08-23（Phase 01）：建立本文件。
