# P2.5 R1 运行时验证计划（重启后执行）

> 状态快照（重启前）：实现已提交分支 `fix/context-memory-r1`（commit `47b2cff`）；
> 插件已部署 `~/.dsh/profiles/web/context-memory{,-core}.mjs`；
> autonomous 预设 compaction 组已插入 `context-memory` 行（enabled: true，YAML 校验通过）；
> 单元测试 53/53 PASS；服务即将延迟重启以加载插件。

## 重启后按序执行

1. **加载确认**：`Select-String "context-memory" %LOCALAPPDATA%\DSHHarness\logs\dsh-server-3080.log`（追加模式日志）
   与 guardian 日志；确认无 boot error、无 QUARANTINED。
   若插件导致启动失败：立即把预设行 `enabled: true` 改 false（或删除该行），再走一次延迟重启，然后回滚分析。
2. **真实运行观察**（本会话继续工作即为真实负载）：每个工作回合后检查
   `%LOCALAPPDATA%\DSHHarness\state\context-memory\*.json` 是否出现本会话 store、
   `[context-memory] projected ...` 日志行是否出现（阈值 50000 tokens 或 provider 切换触发）。
3. **Token A/B（real）**：从会话事件 usage 收集 inputTokens：
   用 node 脚本读本会话 `session.jsonl.zstd`（官方格式）或经 GUI/API 统计最近 N turn 的
   input tokens 序列，记录 total/avg/p95/max；与基线对比——
   基线 = 本仓库历史长会话（P2 阶段会话）同口径数据。若本阶段内拿不到足够长的真实任务，
   如实标注 partial/synthetic（已有单元级 synthetic ratio=0.054 @60 组肥会话）。
4. **Provider-switch（real）**：若自然发生 fallback/切换，记录激活日志与投影连续性；
   未发生则如实标注 synthetic（单元测试 T6 已覆盖判定逻辑）。
5. **Restart 恢复（real）**：本次重启本身即证据之一（store 跨重启恢复由 T5 单测覆盖 +
   实际 store 文件在重启后仍被读取）。
6. **REPORT_R1.md** 汇总 REAL/SYNTHETIC/INFERRED 三级证据 → commit → push → PR → CI → merge。
7. 状态置 `IMPLEMENTATION_COMPLETE / AWAITING_REVIEW`，更新 CURRENT_STATUS.md + Notion 99 页。
8. **停止。不进入 P3。**

## 回滚预案

- 快速停用：预设行改 `enabled: false`（或删行）→ 延迟重启。
- 完整回滚：git checkout main（分支未合入前）；删 profiles/web 两插件文件；store 文件残留无害。
- raw session 安全性：append-only 保证，任何情况下原始事件不可被本插件删除。
