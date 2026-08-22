# DeepSeek Native Multimodal Migration

移除旧的「image → Xiaomi/MiMo → DeepSeek」兼容路径，改为「image → Harness 原生多模态 → DeepSeek 直达」。

> 分支：`fix/deepseek-native-multimodal`（from `main`）
> 2026-08-22

## ROOT CAUSE

旧行为由两层共同造成：

1. **`vision-bridge.mjs`**（运行时 `agent/pre-step` 钩子，所有 provider 生效）
   用 `!/^deepseek([-.]|$)/i` 把**所有 `deepseek-*` 模型一律判为 text-only**，即使该模型已声明/支持原生图片，
   也会在请求进入历史前把图片块交给 MiMo 转成文字，DeepSeek 全程只见文字。
   - 这是当前实际运行路径（`bai/deepseek-v4-flash-vision-exp`）上的真正「桥」。

2. **`openrouter-router-core.mjs`**（仅 `provider=openrouter` 的 `model=auto`）
   `CAPABILITY.deepseek.input = ["text"]` + Rule 2 `multimodal → mimo`。
   **经实测该默认对 OpenRouter 的 DeepSeek 是对的**（见下），因此不删除该默认行为，
   只做最小 capability 区分。

## 实测：真实 DeepSeek 模型的原生图片能力（关键证据）

用一张**新生成的测试图片**（左上角红色圆形）直接对候选端点发送原生 `image_url` 块：

| 路由 | 结果 |
|------|------|
| `bai/deepseek-v4-flash-vision-exp`（当前默认模型） | **IMAGE_OK**，正确回答「红色圆形/圆形」 |
| `bai/deepseek-v4-flash` | 400 `This model does not support image` → text-only |
| `openrouter/deepseek/deepseek-v4-flash-0731` | 404 `No endpoints found that support image input` → **text-only** |
| `opencode/deepseek-v4-flash` / `-vision-exp` | 429（额度限制，无法核验；不影响结论） |

结论：**只有 `deepseek-v4-flash-vision-exp` 与 `*-vision-exp` 系列是真正原生图片模型**；
OpenRouter 上的 `deepseek/deepseek-v4-flash-0731` 确实是 text-only。**不能一刀切把「所有 deepseek = image capable」。**

## 修改

### `vision-bridge.mjs`
- 新增 `DEFAULT_DEEPSEEK_NATIVE_IMAGE_MODELS`（已验证原生图 DeepSeek 白名单，默认 `deepseek-v4-flash-vision-exp`），
  可用 `config.deepseekNativeImageModels` 扩展。
- 新增纯函数 `canPassThroughNativeImage(info, modelId, allowlist)`（导出，可单测）：
  - 模型声明支持图片 + **非 deepseek** → 原生透传；
  - 模型声明支持图片 + **deepseek 且 base id 在白名单** → 原生透传；
  - 其余 deepseek-* → 仍保守走 MiMo 转述（防图片被发到纯文本模型 → 400 会话毒化）。
- pre-step 用该函数判定，代替原 `!/^deepseek/` 一刀切。
- 顺带修复潜在 bug：`isDeepseek` 改按 `baseModelId` 判定，兼容 `deepseek/deepseek-...`（provider 前缀）形式，
  避免带前缀的 text-only deepseek 被误判为非 deepseek。
- `isDeepseek` / `isDeepseekNativeVision` / `baseModelId` / `canPassThroughNativeImage` 已导出，便于单测。

### `openrouter-router-core.mjs`
- **保持** `CAPABILITY.deepseek = ["text"]`（OpenRouter 的 DeepSeek 实测 text-only，该默认正确）。
- 新增 `VERIFIED_VISION_DEEPSEEK_IDS`（实测集合）与 `aliasSupportsModality(alias, modality, cfg)`：
  当 `deepseek` alias 解析到的具体模型 id 命中该集合时，才向上修正为「支持图片」。
- `route()`：`deepseekImageCapable` 决定纯图片请求走 deepseek 还是 mimo；
  `audio`/`video` 恒走 MiMo（DeepSeek 不支持）。默认（text-only alias）行为完全不变。
- **未改动** `KNOWN_ROUTING_MODES` / `explicit_model_passthrough`（PR #4 的 exact-model invariant 保持）。

## 测试

- 新增 `tests/router/test-deepseek-native-multimodal.mjs`：T1-T7 逻辑断言，28 项全过。
- 既有 `tests/router/test-exact-model-preservation.mjs`：9/9 全过（无缝回归）。
- 机器可读动态验收（真机，未重启服务）：`XIAOMI_PRECALL_COUNT=0`，`DEEPSEEK_NATIVE_IMAGE_REQUEST=1`，
  DeepSeek 正确答出左上角物体，证明图片以原生 `image_url` 块直达 DeepSeek。

## MiMo 保留

未删除 Xiaomi/MiMo provider。MiMo 仍用于：
- 用户显式选择 `mimo`；
- `audio`（DeepSeek 不支持）；
- `video`（DeepSeek 不支持）；
- 纯文本 DeepSeek 路由下的图片转述兜底。

仅取消「只要有图片就强制走 MiMo」这一规则。

## 说明

- 运行时已部署修改后的 `vision-bridge.mjs` / `openrouter-router-core.mjs`（有备份），
  但宿主插件在服务启动时加载，**需重启 3080 服务才生效**（未在本次任务内执行重启，避免中断）。
- 保留 `bai/deepseek-v4-flash-vision-exp` 为 `agent-default-model` 不变。
