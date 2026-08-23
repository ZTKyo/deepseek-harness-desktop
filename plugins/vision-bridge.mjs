// vision-bridge.mjs — 视觉桥接插件（无感图片解析，多级视觉 fallback）
//
// 目标：让 DeepSeek V4 Flash 这类纯文本模型也能"无感"接收图片——
// 用户在 GUI 上传图片后，本插件在 agent/pre-step 阶段拦截消息，
// 把其中的图片块自动交给视觉模型解析成文字描述，再用文字块替换图片块，
// DeepSeek 全程只看到文字。
//
// 视觉路由（按优先级，只有前一级失败才用下一级）：
//   1) OpenCode Go / MiMo-V2.5        （openai-completions，/chat/completions）
//   2) OpenCode Go / Qwen3.7-Plus     （anthropic-messages，/messages）
//   3) 小米官方 API / mimo-v2.5       （emergency fallback，开关控制）
// 两种 OpenCode Go 路径共用同一份 OPENCODE_API_KEY 凭证引用；小米路径用 MIMO_API_KEY。
// 当用户请求明确要求"逐字 OCR / 精确 UI 描述"等时，直接使用 Qwen3.7-Plus；
// 当 MiMo 返回 UNCERTAIN 标记（无法可靠识别）时自动升级到 Qwen3.7-Plus。
//
// 配合配置：
//   1) settings.yaml 的 llm-pi-ai.providers.<route>.models[].input 需声明
//      [text, image]，让 DSH 的"图片准入门禁"放行（本插件随后把图片转成文字，
//      API 端永远不会收到图片）。
//   2) 本文件挂载在 ~/.dsh/profiles/web/cordis.patch.yml：
//      - insert:
//          - id: vision-bridge
//            name: './vision-bridge.mjs'
//            config:
//              primaryModel: mimo-v2.5
//              fallbackModel: qwen3.7-plus
//              xiaomiFallbackEnabled: true
//              maxTokens: 1024
//
// 行为规则：
//   - 仅当"当前路由的模型不支持原生图片输入"时才转换；原生多模态模型
//     （如 xiaomi/mimo-v2.5 直连会话）直接透传图片，不受影响。
//   - 转换发生在消息进入会话历史之前，因此历史中只存文字，不会重复解析，
//     也不会污染后续 compaction / 标题生成 / 模型切换；重试 turn 复用已存文字。
//   - 历史清扫（防毒化，2026-08-15）：请求体由会话 store 的 surface 事件折叠而来，
//     pre-step 钩子只能看到"本轮新增消息"，历史里已存在的图片块（例如 read_image
//     工具结果的 tool/result 事件、早期原生多模态透传遗留的 user/message 图片）
//     永远不会被转换逻辑处理，text-only 模型（deepseek-*）每轮请求携带 image_url
//     会被上游 400 拒绝、会话永久卡死。清扫逻辑在 text-only 路由的每个 pre-step
//     扫描 store，用 surface replace 事件把含图片块的 surface 事件影子替换为文字版
//     （仅模型视角；人类侧 transcript 保留原图）。
//   - 图片只发送给当前实际选中的那一级视觉 provider，绝不广播给多个 provider。
//   - 所有视觉路径都失败时降级为占位文字，不让整个步骤崩溃。
//   - API Key 优先走 credentials 服务，找不到则回退读取 ~/.dsh/.credentials.yaml；
//     日志与输出中绝不打印密钥。
//
// 纯 ESM，无第三方依赖（仅用 Node 内置能力），通过 ctx 使用 host 服务。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "vision-bridge";
export const inject = ["llm", "attachments"];

const DEFAULT_PROMPT = [
  "你是图片解析助手（IMAGE_ANALYSIS）。请客观描述这张图片，只陈述你实际看到的内容：",
  "1) 图片类型（截图/照片/图表/报错窗口等）与一句话概括；",
  "2) 逐字提取图中所有可见文字（错误信息、数值、状态、文件名、行号等，保留原文）；",
  "3) 关键 UI 元素、控件、按钮、位置与相对布局；",
  "4) 明显的视觉异常；",
  "5) 无法可靠识别的内容明确列入 uncertain。",
  "输出为清晰、结构化的中文文本。",
  "如果你无法可靠识别图片内容（图片损坏、过于模糊、内容缺失等），请仅以 UNCERTAIN: <原因> 开头回复。",
].join("\n");

