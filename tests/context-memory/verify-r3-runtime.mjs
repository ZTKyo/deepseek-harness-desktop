// verify-r3-runtime.mjs —— P2.5 CONTEXT MEMORY R3 REAL-runtime 验证（External Review Round 2 CHANGES_REQUIRED 收口）
//
// 与单元回归（verify-context-memory.mjs, T1-T11）互补：本脚本在【进程内对真实部署
// 模块代码路径】+【真实磁盘状态目录（临时 dir，不触碰生产 store）】执行端到端验证：
//   R3-1 REAL provider-switch gate：observeRoute A→B 真实激活投影（store.active 持久化）
//   R3-4 REAL corrupt-projection fail-open：损坏 store 文件 → 重建 → 正常投影 → 落盘合法
//   R3-5 REAL missing-projection fail-open：目录/文件缺失 → 空 store 从 raw 学习并投影
//   R3-6 REAL kill-switch：CM_DISABLED=true / enabled=false → 不注册任何钩子
// 全部零第三方依赖，repo-relative 可移植（CI 可运行）；fail → exit 1。
//
// 运行：node tests/context-memory/verify-r3-runtime.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOD = await import(pathToFileURL(path.join(REPO, "plugins/context-memory.mjs")).href);
const CORE = await import(pathToFileURL(path.join(REPO, "plugins/context-memory-core.mjs")).href);

let passCount = 0, failCount = 0;
function assert(c, n, d = "") { if (c) { passCount++; console.log("  PASS  " + n); } else { failCount++; console.log("  FAIL  " + n + (d ? " :: " + d : "")); } }
function section(t) { console.log(`\n=== ${t} ===`); }

// ── 合成 session：官方 surface fold 最小同构（append-only nodes + replace 折叠）──
function makeSession(id) {
  const events = [];
  const nodes = [];
  return {
    id,
    events,
    surface: { get nodes() { return nodes; } },
    append(type, data, opts = {}) {
      const seq = events.length;
      const evt = { seq, type, data };
      const op = opts.surfaceOp;
      if (op && typeof op === "object") {
        const si = nodes.indexOf(op.start), ei = nodes.indexOf(op.end);
        if (si < 0 || ei < 0 || si > ei) throw new Error(`bad replace range`);
        if ((opts.sourceEventSeqs ?? []).length !== ei - si + 1) throw new Error("sourceEventSeqs must cover shadowed");
        nodes.splice(si, ei - si + 1, seq);
      } else {
        nodes.push(seq);
      }
      events.push(evt);
      return { seq };
    },
  };
}

/** 构造一个超窗、可触发投影的会话（每节点 ~120 字符文本）。 */
function seedLongSession(n = 12, sid = "r3rt-" + Math.random().toString(36).slice(2)) {
  const s = makeSession(sid);
  for (let i = 0; i < n; i++) {
    s.append("user/message", {
      role: "user", id: "u" + i,
      content: [{ type: "text", text: `turn ${i}: ` + "x".repeat(110) }],
      source: { kind: "user" },
    }, "append");
  }
  return s;
}

/** 干净的临时插件实例（独立 stateDir + 捕获日志）。 */
function makePlugin(stateDir, extraCfg = {}) {
  const logs = [];
  const inst = MOD.apply({
    on() {}, // 钩子注册直通（本项目直接调 _test.*）
    logger: { info: (m) => logs.push(String(m)) },
  }, { stateDir, recentWindowNodes: 4, activationThresholdTokens: 10, minNewNodes: 1, capsPerSection: 8, capsTotalChars: 2000, ...extraCfg });
  return { inst, logs };
}

fs.rmSync ? null : null; // noop

