// E2E 尸检工具（P3R1 2026-08-30）：对隔离实例持久化 home 做离线全量 CT 判决。
// 用法：node tests/autonomy/e2e-autopsy.mjs <homeDir>
// 解码 sessions/<cwd>/<sid>/session.jsonl.zstd（多帧 zstd，方法与 cm-r4-log-decoder 一致）
// → evaluateCompletion 全量判决 + 未闭合调用定位 + 意图状态。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { evaluateCompletion } from '../../plugins/completion-truth-core.mjs';

const home = process.argv[2];
if (!home || !existsSync(home)) { console.error(`home not found: ${home}`); process.exit(1); }

const FRAME_MAGIC = 0xfd2fb528;
function parseFrames(buf) {
	const frames = [];
	let off = 0;
	while (off + 4 <= buf.length) {
		const m = buf.readUInt32LE(off);
		if (m === FRAME_MAGIC) {
			let p = off + 4;
			const fhd = buf[p++];
			const singleSegment = (fhd >> 5) & 1;
			const checksum = (fhd >> 2) & 1;
			const didSize = fhd & 3;
			const fcsCode = (fhd >> 6) & 3;
			if (!singleSegment) p += 1;
			p += [0, 1, 2, 4][didSize];
			p += fcsCode === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsCode];
			for (;;) {
				if (p + 3 > buf.length) throw new Error(`truncated block header at ${p}`);
				const bh = buf.readUIntLE(p, 3); p += 3;
				const last = bh & 1;
				const btype = (bh >> 1) & 3;
				const bsize = bh >> 3;
				if (btype === 3) throw new Error("reserved block type");
				if (btype !== 1) p += bsize;
				if (last) break;
			}
			if (checksum) p += 4;
			frames.push([off, p]);
			off = p;
		} else if ((m & 0xfffffff0) === 0x184d2a50) {
			off += 8 + buf.readUInt32LE(off + 4);
		} else break;
	}
	return frames;
}
function decodeLines(file) {
	const buf = readFileSync(file);
	const frames = parseFrames(buf);
	if (!frames.length) throw new Error('no zstd frames found');
	let text = '';
	for (const [s, e] of frames) text += zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
	return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// 1) 意图
const intentsPath = join(home, 'ec-state', 'execution-intents.json');
if (existsSync(intentsPath)) {
	try {
		const st = JSON.parse(readFileSync(intentsPath, 'utf8'));
		for (const [sid, it] of Object.entries(st.data?.intents ?? st.intents ?? {})) {
			console.log(`INTENT ${sid} state=${it.state} autoResume=${it.autoResume} retryCount=${it.retryCount} lastResumeAt=${it.lastResumeAt ?? '-'}`);
			console.log(`  autonomy: state=${it.autonomy?.verificationState ?? '-'} milestones=${it.autonomy?.verifiedMilestones?.length ?? 0} criteria=${it.autonomy?.acceptanceCriteria?.length ?? 0} lastCheckpoint=${JSON.stringify(it.autonomy?.lastVerifiedCheckpoint ?? null)}`);
		}
	} catch (e) { console.log(`intents parse error: ${e.message}`); }
} else console.log(`no intents file at ${intentsPath}`);

// 2) 会话日志 → 全量 CT
const sessRoot = join(home, 'sessions');
if (!existsSync(sessRoot)) { console.log(`no sessions dir`); process.exit(0); }
for (const cwdDir of readdirSync(sessRoot)) {
	const cwdPath = join(sessRoot, cwdDir);
	for (const sidDir of readdirSync(cwdPath)) {
		const logFile = join(cwdPath, sidDir, 'session.jsonl.zstd');
		if (!existsSync(logFile)) continue;
		let events = [];
		try {
			for (const line of decodeLines(logFile)) {
				try { events.push(JSON.parse(line)); } catch { /* tolerate */ }
			}
		} catch (e) { console.log(`${sidDir}: decode error ${e.message}`); continue; }
		console.log(`\nSESSION ${sidDir}: ${events.length} events (decoded)`);
		let verdict;
		try { verdict = evaluateCompletion(events); } catch (e) { console.log(`evaluateCompletion error: ${e.message}`); continue; }
		console.log(`CT verdict: ${verdict.state}${verdict.detail ? ` :: ${verdict.detail}` : ''}`);
		if (verdict.state !== 'clean') {
			const results = new Set();
			for (const ev of events) {
				if (ev?.type === 'tool/result') {
					const d = ev.data ?? ev;
					const rid = d.tool_call_id || d.toolCallId || d.call_id || d.id || (d.result && (d.result.tool_call_id || d.result.call_id));
					if (rid) results.add(String(rid));
				}
			}
			const open = [];
			for (const ev of events) {
				if (ev?.type === 'tool/result') continue;
				const parts = ev?.data?.parts ?? ev?.parts ?? [];
				for (const tc of Array.isArray(parts) ? parts : []) {
					const raw2 = tc?.tool_call ?? tc?.function_call ?? tc;
					if (!tc || (tc.type !== 'tool-call' && tc.type !== 'function_call')) continue;
					const id = tc.id || tc.tool_call_id || tc.call_id || tc.function?.call_id || raw2?.id || '';
					const name = tc.name || raw2?.name || tc.function?.name || raw2?.function?.name || '';
					if (!results.has(String(id))) open.push({ seq: ev.seq, ev: ev.type, id, name });
				}
			}
			console.log(`unresolved calls (last 8): ${JSON.stringify(open.slice(-8))}`);
			// 尾部事件类型序列（诊断上下文）
			console.log(`tail types: ${events.slice(-6).map((e) => `${e.seq}:${e.type}`).join(' | ')}`);
		}
	}
}
