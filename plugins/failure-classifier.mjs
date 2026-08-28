// failure-classifier.mjs — P2.6 R1 observation plugin (evidence only, zero decisions)
// ─────────────────────────────────────────────────────────────────────────────
// Chain position: FIRST patch-layer listener on `agent/request-error`
// (registered before openrouter-router / commandcode-router / execution-continuity
// in cordis.patch.yml; the core dsh-llm-retry listener still observes the raw
// failure first by bundle order — see the baseline audit for why that is
// intentional and why classification here is observational).
//
// Contract (per P26_R1_BASELINE_AUDIT.md I2):
//  - Classifies every agent/request-error failure into Failure Taxonomy V1 via
//    failure-classifier-core.mjs and appends ONE evidence line to a local JSONL
//    file (default ~/.dsh/p26-failure-classifier.log, 1 MiB rotate).
//  - NEVER mutates payload.failure (llm/retry session-event schema stays safe),
//    NEVER appends session event types, NEVER retries, NEVER picks a model.
//  - All errors are contained; the chain is always forwarded to next().
//  - Rollback single switch: config { enabled: false } (or delete this insert
//    block from cordis.patch.yml) — identical to pre-R1 behavior.
//
// export const name — "failure-classifier"

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFailureV1, TAXONOMY_VERSION } from "./failure-classifier-core.mjs";

export const name = "failure-classifier";

const DEFAULT_MAX_BYTES = 1024 * 1024;

function evidencePath() {
  return path.join(os.homedir(), ".dsh", "p26-failure-classifier.log");
}

function redact(text) {
  return String(text ?? "")
    .replace(/\b(?:sk|rk|ck)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, 200);
}

function appendEvidence(file, maxBytes, record) {
  try {
    let line = JSON.stringify(record) + "\n";
    try {
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        try { fs.rmSync(file + ".1", { force: true }); } catch {}
        fs.renameSync(file, file + ".1");
      }
    } catch {}
    fs.appendFileSync(file, line);
  } catch {
    // Evidence is best-effort; never surface to the chain.
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    console.error("[failure-classifier] disabled by config (pre-R1 behavior restored)");
    return;
  }
  console.error("[failure-classifier] armed (P2.6 R1 observation plugin loaded; boot-time evidence line)");
  const file = typeof config.evidenceFile === "string" && config.evidenceFile.length > 0
    ? config.evidenceFile
    : evidencePath();
  const maxBytes = Number.isFinite(config.evidenceMaxBytes) && config.evidenceMaxBytes > 0
    ? config.evidenceMaxBytes
    : DEFAULT_MAX_BYTES;

  const dispose = ctx.on("agent/request-error", async (payload, next) => {
    try {
      const failure = payload?.failure;
      const provider = typeof payload?.provider === "string" ? payload.provider : "";
      const model = payload?.model || payload?.resolved?.model || "";
      const sid = payload?.agent?.session?.id || "";
      const cls = classifyFailureV1(failure, { provider, model });
      appendEvidence(file, maxBytes, {
        ts: new Date().toISOString(),
        sid,
        provider,
        model,
        taxonomyVersion: TAXONOMY_VERSION,
        classification: cls.classification,
        providerCode: cls.providerCode,
        httpStatus: cls.httpStatus ?? null,
        retryableSameRoute: cls.retryableSameRoute,
        deterministic: cls.deterministic,
        unavailableUntil: cls.unavailableUntil,
        retryAfterMs: cls.retryAfterMs,
        normalizedSignature: cls.normalizedSignature,
        reason: cls.reason,
        coreCode: String(failure?.code || ""),
        message: redact(failure?.message),
      });
    } catch (e) {
      console.error(`[failure-classifier] classify/evidence error (isolated): ${e && e.message ? e.message : e}`);
    }
    return next();
  });

  ctx.effect(() => () => {
    // Listener lifecycle is owned by cordis; nothing extra to free (evidence is append-only).
  }, "failure-classifier lifecycle");

  return {
    _test: { classifyFailureV1, appendEvidence, evidencePath: file },
  };
}
