// secret-gate.mjs —— 密钥安全通道（host 侧）
//
// 配合前端插件 secret-gate-client 使用：模型需要用户提供密钥（API key / 密码 /
// token）时，调用本插件注册的工具 request_secret，前端自动弹出密码遮罩填写框；
// 用户提交后值直接写入凭据库（~/.dsh/.credentials.yaml，credentials.set），
// 前端投递一条"已存入 ref"消息，模型再用 read_secret 读取真实值使用。
// 全程密钥不经过聊天文本、不在日志中打印。
//
// 工具清单：
//   request_secret  —— 请求用户通过安全面板填写密钥（前端自动弹窗）
//   read_secret     —— 按 ref 读取已存密钥的真实值（标准模式：值进入模型上下文）
//   secret_status   —— 列出面板登记过的 ref 及其配置状态（永不含值）
//   forget_secret   —— 删除一个已存密钥
//
// 挂载：~/.dsh/profiles/web/cordis.patch.yml
//   - insert:
//       - id: secret-gate
//         name: './secret-gate.mjs'
//         config: {}
//
// 纯 ESM，无第三方依赖；refs.json 只登记 ref 名/label/时间，绝不落盘密钥值。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

export const name = 'secret-gate';
export const inject = ['tools', 'credentials', 'webServer'];

/** POSIX shell identifier：与 dsh-credentials 的 CredentialRef 规则一致。 */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function dshHome() {
	return process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
}

function refsFile() {
	return path.join(dshHome(), 'secret-gate', 'refs.json');
}

/** 登记一个 ref（只存元数据，不存值）。 */
async function recordRef(ctx, ref, label) {
	const file = refsFile();
	let list = [];
	try {
		const raw = await readFile(file, 'utf8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.refs)) list = parsed.refs;
	} catch {
		// 首次运行/文件不存在：空列表
	}
	const existing = list.find((item) => item.ref === ref);
	if (existing) existing.label = label;
	else list.push({ ref, label, at: Date.now() });
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ refs: list }, null, 2), 'utf8');
}

/** 读取登记列表。 */
async function readRefs() {
	try {
		const raw = await readFile(refsFile(), 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed.refs) ? parsed.refs : [];
	} catch {
		return [];
	}
}

/** 从登记中移除一个 ref。 */
async function dropRef(ref) {
	const list = await readRefs();
	const next = list.filter((item) => item.ref !== ref);
	await mkdir(path.dirname(refsFile()), { recursive: true });
	await writeFile(refsFile(), JSON.stringify({ refs: next }, null, 2), 'utf8');
}

