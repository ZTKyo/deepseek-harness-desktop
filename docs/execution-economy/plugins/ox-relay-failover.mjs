// ox-relay-failover.mjs —— stealth/ox-alpha 同模型跨 relay provider failover 宿主插件
//
// 机制（复用现有 agent/request + agent/request-error 瀑布，最薄一层）：
//  - agent/request：只关心 model === OX_ALPHA_MODEL（stealth/ox-alpha）的请求。
//    若本会话已 armed 下一个 relay（上一请求 provider failure），把 provider 改写为
//    armedNext，model 保持原样（Same-Model Invariant）。其他模型的请求一律不干预。
//  - agent/request-error：先 await next()，让既有 dsh-llm-retry 先做『同模型同 provider
//    重试』（各 relay 自己的 retryPolicy 已设 maxRetries=1）；当重试链放弃时，若属于
//    真实 provider failure（RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）→ 推进到下一个 relay；
//    若属于 auth/billing/access/UNKNOWN_MODEL/content/user-cancel → 一律不 fallback，
//    如实报错（AUTH_REQUIRED / PAYMENT_REQUIRED / ACCESS_REQUIRED / UNKNOWN_MODEL）。
//  - A/B/C 全失败 → fail closed：抛 "all ox-alpha relay attempts exhausted (…) 错误，
//    绝不降级到 DeepSeek/MiMo/Qwen 等其他模型制造"成功"。
//
// 协作关系：
//  - dsh-llm-retry（内建）先执行 provider 内部 bounded retry；耗尽后瀑布流到下传。
//  - openrouter-router（已有插件）对显式 passthrough 模型（stealth/ox-alpha）链长为 1，
//    不做跨模型 fallback，不会与本文冲突；对 ox-relay-* provider 完全放行。
//
// 配置（环境变量，均可缺省）：
//   OX_RELAY_CHAIN               逗号分隔 relay provider id（默认 ox-relay-a,ox-relay-b）
//   OX_ALPHA_MODEL               logical model（默认 stealth/ox-alpha）
//   OX_RELAY_DIAGNOSTICS_FILE    追加诊断日志的路径（默认 ~/.dsh/ox-relay-diagnostics.log，
//                                仅当 OX_RELAY_DIAGNOSTICS=true 时写入）
//
// 观测（任务 §15）：每次 attempt / fallback / fail-closed 都向会话追加
//   ox-relay/failover 事件，字段：logical_model / requested_model / attempt / provider /
//   failure_kind / next_provider / final_provider / final_model —— 机器可读，
//   可回答"这一次 ox-alpha 从哪个中转站成功返回"。不含任何 secret。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OX_ALPHA_MODEL,
  classifyFailure,
  isProviderFailure,
  resolveChain,
  resolveModel,
  nextProvider,
  buildAttemptRecord,
  failClosedError,
  attemptNumberFor,
} from "./ox-relay-core.mjs";

export const name = "ox-relay-failover";

function diagnosticsPath() {
  const custom = process.env.OX_RELAY_DIAGNOSTICS_FILE;
  if (custom && custom.length > 0) return custom;
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, ".dsh", "ox-relay-diagnostics.log");
}
let fileLogEnabled = false;
function logDiag(line) {
  if (!fileLogEnabled) return;
  try { fs.appendFileSync(diagnosticsPath(), new Date().toISOString() + " " + line + "\n"); } catch {}
}
function logDiagVolume(sid, fields) {
  if (!fileLogEnabled) return;
  try { logDiag(JSON.stringify({ sid, ts: Date.now(), ...fields })); } catch {}
}

/** 从 request-error payload 提取 provider（错误 payload 只带 provider，不带 model）。 */
function providerOf(payload) {
  try { return payload?.provider ?? payload?.request?.provider ?? payload?.resolved?.provider ?? null; } catch { return null; }
}

