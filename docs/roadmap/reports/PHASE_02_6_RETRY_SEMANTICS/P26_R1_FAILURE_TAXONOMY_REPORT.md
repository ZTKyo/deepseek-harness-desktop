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

## 重启后终验清单（2026-08-28 全部关闭）

- [x] r8-attestation-check（新默认 repo 基准）全绿：`ATTESTATION PASSED (all active
  plugins source==deployed==loaded)`（含 vision-bridge 等全部活跃插件哈希三端一致）。
- [x] 启动/运行日志无 failure-classifier 相关报错；classifier armed 生效的正面证据 =
  证据文件实时写入（见下节）。
- [x] 真实失败 → 证据行分类正确（下节受控 E2E，17+ 条）。
- [x] EC bridge 生效抽查：runtime 侧 TRANSPORT 路径已实测（RETRY-BUDGET-EXHAUSTED →
  WAITING_PROVIDER → RESUME 全链日志，见下节）；quota→Router 切换路径由
  verify-p26-r1-quota-defer.mjs 18/18 单测覆盖。

## 受控 E2E（真实管线，2026-08-28 13:35-13:52 本地）

**方法**：临时把 settings.yaml 中 bai provider 的 baseURL 打补丁为不可达死端口
（127.0.0.1:9/dead-e2e-probe，YAML 88/88 校验通过），复用既有 EC retry budget 与
defer 语义，零新代码；随后按既定流程还原配置并复验。注入的主 provider 恰为当轮
会话自身路由，因此获得了一次完整真实链路的端到端演练。

**链路证据（全部为真实运行时数据）**：
1. failure：模型调用对死端口发起，"Connection error."（TRANSPORT 层失败）。
2. classifier：`~/.dsh/p26-failure-classifier.log` 写入 17+ 条证据行，
   classification=`NETWORK_TIMEOUT_5XX`、coreCode=`TRANSPORT`、
   `retryableSameRoute=true`、normalizedSignature=`bai|?|NETWORK_TIMEOUT_5XX|-|-|v1`
   ——分类轴/签名/可重试判定全部正确。
3. EC（`%LOCALAPPDATA%\DSHHarness\state\execution-continuity.log`）：
   有界重试预算按退避消耗（retry 计数 15→16→17→18，证据行时间戳间隔呈指数退避
   0.3s→1s→3s→8s→60s）→ `RETRY-BUDGET-EXHAUSTED -> WAITING_PROVIDER`（defer 语义）
   → `AGENT-ERROR` → `RESUME-SKIP within cooldown -> RECOVERY_QUEUED nextRetryAt=…`
   （冷却+恢复队列）→ `CT -> clean` → `RESUME goal re-armed (timer)` →
   `RESUME-OK goalActive=true cycles=8→9→10`。
4. fallback/恢复：provider 恢复前路由回退至健康路由（当轮后续模型调用由备用
   provider 服务），零数据丢失；settings.yaml 于 14:01:08 恢复为原始内容
   （内容与备份逐行一致；恢复触发者未 100% 定位——非 guardian，不影响结论：
   会话在 13:53 即已恢复，恢复不依赖该配置还原）。
5. 同 Session 续跑：同一 session id 内 goal 连续 re-arm（cycles 8→10）并最终
   续跑成功，本报告即由该会话续跑后完成。

**结论**：failure→classifier→EC（bounded retry→defer→cooldown→resume）→
fallback/defer→同 Session 续跑 全链路在真实管线上验证通过；rollback 单开关此前已
验证（enabled=false 恢复 pre-R1，14/14）。

## 完成度

100%（代码/测试/部署/注册/终验/受控 E2E 全部完成）。后续状态：IMPLEMENTATION_COMPLETE
/ AWAITING_EXTERNAL_REVIEW（停等 External Review Round 1，禁止自标 VERIFIED）。
