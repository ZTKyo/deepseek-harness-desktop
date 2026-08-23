# AI_CONTEXT.md — Harness AI 入口（最简）

> Phase 01（SAVE）建立，R2 修正 Authority 规则。任何 AI/Agent 接手本仓库时**先读本文件**。
> 状态入口：docs/roadmap/CURRENT_STATUS.md（执行位置恢复）。

## Mission

DeepSeek Harness Windows 桌面化项目：以 DSH（DeepSeek Harness Web GUI @ 127.0.0.1:3080）
为核心，提供原生感 WPF+WebView2 客户端、深度自愈（guardian/execution-continuity）、
事件通知、凭据保险箱、一键更新与移动端通道。
本仓库（GitHub ZTKyo/deepseek-harness-desktop）= 该系统的 **canonical 源码与文档仓库**。

## 冲突裁决原则（R2 修正，取代 R1 的"Live 优先"）

**Live/Runtime 只是 deployed truth，不代表"更新或更正确"。** 冲突时必须裁决，不允许盲目
Live wins 或 Git wins：

1. **Runtime = deployed truth**：只回答"现在部署了什么"。
2. **GitHub verified commit/tag = canonical code truth**：仓库 main 与已验证 tag 是源码权威。
3. 二者漂移时，比较 **commit/history / Golden / 功能语义 / 测试** 后裁决。
4. **已通过正式 Reliability 验证的不变量**（如 YAML valid != Last Good、COMMIT_READY gate、
   Transaction 2.0、True Safe Mode），除非有更强证据 + 完整回归，不得被较旧副本覆盖。
5. 教训（Phase 01 R1）：曾把"DSH-Client 正在运行"误当"更新/更正确"，用旧 Live 覆盖了
   Reliability v1 已验证源码，导致能力回退。**禁止重犯。**

## Current Golden

- **DSH 版本**：`0.1.1-rc.2`（官方 @deepseek-ai/dsh）
- **Stable Golden**：`NEW_LOCAL_GOLDEN_P1_HARDENED`（上一个通过验证的稳定基线）
- **Candidate Golden（当前）**：`PHASE01_CANONICAL_GOLDEN_R2`（含 HASHES.txt，待 Reviewer 审核）
- **REJECTED_CANDIDATE**：`PHASE01_CANONICAL_GOLDEN` / tag `phase01-save-complete`（R1 含回退代码，已标记废弃）
- **部署目录**：`DSH-Client/`（Live Deployment Target；guardian/start-dsh-server 由此运行）
- **插件部署目标**：`~/.dsh/profiles/web/`（由仓库 `plugins/` 部署）

## Authority Map（单一 Authority 原则）

| 职责 | 唯一 Authority | 位置 |
|---|---|---|
| **代码真源** | **GitHub verified main / tag** | ZTKyo/deepseek-harness-desktop |
| Cordis 插件源码 | `plugins/`（仓库内） | 部署到 ~/.dsh/profiles/web/ |
| 独立脚本（goal-recovery / dsh-event-notify） | 仓库根目录 | 消费者 guardian/客户端从根目录调用 |
| 部署/守护脚本 | 仓库根 *.ps1/*.cmd | 同步到 DSH-Client/（deployment） |
| 执行状态 | `docs/roadmap/CURRENT_STATUS.md` | 唯一状态入口 |
| 阶段报告 | `docs/roadmap/reports/PHASE_XX_*/REPORT_R*.md` | 不可覆盖 |
| Golden 快照 | DSH-Client/_release-staging/PHASE01_CANONICAL_GOLDEN_R2 | 可回滚基线 |
| Notion Roadmap | 《🛠️ 待优化项目》 | 外部审核入口 |
| 旧实现/历史证据 | `docs/_archived/` | 只读，不引用 |

> 注意：本地 `_release-staging/` 只是 **working checkout**，不是 Authority；
> 它必须与 GitHub main 同步才算有效。

## Critical Invariants

1. **不丢原始任务**：任何修复完成必须 RETURN_TO_PHASE_CHECKLIST，不因新 Bug 跑偏。
2. **不因未验证阶段污染下一阶段**：Phase 未外部 APPROVED 禁止推进。
3. **不双 Authority**：同一功能只保留一个真源；发现双份立即收口（例：R2 移除 plugins/ 中
   goal-recovery / dsh-event-notify 重复副本）。
4. **GitHub verified = canonical**：冲突按"语义 + 历史 + Golden + 测试"裁决，不盲信 Live。
5. **Reliability 不变量神圣**：YAML valid != Last Good；COMMIT_READY gate；Transaction 2.0；
   True Safe Mode；boot-mode 接线。除非更强证据 + 全量回归，不得回退。
6. **Secret 红线**：不泄露/打印/提交 API Key、Token、Cookie、SSH 私钥、密码。
7. **可回滚**：任何写操作前 checkpoint；Golden 可回滚。
8. **禁止 force push / rewrite history**。
9. **报告不可覆盖**：REPORT_R1 → R2 → R3…，永远不覆盖旧报告。

## Read Next

1. `docs/roadmap/CURRENT_STATUS.md` — 当前执行位置与恢复指令
2. `plugins/README.md` — 插件 canonical 清单与部署映射
3. `docs/roadmap/reports/PHASE_01_SOURCE_OF_TRUTH/REPORT_R2.md` — Phase 01 R2 修复审计
4. `DSH-Client/RUNBOOK.md`（若在部署机上）— 操作手册

## 变更日志

- 2026-08-23（Phase 01 R1）：建立本文件。
- 2026-08-23（Phase 01 R2）：修正 Authority 规则——GitHub verified = canonical；删除"Live 优先"；
  标注 Stable/Candidate/REJECTED Golden 分层；记录 R1 教训。