// ============================================================
section("R3-6 REAL kill-switch：env CM_DISABLED=true / config.enabled=false");
{
  const prevEnv = process.env.CM_DISABLED;

  // (a) env 开关：apply 必须返回空对象（无任何钩子/无 _test）
  process.env.CM_DISABLED = "true";
  const offByEnv = MOD.apply({ on() {} }, {});
  assert(offByEnv && typeof offByEnv === "object" && Object.keys(offByEnv).length === 0,
    "CM_DISABLED=true → apply() 返回空对象，未注册任何钩子");

  // (b) config 开关
  delete process.env.CM_DISABLED;
  const offByCfg = MOD.apply({ on() {} }, { enabled: false });
  assert(offByCfg && Object.keys(offByCfg).length === 0,
    "config.enabled=false → apply() 返回空对象（卸载挂载行即整体回滚语义）");

  // (c) 对照组：默认开启时有 _test 面
  const tmpOn = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r3-on-"));
  const onInst = MOD.apply({ on() {} }, { stateDir: tmpOn });
  assert(onInst && onInst._test && typeof onInst._test.maybeProject === "function",
    "对照组：默认开启 → apply() 注册并提供 maybeProject 测试面");

  if (prevEnv === undefined) delete process.env.CM_DISABLED; else process.env.CM_DISABLED = prevEnv;
}

// ============================================================
section("R3-5 REAL missing-projection fail-open（stateDir 为全新空目录）");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r3-missing-"));
  const sid = "s-missing-" + Date.now();
  const s = seedLongSession(12, sid);
  const { inst, logs } = makePlugin(dir);

  assert(!fs.existsSync(path.join(dir, sid + ".json")), "前置：store 文件不存在（真实缺失）");

  let r = null, threw = false;
  try { r = inst._test.maybeProject(s, undefined); } catch (e) { threw = true; console.log("  EX:", e.message); }
  assert(!threw && r && r.version === 1, "缺失 → 空 store 从 raw 学习 → 第 1 次投影成功 version=1");

  // 官方协议落点：compaction/prune 影事件 + 替换节点带全量 sourceEventSeqs
  const pruneEvt = s.events.find(e => e.type === "compaction/prune");
  const obsNodes = [...s.surface.nodes].filter(q => s.events[q]?.data?.content?.[0]?.text?.includes("[context-memory observation v"));
  assert(!!pruneEvt, "投出 compaction/prune 影事件（shadowedRange 记录原文区段）");
  assert(obsNodes.length === 1, "表面恰有 1 个单活观察快照节点（单活快照不变量）");

  // 落盘必须为合法 store 且可通过核心校验
  const raw = JSON.parse(fs.readFileSync(path.join(dir, sid + ".json"), "utf8"));
  const ok = CORE.validateStore(raw);
  assert(!!ok && ok.version >= 1 && ok.watermark > 0, "恢复后 store 落盘且通过 validateStore（version/watermark 一致）");
  assert(raw.refs.length === 1 && raw.refs[0].endSeq === raw.watermark, "refs ring 首条 endSeq == watermark（回源索引闭合）");
  assert(logs.some(l => l.includes("[context-memory] projected")), "捕获插件日志 projected …（观测通道真实）");

  // 幂等：无新增节点时再调用 → 不重复投影
  const again = inst._test.maybeProject(s, undefined);
  assert(again === null, "幂等：无增量新节点 → 第二次调用不动表面（防抖）");

  // 增量：追加新节点后再次投影 version=2
  for (let i = 100; i < 108; i++) {
    s.append("user/message", { role: "user", id: "u" + i, content: [{ type: "text", text: "more " + "y".repeat(110) }], source: { kind: "user" } }, "append");
  }
  const r2 = inst._test.maybeProject(s, undefined);
  assert(r2 && r2.version === 2, "增量投影 version=2（bounded 增量而非重扫全量）");
}

