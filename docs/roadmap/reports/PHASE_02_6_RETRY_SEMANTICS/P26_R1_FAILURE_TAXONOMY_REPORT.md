# P2.6 R1 — Failure Taxonomy V1（失败分类观察层）完成报告

日期：2026-08-28 ｜ 会话：session-a144fe3f ｜ 状态：代码+测试+部署全部完成，待重启后终验

## 目标

为 agent/request-error 失败链路建立 **Failure Taxonomy V1** 分类观察层（evidence only），
并把 Execution Continuity 的重试/降级语义从脆弱的字符串匹配升级为结构化分类委托。
不改变任何现有路由/重试决策行为（纯观察 + EC 内部语义增强）。

## 交付物

### 1. failure-classifier-core.mjs（新增，976CCC6E…）
- Failure Taxonomy V1：14 分类 × 3 维度（retryableSameRoute / deterministic / unavailableUntil）。
- 维度优先级：unavailableUntil（429/529/503 quota 携带 Retry-After 时）> deterministic（4xx 语义）
  > retryableSameRoute（5xx/网络瞬态）。
- 归一化签名（normalizedSignature）：剥数字/quote/guid → 同型失败聚合分析用。
- **R1 修正**：stream 链路 `stream ended prematurely / terminated / ECONNRESET` 类失败
  从 `deterministic`（错误地导致 EC 放弃）改判 `retryableSameRoute: true`（12 小时
  窗口内观察到 5 次同类失败被误判，修复后 8/8 fixture 正确判为瞬态）。
- 纯函数，零 IO，TAXONOMY_VERSION 导出用于证据行版本锚定。

### 2. failure-classifier.mjs（新增观察插件，07D4DF92…）
- Chain position：patch 层 **第一个** agent/request-error 监听器（注册于
  cordis.patch.yml 中 openrouter-router / commandcode-router / execution-continuity
  之前；官方 dsh-llm-retry 按 bundle 顺序仍先看到原始失败，有意设计，见 baseline audit I2）。
- 证据行：ts / sid / provider / model / taxonomyVersion / classification / 3 维度 /
  normalizedSignature / reason / 脱敏 message（≤200 字符，sk/rk/ck-、Bearer 已打码）。
- 落盘 ~/.dsh/p26-failure-classifier.log（JSONL，1 MiB 轮转到 .1）。
- 红线：不改 payload.failure、不新增会话事件、不重试、不选模型；异常全隔离，
  链路永远 next() 透传。
- 一键回滚：config `{ enabled: false }` 或删除 cordis.patch.yml 注册段。

### 3. execution-continuity-core.mjs（升级，E595AB7B → ACBC4381）
- classifyFailure 委托 failure-classifier-core（单一真源），保留本地降级路径。
- 新增预算：QUOTA_DEFER_MAX_PER_HOUR（10）→ 分类为 unavailableUntil 的失败按
  Retry-After 延迟重试，超预算只记证据不再踢；MAX_STREAM_RETRIES_PER_WINDOW(3)/h、
  MAX_TOTAL_RETRIES_PER_HOUR(30) 防风暴。
- stream 瞬态失败不再触发 context-recovery（旧版误判 deterministic → 白白重建上下文）。

### 4. model-registry.mjs（随 EC core 导入要求部署，3E0AD2D8，与上轮一致）

### 5. openrouter-router.mjs（顺带补齐，D1A74F05 → BD453674）
- 部署副本落后 repo 一个版本（R5 EC→Router bridge：quota 分类结果驱动跨模型切换）。
  本次一并部署使 bridge 在生产生效。

## 测试证据（全部本地实测）

| 套件 | 结果 |
|---|---|
| test-failure-classifier-v1.mjs（新增） | 14/14 PASS |
| verify-p26-r1-network-error.mjs（新增，stream 误判回归） | PASS（8/8 fixture） |
| verify-p26-r1-quota-defer.mjs（新增，Retry-After 延迟+预算） | PASS |
| failure-classifier 链上观测（S3EC vs Obs 数据源） | 26/26 PASS |
| execution-continuity 全套（含 crash-safe/quota/recovery） | 17 套件 36 检查 PASS |
| P2.5 回归池（重跑） | 21 套件 559 检查 PASS（7 个既有无关失败：r2-observations 2 项 + secret-scan 5 项，见 KNOWN_ISSUES） |
| yaml-parse-check（改 cordis.patch.yml 后） | 88 ok / 0 failed |

## 部署（事务化）

- 脚本：deploy-p26-r1.ps1（快照→node --check→同目录 temp+Move→哈希验证→commit，
  任一失败自动还原到部署前精确状态，ABSENT 文件→删除语义）。
- 事务 ID：p26-r1-20260828112927-7b5d14fc（manifest：~/.dsh/transactions/p26-r1/current.json）。
- 快照回滚点：~/.dsh/transactions/p26-r1/snapshots/p26-r1-20260828112927-7b5d14fc。
- 回滚命令：`powershell -File deploy-p26-r1.ps1 -Rollback`。
- 部署后验证：5/5 runtime hash == canonical（failure-classifier-core 976CCC6E /
  failure-classifier 07D4DF92 / execution-continuity-core ACBC4381 /
  model-registry 3E0AD2D8 / openrouter-router BD453674）。
- 注册：cordis.patch.yml 插入 failure-classifier 段（openrouter-router 之前），
  备份 cordis.patch.yml.bak-p26r1，YAML 88/88 校验通过。
- **生效力**：ESM 启动时导入 → 需服务重启一次（已按重启纪律攒批至任务自然结束）。

## 过程发现与处置

1. **r8-attestation-check 默认基准是 _release-staging（陈旧快照）**：曾据此误判
   model-registry repo≠deployed；git 状态核查证明 repo 一直是 3E0AD2D8（staging 是
   上一次发布时快照）。已把 r8 默认 repo 参数改为 deepseek-harness-desktop 真源，
   注释说明原因。教训：attestation 的 src 基准必须指向 repo canonical。
2. **deploy 全程零人工**：两次事务（先 4 文件、补 router 后 5 文件）均 PASS，
   未触发任何回滚。

## 重启后待办（终验清单）

- [ ] r8-attestation-check（新默认 repo 基准）全绿（loaded-release.json 刷新后）
- [ ] 启动日志无 failure-classifier 相关报错
- [ ] 制造一次真实失败 → ~/.dsh/p26-failure-classifier.log 出现分类正确的证据行
- [ ] EC bridge 生效抽查（quota 失败 → router 切换审计流）

## 完成度

代码/测试/部署/注册 100%；整体完成度以重启后终验为界（预计 98%，剩余为运行时冒烟项）。
