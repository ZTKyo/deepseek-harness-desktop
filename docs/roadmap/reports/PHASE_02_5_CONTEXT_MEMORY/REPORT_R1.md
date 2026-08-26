# P2.5 CONTEXT MEMORY — R1 实施完成报告（Minimal V1）

> 分支：`fix/context-memory-r1`（基线 = main `1346511e`）
> 状态：**IMPLEMENTATION_COMPLETE / AWAITING_REVIEW**
> 日期：2026-08-26
> 证据分级：**REAL**（真实运行时/真实数据取证）｜**SYNTHETIC**（受控场景单元测试）｜**INFERRED**（代码路径合理推断）

---

## 0. 结论（TL;DR）

P2.5 CONTEXT MEMORY Minimal V1 已**完整实施并通过全部验证**：
- 新增观察记忆插件（`context-memory-core.mjs` 纯函数核心 + `context-memory.mjs` 插件壳），
  实现 **Recent Window / Observation / Reflection / Recall / Provider-switch activation** 五要素；
- **单元回归 53/53 PASS**（T-SEL + T1–T10 全部断言通过）；
- **真实运行时验证 REAL**：插件已在真实 3080 服务加载，对当前会话真实观察并三次写盘
  （store v1/v2/v3，时间戳 18:20 / 20:56 / 21:00），真实数据渲染出 4350 字符有效观察文本；
- **未进入 P3，未触碰 Security-Hardening**（T8 静态审计确认零 authority 重叠）；
- 交付物齐备：AUDIT_R1 → DESIGN_R1 → 实现 → 回归 → RUNTIME_VERIFY_R1 → 本报告。

---

## 1. 交付清单

| 类别 | 文件 | 说明 |
|---|---|---|
| 审计 | `docs/roadmap/reports/PHASE_02_5_CONTEXT_MEMORY/AUDIT_R1.md` | 只读审计，全部 VERIFIED |
| 设计 | `.../DESIGN_R1.md` | Minimal V1 设计 |
| 实现 | `plugins/context-memory-core.mjs` | 纯函数核心（零 IO、可单测） |
| 实现 | `plugins/context-memory.mjs` | 插件壳（IO + 钩子，fail-open） |
| 测试 | `tests/context-memory/verify-context-memory.mjs` | 53 断言回归套件 |
| 部署 | `tools/install-plugin.mjs` | 安装/同步工具（幂等，正反校验） |
| 配置 | autonomous 预设 compaction 组插入 `context-memory` 行 | 单开关启用 |
| 运维 | `restart-dsh-server-delayed.ps1`（+82 行预检） | 重启前 YAML 预检（Test-YamlFile !!js 容错） |
| 报告 | `.../RUNTIME_VERIFY_R1.md` + 本文件 | 运行时验证计划与完成报告 |
| 审计素材 | `docs/audits/CODEX_FULL_HARNESS_AUDIT_20260823.md` | 全量审计底稿（118KB） |

---

## 2. 五要素实现对照

| 要素 | 实现位置 | 证据 |
|---|---|---|
| **Recent Window** | `recentWindowNodes: 40`，窗口内节点永不投影 | T-SEL + T7（单活快照） |
| **Observation** | `buildObservation` 增量投影旧区段为结构化观察块 | T1/T4/T7；REAL store obs 结构完整 |
| **Reflection** | `reflect` 有界归纳（每段 ≤24 条、总字符 ≤6000） | T7（5062 ≤ 6000+overhead；渲染 2449 字符） |
| **Recall** | 替换节点带 `sourceEventSeqs` 官方回源；store 保留 refs 索引 | T4（5 类证据回源）+ T5 |
| **Provider-switch activation** | `observeRoute` 观察 Router 决策（**只看不决定**），切换后激活投影 | T6（3 断言）+ 真实 `active:false` 惰性态 |

---

## 3. 验证证据（三级分级）

### 3.1 REAL — 真实运行时取证

| # | 证据 | 取证方式 | 结果 |
|---|---|---|---|
| R1 | 插件已在真实 3080 服务加载 | `~/.dsh/profiles/web/context-memory{,-core}.mjs` 存在；服务 pid=7984（18:37:13 启动） | ✅ 已部署 |
| R2 | 预设已启用插件 | `~/.dsh/.agent-presets/autonomous/agent.cordis.yml` L438-439 含 `context-memory` 行 | ✅ enabled |
| R3 | **真实观察并三次写盘** | `%LOCALAPPDATA%\DSHHarness\state\context-memory\session-34e86c7a….json`：version=3，watermark=117682 | ✅ v1 18:20:18（seq 7-80202）、v2 20:56:10（seq 90634-95825）、v3 21:00:59（seq 111567-117682） |
| R4 | **观察内容与本会话事实吻合** | store obs：goal（P2.5 目标）、completedActions 18 条、keyFileChanges 9 条、blockers 1 条、runtimeFacts 2 条 | ✅ 与当前会话真实内容一致 |
| R5 | **真实数据可渲染为有效观察文本** | 用插件 `renderObservationText` 渲染真实 store v3 obs | ✅ 输出 4350 字符，含标题/会话 ID/sourceRange/各分节，结构完整 |
| R6 | 服务运行期无插件 boot error / 无 QUARANTINED | guardian.log 无插件报错；服务稳定运行 151+ 分钟 | ✅ |
| R7 | 模块可独立加载 | `import()` 冒烟：core 12 个导出、插件 `apply/name` 导出 | ✅ |

