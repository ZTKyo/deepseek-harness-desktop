// openrouter-router.mjs —— 『model=auto』三模型路由 宿主插件（单一真源）
//
// 机制：
//  - 监听 agent/request 瀑布（服务启动即注册 → 在最外层），把 provider=openrouter 且
//    model=auto（或已显式选定具体模型）的请求改写为 openrouter-router-core 决策出的
//    具体模型 id。其他 provider（opencode/deepseek/xiaomi 直连）一律不干预。
//  - 监听 agent/request-error：先让既有 dsh-llm-retry 处理『同模型重试』；当其放弃时，
//    若属于路由级失败（配额/超时/模型不可用等）才做『跨模型 fallback』（按决策链推进）。
//  - 质量升级：quality 校验钩子失败时可 escalate（Qwen → DeepSeek，一次性、有上限）。
//  - 无密钥、无 token 落盘：日志只记录请求/模型/规则/上下文估算等非敏感字段。
//
// 配置（环境变量，均可缺省）：
//   OPENROUTER_QWEN_MODEL / OPENROUTER_DEEPSEEK_MODEL / OPENROUTER_MIMO_MODEL
//   ROUTER_LONG_CONTEXT_THRESHOLD / ROUTER_MAX_RETRIES / ROUTER_MAX_ESCALATIONS
//   ROUTER_DIAGNOSTICS=true 时把不敏感的路由决定追加到日志文件 ~/.dsh/router-diagnostics.log

import { route, resolveConfig, classifyTask, detectModalities, detectStrictJson, ALIASES, CAPABILITY } from "./openrouter-router-core.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "openrouter-router";

const DEFAULT_DEEPSEEK = "deepseek/deepseek-v4-flash-0731";
// 路由级失败码（跨模型 fallback 候选）；其余错误交给既有重试/错误链
const ROUTING_FAILURE_RE = /(429|5\d{2}|timeout|timed\s*out|etimedout|econnreset|econnrefused|enotfound|rate\s*limit|overloaded|model[_ ]not[_ ]found|insufficient[_ ]quota|context[_-]window|finance|keepalive)/i;
// Provider 级失败：网络/配额/服务端问题（走 fallback chain）
const PROVIDER_FAILURE_RE = /(429|5\d{2}|timeout|timed\s*out|etimedout|econnreset|econnrefused|enotfound|rate\s*limit|overloaded|insufficient[_ ]quota|finance|keepalive)/i;
// 模型质量失败：tool error / 能力不足 / 空响应（走 escalation / 主力回落）
const QUALITY_FAILURE_RE = /(tool[_ ]error|tool[_ ]failed|invalid[_ ]response|capability|not[_ ]supported|function[_ ]call|json[_ ]parse|structured[_ ]output|empty[_ ]response|empty response|no[_ ]content|empty|zero[_ ]tokens|no[_ ]output)/i;
// 空响应/无输出失败（主力 empty response 的专门匹配，触发跨 provider 回落）
const EMPTY_RESPONSE_RE = /(empty[_ ]response|empty response|no[_ ]content|zero[_ ]tokens|no[_ ]output|empty|returned an empty)/i;

