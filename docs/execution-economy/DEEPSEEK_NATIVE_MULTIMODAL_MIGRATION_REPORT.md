# DeepSeek Native Multimodal Migration

移除旧的「image → Xiaomi/MiMo → DeepSeek」兼容路径，改为「image → Harness 原生多模态 → DeepSeek 直达」。

> 分支：`fix/deepseek-native-multimodal`（from `main`）
> 2026-08-22（收口版：provider+model 联合白名单 / 回滚 OpenRouter core 改动 / 测试入 CI L1）

## ROOT CAUSE

旧行为由**运行时插件 `vision-bridge.mjs`** 造成（`agent/pre-step` 钩子，所有 provider 生效）：
- 它用 `!/^deepseek([-.]|$)/i` 把**所有 `deepseek-*` 模型一律判为 text-only**，
  即使模型已声明/支持原生图片，也会在请求进入历史前把图片块交给 MiMo 转成文字，DeepSeek 全程只见文字。
- 这是当前实际运行路径（`bai/deepseek-v4-flash-vision-exp`）上的真正「桥」。

`openrouter-router-core.mjs` 的 `CAPABILITY.deepseek=["text"]` + `multimodal→mimo` **仅对 OpenRouter 的 `model=auto` 生效**，
且实测 OpenRouter 的 `deepseek/deepseek-v4-flash-0731` 确实是 text-only（404 no endpoints support image），
因此**该默认正确、予以保留**。本 PR **不修改** `openrouter-router-core.mjs`（已整体回滚到 main 状态，
不含任何 Vision capability 改动；OpenRouter 未来若出现可用 Vision endpoint，另行验证后再加）。

## 实测：真实 DeepSeek 模型的原生图片能力（关键证据）

用一张**新生成的测试图片**（左上角红色圆形）直接对候选端点发送原生 `image_url` 块：

| 路由 | 结果 |
|------|------|
| `bai/deepseek-v4-flash-vision-exp`（当前默认模型） | **IMAGE_OK**，正确回答「红色圆形/圆形」 |
| `bai/deepseek-v4-flash` | 400 `This model does not support image` → text-only |
| `openrouter/deepseek/deepseek-v4-flash-0731` | 404 `No endpoints found that support image input` → **text-only** |
| `opencode/deepseek-v4-flash` / `-vision-exp` | 429（额度限制，无法核验；不影响结论） |

结论：**只验证过 `provider=bai` + `model=deepseek-v4-flash-vision-exp` 这一个组合是原生图片**；
同 model 名在 opencode/openrouter 等其他 provider 上**未经实测，一律不放行**。

## 修改（仅 `vision-bridge.mjs` + 测试 + CI）

### `vision-bridge.mjs`
- **provider+model 联合白名单** `DEFAULT_VERIFIED_NATIVE_IMAGE = ["bai/deepseek-v4-flash-vision-exp"]`
  （格式 `"provider/model-basename"`），可用 `config.verifiedNativeImageRoutes` 扩展。
- 新增/导出纯函数：
  - `normalizeProvider(provider)`、`isVerifiedNativeImageRoute(provider, modelId, allowlist)`（联合匹配，缺一不可）；
  - `canPassThroughNativeImage(info, provider, modelId, allowlist)` —— **必须拿到 provider**。
- 判定语义：
  - 模型未声明 image 能力 → 转述（false）；
  - 非 deepseek（mimo/qwen 等）声明支持 → 原生透传（true）；
  - deepseek → **仅当 `provider+model` 命中白名单**才原生透传；否则保守走 MiMo 转述。
- 计数器（进程内，重启清零）：`XIAOMI_PRECALL_COUNT`（小米官方 API 预调用）、
  `MIMO_PRECALL_COUNT`（任意 MiMo 模型预调用）、`DEEPSEEK_NATIVE_IMAGE_REQUEST`（原生图直达 DeepSeek）。
  每个含图 pre-step 输出 `TURN_STATS` 日志行，供端到端验收 grep。

### 测试
- `tests/router/test-deepseek-native-multimodal.mjs`：T1-T7（provider+model 版），25 项全过。
  关键用例：`opencode/deepseek-v4-flash-vision-exp`、`openrouter/deepseek-v4-flash-vision-exp`
  等**同名但未验证 provider → 不放行**（nativeImage=false，旧安全 fallback 保留）。
- 既有 `tests/router/test-exact-model-preservation.mjs`：9/9 全过（PR #4 invariant 未动）。

### CI L1
- 在 `ci-level1.yml` 新增独立 step「DeepSeek native multimodal tests (pure)」，
  运行 `node tests\router\test-deepseek-native-multimodal.mjs`；既有 check 名称全部不变。

## 动态验收（受控重启 + 真实 Harness session）

- 重启 3080 服务加载新 `vision-bridge` 后，用**全新图片**经真实 session 验证：
  `provider=bai`、`model=deepseek-v4-flash-vision-exp`、image modality 直达 DeepSeek、
  `XIAOMI_PRECALL_COUNT=0`、`MIMO_PRECALL_COUNT=0`、能回答必须看图的问题。
- 另验证 text-only DeepSeek（`bai/deepseek-v4-flash`、`openrouter/deepseek/deepseek-v4-flash-0731`）
  仍不会直接收到图片（旧安全 fallback 保留）。
- 结束后 `primary` 恢复原值（`bai/deepseek-v4-flash-vision-exp` 不变）、COMMIT_READY PASS、Guardian PASS。

## MiMo 保留

未删除 Xiaomi/MiMo provider。MiMo 仍用于：显式选择 `mimo`；`audio`（DeepSeek 不支持）；
`video`（DeepSeek 不支持）；未验证/纯文本 DeepSeek 路由下的图片转述兜底。
仅取消「只要有图片就强制走 MiMo」这一规则。
