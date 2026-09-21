# PHASE 04 LEARN — R1 FINAL REPORT

**Date:** 2026-09-21
**Executor:** Harness (main control)
**Baseline:** `6d0623627c4b38f6b870ef03fe9ed776186c9e09` (origin/main), branch `p4-learning-r1`
**Worktree:** `.worktree-p4-learning-r1` (isolated; production profile untouched)
**Status:** `P4_LEARN_R1 = COMPLETE` — all 12 acceptance criteria satisfied, 278 P4 assertions
green, 0 regressions introduced (1 pre-existing unrelated failure recorded, §5.5)

---

## 1. Objective

Give DSH a **learning capability that never self-activates**: real sessions produce
*experience candidates* with verifiable provenance, a human approves them, and only then do
they become recallable. Promotion to durable/skill status is a separate, explicitly-evidenced
act. Nothing learning-related may ever overwrite runtime state, goals, credentials, or policy.

The hard part is not "summarize a session" — it is making **proposal ≠ activation** true in
code, not in prose.

---

## 2. What was delivered

| File | Lines | Role |
|---|---|---|
| `plugins/learn-core.mjs` | 619 | Pure algorithm (no DSH runtime): digest, signal detection, store schema, validation, recall, promotion eligibility, redaction, write boundary |
| `plugins/learn.mjs` | 378 | Cordis plugin shell: hook wiring, 5 tools, persistence, telemetry, kill switch |
| `tests/learn/test-learn-core.mjs` | 442 | Unit suite — **220 PASS / 0 FAIL** |
| `tests/learn/run-learn-real-e2e.mjs` | 326 | Real-session E2E E1–E4 — **58 PASS / 0 FAIL** |
| `tests/learn/run-ac7-regression.ps1` | — | AC7 regression sweep over pre-existing suites |
| `docs/roadmap/evidence/P4_LEARN_R1_*.txt` | — | Raw unedited test output |

**Modified (1 file):** `docs/roadmap/evidence/cm-r4-log-decoder.mjs` — export-only change so
the decoder is reusable as a module. Proven byte-identical in behaviour (§5.3).

---

## 3. Architecture — reuse, not duplication

Rule §0.3 of the playbook: search before building. What already existed and was reused:

| Need | Reused from | How |
|---|---|---|
| Raw session truth source | P2.5 context-memory | Same append-only session events; **no second parser** |
| Message text extraction | P2.5 official extractors | Injected as `{messageOfEvent, recursiveText, isPluginSourced}`; `buildLearnDigest` **fails closed** (`missing_official_extractors`) if absent |
| Session log decoding | P2 R4 `cm-r4-log-decoder.mjs` | Same implementation the E2E uses |
| Secret patterns | `supervisor-bridge-core.mjs` | `KEY_PATTERN` / sha256 / redaction semantics |
| Tool registration | `execution-continuity.mjs` pattern | `defineTool` soft-import; degrades gracefully if unavailable |
| Persistence location | Existing state dir convention | `stateDir` under the DSH state root, never a new store system |
| Progress/telemetry | Existing structured-event convention | Same shape as P2/P3 plugins |

No second watchdog, no second router, no second progress system, no second memory system.

### The authority chain (this is the whole design)

```
real session events
   └─> buildLearnDigest()        (P2.5 extractors, redacted)
        └─> learningSignals()    (failure / correction / success)
             └─> experience      state = PROPOSED        <-- NOT recallable
                  └─> learn_review approve (approver + evidence, human)
                       └─> state = APPROVED              <-- recallable
                            └─> learn_promote (evidence, explicit)
                                 └─> promotion = PROMOTED <-- durable/skill
```

Every arrow is a code-enforced gate. `learn_recall` filters on `state === 'APPROVED'`; a
PROPOSED experience is invisible to recall **by construction**, not by convention.

---

## 4. Acceptance criteria — evidence mapping

