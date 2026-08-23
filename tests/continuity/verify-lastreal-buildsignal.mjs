// verifies the openrouter-router buildSignal fix: longReal -> classifierMsg
import { apply } from "file:///C:/Users/Administrator/.dsh/profiles/web/openrouter-router.mjs";

let result = { ok: false, steps: [] };
try {
  const ctx = {
    on: () => () => {},
    effect: (fn) => { try { fn(); } catch {} ; return () => {}; },
    get: () => undefined,
  };
  const plugin = apply(ctx, {});
  const buildSignal = plugin._test.buildSignal;

  const mk = (msgs, events) => ({ session: { id: "t", deriveMessages: () => msgs, events: events || [] } });

  // Case 1: strict-json real user msg (should set strictJson=true)
  const s1 = buildSignal(ctx, mk([
    { role: "user", content: "<system-reminder>noise</system-reminder>" },
    { role: "user", content: "请返回严格 JSON schema 的结果" },
  ]));
  result.steps.push({ case: "strictJson", strictJson: s1.strictJson, expect: true });

  // Case 2: tool/agentic text (should set toolsActive=true)
  const s2 = buildSignal(ctx, mk([
    { role: "system", content: "you are" },
    { role: "user", content: "请调用工具 执行命令 处理" },
  ]));
  result.steps.push({ case: "toolsActive", toolsActive: s2.toolsActive, expect: true });

  // Case 3: all-noise user msgs (should not crash; default false)
  const s3 = buildSignal(ctx, mk([
    { role: "user", content: "<system-reminder>skip me</system-reminder>" },
  ]));
  result.steps.push({ case: "allNoise", strictJson: s3.strictJson, toolsActive: s3.toolsActive, expect: { strictJson: false, toolsActive: false } });

  const ok1 = s1.strictJson === true;
  const ok2 = s2.toolsActive === true;
  const ok3 = s3.strictJson === false && s3.toolsActive === false;
  result.ok = ok1 && ok2 && ok3;
} catch (e) {
  result.error = String(e && e.stack || e);
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
