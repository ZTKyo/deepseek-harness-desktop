# Phase 02 R5 — Refinement Real-Runtime Evidence (2026-08-24 13:54)

## Legacy NEEDS_VERIFICATION migration + goal-scoped liveness — REAL restart proof

Restart attempt `5d7691a56aff4b21b5a547cbe7728006` (13:54:06, worker 16004):
- old server 23808 -> new server **22032** (13:54:14), generation `639231764546792076_22032` (non-empty)
- candidate bound 13:54:32 (generation binding real); stable re-check hit api_unready timeout
  (server was mid-boot) -> attempt FAILED; server self-recovered to HTTP 200 + COMMIT_READY True
- NOTE: the api_unready at 13:55:07 was a transient boot-time timeout — the server
  reached readiness afterwards; restart mechanism itself was sound (detached worker
  ran to completion independent of the interrupted agent turn).

## Legacy migration — REAL execution log (execution-continuity.log, new process 22032)

```
05:54:20.481 plugin ready; apiOk=true enableAutoResume=true           (Refinement EC loaded)
05:54:25.695 RECONCILE-LEGACY sid=session-9e3b29bb legacy NEEDS_VERIFICATION
           (reason='completion-unknown: ... (session events unavail') -> revalidate
05:54:25.697 CT ... session events unavailable -> evidence_defer (transient, bounded)
05:54:25.706 RECONCILE-LEGACY ... CT evidence unavailable -> bounded defer
05:54:25.716 SCAN restart: 2 recoverable intent(s): ...[WAITING_NETWORK]   <- out of dead-end
05:54:25.725 ... bounded defer #2 nextRetryAt=1787550875719
05:55:13.217 CT sid=session-9e3b29bb -> clean                            <- events readable, CT clean
05:55:16.283 RESUME sid=... goal re-armed (timer)
05:55:16.362 RESUME-OK sid=session-9e3b29bb goalActive=true cycles=7 (timer)
```

Intent transition (execution-intents.json, mtime 13:55:43):
```
state: NEEDS_VERIFICATION -> RUNNING
reason: CT-evidence-defer: session events unavailable (2/5)
schemaVersion: 2, verificationKind: EVIDENCE_DEFER
```

Goal-level liveness (session.list projection):
- goal phase=active, roundsStarted 0 -> **4** (goal-round-driver advancing after RESUME-OK)

## Conclusion
- Post-restart task recovery: **PASS** (was FAIL: legacy dead-end + session-level liveness)
- Generation production binding: PASS (non-empty gen 639231764546792076_22032 in candidate)
- Real unresolved side effect remains fail-closed (UNRESOLVED_SIDE_EFFECT never migrates)
- Same-session manual activity (diagnostics/steps) does NOT count as goal liveness