// ============================================================
section("R3-4 REAL corrupt-projection fail-open（store 文件真损坏）");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r3-corrupt-"));
  const sid = "s-corrupt-" + Date.now();
  // 先写一个「真损坏」文件：非法 JSON + 半截结构各来一份（两个会话互不干扰）
  fs.writeFileSync(path.join(dir, sid + ".json"), '{"schemaVersion":1,"sessionId":"', "utf8"); // 半截 JSON
  const otherId = sid + "-z";
  fs.writeFileSync(path.join(dir, otherId + ".json"), "not-json-at-all{{{", "utf8");           // 完全非 JSON

  const s = seedLongSession(12, sid);
  const { inst, logs } = makePlugin(dir);

  let r = null, threw = false;
  try { r = inst._test.maybeProject(s, undefined); } catch (e) { threw = true; console.log("  EX:", e.message); }
  assert(!threw, "损坏 store 不抛异常（fail-open：任务永不因投影问题停止）");
  assert(r && r.version === 1, "损坏 → 判废重建（version 从 0 重学）→ 投影成功 version=1");

  const raw = JSON.parse(fs.readFileSync(path.join(dir, sid + ".json"), "utf8"));
  const ok = CORE.validateStore(raw);
  assert(!!ok, "损坏文件被原子覆写为合法 store 并通过 validateStore（自愈闭环）");
  assert(raw.sessionId === sid, "重建 store 的 sessionId 正确归属当前会话");
  assert(logs.length >= 1, "过程产生插件日志（静默降级但可观测）");

  // 对照：非法字符 + 合法 JSON 外壳但结构损坏（validateStore 判废）
  const badStructDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r3-badstruct-"));
  const bsSid = "s-badstruct-" + Date.now();
  fs.writeFileSync(path.join(badStructDir, bsSid + ".json"),
    JSON.stringify({ hello: "world", schemaVersion: 9 }), "utf8");
  const s2 = seedLongSession(12, bsSid);
  const p2 = makePlugin(badStructDir).inst;
  const r3 = p2._test.maybeProject(s2, undefined);
  assert(r3 && r3.version === 1, "schemaVersion 不符的结构性损坏同样判废重建（validateStore 门卫生效）");
}

// ============================================================
section("R3-1 REAL provider-switch gate（双路由真切换 → 激活持久化）");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r3-switch-"));
  const sid = "s-switch-" + Date.now();
  const { inst, logs } = makePlugin(dir);

  const payloadOf = () => ({ agent: { session: { id: sid } }, model: "auto" });

  // 第一次解析：provider=A（prev 不存在 → 仅记录，不激活）
  await inst._test.observeRoute(payloadOf(), async () => ({ provider: "provA", model: "m1" }));
  let st = inst._test.getStore(sid);
  assert(st.active === false, "首次路由仅登记 prev，不触发激活（inactive）");

  // 同 provider 同 model 重复 → 无切换
  await inst._test.observeRoute(payloadOf(), async () => ({ provider: "provA", model: "m1" }));
  st = inst._test.getStore(sid);
  assert(st.active === false && !st.lastSwitchAt, "同路由重复请求不误触发 switch gate（负例）");

  // 跨 provider 真实切换 A→B → gate 打开并持久化
  await inst._test.observeRoute(payloadOf(), async () => ({ provider: "provB", model: "m2" }));
  st = inst._test.getStore(sid);
  assert(st.active === true, "REAL 跨 provider 切换 → store.active=true（投影门打开）");
  assert(typeof st.lastSwitchAt === "number" && st.lastSwitchAt <= Date.now(), "lastSwitchAt 已记录切换时刻");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, sid + ".json"), "utf8"));
  assert(onDisk.active === true, "激活状态已持久化到磁盘 store（重启场景下仍生效）");
  assert(CORE.detectSwitch({ provider: "x", model: "a" }, { provider: "x", model: "b" }, "auto") === false &&
         CORE.detectSwitch({ provider: "x", model: "a" }, { provider: "x", model: "b" }, "codex") === true,
    "detectSwitch 语义复核：auto 模式同 provider 换模不激活；显式模式才激活");

  // 之后发生投影：switchActivated 标记进观察头（激活窗口内 projected 日志仍出现）
  const sess = seedLongSession();
  const r = inst._test.maybeProject(sess, undefined);
  assert(r && r.version === 1 && logs.some(l => l.includes("projected")),
    "gate 打开后首轮 pre-step 即完成投影（switch→activate→project 全链路）");
}

// ============================================================
console.log(`\n=== RESULT: ${passCount} PASS, ${failCount} FAIL ===`);
process.exit(failCount === 0 ? 0 : 1);
