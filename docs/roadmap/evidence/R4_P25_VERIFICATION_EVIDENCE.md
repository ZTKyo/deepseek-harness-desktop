# P2.5 Context-Memory 运行时验证证据（R4-2 / R4-4 / R4-5 · 2026-08-27）

> 生产会话只读取证。方法链与上一份《R4 运行时证据》（2026-08-26，设计依据）同源：
> 自研多帧 zstd 解码器逐帧无损解码 `~/.dsh/sessions/**/session.jsonl.zstd`，全程零写入生产文件。

## 会话样本（真实生产日志）

| 角色 | 会话 | 大小 | 结束时间 | CM 状态 |
|---|---|---|---|---|
| ON 活体 | session-34e86c7a（本会话） | 13.8MB | 进行中 | 挂载运行 |
| OFF 对照① | session-11c7aa70 | 11.4MB | 08-14 | 部署前时代 |
| OFF 对照② | session-9e3b29bb | 24.2MB | 08-26 15:57 | 挂载前夜 |
| OFF 对照③ | session-293a808a | 1.8MB | 08-25 | 部署前 |

## R4-2 真实 token 压力跨会话天然 A/B（核心结论）

数据源：provider 官方 usage（`assistant/message.data.usage`），本会话 **1,846 条**有效记录，
message 级 100% 非零可用。

| 条件 | 路由（同 deepseek-v4-flash 族） | 中位压力 tok | p95 |
|---|---|---|---|
| OFF（对照②） | commandcode/deepseek-v4-flash（n=2102） | **422,693** | 586,200 |
| OFF（对照①） | deepseek-official/deepseek-v4-flash（n=572） | **275,770** | 742,266 |
| **ON（活体）** | commandcode/deepseek-v4-flash（n=405） | **56,933**（↓86.5%） | 77,463 |
| **ON（活体）** | bai/deepseek-v4-flash（n=239） | **50,925**（对 OFF③ 同族 451,559 ↓88.7%） | 64,533 |

- 活体会话原始事件 seq 已达 62 万+，而实际计费上下文被压平在 ~8 万 tok 内；最新三采样
  pressure=77,530/81,542/81,542（zhipu），cacheRead 主导。
- 口径说明：跨会话天然对照（同为 v4-flash、不同时代/不同任务），非严格同任务跨天配对；
  「同任务重放配对」仍保留为 PARTIAL 项。
- 佐证原件：`R4_LIVE_ROUTE_STATS.json`（四日志分路由统计）。

## R4-4 抽取路径回源实证（锚点对账）

本会话日志内发现 **181 个观察注入节点，版本连续覆盖 v1→v172 全历史可回源**；
投影声明 237 条全部 `op:"replace"`，携带显式 `{start,end}` 原始 seq 区间。

- **store refs（基线快照）与日志声明逐条对账：共存的 64 个版本全部 EXACT 一致，0 错位。**
- refs 为精确滑窗：恰好保留最近 64 版（v103..v166，storeVersion=166）；其余 109 个注入点
  因版本早于滑窗而无 ref 属预期裁剪（172−64≈108 与实测吻合）。
- MISMATCH 仅 1 例且成因明确：refs 快照摄于基线时点，活体随后前进（快照后置性，非错位）。
- declOverlaps=168 为嵌套窗口语义（每次 replace 声明 [最新影子锚 … 最新原生尾]，
  连续声明在影子端自然重叠），非重复投影。
- 佐证原件：`R4_CORRELATE.json`、脚本 `cm-r4-correlate.mjs` / `cm-r4-anchor.mjs`。

## R4-5 幂等性与双写检测

- 替换区间字节级比对：**237 条声明 ↔ 237 个互不相同的区间，duplicatedRanges=0**
  （`cm-r4-dedupe.mjs` → `R4_DEDUPE.json`）。
- 回合级观察头重复：带 turn 字段的现代事件每回合槽位恰 1 个 ✓；173 个历史事件无
  turn 字段无法按回合分组 → 记录为测量限制，由区间幂等间接覆盖。