const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
const XIAOMI_BASE = "https://api.xiaomimimo.com/v1";

/** 需要精确视觉的用户请求关键词：命中时直接用 Qwen3.7-Plus（跳过 MiMo）。 */
const PRECISION_KEYWORDS = /逐字|OCR|精确|按钮|布局|控件|图标|坐标|ui|界面|位置/;

/** UNCERTAIN 标记：MiMo 无法可靠识别时升级到 Qwen。 */
const UNCERTAIN_MARK = /^\s*UNCERTAIN\b/i;

// ────────────────────────────────────────────────────────────
// 已验证"原生图片输入"的 provider+model 联合白名单（2026-08-22 实测，见 docs/）。
// 只放行"真实验证过能直接收图并答对"的 组合；同 model 名但未验证的 provider
// （opencode/deepseek-v4-flash-vision-exp、openrouter/... 等）一律不放行。
// 当前实测：provider=bai + model=deepseek-v4-flash-vision-exp → IMAGE_OK（正确回答左上角物体）。
// 名单格式："provider/model-basename"。可通过 config.verifiedNativeImageRoutes 配置扩展。
// Phase 02 R2 (BLOCKING-3): the verified native-image FACT list comes from the
// single Model Registry (VERIFIED_NATIVE_IMAGE); Vision only adds user-config
// extensions on top. No second truth source.
import { FACTS as REGISTRY_FACTS } from "./model-registry.mjs";
const DEFAULT_VERIFIED_NATIVE_IMAGE = [...(REGISTRY_FACTS.VERIFIED_NATIVE_IMAGE || [])];

/** 取模型 id 的基名（去掉 provider 前缀，如 deepseek/ deepseek-v4-flash-vision-exp → deepseek-v4-flash-vision-exp）。 */
export function baseModelId(modelId) {
  const id = String(modelId ?? "").trim();
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}
/** provider 归一化（小写、去空白）。 */
export function normalizeProvider(provider) {
  return String(provider ?? "").trim().toLowerCase();
}
/** 是否为 deepseek 家族（语义上保守 text-only 边界；按基名判定，兼容"provider/前缀"形式）。 */
export function isDeepseek(modelId) {
  return /^deepseek([-.]|$)/i.test(baseModelId(modelId));
}
/** 该 provider+model 组合是否在已验证原生图白名单中（联合匹配，缺一不可）。 */
export function isVerifiedNativeImageRoute(provider, modelId, allowlist) {
  const p = normalizeProvider(provider);
  const base = baseModelId(modelId).toLowerCase();
  const list = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : DEFAULT_VERIFIED_NATIVE_IMAGE;
  return list.some((x) => {
    const idx = String(x).indexOf("/");
    if (idx <= 0) return false;
    const xp = String(x).slice(0, idx).trim().toLowerCase();
    const xm = String(x).slice(idx + 1).trim().toLowerCase();
    return p === xp && base === xm;
  });
}

/**
 * 决策：当前路由（provider+model）能否"原生透传图片"（无需 MiMo 转述）。
 * @param {object|null} info resolveModelInfo 结果（含 inputModalities）
 * @param {string} provider 路由 provider（如 bai / opencode / openrouter）
 * @param {string} modelId 路由模型 id
 * @param {string[]} allowlist 已验证原生图 provider/model 白名单（"provider/model" 格式）
 * @returns {boolean} true=允许原生透传图片
 */
export function canPassThroughNativeImage(info, provider, modelId, allowlist) {
  const mods = Array.isArray(info?.inputModalities) ? info.inputModalities : [];
  if (!mods.includes("image")) return false;          // 模型声明不支持图片 → 转述
  const id = String(modelId ?? "");
  if (!isDeepseek(id)) return true;                    // 非 deepseek：声明支持即透传
  return isVerifiedNativeImageRoute(provider, id, allowlist); // deepseek：仅 provider+model 白名单透传
}

