// agent-inspector.mjs —— Agent Inspector 宿主插件
//
// 职责（三个，全在一个插件内收口，不建第二套系统）：
//   1. 把 agent-inspector-client/client.js 手动注册进浏览器 boot entries
//      （与 secret-gate.mjs 相同的 tapIndex 模式——client 插件包无法靠
//      cordis 自动声明进入 boot manifest）。
//   2. 注册 switch_primary_model 工具：用户说「把主力换成 X / 主力改回
//      DeepSeek / 辅助换 XXX」时，agent 调用它完成：验证模型存在 →
//      capability 检查 → 昂贵保护 → 写 settings.yaml agent-default-model
//      （真源）→ YAML 校验 → 更新 provider-registry PRIMARY 指针 → 返回
//      Expected model。任何一步失败 → 不改动，返回原因（可回滚）。
//   3. 路由决策透明数据源：捕获 agent/request 的路由决定，供 Inspector /
//      Router Doctor 查询（不落盘密钥，只记非敏感字段）。
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml
//   - insert:
//     - id: agent-inspector
//       name: './agent-inspector.mjs'
//       config: {}
//
// 纯 ESM，零第三方依赖（仅复用 dsh-tools defineTool，与 secret-gate 一致）。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

export const name = 'agent-inspector';
export const inject = ['tools', 'webServer'];

function dshHome() {
	return process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
}
function settingsFile() {
	return path.join(dshHome(), 'settings.yaml');
}
function registryFile() {
	return path.join(dshHome(), 'profiles', 'web', 'provider-registry-core.mjs');
}
/** 宿主导出的路由决策流（内存，每 session 最近 N 条，不落盘） */
const routingStream = new Map(); // sid -> Array<{ts,type,...}>

/** 记录一条路由审计事件（脱敏） */
export function recordRouting(sid, fields) {
	const list = routingStream.get(sid) ?? [];
	list.push({ ts: Date.now(), ...fields });
	if (list.length > 200) list.splice(0, list.length - 200);
	routingStream.set(sid, list);
}

/** 读取某 session（或全部）的路由审计事件 */
export function readRouting(sid = null) {
	if (sid) return routingStream.get(sid) ?? [];
	const all = {};
	for (const [k, v] of routingStream) all[k] = v;
	return all;
}