function apply(ctx) {
	// ---- 注入浏览器端面板脚本（修复 2026-08-18, v2）----
	// client 插件包（secret-gate-client）从未进入 cordis 的 boot manifest，
	// 故由 host 插件把它按官方插件格式注册进 __DSH_BOOT__.entries：
	// framework 会像加载官方 client 插件一样执行 client.js 的
	// ModuleLoader.load，并调用其 apply(ctx) 注入 connection/runtime
	// 服务（ctx.connection.api / ctx.sessions），面板随即生效。
	try {
		const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'secret-gate-client', 'client.js');
		const clientJs = readFileSync(clientPath, 'utf8');
		const rev = createHash('sha1').update(clientJs).digest('hex').slice(0, 8);
		ctx.webServer?.register({
			kind: 'exact',
			path: '/plugins/secret-gate-client/client.js',
			handler: async (_req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
				res.end(clientJs);
			},
		});
		ctx.webServer?.tapIndex((html) => {
			if (html.includes('secret-gate-client')) return html;
			const i0 = html.indexOf('__DSH_BOOT__');
			if (i0 < 0) return html;
			const eq = html.indexOf('=', i0);
			const term = html.indexOf('</script>', eq);
			if (eq < 0 || term < 0) return html;
			try {
				const boot = JSON.parse(html.slice(eq + 1, term).trim().replace(/;$/, ''));
				if (Array.isArray(boot.entries)) {
					boot.entries.push({
						id: 'secret-gate-client',
						url: '/plugins/secret-gate-client/client.js?rev=' + rev,
						rev,
						inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime'],
						immediately: true,
					});
				}
				return html.slice(0, eq + 1) + ' ' + JSON.stringify(boot) + html.slice(term);
			} catch (e) {
				ctx.logger?.warn(`secret-gate: boot 注入失败 ${e.message}`);
				return html;
			}
		});
		ctx.logger?.info(`secret-gate: client 插件已注册进 boot entries（rev=${rev}）`);
	} catch (e) {
		ctx.logger?.warn(`secret-gate: 浏览器脚本注入失败: ${e.message}`);
	}

	// ---- request_secret：请求用户通过安全面板填写密钥 ----
	ctx.tools.register(defineTool({
		name: 'request_secret',
		description: 'Ask the user to provide a secret (API key / password / token) through the secure in-app secret panel — NEVER ask the user to paste secrets into chat. The panel pops up automatically on the user\'s screen. This tool returns immediately; when the user submits, a "secret saved" user message arrives in the conversation, and you then call read_secret to obtain the value. If the reference is already configured, call read_secret directly instead.',
		parameters: {
			ref: {
				type: 'string',
				required: true,
				description: 'Credential reference name — a POSIX identifier such as GITHUB_TOKEN or SMTP_PASSWORD.'
			},
			label: {
				type: 'string',
				required: true,
				description: 'Human-readable label shown in the panel, e.g. "GitHub Token".'
			},
			hint: {
				type: 'string',
				description: 'Optional short usage note shown in the panel.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					requested: { type: 'boolean', required: true },
					ref: { type: 'string', required: true },
					message: { type: 'string', required: true }
				}
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
		},
		async execute(args) {
			if (!REF_RE.test(args.ref)) {
				throw new Error(`invalid credential ref: ${args.ref}（需为 POSIX 标识符，如 GITHUB_TOKEN）`);
			}
			await recordRef(ctx, args.ref, args.label);
			return {
				requested: true,
				ref: args.ref,
				message: `已请求用户通过安全面板填写密钥「${args.label}」（ref ${args.ref}），面板已在其屏幕上弹出，密钥不会经过聊天文本。用户提交后会收到"已存入"通知，届时调用 read_secret 读取使用。`
			};
		}
	}));

	// ---- read_secret：读取已存密钥的真实值 ----
	ctx.tools.register(defineTool({
		name: 'read_secret',
		description: 'Resolve a stored credential value by its reference name (the plaintext value is returned and enters the model context — required to actually use the secret). Returns configured:false when nothing is stored for the reference. Use after the user has submitted a secret through the panel, or to reuse an already-stored secret.',
		parameters: {
			ref: {
				type: 'string',
				required: true,
				description: 'Credential reference name, e.g. GITHUB_TOKEN.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					configured: { type: 'boolean', required: true },
					source: { type: 'string' },
					value: { type: 'string' }
				}
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
		},
		async execute(args) {
			if (!REF_RE.test(args.ref)) {
				throw new Error(`invalid credential ref: ${args.ref}`);
			}
			const hit = await ctx.credentials.resolve(credentialRef(args.ref));
			if (hit === void 0) {
				await recordRef(ctx, args.ref, args.ref);
				return { configured: false };
			}
			await recordRef(ctx, args.ref, args.ref);
			return { configured: true, source: hit.source, value: hit.value };
		}
	}));

	// ---- secret_status：列出登记过的 ref 及其状态（不含值） ----
	ctx.tools.register(defineTool({
		name: 'secret_status',
		description: 'List credential references recorded by the secret panel with their configured state, source, and writability. NEVER returns secret values. Useful to report to the user which secrets are stored or to check a reference before requesting it.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					refs: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								ref: { type: 'string', required: true },
								label: { type: 'string', required: true },
								configured: { type: 'boolean', required: true },
								source: { type: 'string' },
								writable: { type: 'boolean', required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
		},
		async execute() {
			const list = await readRefs();
			const out = [];
			for (const item of list) {
				if (!REF_RE.test(item.ref)) continue;
				let info;
				try {
					info = await ctx.credentials.describe(credentialRef(item.ref));
				} catch {
					info = { configured: false, writable: false };
				}
				out.push({
					ref: item.ref,
					label: item.label || item.ref,
					configured: info.configured === true,
					...(info.source !== void 0 ? { source: info.source } : {}),
					writable: info.writable === true
				});
			}
			return { refs: out };
		}
	}));

	// ---- forget_secret：删除一个已存密钥 ----
	ctx.tools.register(defineTool({
		name: 'forget_secret',
		description: 'Remove a stored credential reference (durable unset). Fails while a read-only layer such as a live environment variable shadows the reference. Use when the user asks to delete a stored secret.',
		parameters: {
			ref: {
				type: 'string',
				required: true,
				description: 'Credential reference name to remove, e.g. GITHUB_TOKEN.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					removed: { type: 'boolean', required: true },
					ref: { type: 'string', required: true }
				}
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
		},
		async execute(args) {
			if (!REF_RE.test(args.ref)) {
				throw new Error(`invalid credential ref: ${args.ref}`);
			}
			await ctx.credentials.unset(credentialRef(args.ref));
			await dropRef(args.ref);
			return { removed: true, ref: args.ref };
		}
	}));
}

export { apply };
