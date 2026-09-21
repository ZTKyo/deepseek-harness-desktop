# PHASE 04 LEARN — §8 autonomy_verify PREFLIGHT

**Date:** 2026-09-20
**Executor:** Harness (main control)
**Baseline:** `6d0623627c4b38f6b870ef03fe9ed776186c9e09` (origin/main), branch `p4-learning-r1`
**Status:** `AUTONOMY_VERIFY_PREFLIGHT = PASS` (with one documented latent P3 gap + one executor-introduced binding limitation)

---

## 1. Question being answered

Before touching P4, the P3 verification authority (`autonomy_verify`) must be proven usable.
Prior attempts in this session failed with:

```
tool "autonomy_verify" returned invalid output: "value.verificationState" must be a string
```

The required classification was: (A) caller contract error, or (B) canonical P3 verifier defect.

---

## 2. Where the tool actually lives (not where it was assumed to be)

| Search target | Result |
|---|---|
| Official `@deepseek-ai/dsh` npm package | **No** `autonomy_verify`, **no** `criteriaBindings`, **no** `verificationState` |
| `~/.dsh/profiles/web/execution-continuity.mjs` | **Registers `autonomy_verify`** (line 2094) |
| `plugins/execution-continuity.mjs` (repo) | Same registration |

`autonomy_verify` / `autonomy_report` / `autonomy_state` are registered by **our own P3
execution-continuity Cordis plugin** via `ctx.tools.register(defineTool({...}))`, guarded by a
soft import of `@deepseek-ai/dsh-tools` (deployed `execution-continuity.mjs:80-85`).

Single source of the algorithm: `plugins/autonomy-state-core.mjs` (pure module, no DSH runtime).
The production plugin and the tests import **this exact module** — no duplicated algorithm.

---

## 3. Root cause (deterministic, zero-side-effect proof)

Declared contract (`execution-continuity.mjs:2106`, tool **output** schema):

```js
schema: { type: "object", additionalProperties: false,
          properties: { ok: { type: "boolean", required: true },
                        verificationState: { type: "string" }, ... } }
```

Producer (`execution-continuity.mjs:2206` + `:2212`):

```js
patch.verificationState = deriveVerificationState(merged.value.acceptanceCriteria, merged.value.criteriaEvidence);
...
return { ok: true, verificationState: patch.verificationState, autonomy: final.value };
```

`autonomy-state-core.mjs:218-219`:

```js
export function deriveVerificationState(criteria, evidence) {
  if (!Array.isArray(criteria) || criteria.length === 0) return null;   // <-- returns NULL
```

**`null` is not a string ⇒ the tool's own output fails its own schema.**

Probe (`evidence/preflight-derive-probe.txt`, canonical module, pure functions only):

| case | derived value | `typeof` | schema-valid |
|---|---|---|---|
| empty criteria + empty evidence | `null` | object | **NO** |
| `null` criteria | `null` | object | **NO** |
| `undefined` criteria | `null` | object | **NO** |
| 2 criteria, no evidence | `"UNVERIFIED"` | string | yes |
| 2 criteria, both PASS | `"VERIFIED"` | string | yes |
| 2 criteria, one FAIL | `"FAILED"` | string | yes |
| soft PASS only (`ai_judgment`) | `"UNVERIFIED"` | string | yes |
| hard PASS + soft PASS | `"PARTIAL"` | string | yes |

`violationCount=3 totalCases=8` — **all three violations are exactly the "no acceptance criteria
declared yet" case.** Every case with criteria present returns a valid string.

### Trigger condition

The error appears **only when `acceptanceCriteria` has never been declared** in the session.
The earlier failed calls were made *before* any `autonomy_report` call, i.e. the canonical
**prerequisite** (declare criteria → then verify) had been skipped.

### Classification

- Parameter names/values were **correct** per the tool's declared `parameters` schema
  (`status`, `evidenceClass`, `evidence` — deployed `:2098-2100`). → **not** a wrong-parameter error.
- The failure was a **missing prerequisite**, not a wrong parameter.
- With the prerequisite satisfied, the canonical contract **works** (proven above).

**⇒ `AUTONOMY_VERIFY_PREFLIGHT = PASS`.** P4 proceeds.