| AC | Requirement | Evidence | Verdict |
|---|---|---|---|
| **AC1** | Same raw session source as P2.5; no duplicate parser | Unit: default path byte-identical to P2.5 official extraction (assert compares joined text of both paths). Fail-closed on missing extractors. E2E: decodes real session via the shared decoder | **PASS** |
| **AC2** | Proposal is never activation; approval enforced in code | E2E E1: `PROPOSED is NOT recallable`. E2: approve without approver rejected; without evidence rejected; rejection terminal | **PASS** |
| **AC3** | No secrets in records/telemetry/prompts/logs | Unit: digest text redacted. E2E: raw secret absent from persisted bytes; approve-with-secret-in-evidence rejected | **PASS** |
| **AC4** | Deterministic recall from APPROVED only | E2E E3: identical query → byte-identical output; PROPOSED and REJECTED both absent from results | **PASS** |
| **AC5** | Corruption/missing/malformed handled fail-closed | E2E E4: corrupt store → 0 experiences trusted, rebuilt to valid empty, `STORE_REBUILT` telemetry. Malformed sessions do not throw | **PASS** |
| **AC6** | Genuine learning from the real raw session | E2E E1: grew a **real 3227-node / 44252-frame session** node-by-node through the live hook; candidate produced with provenance seqs each verified to point at a real event, title traced to a real utterance | **PASS** |
| **AC7** | No regression in P1/P2/P2.5/P2.6/P2.75/P3 | Decoder byte-identical proof (§5.3) + regression sweep: **19/20 suites green, 0 failures introduced**; the 1 red suite carries **2 pre-existing failures proven unrelated to P4** (§5.5) | **PASS** |
| **AC8** | Learning telemetry observable, structured, redacted | `PROPOSED / APPROVED / REJECTED / RECALLED / PROMOTION_BLOCKED / STORE_REBUILT / WRITE_DENIED` counters asserted in E1/E2/E3b/E4 | **PASS** |
| **AC9** | Isolated E2E E1–E4 all PASS | 58 PASS / 0 FAIL, exit 0 | **PASS** |
| **AC10** | Can never overwrite runtime state/goals/credentials/policy | E2E E4: 9 protected targets denied, unknown target denied, null/empty denied, `experience-store` allowed | **PASS** |
| **AC11** | Promotion requires evidence + explicit approval; no self-escalation | E2E E3b: promotion BLOCKED for non-approved experience (telemetry recorded); explicit promotion only | **PASS** |
| **AC12** | Desktop usable; no fabricated evidence; no overclaiming | No service restart performed; production `cordis.patch.yml`/`settings.yaml` mtimes unchanged; §8 discloses the one verification limitation | **PASS** |

---

## 5. Verification actually performed

### 5.1 Unit suite — 220 PASS / 0 FAIL
`node tests/learn/test-learn-core.mjs` → exit 0. Raw output: `evidence/P4_LEARN_R1_UNIT_OUTPUT.txt`.

### 5.2 Real-session E2E — 58 PASS / 0 FAIL
`node tests/learn/run-learn-real-e2e.mjs` → exit 0. Raw output: `evidence/P4_LEARN_R1_E2E_OUTPUT.txt`.

Main evidence session: `session-9e3b29bb-3f36-4659-9162-18ad928a7f49`
(3227 surface nodes, 44252 zstd frames, 0 JSON parse errors).

**Fidelity note.** The first E2E attempt reported `experiences=0` and I did **not** paper over it.
Root cause: the plugin learns only from nodes *new since the last watermark* (correct design —
it must not re-learn history). My first harness dumped 12 nodes at once, producing a window too
small to contain a learning signal. The fix was to make the harness drive the hook the way a
**real session actually grows** — node by node — which is both more faithful and now proven:
the candidate appeared after 60 real pre-step calls. The assertion was not weakened; the
harness was made honest.

### 5.3 Decoder regression proof (AC7, the only modified file)
```
BASELINE frames=32388 lines=39827 parsed=39827 bad=0
AFTER    frames=32388 lines=39827 parsed=39827 bad=0
REGRESSION-CHECK: PASS (identical to baseline)
IMPORT-OK exports: analyze, decodeLines, parseFrames
```
The change is export-only; output is byte-identical on a real 39,827-line session log.

### 5.4 Regression sweep
`tests/learn/run-ac7-regression.ps1` — see §5.5 for the recorded result. The sweep deliberately
**excludes** every suite that starts, stops, or restarts the dsh service or binds port 3080, so
the operator's desktop session was never interrupted.

### 5.5 Regression result — 19 GREEN / 1 RED (2 pre-existing failures, 0 introduced)

Raw summary: `evidence/P4_LEARN_R1_AC7_OUTPUT.txt`.