/** 插件配置（apply 时初始化），避免在 Cordis 上下文代理上挂自定义属性。 */
let settings = {
  primaryModel: "mimo-v2.5",
  fallbackModel: "qwen3.7-plus",
  xiaomiFallbackEnabled: true,
  xiaomiModel: "mimo-v2.5",
  maxTokens: 1024,
  timeoutMs: 120000,
  prompt: DEFAULT_PROMPT,
  verifiedNativeImageRoutes: DEFAULT_VERIFIED_NATIVE_IMAGE,
};

/** 预调用/原生透传计数器（进程内累计；重启清零）。用于端到端验收：XIAOMI_PRECALL_COUNT / MIMO_PRECALL_COUNT / DEEPSEEK_NATIVE_IMAGE_REQUEST。 */
const counters = {
  XIAOMI_PRECALL_COUNT: 0,      // 小米官方 API / MiMo 视觉预调用次数
  MIMO_PRECALL_COUNT: 0,        // 任何 MiMo 模型（OpenCode Go 或小米官方）视觉预调用次数
  DEEPSEEK_NATIVE_IMAGE_REQUEST: 0, // 原生图直达 DeepSeek 的请求次数
};

// 文件级诊断（仅 config.debugFile=true 时启用）：写入 ~/.dsh/vision-bridge-debug.log。
const DEBUG_FILE = path.join(os.homedir(), ".dsh", "vision-bridge-debug.log");
let debugEnabled = false;
function debugLog(line) {
  if (!debugEnabled) return;
  try {
    fs.appendFileSync(DEBUG_FILE, new Date().toISOString() + " " + line + "\n");
  } catch {}
}

/** 图片描述缓存：附件 ID -> 解析文字（同一张图只解析一次，重试 turn 复用）。 */
const cache = new Map();

/** 递归判断内容块中是否含图片块（含嵌套 tool-result）。 */
function hasImageBlocks(blocks) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      (block.type === "image" ||
        (block.type === "tool-result" && hasImageBlocks(block.content)))
  );
}

/** 拼接消息中的全部文本块（作为传给视觉模型的最小上下文）。 */
function messageText(blocks) {
  const parts = [];
  const walk = (list) => {
    for (const block of list) {
      if (block !== null && typeof block === "object") {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "tool-result" && Array.isArray(block.content)) walk(block.content);
      }
    }
  };
  walk(blocks);
  return parts.join("\n").trim();
}

/** 读取附件字节，返回 { data, mime }。 */
async function readAttachment(ctx, attachment, signal) {
  const stored = await ctx.attachments.readImage(attachment, signal);
  return {
    data: stored.data,
    mime: stored.ref?.mediaType ?? attachment.mediaType ?? "image/png",
  };
}

/** OpenAI Chat Completions（含 data URI 图片）。成功返回文本，失败抛错。 */
async function callOpenAICompletions(ctx, { endpoint, model, key }, prompt, b64, mime, signal) {
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    max_tokens: settings.maxTokens,
  };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
  }
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("空回复");
  return text.trim();
}

/** Anthropic Messages（base64 image block）。成功返回文本，失败抛错。 */
async function callAnthropicMessages(ctx, { endpoint, model, key }, prompt, b64, mime, signal) {
  const body = {
    model,
    max_tokens: settings.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        ],
      },
    ],
  };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
  }
  const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (typeof text !== "string" || text.trim().length === 0) throw new Error("空回复");
  return text.trim();
}

/** 密钥解析：credentials 服务优先，回退 ~/.dsh/.credentials.yaml（按键名）。 */
const keyCache = new Map();
async function resolveApiKey(ctx, envName) {
  if (keyCache.has(envName)) return keyCache.get(envName);
  let value;
  try {
    const credentials = ctx.get("credentials");
    const hit = credentials?.resolve ? await credentials.resolve(envName) : undefined;
    if (hit?.value) value = String(hit.value).trim();
  } catch (error) {
    ctx.logger.warn(`vision-bridge: credentials 服务读取 ${envName} 失败（${String(error?.message ?? error)}），尝试直接读取配置文件`);
  }
  if (!value) {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const text = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const match = text.match(new RegExp(`^\\s*${envName}\\s*:\\s*(.+?)\\s*$`, "m"));
    if (!match?.[1]) throw new Error(`vision-bridge: 找不到 ${envName}`);
    value = match[1].trim();
  }
  keyCache.set(envName, value);
  return value;
}

