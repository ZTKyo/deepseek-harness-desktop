# AC1 产物凭据清除记录（2026-09-28 00:25）

## 结论（先说结果）

- **生产 learn store：CLEAN** —— 19 族 × 10 文件零命中；重启前的存量 google/stripe 命中已被自愈迁移抹除。
- **本任务产物（172 文件）：发现 3 个文件含"与现行生产配置同值的真实凭据副本"** → 已就地脱敏，
  逐文件复验 0 命中。
- 其余命中经"无泄漏细看"（只打上下文、不打值）定性为**源码表达式误报 / 文档示例 / 合成测试夹具** →
  **保留原样**（改写它们会破坏源码、pristine 基线与测试夹具，属反向伤害）。

## 扫描范围与总量

| 范围 | 文件数 | 家族数 | 结果 |
|---|---|---|---|
| 生产 learn store（`%LOCALAPPDATA%\DSHHarness\state\learn`） | 10 | 19 | ✅ 0 命中 |
| 本任务产物（`_p4r2-final-closure` + `_p4r2-evidence`） | 172 | 19 | 见下（3 清理 / 14 定性保留） |

## 真实凭据副本（已清除）

| 文件 | 家族 | 同源核对（sha256 比对，绝不显示值） | 处置 |
|---|---|---|---|
| `checkpoint/PRE_P4_FINAL_POSITIVE_PATH_FIX/cordis.patch.yml.prod.before` | notion×1 | **与现行 `~/.dsh/profiles/web/cordis.patch.yml` 中的值完全相同** ⇒ 真实在用的凭据副本 | → `[REDACTED:notion]` |
| `_p4r2-evidence/prod-rollback-20260927-230301/cordis.patch.yml` | notion×1 | **同上，完全相同** | → `[REDACTED:notion]` |
| `ac1-leak-pre-remediation-20260927155415..json` | google×1, stripe×1 | 与已知夹具散列**不同源**（无法证明是否合成 ⇒ 按真实凭据同等处理） | → 占位符 |

脱敏方式：**就地**把命中值替换为 `[REDACTED:<family>]`，文件结构完整（仍可作证据使用）；
替换后立即用同一套 19 族模式**逐文件复验 = 0 命中**（脚本 `_ac1-redact-artifacts.mjs`，日志 `_ac1-redact-log.json`）。

## 非凭据命中（保留 + 判定依据）

| 文件 | 家族 | 判定 |
|---|---|---|
| `deploy-backup-*/learn-core.mjs`、`_p4r2-evidence/pristine/learn-core.mjs`、`checkpoint/*/learn-core.mjs.*.before` | uri-credential×2 | 源码**注释里的文档示例**（形如 `postgres://user@host` 的连接串，中段口令为占位名）——脱敏会污染源码/pristine 基线 |
| `ac1-fix/watchdog.mjs` + 其 `.backup-*` | generic-assignment×3 | **源码表达式**：`let token = …`、`token` 由 `randomBytes(32).toString('hex')` 产生、`fcmCache.accessToken = …` |
| `_this-session.jsonl` | uri-credential×4, generic-assignment×3 | **本任务报告正文中的示例文本**（postgres 连接串示例、password 赋值示例——均不含真实口令，故不再复现字面形态） |
| `repro/a6/test-learn-r3-secrets.mjs.txt`、`_ac1-secret-families.mjs` | 多族 | **负控合成夹具**（`'X'.repeat(24)` 一类构造样本），是测试证据本身 |

## 回滚注意（重要）

两份配置备份里的 `NOTION_TOKEN` 现为占位符。日后若用它们回滚，必须从**现行**生产配置重新取值。
**现行生产配置与凭据库本轮未被触碰**（未读改、未迁移、未写回）。

## 边界（诚实标注）

- 本扫描**不覆盖整个工作区**（只含生产 store + 本任务产物）；全量工作区密钥普查不在 P4 AC1 范围。
- 未删除任何证据文件；全部处置为"就地占位符替换"，证据结构完整。
- 未改动生产插件字节：`learn.mjs`/`learn-core.mjs` 的 source==deployed==loaded 结论不受本轮影响
  （本轮只动 workspace 产物）。
- 工具脚本（本记录的取证工具，留在闭环目录）：`_ac1-workspace-leak-scan.mjs`（扫描）、
  `_ac1-hit-classify.mjs`（上下文分类）、`_ac1-peek.mjs`（无泄漏细看）、`_ac1-redact-artifacts.mjs`（脱敏+复验）。
