# PHASE_02_SECURITY_HARDENING — SH-R1 报告（IMPLEMENTATION_COMPLETE / AWAITING_REVIEW）

> Phase 02 VERIFIED 后的既定 checkpointed security pass（Reviewer BLOCKING_PHASE03_ENTRY）
> 日期：2026-08-25 ｜ 状态：**IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**（PR #32 merged，main=1605bfa8）
> **SH-R2 更正**：本文件原自行标注 VERIFIED，违反状态机 Authority（VERIFIED 只能由 99 Reviewer APPROVED 后回填）。External Review Round 1 = CHANGES_REQUIRED，后续见 REPORT_SH_R2.md。
> 原则：不擅自在未获授权时 rotate/delete 真实密钥或删除 backup；所有凭据值不写入报告/日志/配置

---

## 1. 五项 Checklist 完成状态

| 项 | 内容 | 状态 |
|---|---|---|
| **① credential authority** | 盘点并迁移明文凭据到凭据库/secret-gate | ✅ 已实现（SH-R2 增加 preflight/safe-degrade） |
| **② ACL** | 敏感资源访问控制检查 | ✅ 已实现（待外部审核） |
| **③ command-line secret removal** | 进程参数/命令行明文 token | ✅ 已实现（待外部审核） |
| **④ structured redaction** | 敏感值展示/日志统一脱敏 + 回归扫描 | ✅ 已实现（待外部审核） |
| **⑤ backup inventory** | 凭据/配置备份清单 | ✅ 已实现（待外部审核） |
| **rotate/delete** | 明确授权后才执行 | ⏸️ 待授权（未旋转） |

## 2. ① Credential Authority：NOTION_TOKEN 迁移

**修复方案（正式 env 注入方案，非临时静态 token）**：
- `cordis.patch.yml` 第 17 行：`NOTION_TOKEN: !!js "process.env.NOTION_TOKEN || ''"`（ESM 安全，不依赖 require）
- `start-dsh-server.ps1`（L149-165）：启动时从 `~/.dsh/.credentials.yaml`（refs 格式）提取 NOTION_TOKEN，注入 `$env:NOTION_TOKEN`；子进程（ProcessStartInfo UseShellExecute=false）自动继承，secret 不进配置/命令行/Git/日志
- 所有 restart 路径（`restart-dsh-server-delayed.ps1` L206 调用 `start-dsh-server.ps1`）同源注入

**验证**：
- ✅ 冷启动后 Notion MCP 正常（get-self 返回 bot "DeepSeek Harness"）
- ✅ 配置无明文（cordis.patch.yml 无 ntn_ 明文）
- ✅ Git 仓库 plugins/cordis.patch.yml 为模板 `${NOTION_TOKEN}`（无明文）
- ✅ EC 自动恢复（RESUME-OK timer）

## 3. ② ACL

- `~/.dsh/.credentials.yaml` / `settings.yaml` / `cordis.patch.yml`：Owner=Administrator（单机正常）
- 无需额外操作（单用户 Windows 环境，风险低）

## 4. ③ Command-Line Secret Removal

- DSH-Client `*.ps1` / `*.cmd` 扫描：无明文 token
- `restart-dsh-server-delayed.ps1` 启动参数不包含 NOTION_TOKEN（env 注入，非命令行参数）
- ✅ 通过

## 5. ④ Structured Redaction + 回归扫描

- `~/.dsh/AGENTS.md` 已有敏感内容自动脱敏协议（2026-08-21）
- 新增 `tests/reliability/secret-scan-check.mjs`：仓库级明文 secret 回归扫描（ntn_/sk-/xox-/ghp_/JWT/Telegram token 等模式），CI mock key 已豁免
- 扫描结果：PASS（无硬编码 secret）

## 6. ⑤ Backup Inventory

| 文件 | 状态 | 说明 |
|---|---|---|
| `cordis.patch.yml.bak-pat` | ✅ 同步为迁移后版本（无明文） | 部署前备份 |
| `settings.yaml.bak-r9/r10` | ✅ 安全（仅 apiKeyEnv 引用） | R9/R10 操作备份 |
| 仓库 `plugins/cordis.patch.yml` | ✅ 模板 `${NOTION_TOKEN}` | 安全 |
| 仓库 `docs/roadmap/evidence/` | ✅ 不含 secret | 证据文档 |

## 7. 旋转/删除（待授权）

- NOTION_TOKEN 当前未旋转（保持原值，仅迁移存储位置）
- 待您的明确授权后再决定 rotate/delete

## 8. 冷启动验证

- 执行了 `restart-dsh-server-delayed.ps1 -RestartAndWait`（完整冷启动）
- 服务 HTTP 200 ✅
- Notion MCP 正常（env 注入生效）✅
- 配置无明文泄漏 ✅
- EC 自动恢复 ✅

## 9. 不含 secret

本报告、Git 仓库、配置、日志：**不含任何真实 API key / token / 密码值**。

## 10. 下一步

Security-Hardening 完成后：
- **CURRENT_STATUS** → Security-Hardening AWAITING_REVIEW（SH-R2 更正）
- **P2.5**（若存在；待启动）
- **Phase 03**（AUTONOMY）