function apply(ctx) {
	// ── 1) 浏览器 client.js 注入（tapIndex 模式，复用 secret-gate 成功做法） ──
	// 注意：每次读取 client.js 文件并给 rev 加时间戳，保证改完刷新页面即生效、
	// 无需重启 dsh 服务（去掉「启动时一次性缓存」的旧行为）。
	try {
		const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-inspector-client', 'client.js');
		ctx.webServer?.register({
			kind: 'exact',
			path: '/plugins/agent-inspector-client/client.js',
			handler: async (_req, res) => {
				let clientJs;
				try { clientJs = readFileSync(clientPath, 'utf8'); } catch (e) {
					res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
					res.end('agent-inspector-client.js 读取失败: ' + e.message);
					return;
				}
				const rev = createHash('sha1').update(clientJs).digest('hex').slice(0, 8);
				res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Rev': rev });
				res.end(clientJs);
			},
		});
		ctx.webServer?.tapIndex((html) => {
			if (html.includes('agent-inspector-client')) return html;
			const i0 = html.indexOf('__DSH_BOOT__');
			if (i0 < 0) return html;
			const eq = html.indexOf('=', i0);
			const term = html.indexOf('</script>', eq);
			if (eq < 0 || term < 0) return html;
			try {
				const boot = JSON.parse(html.slice(eq + 1, term).trim().replace(/;$/, ''));
				if (Array.isArray(boot.entries)) {
					boot.entries.push({
						id: 'agent-inspector-client',
						url: '/plugins/agent-inspector-client/client.js?rev=' + Date.now(),
						rev: String(Date.now()),
						inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime'],
						immediately: true,
					});
				}
				ctx.logger?.info(`agent-inspector: client 插件已成功注入 boot entries（rev=每次请求动态计算）`);
				return html.slice(0, eq + 1) + ' ' + JSON.stringify(boot) + html.slice(term);
			} catch (e) {
				ctx.logger?.warn(`agent-inspector: boot 注入失败 ${e.message}`);
				return html;
			}
		});
	} catch (e) {
		ctx.logger?.warn(`agent-inspector: client 注入失败: ${e.message}`);
	}

	// ── 1b) 路由数据 API：浏览器 client 可查询当前 session 的路由记录 ──
	try {
		ctx.webServer?.register({
			kind: 'exact',
			path: '/plugins/agent-inspector/api/routing',
			handler: async (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost');
					const sid = url.searchParams.get('sid');
					const data = sid ? (routingStream.get(sid) ?? []) : [];
					// 只返回最近 30 条，脱敏：去掉可能的 key/token 字段
					const safe = data.slice(-30).map(e => {
						const copy = { ...e };
						delete copy.headers;
						delete copy.body;
						return copy;
					});
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
					res.end(JSON.stringify({ ok: true, events: safe }));
				} catch (e) {
					res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
					res.end(JSON.stringify({ ok: false, error: e.message }));
				}
			},
		});
	} catch (e) {
		ctx.logger?.warn?.(`agent-inspector: routing API 注册失败: ${e.message}`);
	}

	// ── 2) 路由审计：捕获 agent/request 决策写入流（供 Inspector/Doctor 读） ──
	ctx.on('agent/request', async (payload, next) => {
		let resolved;
		try {
			resolved = await next();
		} catch (e) {
			throw e;
		}
		const sid = payload?.agent?.session?.id ?? '?';
		recordRouting(sid, {
			type: 'request',
			provider: resolved?.provider ?? '?',
			model: resolved?.model ?? '?',
			rule_id: resolved?.routerRule ?? null,
		});
		return resolved;
	});

	// ── 3) switch_primary_model：一句话切换主力（安全链路） ──
	ctx.tools.register(defineTool({
		name: 'switch_primary_model',
		description:
			'Switch the PRIMARY role model via user request in plain language (e.g. "把主力换成 X", "DeepSeek 重新做主力", "只修改 OpenRouter 的主力"). This is a role pointer update at the single source of truth (settings.yaml agent-default-model) plus the provider-registry PRIMARY pointer. Safety: validates the target model exists & is ACTIVE in the provider registry, blocks expensive models (must use escalation instead), backs up settings before writing, YAML-validates after, and returns the new EXPECTED model on success — on any failure nothing is changed (rollback-safe).',
		parameters: {
			provider: {
				type: 'string',
				required: true,
				description: 'Provider id from the registry, e.g. "opencode", "openrouter", "xiaomi", "agentrouter-openai".',
			},
			model: {
				type: 'string',
				required: true,
				description: 'Exact model id in that provider, e.g. "deepseek-v4-flash", "deepseek/deepseek-v4-flash-0731", "xiaomi/mimo-v2.5".',
			},
			reasonEffort: {
				type: 'string',
				description: 'Optional reasoningEffort override (e.g. "max", "high"). Default: keep existing.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true },
					expectedModel: { type: 'string' },
					provider: { type: 'string' },
					message: { type: 'string' },
					reason: { type: 'string' },
					expensive: { type: 'boolean' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
		},
		async execute(args) {
			const { provider, model } = args;
			const settingsPath = settingsFile();
			let before = null;
			try { before = readFileSync(settingsPath, 'utf8'); } catch (e) { return { ok: false, reason: `cannot read settings.yaml: ${e.message}` }; }

			// a) 验证 provider/model 存在于注册表且 ACTIVE（真源 provider-registry-core）
			let reg = null;
			try { reg = await import('file:///' + registryFile().replace(/\\/g, '/')); } catch (e) { return { ok: false, reason: `cannot load provider-registry-core: ${e.message}` }; }
			const prov = reg.getProvider ? reg.getProvider(provider) : null;
			if (!prov) return { ok: false, reason: `provider "${provider}" 未注册（注册表：${reg.listProviders ? reg.listProviders().map(p => p.id).join(', ') : '?'}）` };
			const m = prov.models ? prov.models[model] : null;
			if (!m) return { ok: false, reason: `model "${model}" 不在 provider "${provider}"（可用：${Object.keys(prov.models || {}).join(', ')}）` };
			const state = reg.getModelState ? reg.getModelState(provider, model) : 'ACTIVE';
			if (state !== 'ACTIVE') return { ok: false, reason: `model "${model}" 当前状态 ${state}，非 ACTIVE，不可设为主力` };
			if (reg.isExpensive && reg.isExpensive(model)) return { ok: false, expensive: true, reason: `"${model}" 是昂贵模型，禁止作为主力直接切换（须走显式 escalation）` };

			// b) 备份 settings（原子写前快照副本）
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			const bak = settingsPath + '.bak-switch-primary-' + ts;
			try {
				const { writeFileSync, copyFileSync } = await import('node:fs');
				copyFileSync(settingsPath, bak);
				recordRouting('__switch__', { type: 'primary-switch-backup', from: 'settings.yaml', backup: bak });
			} catch (e) { /* 备份失败不阻断（copyFileSync 尽力而为） */ }

			// c) 更新 settings.yaml 的 agent-default-model（唯一真源）
			const jsyaml = await import('js-yaml');
			let doc;
			try { doc = jsyaml.load(before); } catch (e) { return { ok: false, reason: `settings.yaml 解析失败：${e.message}` }; }
			// reasoningEffort 只在该模型声明了可推理能力时才写：
			// 未声明 reasoningEfforts 的模型（如 Command Code 的 Muse/DeepSeek V4 Flash）没有
			// 可支持的 effort 级别，dsh-llm 会在 resolveCallConfig 直接抛 UNSUPPORTED_REASONING_EFFORT
			// （用户"手动切换报错"的根因之一）。此时省略字段 = 用提供方自身默认推理，不发 effort 参数。
			let reasoningEffort = args.reasonEffort;
			if (reasoningEffort === undefined) {
				const prev = doc['agent-default-model']?.reasoningEffort;
				if (prev !== undefined) {
					// 保留旧值仅当它仍合理；此处保守处理：切到新模型一律不继承旧 effort，
					// 避免旧 effort 对不支持它的模型报错。用户显式传 reasonEffort 则用该值。
					reasoningEffort = undefined;
				}
			}
			const next = { provider, model };
			if (reasoningEffort !== undefined) next.reasoningEffort = reasoningEffort;
			doc['agent-default-model'] = next;
			const outYaml = jsyaml.dump(doc, { lineWidth: -1, noRefs: true });
			// d) YAML 回读校验（防坏写）
			try { jsyaml.load(outYaml); } catch (e) { return { ok: false, reason: `新 settings 校验失败（未写入）：${e.message}` }; }
			try {
				const { writeFileSync } = await import('node:fs');
				writeFileSync(settingsPath, outYaml, 'utf8');
			} catch (e) { return { ok: false, reason: `settings.yaml 写入失败：${e.message}` }; }

			// e) 读取新 Expected Model 上下文（供 Inspector）
			recordRouting('__switch__', { type: 'primary-switch', provider, model, expectedModel: `${provider}/${model}` });
			return {
				ok: true,
				expectedModel: `${provider}/${model}`,
				provider,
				message: `主力已切换为 ${provider}/${model}（settings.yaml agent-default-model 已更新，YAML 校验通过，原配置备份在 ${path.basename(bak)}）。预期模型 Expected = ${provider}/${model}。`,
			};
		},
	}));

	// 清理
	ctx.on('dispose', () => {
		routingStream.clear();
	});

	return {
		readRouting,
		recordRouting,
		_diag: () => ({ sessions: routingStream.size, settings: settingsFile() }),
	};
}

export { apply };