function diagnosticsPath() {
  const custom = process.env.ROUTER_DIAGNOSTICS_FILE;
  if (custom && custom.length > 0) return custom;
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, ".dsh", "router-diagnostics.log");
}
let fileLogEnabled = false;
function logDiag(line) {
  if (!fileLogEnabled) return;
  try {
    fs.appendFileSync(diagnosticsPath(), new Date().toISOString() + " " + line + "\n");
  } catch {}
}
function logDiagVolume(sid, fields) {
  if (!fileLogEnabled) return;
  logDiag(JSON.stringify({ sid, ts: Date.now(), ...fields }));
}
function isRoutingFailure(failure) {
  const m = (failure && (failure.message || failure.code || "")) || "";
  return ROUTING_FAILURE_RE.test(m);
}
function isProviderFailure(failure) {
  const m = (failure && (failure.message || failure.code || "")) || "";
  return PROVIDER_FAILURE_RE.test(m);
}
function isQualityFailure(failure) {
  const m = (failure && (failure.message || failure.code || "")) || "";
  return QUALITY_FAILURE_RE.test(m);
}
function isEmptyResponse(failure) {
  const m = (failure && (failure.message || failure.code || "")) || "";
  return EMPTY_RESPONSE_RE.test(m);
}
// PRIMARY 概念：当前默认主力（settings 真源 = opencode/deepseek-v4-flash）
// 常量仅标识"是否是需要跨 provider 保护的模型"，具体映射来自 settings/provider-registry
function isPrimaryModel(model, provider) {
  const m = String(model || "");
  return (provider === "opencode" && (m === "deepseek-v4-flash" || m === "deepseek-v4-flash-free"));
}
// 从 request-error payload 提取失败的模型名
function resolvedModelOf(payload) {
  try {
    return payload?.resolved?.model ?? payload?.model ?? payload?.request?.model ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 session 推导路由所需的信号（尽力而为，绝不抛错）。
 */
function buildSignal(ctx, agent) {
  const out = { modalities: [], text: "", toolsActive: false, estimated: 0, strictJson: false };
  try {
    const session = agent?.session;
    if (!session) return out;
    let msgs = [];
    try {
      msgs = session.deriveMessages?.() ?? [];
    } catch {}
    out.estimated = estimateContextTokens(ctx, session, msgs);
    // 分类器：取最后一条"非系统注入"的用户消息（跳过 <system-reminder>, 技能目录, 工作区指令等）。
    // 如果全部被跳过，则回退到原始最后一条用户消息。
    const allUserMsgs = (msgs || []).filter((m) => m && m.role === "user" && m.content);
    const isNoise = (m) => {
      if (!m || !m.content) return true;
      const str = Array.isArray(m.content) ? m.content.map((b) => (b?.text ?? b?.content ?? "")).join(" ") : typeof m.content === "string" ? m.content : "";
      return str.includes("<system-reminder>") || str.includes("<available_skills>") || str.includes("Instructions from:") || str.includes("workspace instructions may be relevant") || str.startsWith("Current runtime context") || str.startsWith("A skill is a reusable") || str.includes("The following workspace instructions may be relevant");
    };
    let lastRealIdx = -1;
    for (let ri = allUserMsgs.length - 1; ri >= 0; ri--) { if (!isNoise(allUserMsgs[ri])) { lastRealIdx = ri; break; } }
    const classifierMsg = lastRealIdx >= 0 ? allUserMsgs[lastRealIdx] : allUserMsgs[allUserMsgs.length - 1];
    const extractText = (m) => {
      if (!m) return "";
      if (Array.isArray(m.content)) return m.content.filter((b) => b && (b.type === "text" || typeof b.text === "string")).map((b) => (b.text ?? b.content ?? "")).join(" ");
      return typeof m.content === "string" ? m.content : "";
    };
    out.text = extractText(classifierMsg).slice(-4000);
    // 多模态：扫描最近几条消息的 content 块
    out.modalities = detectModalities(msgs.slice(-6));
    if (classifierMsg) {
      const c = classifierMsg.content;
      out.strictJson = detectStrictJson(Array.isArray(c) ? c.map((b) => (b.text ?? "")).join(" ") : typeof c === "string" ? c : "");
    }
    const text = out.text.toLowerCase();
    out.toolsActive =
      /(调用工具|调用函数|工具调用|使用工具|tool[_ ]call|tool calling|get_router_test_value|执行命令|跑命令)/.test(text) ||
      hasToolCallsInTurn(session);
  } catch {}
  return out;
}

function hasToolCallsInTurn(session) {
  try {
    const events = session.events;
    if (!events) return false;
    let openTurn = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === "turn/start") {
        openTurn = ev.data.turn;
        break;
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (openTurn !== null && ev.type === "assistant/message" && ev.data?.turn === openTurn) {
        const content = ev.data?.message?.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === "tool-call")) return true;
      }
      if (ev.type === "turn/end") {
        const t = ev.data?.turn;
        if (openTurn === null || t === null || t === undefined || t >= (openTurn ?? 0)) {
          if (openTurn === null) break;
        }
      }
    }
  } catch {}
  return false;
}

function estimateContextTokens(ctx, session, msgs) {
  try {
    const meter = ctx.get?.("tokenMeter");
    if (meter && meter.measure && session) {
      const m = meter.measure(session);
      if (m && Number.isFinite(m.totalTokens)) return Math.round(m.totalTokens || 0);
    }
  } catch {}
  try {
    // 兜底：字符数估算（中文≈1字≈0.8~1 token，英文≈4字符≈1 token；取 /3 保守）
    let chars = 0;
    for (const m of msgs || []) {
      const c = m.content;
      if (!c) continue;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) for (const b of c) if (b) chars += (b.text ?? b ?? "").length + (b.content ?? "").length;
    }
    return Math.round(chars / 3) + 4000; // +系统/工具系统提示开销估
  } catch {}
  return 0;
}

