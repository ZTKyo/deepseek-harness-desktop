# EXECUTION_ECONOMY_BASELINE

**日期**：2026-08-21
**分支**：execution-economy-v1
**Base**：main @ `3f4208c7c01b9bdf437de421809c098f6d778ee4`（Reliability v1 SEALED）

---

## 1. 目的

回答 ox-alpha 接入事件（Turn 1 ≈ 44min，总体 ≈ 110min）为何被放大，
并记录 Execution Economy v1 的起点能力清单。

## 2. 现有能力审计（本次只读核查）

| 能力 | 是否已存在 | 证据 |
|---|---|---|
| Task scope / DoD 概念 | ✅ 部分 | ~/.dsh/AGENTS.md 任务收资协议、goal system |
| Time awareness / ETA | ✅ | AGENTS.md 第 3 节 ETA 与真实进度 |
| Retry 行为 | ✅ | dsh-llm-retry + openrouter-router 跨模型 fallback |
| User question | ✅ | ask_user_question 工具（≤8 问） |
| Settings hot reload | ✅ | dsh-settings-file watcher（上轮实证：settings.describe revision 0→1→10 热更新） |
| Runtime settings API | ✅ | settings.mutate / describe / replace（上轮实证可用） |
| Provider 注册表（静态） | ✅ | provider-registry-core.mjs（启动加载） |
| Task completion stop | ✅ | goal system + 完成通知纪律 |
| FAST/NORMAL/DEEP 任务分类 | ❌ 缺失 | 无显式分类规则 |
| MACHINE-FIRST VERIFY 优先级 | ❌ 缺失 | 无强制层级，导致上轮走 GUI |
| TWO-STRIKE REPLAN | ❌ 缺失 | 无"同路线 2 次失败必须换路"硬规则 |
| WALL-CLOCK BUDGET | ❌ 缺失 | 无 FAST 5m/10m 检查点 |
| Vision/Screenshot 限制 | ❌ 缺失 | 无"FAST 默认 0 次 vision" |
| Probe timeout 与生产 timeout 分离 | ❌ 缺失 | 无 5-10s probe 预算 |
| User presence 概念 | ❌ 缺失 | 无显式 AVAILABLE/UNAVAILABLE 判断 |

## 3. 为什么 ox-alpha 当时会：API 可验证 → 却进入 GUI → Screenshot → Vision → 再截图 → 再 Vision

**决策缺口（按顺序）：**

1. **无 MACHINE-FIRST 层级**：当时已通过 `llm.discoverModels` / `settings.describe` /
   `llm.models` 得到机器可读状态（模型注册成功、value 层更新），
   但没有规则强制"机器可读优先"，Agent 继续用 GUI 截图确认同一个事实。
2. **无 Vision 次数上限**：首次 Vision 截图结果"不确定/未展开"，随后重复走
   截图+Vision 路线（≥3 次），违反本应存在的"第一次 Vision 不确定 → 换路"。
3. **无 WALL-CLOCK BUDGET**：GUI 验证循环持续数轮没有触发"已经 X 分钟，为什么还在做这个"。
4. **验证目标混淆**：把"后端注册成功"（API 已证明）与"用户界面显示正常"（GUI 唯一职责）混为一谈。
5. **工具调用膨胀**：大量无信息增益的 tool calls 加剧 context 压力 → compaction 压力，
   又进一步拖慢后续轮次。

**本质**：不是技术阻塞，是 **验证策略缺失 + 验证路径选择错误**。

## 4. 7 条规则落地方案（Policy-Only 优先）

| 规则 | 落地方式 |
|---|---|
| 1 CLASSIFY | AGENTS.md + preset 指令：任务开始 FAST/NORMAL/DEEP 三分类 |
| 2 LOCK DOD | AGENTS.md：开始前写最小 DoD，动作前问"是否推进 DoD" |
| 3 MACHINE-FIRST VERIFY | AGENTS.md：验证优先级 1-7（API/RPC → Registry → Settings → Probe → Logs → DOM → Vision） |
| 4 TWO-STRIKE REPLAN | AGENTS.md：同路线失败 2 次必须 REPLAN，第 3 次必须改变变量 |
| 5 WALL-CLOCK BUDGET | AGENTS.md：FAST 5m 轻检查 / 10m Hard Replan |
| 6 HUMAN LEVERAGE | AGENTS.md：仅当 Human<30s 且 Agent>5m 才 ASK |
| 7 STOP | AGENTS.md：DoD 达成立即 STOP，额外发现进 FOLLOW_UPS |

## 5. Model/Provider Fast Path（复用现有能力）

DSH 现有 runtime settings（settings.mutate + watcher hot reload + llm.discoverModels）
已能完成：注册 → 热生效 → 验证 → 删除。**无需新代码**，只需 Policy 规定路径：

```
DISCOVER（30-60s，只读 API）→ SNAPSHOT（仅目标 section）→ MUTATE（settings API）
→ PROBE（5-10s connection / 20-30s first response）→ VERIFY（API 层）→ DONE
失败 → ROLLBACK
```

## 6. 本阶段禁止

- 修改 Reliability v1 / Router / Provider Registry / Safe Mode
- 创建大模块（Controller/Scheduler/Lifecycle Engine）
- 修改 Compaction / Tool Output Offload
- 升级 DSH