- 已观察现象（记录不判定缺陷）：同版本注入头远距二次出现（v3、v166 各一次）与会话
  恢复/resume 重放时点吻合，属恢复流程显示级重发，非存储双写。

## 工具链固化

解码器 `cm-r4-log-decoder.mjs`（多帧感知、只读）、统计 `cm-r4-route-stats.mjs`、
回源对账 `cm-r4-anchor.mjs` / `cm-r4-correlate.mjs`、幂等 `cm-r4-dedupe.mjs` ——
均在本目录，node>=22 原生 zlib，无第三方依赖。

## P2.6 风险登记册（终版，2026-08-27）

| # | 风险 | 等级 | 状态 | 处置 |
|---|---|---|---|---|
| 1 | **LogStore 关闭窗口非持久化**：store 为内存态+落盘，硬杀/断电丢最近未落盘增量 | 低 | 已登记·不修 | 正常关闭已有 flush；硬杀仅致影子锚水位轻微回退（自愈性展示差异），原始 Session 日志 append-only 无损。如 Reviewer 要求可评估 per-append fsync（IO 放大代价） |
| 2 | **会话文件残留投影**：观察头与 surfaceOp 声明永久留在原始 zstd 日志 | 信息 | 已登记·设计如此 | GUI/API 视图层不受影响；离线直读工具须按投影区间折叠（本轮解码器已实现并验证 237 条零遗漏） |
| 3 | lastSwitchAt 只持久化激活时刻，不持久化 prev→new 路由对（重启即失） | 低 | R3 §16 已登记 | 观测粒度限制；如需可后续加轻量持久化字段（向后兼容） |
| 4 | 严格跨天同任务 token A/B 未获取 | — | PARTIAL 保持 | 已有三点 REAL 序列 + 跨会话天然对照（本档 R4-2：↓86.5%/88.7%）+ 合成级下限 |
| 5 | completion quality 跨会话 A/B 未建立 | — | PARTIAL 保持 | 需独立评测系统，红线禁止本轮私建 |

> 登记 1/2 为本轮 R4 运行时验证新发现，已同步工作区 `KNOWN_ISSUES.md`；3–5 沿袭
> REPORT_R3 §16 遗留清单。均不阻塞 AWAITING_REVIEW 状态下的 External Review Round 3。

## P2.7 开关/失败开放部署字节复验 + 挂载链澄清（2026-08-27）

**免重启判定依据（部署一致性）**：
- `context-memory.mjs` / `context-memory-core.mjs`：live（~/.dsh/profiles/web/）与 repo 插件目录
  SHA256 逐字节一致（5FCD2EC40173… / E68FBD173340…）——正在运行的服务执行的就是套件所测逻辑。
- 活体冷启动加载由"运行中事实"直接证明：本会话的观察注入头 / surfaceOp 投影正是该文件
  经 `.agent-presets/autonomous/agent.cordis.yml`（agent 预设层挂载，id=context-memory，
  config.enabled=true）注册的钩子实时产生；服务自文件写入后已真实重启加载过这些字节。
- 预设 YAML 解析权威说明：独立 js-yaml 无法解析 Cordis 的 `!!js/*` 方言（预期行为）；
  该文件的最终解析器就是服务自身加载器，而其加载成功=活体在跑（本会话即证据）。

**当场复跑正套件（非仅开关两项）**：
```
node tests/context-memory/verify-context-memory.mjs   → exit=0
RESULT: 61 PASS / 0 FAIL   （含 T2 单开关停用×2 变体、T3 损坏 store 重建失败开放）
```
完整输出存档：`docs/roadmap/evidence/R4_SWITCH_FAILOPEN_RERUN_20260827.txt`。

结论：R3 门禁通过版本原样在产线执行；kill-switch 与 fail-open 行为今日再次实证 PASS。
未对运行中服务做任何重启或配置变更（服务中断预告纪律：本次操作全程零中断）。