/** 从 resolved.model 推导用户请求模式：'auto' / 具体 alias / 或显式 concrete model id（原样保留） */
function deriveRequestedMode(model, env) {
  const m = String(model || "").trim();
  if (m === "auto" || m === "") return "auto";
  const cfg = resolveConfig(env);
  for (const alias of Object.keys(ALIASES)) if (m === cfg.modelIds[alias]) return alias;
  // 非空且非 routing alias 的明确模型 id（如 stealth/ox-alpha）→ 保留原样，
  // 由 route() 的 KNOWN_ROUTING_MODES 分支做 exact passthrough。绝不静默降级为 auto。
  return m;
}

export function apply(ctx, config = {}) {
  const env = process.env || {};
  const cfg = resolveConfig(env);
  fileLogEnabled = !!(config && config.diagnostics) || cfg.diagnostics;
  const state = new Map(); // sid -> { requestedMode, lastDecision, forcedAlias, fallbackIndex, modelFallbackCount, providerFallbackAttempts, escalationPending, escalationCount, opencodeEmptyFailures, forcedOpenRouter }

  const getState = (sid) => {
    let s = state.get(sid);
    if (!s) {
      s = { requestedMode: "auto", forcedAlias: null, fallbackIndex: 0, modelFallbackCount: 0, providerFallbackAttempts: 0, escalationPending: false, escalationCount: 0, opencodeEmptyFailures: 0, forcedOpenRouter: false, recoveryRequirement: null };
      state.set(sid, s);
    }
    return s;
  };

  // Phase 02 R4 (Step 3): typed bridge — EC (execution-continuity) emits a
  // recovery REQUIREMENT (reason/modalities/tools/needLargerContext) when it
  // classifies an agent/request-error but is NOT allowed to pick the fallback
  // model. Router is the sole model authority; it stores the requirement and
  // applies it on the next agent/request (consume + ack).
  ctx.on("ec/recovery-requirement", (payload) => {
    try {
      const sid = payload && payload.sessionId;
      if (!sid) return;
      const st = getState(sid);
      st.recoveryRequirement = payload.requirement || null;
      logDiagVolume(sid, { type: "ec-recovery-requirement", reason: st.recoveryRequirement ? st.recoveryRequirement.reason : "?" });
    } catch (e) { /* bridge must never break routing */ }
  });

  ctx.on("agent/request", async (payload, next) => {
    let resolved;
    try {
      resolved = await next();
    } catch (e) {
      // 内层异常不应吞掉：交给上层
      throw e;
    }
    // 只路由 openrouter；opencode 主力仅在该 session 已标记跨 provider 回落时才拦截
    if (!resolved) return resolved;
    if (resolved.provider !== "openrouter") {
      const sid0 = payload?.agent?.session?.id ?? "?";
      const st0 = getState(sid0);
      // opencode 主力 + 已标记回落 → 改写到 openrouter / openrouter deepseek flash
      if (resolved.provider === "opencode" && st0.forcedOpenRouter && isPrimaryModel(resolved.model, "opencode")) {
        st0.forcedOpenRouter = false; // 一次性
        logDiagVolume(sid0, { type: "primary-failover", category: "provider", from_provider: "opencode", from_model: resolved.model, to_provider: "openrouter", to_model: cfg.modelIds.deepseek, reason: "primary empty-response failover (auto)" });
        const { reasoningEffort: _e1, ...rest } = resolved;
        return { ...rest, provider: "openrouter", model: cfg.modelIds.deepseek };
      }
      return resolved;
    }
    const sid = payload?.agent?.session?.id ?? "?";
    const st = getState(sid);
    try {
      const signal = buildSignal(ctx, payload.agent);
      // 用户意图 = agent.options.model（会话级选择，通常是 'auto'）。
      // 不能用 resolved.model：后续步骤它会变成"上一步我路由出的具体模型"，
      // 会被误判成用户显式指定 → 卡死在第一个决定（sticky bug）。
      const agentOptionsModel = payload?.agent?.options?.model;
      const requestedMode = deriveRequestedMode(agentOptionsModel && String(agentOptionsModel).length > 0 ? agentOptionsModel : resolved.model, env);
      st.requestedMode = requestedMode;
      const text = signal.text;
      let taskType = classifyTask(text);
      // 显式模式：若用户明确选定具体模型（qwen/deepseek/mimo），仍走 Rule 0
      const d = route(
        {
          requestedMode,
          modalities: signal.modalities,
          strictJson: signal.strictJson,
          estimatedContextTokens: signal.estimated,
          taskType,
          text,
          toolsActive: signal.toolsActive,
        },
        env
      );
      st.lastDecision = d;
      // 质量升级：pending 时把 qwen 提升到 deepseek
      let finalModel = st.forcedAlias ? cfg.modelIds[st.forcedAlias] : d.selected_model_id;
      // Phase 02 R4 (Step 3): consume EC's recovery requirement (typed bridge).
      // Router is the sole model authority — it decides the fallback model here.
      // Consumed once (ack); explicit user selection is preserved unless the
      // requirement explicitly demands a capability the current model lacks.
      if (st.recoveryRequirement) {
        const req = st.recoveryRequirement;
        st.recoveryRequirement = null; // consume (ack) before applying
        if (req.needLargerContext === true) {
          // pick the largest-context known model for the family
          const bigModel = cfg.modelIds.mimo || cfg.modelIds.deepseek;
          if (finalModel !== bigModel) {
            logDiagVolume(sid, { type: "ec-requirement-apply", reason: req.reason, from: finalModel, to: bigModel, ctx: "needLargerContext" });
            finalModel = bigModel;
          }
        } else if (req.modalities && req.modalities.includes("image")) {
          // image-capable fallback (mimo family)
          if (cfg.modelIds.mimo && finalModel !== cfg.modelIds.mimo) {
            logDiagVolume(sid, { type: "ec-requirement-apply", reason: req.reason, from: finalModel, to: cfg.modelIds.mimo, ctx: "image-required" });
            finalModel = cfg.modelIds.mimo;
          }
        } else if (req.reason && /reasoning_protocol/i.test(req.reason)) {
          // reasoning-protocol: prefer a model with stable reasoning
          if (cfg.modelIds.deepseek && finalModel !== cfg.modelIds.deepseek) {
            logDiagVolume(sid, { type: "ec-requirement-apply", reason: req.reason, from: finalModel, to: cfg.modelIds.deepseek, ctx: "reasoning" });
            finalModel = cfg.modelIds.deepseek;
          }
        }
      }
      if (st.escalationPending && d.selected_model === "qwen") {
        finalModel = cfg.modelIds.deepseek;
        st.escalationPending = false;
        st.escalationCount += 1;
      }
      // 昂贵模型保护：auto-router 选中昂贵模型时降级到 PRIMARY
      if (d.expensive && requestedMode === "auto") {
        const guard = { allowed: false, expensive: true, reason: "auto-router selected expensive model — blocked" };
        logDiagVolume(sid, { type: "expensive-guard", model: finalModel, blocked: true });
        finalModel = cfg.modelIds.deepseek; // 降级到 PRIMARY
      }
      // 记录 expected model 用于后续 actual 验证
      st.expectedModelId = finalModel;
      if (st.forcedAlias) {
        st.forcedAlias = null; // 一次性
        st.fallbackIndex = Math.max(0, st.fallbackIndex ?? 0);
      }
      const changed = finalModel !== resolved.model;
      const rec = {
        request_id: `${payload.turn ?? "-"}.${payload.step ?? "-"}`,
        requested_model: resolved.model,
        router_selected_model: finalModel,
        rule_id: d.rule_id,
        reason: d.reason,
        estimated_context: signal.estimated,
        task_type: taskType,
        fallback_chain: d.fallback_chain_ids,
        text_snippet: signal.text ? signal.text.slice(0, 240) : "",
        modalities: signal.modalities,
        tools_active: signal.toolsActive,
      };
      logDiagVolume(sid, { type: "decision", ...rec });
      if (cfg.diagnostics) {
        try {
          ctx.logger.info(`[openrouter-router] ${sid} -> ${d.selected_model} (${d.rule_id}) ctx≈${signal.estimated}`);
        } catch {}
      }
      // OpenRouter 管理的请求一律剥离 reasoningEffort（各模型用自身默认；避免 max 不被支持）
      const { reasoningEffort: _effort, ...rest } = resolved;
      const final = { ...rest, provider: "openrouter", model: finalModel };
      if (finalModel !== resolved.model) return final;
      return final;
    } catch (e) {
      // 路由失败绝不阻断请求：openrouter/auto -> 兜底 deepseek；其余原样
      logDiagVolume(sid, { type: "route-error", error: String(e && e.message) });
      if (resolved.model === "auto") return { ...resolved, provider: "openrouter", model: cfg.modelIds.deepseek };
      return resolved;
    }
  });

  ctx.on("agent/request-error", async (payload, next) => {
    // 先让既有 retry 链决定（同模型 provider 重试）
    const action = await next();
    if (action && action.kind === "retry") return action;
    if (!payload) return action;
    const sid = payload.agent?.session?.id ?? "?";
    const st = getState(sid);
    const failure = payload.failure;
    const errMsg = String(failure?.message || failure?.code || "");

    // ─── opencode 主力空响应 → 跨 provider 回落保护（PRIMARY failover） ───
    if (payload.provider === "opencode" && isPrimaryModel(resolvedModelOf(payload), "opencode") && isEmptyResponse(failure)) {
      st.opencodeEmptyFailures = (st.opencodeEmptyFailures ?? 0) + 1;
      logDiagVolume(sid, { type: "primary-empty-response", category: "quality", count: st.opencodeEmptyFailures, model: resolvedModelOf(payload), message: errMsg.slice(0, 200) });
      // 连续 ≥2 次空响应 → 标记下次请求回落到 openrouter
      if (st.opencodeEmptyFailures >= 2) {
        st.forcedOpenRouter = true;
        logDiagVolume(sid, { type: "primary-failover-arm", category: "provider", reason: "repeated empty-response, arming openrouter failover" });
        return action; // 交给既有链重试本次；下次请求自动改走 openrouter
      }
      return action;
    }

    // openrouter 专属逻辑以下
    if (payload.provider !== "openrouter") return action;

    // ─── Provider 级失败（429/5xx/timeout/quota）→ 跨模型 fallback chain ───
    if (isProviderFailure(failure)) {
      const chain = st.lastDecision?.fallback_chain ?? ["deepseek", "mimo", "qwen"];
      const currentIdx = st.forcedAlias ? Math.max(0, st.fallbackIndex ?? 0) : Math.max(0, st.fallbackIndex ?? 0);
      if (currentIdx < chain.length - 1) {
        const nextAlias = chain[currentIdx + 1];
        st.fallbackIndex = currentIdx + 1;
        st.forcedAlias = nextAlias;
        st.modelFallbackCount += 1;
        logDiagVolume(sid, { type: "provider-fallback", category: "provider", from_alias: chain[currentIdx], to_alias: nextAlias, code: failure?.code, message: errMsg.slice(0, 300) });
        return { kind: "retry" };
      }
      return action;
    }

    // ─── 模型质量失败（tool error/能力不足）→ 模型 escalation（Qwen → DeepSeek）───
    if (isQualityFailure(failure) && st.escalationCount < 2) {
      const currentModel = st.lastDecision?.selected_model;
      if (currentModel === "qwen") {
        st.escalationPending = true;
        st.escalationCount += 1;
        logDiagVolume(sid, { type: "quality-escalation", category: "quality", from_alias: "qwen", to_alias: "deepseek", reason: errMsg.slice(0, 300), escalationCount: st.escalationCount });
        return { kind: "retry" };
      }
      // 非 qwen 的质量失败：记录但不自动升级（由 agent 判断）
      logDiagVolume(sid, { type: "quality-failure", category: "quality", model: currentModel, reason: errMsg.slice(0, 300) });
      return action;
    }

    // ─── 其他错误：交给既有链 ───
    return action;
  });

  ctx.effect(() => () => {
    state.clear();
  }, "openrouter-router: reset state");

  return {
    state,
    _test: {
      buildSignal,
      isRoutingFailure,
      deriveRequestedMode,
      escalate: (sid) => {
        const st = getState(sid);
        st.escalationPending = true;
        return st;
      },
    },
    diagnostics: () => ({
      config: cfg,
      activeSessions: [...state.keys()],
      sessions: Object.fromEntries([...state.entries()].map(([sid, s]) => [sid, {
        requestedMode: s.requestedMode,
        expectedModelId: s.expectedModelId ?? null,
        fallbackIndex: s.fallbackIndex,
        modelFallbackCount: s.modelFallbackCount,
        escalationCount: s.escalationCount,
        escalationPending: s.escalationPending,
      }])),
      classification: {
        providerFailure: "429/5xx/timeout/quota → fallback chain",
        qualityFailure: "tool error/capability → escalation (Qwen→DeepSeek, max 2)",
      },
      pod: memoryDiag(),
    }),
  };
  function memoryDiag() {
    return { sessions: state.size };
  }
}