/** 对一张图片执行多级视觉路由，返回最终文本（绝不抛错，全失败给占位）。 */
async function describeImage(ctx, attachment, signal, userText) {
  const id = String(attachment.attachmentId ?? "unknown");
  const hit = cache.get(id);
  if (hit !== undefined) return hit;

  let b64;
  let mime;
  try {
    const img = await readAttachment(ctx, attachment, signal);
    b64 = Buffer.from(img.data).toString("base64");
    mime = img.mime;
  } catch (error) {
    const text = `[图片解析失败：无法读取附件（${String(error?.message ?? error)}）]`;
    cache.set(id, text);
    return text;
  }

  const prompt = `${settings.prompt}\n\n用户的请求（与此图片直接相关）：${userText || "（无附加说明）"}`;
  const needPrecision = PRECISION_KEYWORDS.test(userText ?? "");
  const failures = [];

  // 视觉路由链：每级成功且非 UNCERTAIN 即返回；否则进入下一级。
  const opencodeKey = () => resolveApiKey(ctx, "OPENCODE_API_KEY");
  const xiaomiKey = () => resolveApiKey(ctx, "MIMO_API_KEY");

  const levels = [];
  if (!needPrecision) {
    levels.push({
      name: "OpenCode Go / MiMo-V2.5",
      run: async () => {
        counters.MIMO_PRECALL_COUNT += 1; // MiMo 模型视觉预调用（经 OpenCode Go）
        return callOpenAICompletions(
          ctx,
          { endpoint: `${OPENCODE_BASE}/chat/completions`, model: settings.primaryModel, key: await opencodeKey() },
          prompt,
          b64,
          mime,
          signal
        );
      },
    });
  }
  levels.push({
    name: "OpenCode Go / Qwen3.7-Plus",
    run: async () =>
      callAnthropicMessages(
        ctx,
        { endpoint: `${OPENCODE_BASE}/messages`, model: settings.fallbackModel, key: await opencodeKey() },
        prompt,
        b64,
        mime,
        signal
      ),
  });
  if (settings.xiaomiFallbackEnabled) {
    levels.push({
      name: "小米官方 API / MiMo",
      run: async () => {
        counters.XIAOMI_PRECALL_COUNT += 1; // 小米官方 API 视觉预调用
        return callOpenAICompletions(
          ctx,
          { endpoint: `${XIAOMI_BASE}/chat/completions`, model: settings.xiaomiModel, key: await xiaomiKey() },
          prompt,
          b64,
          mime,
          signal
        );
      },
    });
  }

  for (const level of levels) {
    try {
      const text = await level.run();
      if (UNCERTAIN_MARK.test(text)) {
        failures.push(`${level.name}: 返回 UNCERTAIN（无法可靠识别）`);
        continue;
      }
      cache.set(id, text);
      return text;
    } catch (error) {
      if (signal?.aborted) throw error; // 用户取消：让步骤正常中止
      failures.push(`${level.name}: ${String(error?.message ?? error)}`);
      ctx.logger.warn(`vision-bridge: ${level.name} 失败（${String(error?.message ?? error)}），尝试下一级`);
    }
  }

  const text = `[图片解析失败：${failures.join("；")}]`;
  cache.set(id, text);
  return text;
}

/** 递归转换内容块：image -> 文字描述；tool-result 内嵌图片递归处理。 */
async function transformBlocks(ctx, blocks, signal, userText) {
  const out = [];
  for (const block of blocks) {
    if (block !== null && typeof block === "object" && block.type === "image") {
      const description = await describeImage(ctx, block.attachment, signal, userText);
      const name = block.attachment?.name;
      out.push({
        type: "text",
        text: `[用户上传的图片${name ? `（${name}）` : ""}已由视觉模型自动解析：\n${description}\n]`,
      });
    } else if (
      block !== null &&
      typeof block === "object" &&
      block.type === "tool-result" &&
      hasImageBlocks(block.content)
    ) {
      out.push({ ...block, content: await transformBlocks(ctx, block.content, signal, userText) });
    } else {
      out.push(block);
    }
  }
  return out;
}