### Latent P3 gap (reported, NOT fixed — §2 forbids P3 modification inside P4)

`deriveVerificationState` returning `null` for an empty criteria set is a **robustness defect**:
the tool surfaces a confusing JSON-schema violation instead of a clear
`autonomy_verify rejected: no_acceptance_criteria`. It is **pre-existing (P3)**, **not
P4-introduced**, and **does not block P4**. Correct disposition per §2: record as a P3 backlog
item; do **not** open a P3 repair branch inside P4.

---

## 4. Executor-introduced limitation (disclosed, not hidden)

While declaring the P4 acceptance criteria I passed `criteriaBindings` with
`kind: "none"` for all 12 indices. Per the tool contract and
`autonomy-state-core.mjs:157-181` (`mergeCriteriaBindings`), bindings are
**write-once per index and immutable after set**, and `kind:"none"` means
*"host-verifiable PASS permanently unavailable for that criterion"*.

Consequences (verified by reading the enforcement path, `execution-continuity.mjs:2150-2176`):

- a criterion-level `file_hash`/`system_api` PASS (`criterionIndex` given) now fails closed with
  `target_binding_mismatch` (because `b.kind !== "file"` / `b.kind !== "api"`);
- therefore `criteriaEvidence` can never carry a host-verified PASS in this session, and the
  derived `verificationState` cannot reach `VERIFIED` from criterion evidence.

This was an **executor error** — it contradicted the executor's own stated plan to defer bindings
until real deliverable paths were known. It is disclosed here rather than worked around.

### What still works (same tool, same host verifier — not a second verifier)

`execution-continuity.mjs:2169-2171` — when **no** `criterionIndex` is supplied (milestone
verification), the binding gate is **skipped** and the call goes straight to
`hostVerifyEvidence(...)`, i.e. real host-side byte/loopback verification:

```js
} else {
  hostResult = await hostVerifyEvidence(args.evidenceClass, evText);
}
```

So **host-verified milestones + `lastVerifiedCheckpoint` remain fully functional** with
`file_hash` / `system_api` evidence. This is the *same* canonical tool and the *same* host
verifier — **not** a bypass or a second verifier, so §8's prohibition is respected.

**P4 verification strategy therefore:**
1. Real verification is performed by **actually running** the unit suites, the fail-closed
   suites and the isolated E2E E1–E4, plus regression of P1–P3.
2. Durable anchors are recorded as **host-verified milestones** (real sha256 of real artifacts,
   host-re-checked) with `lastVerifiedCheckpoint` updates.
3. The per-criterion PASS ledger is **unavailable in this session** and is reported as such —
   no fabricated criterion PASS will be claimed.
4. The final P4 report states AC1–AC12 status with the **real** evidence and explicitly
   distinguishes *verified by execution* from *recorded in the autonomy ledger*.

No direct edit of `~/.dsh/sessions` or `~/.dsh/storages` was attempted — that is a workspace
red line, and the EC IntentStore is the single writer of autonomy metadata.

---

## 5. Constraints discovered that shape P4 design

- `MAX_ACCEPTANCE_ITEMS = 12` (`autonomy-state-core.mjs:27`) — the task defines **14** ACs
  (AC1–AC14). They were consolidated to 12 by merging the two naturally-coupled pairs
  (approval-boundary + proposal≠activation; promotion-evidence + no-auto-promote) and the
  desktop-usable + no-overclaiming pair. Recorded in `autonomy_report`.
- `acceptanceCriteria` is **write-once**; the declared set is now frozen for this session.
- Soft evidence classes (`git`, `browser_state`, `screenshot`, `ai_judgment`) can **never** PASS
  — a claimed soft PASS is recorded `UNVERIFIED` with a `SOFT-EVIDENCE` prefix.

---

## 6. Verdict

```
AUTONOMY_VERIFY_PREFLIGHT = PASS
  evidence   : static proof on the canonical module + tool source read
  blocker    : none for P4
  p3 backlog : deriveVerificationState returns null on empty criteria -> schema violation
               (pre-existing, non-blocking, NOT fixed inside P4)
  executor   : criteriaBindings kind:"none" declared prematurely -> per-criterion
               host-verified PASS unavailable this session (disclosed)
  next       : proceed to P4 gap audit + implementation
```