export function apply(ctx, config = {}) {
  const env = process.env || {};
  const model = resolveModel(env);
  const chain = resolveChain(env);
  fileLogEnabled = !!(config && config.diagnostics) || env.OX_RELAY_DIAGNOSTICS === "true";
  // sid -> { turn, lastModel, lastProvider, usedProviders: [], armedNext }
  const state = new Map();

  const getState = (sid) => {
    let s = state.get(sid);
    if (!s) {
      s = { turn: -1, lastModel: null, lastProvider: null, usedProviders: [], failureKinds: {}, armedNext: null };
      state.set(sid, s);
    }
    return s;
  };

  ctx.on("agent/request", async (payload, next) => {
    let resolved;
    try {
      resolved = await next();
    } catch (e) {
      throw e; // 内层异常不吞
    }
    if (!resolved) return resolved;
    const sid = payload?.agent?.session?.id ?? "?";
    const st = getState(sid);
    const turn = Number.isInteger(payload?.turn) ? payload.turn : -1;
    if (turn !== st.turn) {
      // 结构性复位：新 turn 从默认 provider 重新开始，防止粘滞锁定某个 relay
      st.turn = turn;
      st.usedProviders = [];
      st.failureKinds = {};
      st.armedNext = null;
    }
    // Same-Model Invariant：只处理 model === OX_ALPHA_MODEL 的请求。
    // 任何其他模型一律不干预（armed 状态也清掉，防止跨模型污染）。
    if (resolved.model !== model) {
      st.lastModel = null;
      st.lastProvider = null;
      st.armedNext = null;
      return resolved;
    }
    st.lastModel = resolved.model;
    // 若已 armed 下一个 relay → 只改 provider，model 保持原样
    if (st.armedNext && resolved.provider !== st.armedNext) {
      resolved = { ...resolved, provider: st.armedNext, model };
      st.armedNext = null;
    }
    st.lastProvider = resolved.provider;
    if (st.usedProviders[st.usedProviders.length - 1] !== resolved.provider) {
      st.usedProviders.push(resolved.provider);
    }
    const rec = buildAttemptRecord({
      model,
      requestedModel: resolved.model,
      attempt: attemptNumberFor(st.usedProviders),
      provider: resolved.provider,
    });
    try { payload?.agent?.session?.append?.("ox-relay/failover", rec); } catch {}
    logDiagVolume(sid, { type: "attempt", ...rec });
    return resolved;
  });

  ctx.on("agent/request-error", async (payload, next) => {
    // 先让既有 retry 链（dsh-llm-retry 同模型同 provider 重试）决定
    let action;
    try { action = await next(); } catch (e) { throw e; }
    if (!payload) return action;
    if (action && action.kind === "retry") return action;
    const sid = payload.agent?.session?.id ?? "?";
    const st = getState(sid);
    // 失败必须属于我们追踪的 ox-alpha 请求，否则不干预
    if (st.lastModel !== model) return action;
    const failingProvider = providerOf(payload);
    if (failingProvider && st.lastProvider && failingProvider !== st.lastProvider) return action;
    const failure = payload.failure;
    const kind = classifyFailure(failure);
    const attempt = attemptNumberFor(st.usedProviders) || 1;

    if (!isProviderFailure(failure)) {
      // 非 provider failure（AUTH/QUOTA/UNKNOWN_MODEL/content/user-cancel…）：如实报错，不 fallback
      const rec = buildAttemptRecord({
        model, requestedModel: model,
        attempt, provider: failingProvider, failureKind: kind, nextProvider: null, finalProvider: failingProvider,
      });
      try { payload.agent.session.append("ox-relay/failover", rec); } catch {}
      logDiagVolume(sid, { type: "no-fallback", failure_kind: kind, ...rec });
      return action;
    }

    // 真实 provider failure → 推进到下一个 relay
    const nextP = nextProvider(failingProvider, chain, st.usedProviders);
    if (failingProvider) st.failureKinds[failingProvider] = kind; // 记录每个 provider 的 failure kind（§16）
    const rec = buildAttemptRecord({
      model, requestedModel: model,
      attempt, provider: failingProvider, failureKind: kind, nextProvider: nextP,
    });
    try { payload.agent.session.append("ox-relay/failover", rec); } catch {}
    logDiagVolume(sid, { type: "provider-failure", ...rec });

    if (!nextP) {
      // 所有 relay 耗尽 → fail closed（绝不降级到其他模型）
      const exhausted = failClosedError(
        st.usedProviders.map((p) => ({ provider: p, failure_kind: st.failureKinds[p] ?? null }))
      );
      const finalRec = buildAttemptRecord({
        model, requestedModel: model,
        attempt, provider: failingProvider, failureKind: kind, nextProvider: null,
        finalProvider: failingProvider, exhausted: true,
      });
      try { payload.agent.session.append("ox-relay/failover", finalRec); } catch {}
      logDiagVolume(sid, { type: "relays-exhausted", message: exhausted.message });
      throw exhausted;
    }

    st.armedNext = nextP;
    return { kind: "retry" };
  });

  ctx.effect(() => () => {
    state.clear();
  }, "ox-relay-failover: reset state");

  return {
    state,
    _test: {
      classifyFailure,
      isProviderFailure,
      resolveChain,
      nextProvider,
      buildAttemptRecord,
      failClosedError,
    },
    diagnostics: () => ({
      logicalModel: model,
      chain,
      activeSessions: [...state.keys()],
      sessions: Object.fromEntries([...state.entries()].map(([sid, s]) => [sid, {
        turn: s.turn,
        lastModel: s.lastModel,
        lastProvider: s.lastProvider,
        usedProviders: s.usedProviders,
        failureKinds: s.failureKinds,
        armedNext: s.armedNext,
      }])),
    }),
  };
}