/** 判断一个 surfaceOp 是否为 replace 操作（harness 的 surface 折叠语义）。 */
function isReplaceOp(op) {
  return (
    op !== null &&
    typeof op === "object" &&
    op.op === "replace" &&
    Number.isSafeInteger(op.start) &&
    Number.isSafeInteger(op.end)
  );
}

/** 各 agent 已扫描到的最大事件 seq（模块级状态，按 agent 会话隔离）。 */
const sweptSeqs = new Map();

/**
 * 历史图片块清扫（防毒化，2026-08-15 新增）：
 * 请求体由会话 store 的 surface 事件折叠而来，pre-step 钩子只能看到"本轮新增消息"，
 * 因此历史里已存在的图片块（read_image 工具结果的 tool/result 事件、早期原生多模态
 * 会话透传遗留的 user/message 图片）永远不会被现有转换逻辑处理，text-only 模型
 * （deepseek-*）每轮请求携带 image_url 会被上游 400 拒绝，会话永久卡死。
 *
 * 本函数在 text-only 路由的每个 pre-step 扫描 store 事件，把含图片块的 surface 事件
 * 用 surface replace 事件影子替换为文字版（仅模型视角；人类侧 transcript 保留原图）。
 * 替换事件与原文除 content 外完全一致（tool/result 替换受 harness 的
 * assertToolResultRewrite 约束：仅允许改 content，且 content[0] 结构不变）。
 * 任何失败只记日志，绝不阻塞或破坏当前步骤。
 */
async function sweepHistoryImages(ctx, agent, signal) {
  const session = agent?.session;
  if (!session || typeof session.append !== "function" || !Array.isArray(session.events)) return;
  const agentId = String(agent?.id ?? "unknown");

  // 第一遍：收集所有已被 replace 影子的 seq（服务重启后重扫时避免重复替换）。
  const shadowed = new Set();
  for (const event of session.events) {
    if (event !== null && typeof event === "object" && isReplaceOp(event.surfaceOp)) {
      for (let seq = event.surfaceOp.start; seq <= event.surfaceOp.end; seq++) shadowed.add(seq);
    }
  }

  let last = sweptSeqs.get(agentId) ?? 0;
  let maxSeq = last;
  for (const event of session.events) {
    if (event === null || typeof event !== "object") continue;
    const seq = event.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    if (seq > maxSeq) maxSeq = seq;
    if (seq <= last) continue;
    if (event.type !== "tool/result" && event.type !== "user/message") continue;
    const msg = event.type === "tool/result" ? event.data?.message : event.data;
    if (!msg || !Array.isArray(msg.content) || !hasImageBlocks(msg.content)) continue;
    if (shadowed.has(seq)) continue;
    if (signal?.aborted) return;
    try {
      const userText = messageText(msg.content);
      const content = await transformBlocks(ctx, msg.content, signal, userText);
      session.append(event.type, { ...event.data, message: { ...msg, content } }, {
        surfaceOp: { op: "replace", start: seq, end: seq },
        sourceEventSeqs: [seq],
      });
      ctx.logger.info(`vision-bridge: 已清扫历史图片块（${event.type} seq=${seq}，agent=${agentId}）`);
    } catch (error) {
      ctx.logger.warn(`vision-bridge: 历史图片块清扫失败（${event.type} seq=${seq}）：${String(error?.message ?? error)}`);
    }
  }
  sweptSeqs.set(agentId, maxSeq);
}

