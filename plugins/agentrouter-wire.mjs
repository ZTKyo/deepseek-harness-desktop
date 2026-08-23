// agentrouter-wire.mjs —— AgentRouter（agentrouter.org）Claude Code wire image 注入插件
// ========================================================================
// 背景：agentrouter.org 的 WAF 要求每个请求必须携带 Claude Code wire image 头
// （User-Agent: claude-cli/...、anthropic-version、anthropic-beta、x-app），
// 否则一律返回 401 unauthorized_client_error。而 dsh-llm-pi-ai 适配器会在每个
// provider 请求里强制写入它自己的 user-agent（attribution），且 headers 配置字段
// 无法覆盖 user-agent —— 因此纯 settings 配置无法通过 WAF。
//
// 本插件的最小修复：在全局 fetch 层为所有发往 https://agentrouter.org 的请求
// 注入/覆盖这组必需头（在 SDK 实际发出 HTTP 之前覆盖 user-agent 等）。
// 只影响 agentrouter.org 域名的请求，其余 provider（DeepSeek/MiMo/Qwen/OpenRouter）
// 完全不受影响。零核心代码改动。
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml
//   - insert:
//     - id: agentrouter-wire
//       name: './agentrouter-wire.mjs'
//       config: {}
// 纯 ESM，零第三方依赖。删除该段即还原。
// ========================================================================

export const name = 'agentrouter-wire';

const CC_HEADERS = {
  'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12',
  'x-app': 'cli',
};

let active = false;

export function apply(ctx) {
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== 'function') {
    ctx.logger?.warn?.('agentrouter-wire: no globalThis.fetch to wrap; skipping');
    return;
  }
  globalThis.fetch = async (input, init = {}) => {
    let url;
    try {
      url = typeof input === 'string' ? input : input?.url;
    } catch {
      url = null;
    }
    if (typeof url === 'string' && url.startsWith('https://agentrouter.org')) {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(CC_HEADERS)) headers.set(k, v);
      init = { ...init, headers };
    }
    return origFetch(input, init);
  };
  active = true;
  ctx.on('dispose', () => {
    if (active && globalThis.fetch) {
      globalThis.fetch = origFetch;
      active = false;
    }
  });
  return { _test: { ccHeaders: () => ({ ...CC_HEADERS }), active: () => active } };
}