```
GREEN=19  RED=1  MISSING=0  TOTAL=20  totalFAILlines=2

exit=0  tests\autonomy\test-autonomy-state-core.mjs        RESULT: 104 PASS / 0 FAIL
exit=0  tests\context-memory\verify-context-memory.mjs     RESULT: 72 PASS / 0 FAIL
exit=1  tests\install-plugin\verify-install-plugin.mjs     结果: FAIL（13 通过，2 失败）   <-- pre-existing
exit=0  tests\reliability\test-capacity-resolver.mjs       PASSED
exit=0  tests\reliability\test-completion-truth.mjs        PASSED
exit=0  tests\reliability\test-ec-router-bridge.mjs        PASSED
exit=0  tests\reliability\test-failure-classifier-v1.mjs   34 pass, 0 fail
exit=0  tests\reliability\test-model-registry.mjs          PASSED
exit=0  tests\reliability\test-r5-addendum-ec.mjs          PASSED
exit=0  tests\reliability\test-resume-defer.mjs            PASSED
exit=0  tests\reliability\test-rh2-ec.mjs                  PASSED
exit=0  tests\reliability\test-rh2-r11-goal-resume.mjs     PASSED
exit=0  tests\reliability\test-runtime-capacity-adapter.mjs PASSED
exit=0  tests\reliability\test-secret-scan-fixtures.mjs    PASSED
exit=0  tests\reliability\yaml-parse-check.mjs             YAML CHECK: 6 ok, 0 failed
exit=0  tests\router\test-deepseek-native-multimodal.mjs   25 passed, 0 failed
exit=0  tests\router\test-exact-model-preservation.mjs     9 passed, 0 failed
exit=0  tests\supervisor\test-supervisor-mutation-state.mjs 19 passed, 0 failed
exit=0  tests\learn\test-learn-core.mjs                    RESULT: 220 PASS / 0 FAIL
exit=0  tests\learn\run-learn-real-e2e.mjs                 P4 LEARN R1 REAL-SESSION E2E: 58 PASS / 0 FAIL
```

#### Classification of the 1 red suite: **PRE-EXISTING, not introduced**

Failing assertions (both in `tests/install-plugin/verify-install-plugin.mjs`):
```
FAIL  T3.1 preflight 退出码 0 :: got 1; out=PREFLIGHT FAIL: install-plugin --check 未通过
FAIL  T3.2 输出包含 'PREFLIGHT PASS' :: PREFLIGHT FAIL
```

Root cause, established by direct inspection rather than assumption:
`install-plugin --check` compares the **worktree repo** against the **deployed production
profile** (`~/.dsh/profiles/web/`). It reports **11 checksum mismatches** — `ask-telegram`,
`computer-use`, `secret-gate`, `completion-notify`, `failure-classifier`, `openrouter-router`,
`agentrouter-wire`, `agent-inspector`, `keepalive-patch`, `model-selection-guard`,
`execution-continuity`. These are version drift between the worktree (baseline `6d062362`) and
whatever builds are currently deployed.

Proof that P4 did not cause it:
1. All 11 mismatched files are `UNCHANGED-from-baseline` per `git status` — P4 touched none of them.
2. The new P4 plugin files (`learn-core.mjs`, `learn.mjs`) **never appear** in the check output
   (verified with a precise pattern; an earlier `learn`-substring test was a false positive
   because the worktree path `.worktree-p4-learning-r1` itself contains "learn" — noted so the
   same mistake is not repeated).
3. `cordis.patch.yml` in the production profile contains **no** learn registration, so P4 adds
   nothing to the comparison.
4. The entire failure is "repo ≠ deployed", which was already true before P4 existed.

**Recorded, not fought.** This is an environment/deployment-state issue outside P4's scope. Per
the change-boundary rule I did not "fix" it by re-syncing the production profile — that would
mean overwriting the operator's live plugins, which is not mine to do unprompted.

---

## 6. Explicitly NOT done (scope boundaries)

- **No activation.** This ships the *capability* to learn. No experience is auto-approved, no
  skill is auto-installed, nothing is auto-promoted. That is the point of AC2/AC11.
- **No GUI surface.** `learn_*` tools are agent-callable; there is no learning panel in the web
  GUI. Not requested, and adding UI without a request would violate the change-boundary rule.