/** Cordis 插件入口。 */
export function apply(ctx, config = {}) {
  settings = {
    primaryModel: config.primaryModel ?? "mimo-v2.5",
    fallbackModel: config.fallbackModel ?? "qwen3.7-plus",
    xiaomiFallbackEnabled: config.xiaomiFallbackEnabled ?? true,
    xiaomiModel: config.xiaomiModel ?? "mimo-v2.5",
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 120000,
    prompt: config.prompt ?? DEFAULT_PROMPT,
    verifiedNativeImageRoutes: config.verifiedNativeImageRoutes ?? DEFAULT_VERIFIED_NATIVE_IMAGE,
  };
  debugEnabled = !!config.debugFile;
  ctx.logger.info(
    `vision-bridge: 已挂载（主=${settings.primaryModel}@OpenCodeGo，fallback=${settings.fallbackModel}@OpenCodeGo，小米emergency=${settings.xiaomiFallbackEnabled ? "开" : "关"}；verifiedNativeImageRoutes=[${settings.verifiedNativeImageRoutes.join(",")}]）`
  );

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter") {
      debugLog(`pre-step: kind=${decision.kind} (skip)`);
      return decision;
    }

    // 原生多模态模型直连时直接透传（如 xiaomi/mimo-v2.5、opencode/mimo-v2.5、qwen3.7-plus）。
    // 注意：settings.yaml 中 opencode/bai 的 DeepSeek 文本模型为放行"图片准入门禁"而声明了
    // input: [text, image]，resolveModelInfo 会如实返回 image 能力——但那只是门禁声明，
    // 深版 seek 文本模型（deepseek-* 非 vision 系列）实际不收图，必须仍走桥接转换。
    // 2026-08-22 迁移：只对"provider+model 联合白名单"内已验证的组合放行原生图
    // （当前仅 bai/deepseek-v4-flash-vision-exp）；同 model 名但未验证的 provider 不放行。
    const provider = String(agent.options.provider ?? "");
    const modelId = String(agent.options.model ?? "");
    let nativeImage = false;
    try {
      const info = await ctx.llm.resolveModelInfo(agent.options.provider, agent.options.model, signal);
      nativeImage = canPassThroughNativeImage(info, provider, modelId, settings.verifiedNativeImageRoutes);
      debugLog(`pre-step: provider=${provider} model=${modelId} inputModalities=${JSON.stringify(info?.inputModalities)} nativeImage=${nativeImage}`);
    } catch (e) {
      nativeImage = false; // 无法判定时保守转换，避免图片到达纯文本 API
      debugLog(`pre-step: resolveModelInfo threw: ${String(e?.message ?? e)}`);
    }
    if (nativeImage) {
      if (decision.messages.some((message) => hasImageBlocks(message.content))) {
        counters.DEEPSEEK_NATIVE_IMAGE_REQUEST += 1;
        ctx.logger.info(`vision-bridge: TURN_STATS ${JSON.stringify({ ...counters, provider, model: modelId, native: "passthrough" })}`);
        debugLog(`TURN_STATS ${JSON.stringify({ ...counters, provider, model: modelId, native: "passthrough" })}`);
      }
      return decision;
    }

    // 历史图片块清扫（防毒化）：text-only 路由下，把 store 中已存在的图片块
    // （read_image 工具结果等）以 surface replace 事件替换为文字（仅模型视角），
    // 防止"图片块留在历史 → 每轮请求 400"的会话毒化。
    try {
      await sweepHistoryImages(ctx, agent, signal);
    } catch (e) {
      debugLog(`pre-step: sweepHistoryImages threw: ${String(e?.message ?? e)}`);
    }

    const hasImages = decision.messages.some((message) => hasImageBlocks(message.content));
    debugLog(`pre-step: nativeImage=${nativeImage} messages=${decision.messages?.length ?? "?"} hasImages=${hasImages}`);
    if (!hasImages) return decision;

    ctx.logger.info(`vision-bridge: TURN_STATS ${JSON.stringify({ ...counters, provider, model: modelId, native: "bridge-transform" })}`);
    debugLog(`TURN_STATS ${JSON.stringify({ ...counters, provider, model: modelId, native: "bridge-transform" })}`);

    const messages = [];
    for (const message of decision.messages) {
      if (!hasImageBlocks(message.content)) {
        messages.push(message);
        continue;
      }
      const userText = messageText(message.content);
      const content = await transformBlocks(ctx, message.content, signal, userText);
      messages.push({ ...message, content });
    }
    return { ...decision, messages };
  });
}
