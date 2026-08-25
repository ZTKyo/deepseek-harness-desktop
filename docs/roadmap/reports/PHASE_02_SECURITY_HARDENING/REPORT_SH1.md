# PHASE_02_SECURITY_HARDENING — SH-1 报告（Security-Hardening Gate 首轮）

> Phase 02 VERIFIED 后的既定 checkpointed security pass（Reviewer BLOCKING_PHASE03_ENTRY）
> 日期：2026-08-25 ｜ 状态：Security-Hardening IN_PROGRESS（SH-1 完成）
> 原则：不擅自在未获授权时 rotate/delete 真实密钥或删除 backup；所有凭据值不写入报告/日志

---

## 1. Gate 范围（Reviewer 既定）

| 项 | 内容 |
|---|---|
| ① credential authority | 盘点并迁移明文凭据到凭据库/secret-gate |
| ② ACL | 敏感资源访问控制检查 |
| ③ command-line secret removal | 进程参数/命令行明文 token |
| ④ structured redaction | 敏感值展示/日志统一脱敏 |
| ⑤ backup inventory | 凭据/配置备份清单 |
| rotate/delete | 明确授权后才执行 |

## 2. 收资盘点结果（只读）

| 位置 | 结果 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | ⚠️ **硬编码明文 NOTION_TOKEN**（mcp-notion env）→ 已迁移 |
| `~/.dsh/profiles/web/cordis.patch.yml.bak-pat` | ⚠️ 含同一明文 → 已同步为迁移后版本 |
| `~/.dsh/.credentials.yaml` | ✅ 凭据库（secret-gate refs，明文但 Owner=Administrator 单机） |
| `~/.dsh/settings.yaml` | ✅ apiKeyEnv 全部 env 引用，无明文 |
| `settings.yaml.bak-r9/r10` | ✅ 仅 apiKeyEnv 引用，无明文 |
| DSH-Client *.ps1/*.cmd | ✅ 无明文 token（SH-3 通过） |
| 仓库 `plugins/cordis.patch.yml` | ✅ 模板 `${NOTION_TOKEN}` 引用，无明文 |
| ACL（.credentials.yaml / settings.yaml / cordis.patch.yml） | ✅ Owner=Administrator，单机正常 |
| redaction 协议 | ✅ ~/.dsh/AGENTS.md 已有敏感内容自动脱敏协议 |

## 3. SH-1 修复：NOTION_TOKEN 硬编码 → 凭据库引用

**改动**（仅部署侧 `~/.dsh/profiles/web/cordis.patch.yml` + `.credentials.yaml`）：
- `NOTION_TOKEN: ntn_***`（明文硬编码）→ **`NOTION_TOKEN: !!js "<读取 .credentials.yaml 的表达式>"`**
- NOTION_TOKEN 值移入 `.credentials.yaml`（secret-gate 凭据库 ref）
- 值**未旋转**（保持原 token，待授权决定是否 rotate）

**验证（真实运行）**：
- cordis.patch.yml 无明文 ntn_ token ✅
- .credentials.yaml 有 NOTION_TOKEN ref（len=50）✅
- **服务重启后 Notion MCP 正常**（`notion.get-self` 返回 bot "DeepSeek Harness"）——!!js 表达式成功求值 ✅
- EC 自动恢复（无人工输入）✅

## 4. 待办（需授权/后续轮）

- **rotate/delete 授权**：NOTION_TOKEN 是否换发（rotate）？或保持现 token 仅迁移位置？（当前已迁移，未 rotate）
- **SH-5 备份策略**：`cordis.patch.yml.bak-pat` 已同步迁移后版本；旧明文版本若仍存在于其他位置需清理（需确认无别处备份）
- **SH-4 redaction**：协议已存在；建议增加自动化检查（扫描仓库/部署文件防明文回潮）→ 下一轮
- **ACL 深化**：可考虑对 .credentials.yaml 加 Windows ACL 限制（当前默认单机权限，风险低）→ 可选

## 5. 不含 secret

本报告及本分支不含任何真实 API key / token / 密码值（NOTION_TOKEN 已脱敏为 `ntn_***`）。

## 6. 下一步

- SH-4 自动化 redaction 检查脚本（扫描 plugins/DSH-Client 防明文回潮）
- rotate/delete 授权确认后执行（如需）
- Security-Hardening 完成 → CURRENT_STATUS 置 VERIFIED → P2.5（若存在）→ Phase 03
