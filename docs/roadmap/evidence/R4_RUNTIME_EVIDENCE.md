# R4 运行时证据 — 会话日志 token 计量与模型路由实测（2026-08-26）

## 方法
- 对 4 个真实生产会话日志（`~/.dsh/sessions/.../session.jsonl.zstd`）做**只读**解码分析：
  拷贝到临时目录 → 自研多帧 zstd 遍历解码器逐帧解出全部 JSONL → 折叠
  `request/header`（模型路由）与 `assistant/message`+`assistant/chunk(usage)`（提供商真报 usage）。
- 解码器：`cm-r4-log-decoder.mjs` / 统计：`cm-r4-route-stats.mjs`（本目录，node >=22 原生 zlib zstd）。
- 覆盖：208 ~ 40,317 行；最大单会话 **29,329 个独立 zstd 帧、0 坏行、尾部 0 残留字节** → 文件为
  「每次追加一个完整帧」的拼接布局，帧遍历算法可无损重建任意前缀。

## 权威事实链（R4 设计依据）

1. **A/B 值免费可得，无需新遥测通道**
   B_i（第 i 步实际请求压力）= 第 i 步 `assistant/message.data.usage` 的
   `inputTokens + cacheReadTokens + cacheWriteTokens`（= 官方 TokenMeter `pressureFrom` 口径）。
   A_{i+1} 即下一条 message 的同一字段。每步有 chunk(usage)+message 双采样，message 为最终值。

2. **`request/header` 持久化了每次调用的完整 LlmCallConfig**
   （provider/model/maxTokens/…），且仅在变化时记录（canonical 等值去重）。当前大会话的
   7 次真实路由切换被精确重建：ox-alpha→commandcode→ox-alpha→bai→commandcode→zhipu→bai→zhipu
   （切换点 seq：91626 / 166932 / 169431 / 290691 / 532852 / 546940 / 554814）。
   任何离线进程 fold 日志即可得知「每个历史请求用的什么模型」——context-memory 的
   per-model 记忆策略有了零成本判定源。

3. **各提供商缓存回报质量差异巨大（同会话内实测）**

| 路由 | 样本 | 平均压力 tok | p95 | 平均步增长 tok | cacheRead 占比 |
|---|---|---|---|---|---|
| openrouter/stealth/ox-alpha | 101 | 136,747 | **194,868** | +2,157 | 95% |
| commandcode/deepseek-v4-flash | 405 | 58,543 | 77,463 | +1,075 | **88%** |
| bai/deepseek-v4-flash | 239 | 51,174 | 64,533 | **+2,875** | **45%** |
| zhipu/glm-5.3-flash | 98 | 73,758 | 88,997 | +1,883 | 75%（断续：有步全量 68,026 未命中）|

   - bai 缓存最差（45%）→ 每步约半数上下文按未缓存价计费；
   - commandcode 最优（88%、步增长最小）；
   - zhipu 的 cR 命中不稳定（相邻两步 66,240 命中 vs 68,026 全量未命中），注入器若频繁改写
     提示词前缀会加剧打碎其前缀缓存。
   - 纯 message 级 usage **100% 非零可用**；仅个别空步骤 chunk 上报全 0（可按 seq 去噪）。

4. **上下文压力实测规模**
   - 单 turn 内逐步单调增长（跨步对 100% 不相等——pairStats 中 eqPairs 全部来自同 step 双采样）。
   - 当前主会话 p95 已达 194K tokens（ox-alpha），compaction/prune 在该会话发生 217 次。
   - 每步平均真实新增仅 ~1–3K tokens → context-memory 注入预算应以千级 tokens 为单位，
     且记忆应放**消息尾部**而非系统提示头部，避免打碎 provider 前缀缓存（zhipu 尤甚）。

## R4 结论（可直接落设计）
- TokenMeasurement/Baseline 体系已能把 provider usage 变成权威锚点；R4 无需自建计量，
  只需消费日志（或挂 projection view）即可获得每步精确 A/B 与路由史。
- 记忆注入的成本模型可给出硬数字：注入 N tok 到 bai ≈ 全价 ×N×后续每步重付（45% 命中），
  注入到 commandcode ≈ 仅首次步付（88% 命中后进缓存）。选路由即选成本曲线。
- 佐证数据原件：`R4_PROBE_RAW_OUTPUT.json`（crossings/switches/pairStats）、
  `R4_ROUTE_STATS_RAW_OUTPUT.json`（分路由统计）。