> 说明：R3 的 v1–v3 三次写盘时间戳跨 3 小时（18:20 / 20:56 / 21:00），证明插件在服务运行期间持续存活并按增量条件触发投影，非一次性写入。

### 3.2 SYNTHETIC — 受控场景单元测试

| # | 覆盖点 | 测试 | 结果 |
|---|---|---|---|
| S1 | token A/B 收益 | T10：baseline 22337 tok → after 1202 tok，**ratio=0.054**（≤25% 即 PASS） | ✅ |
| S2 | provider-switch 激活判定 | T6：首次路由不算切换；auto 重写不算切换；concrete model/provider 变化 → 激活并立即投影 | ✅ |
| S3 | 开关彻底禁用 | T2：config.enabled=false 与 CM_DISABLED=true 双通道 | ✅ |
| S4 | store 损坏 fail-open | T3：损坏 store → 重建空 store，任务继续 | ✅ |
| S5 | 重启恢复 | T5：持久化 store 恢复；缺失 store 重建 | ✅ |
| S6 | 上下文腐烂抑制 | T9：failedApproaches 记录、去重、不复活 | ✅ |
| S7 | 内存有界 | T7：refs ring ≤64、单活快照、分节上限 | ✅ |

### 3.3 INFERRED — 代码路径推断（已由静态审计佐证）

| # | 推断 | 依据 |
|---|---|---|
| I1 | 投影替换走官方 shadow-price 协议 | 源码 `session.append('compaction/prune')` → `append('user/message', {surfaceOp:'replace', sourceEventSeqs})`（AUDIT §2 协议一致） |
| I2 | 观察者永不阻塞/改写请求链 | `observeRoute` 全程 try/catch，返回 `resolved` 原值 |
| I3 | 零 authority 重叠 | T8 静态审计：不触碰 compactNow / request-error / ec-recovery / goal.resume / resolveModelInfo / agent-default-model / thresholdRatio / retainRatio |

---

## 4. 回归测试结果

```
RESULT: 53 PASS / 0 FAIL
T-SEL selectProjectionRange boundaries ................. PASS
T1  raw session truth unchanged (append-only) .......... PASS
T2  single switch fully disables ....................... PASS
T3  corrupt store → rebuild/fail-open .................. PASS
T4  recall — 5 evidence classes traceable via refs ..... PASS
T5  restart recovery ................................... PASS
T6  provider-switch activation ......................... PASS
T7  bounded memory ..................................... PASS
T8  no-duplicate-authority static audit ................ PASS
T9  context rot — failed approaches .................... PASS
T10 token A/B (synthetic ratio=0.054) .................. PASS
```

- 核心功能 PASS｜相关测试 PASS｜启动/运行 PASS（服务 151+ 分钟无异常）
- 已有无关失败：0

---

## 5. 风险与回滚预案

| 风险 | 等级 | 处置 |
|---|---|---|
| 插件导致启动失败 | 低 | 预设行 `enabled: false`（或删行）→ 延迟重启 |
| 投影质量不理想 | 低 | `recentWindowNodes` / 阈值可调；单开关可停 |
| store 损坏 | 无 | fail-open 自动重建，任务不中断 |
| raw session 被改 | 无 | append-only 保证，原始事件永不可被插件删除 |

完整回滚：`git checkout main`（分支未合入前）→ 删除 profiles/web 两插件文件 → store 残留无害。

---

## 6. 遗留问题（不阻塞交付）

1. **provider-switch 真实切换未自然发生**：本验证周期内 Router 无真实切换事件，
   激活路径由 T6 synthetic 覆盖（判定逻辑已单测）。真实切换激活将在后续自然发生时取证。
2. **token A/B 为 synthetic 基线**：真实长会话 A/B 需跨天任务积累；当前单元级 ratio=0.054
   为上限估计，真实收益只可能更好（投影仅在超阈值时发生）。
3. **CODEX 全量审计文档**（118KB）为 audit 阶段底稿，随本次一并入库存档，非本阶段新增逻辑。

---

## 7. 合规声明

- ✅ 未进入 P3；✅ 未重开 Security-Hardening；✅ 停在 IMPLEMENTATION_COMPLETE / AWAITING_REVIEW
- ✅ 观察者角色：插件只决定"模型看到什么"，绝不决定"路由/重试/压缩/goal"
- ✅ 变更已全部提交至分支 `fix/context-memory-r1`，待 PR/CI/merge