- **Not deployed to the production profile.** The plugin lives in the worktree and is **not**
  registered in `~/.dsh/profiles/web/cordis.patch.yml`. Deploying it would require a service
  restart, which the operator's rules forbid mid-task. Deployment is a separate, operator-gated
  step.
- **Pushed and PR opened; NOT merged, NOT deployed.** Branch `p4-learning-r1` (commits `ede575e`
  + docs commit) pushed to `origin`, PR **#90** opened against `main`:
  https://github.com/ZTKyo/deepseek-harness-desktop/pull/90 — verified state at hand-off:
  `state=OPEN`, `isDraft=false`, `mergedAt=null`, `mergeStateStatus=BLOCKED`. The PR exists so the
  External Review can be performed on a real, inspectable diff; **merging, deploying, and any
  VERIFIED declaration remain explicitly outside R1** and are reserved for the Reviewer + operator.
- **Latent P3 gap left unfixed** (pre-existing, non-blocking, out of P4 scope):
  `deriveVerificationState` returns `null` when `acceptanceCriteria` is empty
  (`autonomy-state-core.mjs:219`) while the tool output schema declares `type: "string"`
  (`execution-continuity.mjs:2106`) — the tool's output fails its own schema when no criteria
  are declared. Reported, not silently refactored.

---

## 7. Rollback

P4 is **purely additive** apart from one export-only decoder edit.

```powershell
# full rollback (nothing in production was touched)
cd "C:\Users\Administrator\Desktop\sdeepseek harness\.worktree-p4-learning-r1"
git checkout -- docs/roadmap/evidence/cm-r4-log-decoder.mjs
Remove-Item -Recurse -Force plugins\learn-core.mjs, plugins\learn.mjs, tests\learn, docs\roadmap\reports\PHASE_04_LEARNING
```

No production file, credential, session, or runtime state was modified, so rollback carries no
data-loss risk. The E2E writes only under `os.tmpdir()`; its temp dirs are printed at the end of
each run and are safe to delete.

---

## 8. Honest limitations and disclosures

1. **Host-verified per-criterion PASS is unavailable this session.** During the §8 preflight,
   `criteriaBindings` were declared as `kind: "none"` for all 12 criteria — a write-once field
   set before the deliverable paths existed. Per the R1C-2 binding gate, `file_hash` /
   `system_api` PASS can no longer be bound to any criterion in this session. Evidence recorded
   via `autonomy_verify` is therefore **soft** (`ai_judgment` class) and is stored as
   `UNVERIFIED` by the host, not PASS. This is a *verification-plumbing* limitation, not a
   product limitation — the underlying test results above are real, reproducible, and their raw
   output is archived. I am not claiming host-verified PASS for AC1–AC12.
2. **The E2E's real session is one specific session.** The candidate window that fired came from
   session `9e3b29bb…`. Signal detection was separately probed across 59 sliding windows of a
   different real session (11 MB, 609 nodes) with **59/59 windows containing a signal**, so the
   detector is not tuned to one lucky session — but the E2E itself exercises one.
3. **Learning-signal kinds are text-pattern based** (failure / correction / success). Real
   session text is redacted before analysis, so a signal whose only marker was inside a secret
   would be missed. Acceptable: erring toward missing a lesson rather than leaking a credential.
4. **No soak test.** The plugin has been exercised in-process and across simulated restarts, but
   has not run attached to a live long-lived session for days. Deployment should be watched.

---

## 9. Production safety

| Check | Result |
|---|---|
| Service restarted? | **No** |
| `~/.dsh/profiles/web/cordis.patch.yml` mtime | 2026-08-31 — unchanged |
| `~/.dsh/settings.yaml` mtime | 2026-09-21 00:22 — unchanged |
| Sessions / storages written? | **No** (read-only) |
| Secrets printed or stored? | **No** (asserted: raw secret absent from persisted bytes) |
| Writes outside worktree + tmpdir? | **None** |

---

## 10. Verdict

```
P4_LEARN_R1 = COMPLETE
  unit       : 220 PASS / 0 FAIL
  e2e        : 58 PASS / 0 FAIL  (E1-E4, real session, live hook)
  AC1-AC12   : all satisfied
  regression : 19/20 suites green; 1 pre-existing failure (deploy drift, proven
               unrelated to P4); 0 failures introduced
  rollback   : trivial (additive only; no production state touched)
  next       : operator decides whether to register the plugin in the
               production profile (requires one service restart, deferred)
```
