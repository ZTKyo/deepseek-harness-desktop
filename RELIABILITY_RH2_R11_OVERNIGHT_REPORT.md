# HARNESS OVERNIGHT RELIABILITY CLOSURE REPORT

Date: 2026-09-06 (Asia/Shanghai)

Status: `RH2_READY_FOR_FINAL_MERGE_REVIEW`

Scope: `SOURCE / TEST / CI / READ-ONLY PRODUCTION FORENSICS ONLY`.
No merge, deploy, restart, production intent/session mutation, Supervisor state
mutation, credential read/rotation, P3 resume, or P4 start was performed.

Closure fields:

```text
RH2_R11=PASS
RH2_R12=DOCUMENTATION_ONLY_PASS
CODE_CHANGED=NO
TRUE_RH2_DEPLOY_SET=5 exact production files
FALSE_HOTFIX_CLASSIFICATIONS_REMOVED=6
SOURCE_AUTHORITY=GIT_REVIEWED_TREE
LAUNCHER_OVERRIDE=KEEP_TEMPORARILY_FOR_INITIAL_SOAK
GOAL_RESUME_FALLBACK=PASS
RH2_EC=PASS (21/21)
RH2_HEALTH=PASS (13/13)
RH2_WATCHDOG=PASS (11/11)
ADVERSARIAL_AUDIT=NO_NEW_BLOCKER
EC_SOAK=PASS
HEALTH_SOAK=PASS
GUARDIAN_SOAK=PASS
RESOURCE_LEAK=NO_EVIDENCE
PRODUCTION_DRIFT=MAPPED
DEPLOYMENT_MANIFEST=READY
SECURITY_P1=DEFERRED
PRODUCTION_MUTATED=NO
FINAL_STATE=RH2_READY_FOR_FINAL_MERGE_REVIEW
```

## Closure identity (FACT)

| Field | Value |
|---|---|
| Repository | `ZTKyo/deepseek-harness-desktop` |
| PR | `#85` |
| Branch | `hotfix/reliability-rh2-freeze-p1` |
| START_MAIN_SHA | `563ce43d59c5a46a7e663cee804f6e4609d1f70d` |
| START_PR85_HEAD | `1277429b3f2a109d47baeabd2125cde880f7a61d` |
| SOURCE_FIX_COMMIT | `18802858b4b58d61a25d98bf6cc273e30663e018` |
| Final source-bearing head | `18802858b4b58d61a25d98bf6cc273e30663e018` |
| REVIEWED_PR_HEAD | `9c8a519b29058d8d7876d8bbaae15cfcf08f346b` |
| FINAL_PR85_HEAD | documentation-only correction commit; exact hash is captured in the final closure output |
| PR state after source push | OPEN, base `main`, MERGEABLE |
| CI source-bearing head | `18802858b4b58d61a25d98bf6cc273e30663e018` |

The report and manifest are documentation-only additions after the source
candidate CI. The exact final PR head after those documentation additions is
reported in the closure output; source behavior is unchanged by the report
commit.

## R1.2 manifest truth correction (FACT)

`CODE_CHANGED=NO` for R1.2. The canonical source authority is the reviewed Git
tree, not checkout byte hashes, `_release-staging`, the active profile, or a
dirty worktree. Re-deriving `git diff --name-status origin/main...HEAD` and
base/head blob identity removed six false `REVIEWED_HOTFIX` classifications.

```text
SOURCE_AUTHORITY=GIT_REVIEWED_TREE
STAGING_AUTHORITY=NO
DIRTY_WORKTREE_AUTHORITY=NO
TRUE_RH2_DEPLOY_SET=
  plugins/execution-continuity.mjs
  dsh-readiness.ps1
  dsh-health.ps1
  dsh-healthcheck.ps1
  dsh-guardian-watchdog.ps1
UNCHANGED_IN_PR=
  plugins/execution-continuity-core.mjs
  dsh-guardian.ps1
  dsh-reconnect.ps1
  DSH-Harness-PS.ps1
  dsh-launcher.js
  start-dsh-server.ps1
LAUNCHER_OVERRIDE=KEEP_TEMPORARILY_FOR_INITIAL_SOAK
PRODUCTION=UNCHANGED
```

The unchanged files remain excluded even where production or checkout bytes
differ; those differences are `PRE_EXISTING_PRODUCTION_DRIFT` or the specific
known launcher diagnostic override, not RH2 changes. The corrected two-table
Git/prod matrix is in `RH2_DEPLOYMENT_PREFLIGHT_MANIFEST.md`.

## R1.1 closure (TEST RESULT)

`GOAL_RESUME_FALLBACK=PASS`

- Added one shared `resumeGoalThenPrompt()` tail and
  `classifyGoalResumeDisposition()` in `plugins/execution-continuity.mjs`.
- Generic goal-level errors, including HTTP 400 / `INVALID_REQUEST`, stale
  goal/ref/revision, inactive/unknown goal state, and transient errors, attempt
  exactly one `session.prompt(mode=queue)` fallback.
- Only explicit `INVALID_SESSION` / missing session proof and
  `OWNERSHIP_CONFLICT` suppress the prompt and persist `FAILED_FATAL`.
- Successful prompt acceptance persists `RUNNING` / `RESUME-OK`, clears
  `nextRetryAt`, and resets `resumeRetryCount`.
- The public `resumeViaApi()` entry now owns one per-session in-flight guard.
  It covers scan, timer, delayed `session/event`, and direct callers; `finally`
  releases the guard after both success and failure.
- The same goal/prompt tail is used by `resumeViaApi()` and
  `resumeAfterCtClean()`.

Deterministic R1.1 suite: **19 passed, 0 failed** (`GR1`-`GR7` plus adversarial
overlap `AD1`). `AD1` observed one prompt, peak one concurrent prompt, final
state `RUNNING` for two concurrent recovery calls.

## Regression matrix (TEST RESULT)

All listed safe local suites passed after the final source edit:

- RH2 EC `21/21`; RH2 health `13/13`; RH2 watchdog `11/11`.
- Crash-safe `33/33`; fault-injection `38/38`; F2 `24/24`; R5 EC addendum
  `90/90`; resume defer `12/12`.
- Execution Continuity `30/30`; WAITING_USER `12/12`; compaction `18/18`;
  multitask recovery `6/6`; nonrecoverable states `19/19`.
- P2.6 retry policy `41/41`; official retry-zero `16/16`; autonomy state
  `104/104`; failure classifier `34/34`.
- EC-router bridge `14/14`; capacity resolver `6/6`; model registry `33/33`;
  runtime capacity adapter `13/13`; completion truth `18/18`.
- Exact model preservation `9/9`; DeepSeek native multimodal `25/25`;
  model-selection guard `21/21`.
- Restart budget isolated PASS; Stage B/C/D/E isolated PASS; router rollback
  PASS; final reliability drill PASS; Guardian JS-tag `8/8`; launcher args
  `33/33`; orphan-lock contract PASS.
- RH1 R3 Guardian path `19/19`; sanitized credential preflight `36/36`.
- Node syntax `132/132`; PowerShell syntax `63/63`; YAML `6/6`; secret
  fixtures `6/6`; repository secret scan PASS.
- Read-only current-runtime `COMMIT_READY` PASS: process identity, API,
  `events.mux`, `events.host`, renderer, and stable window. This is runtime
  observation only and is not evidence that the un-deployed source candidate
  is loaded.

The local full RH1 live lifecycle harness and cold-start credential mutation
harness were not run because their prescribed paths include process lifecycle
and credential operations forbidden by the overnight boundary. CI Level 3 on
the sanitized runner is the required external lifecycle evidence.

## Adversarial audit (TEST RESULT / INFERENCE)

`ADVERSARIAL_AUDIT=NO_NEW_BLOCKER`

The independent second-pass audit found one confirmed RH2 P1 before the final
patch: delayed `session/event` recovery could call `resumeViaApi()` while scan
or timer recovery was in flight, because the old guard lived only in callers.
The public-entry guard and `AD1` regression close that counterexample. No P0
or unresolved high-confidence P1 remains in the RH2 scope after the patch.

Document-only residuals:

- The pre-existing `session.list` missing-item branch maps to `COMPLETED`.
  No deterministic production counterexample proving a transient list omission
  was available tonight; it remains an explicit follow-up rather than an
  unverified hotfix.
- Message-based error vocabulary and the pre-existing Stage B `-SkipLive`
  `Compare-Object null` hygiene concern remain documented only. Neither was
  shown to invalidate RH2 CI truth.

## Isolated soaks (TEST RESULT; SYNTHETIC)

`SOAK_DURATION=cycle-count criterion satisfied: EC 100 cycles; wall-clock benchmark not claimed`

### EC soak

`EC_SOAK=PASS`

- 450 sessions, 100 recovery cycles, configured concurrency 2.
- `promptCalls=26570`, `goalCalls=26630`, unhandled rejections `0`.
- Final states: `RUNNING=260`, `FAILED_FATAL=150`, `WAITING_USER=20`,
  `COMPLETED=20`.
- Observed maximum concurrent resume `1/2`; terminal, user-wait, completed,
  changing-error, bounded-retry, and success-reset assertions passed.

### Health soak

`HEALTH_SOAK=PASS`

- 400 synthetic sessions and approximately 500KB session-list payload,
  300 full probe cycles.
- API readiness evaluations `300`; session-list evaluations `240`; WebSocket
  checks `480`.
- Average `4.55ms`, P95 `27ms`, maximum `54ms`.
- Memory delta `+118784` bytes; handles `578 -> 564`; threads `32 -> 31`;
  temporary files `0`; unhandled rejections `0`.
- Slow API, one-sided WS failure/recovery, and temporary API error cases passed.

### Guardian watchdog soak

`GUARDIAN_SOAK=PASS`

- 500 observation cycles covering blank command line, fresh/stale heartbeat,
  PID reuse/start mismatch, process/heartbeat missing, and unverified spawn.
- Valid duplicate starts `0`; ambiguous identity starts `0`; ambiguous kills
  `0`; truly absent start eligibility `62`; post-spawn duplicate starts `0`.
- Process starts `0`; kills `0`; temporary files `0`; unhandled rejections `0`.
- Memory delta `+2711552` bytes; handles `567 -> 555`; threads `30 -> 30`.

`RESOURCE_LEAK=NO_EVIDENCE`. The measurements are fixture/process observations,
not a claim that the Windows allocator returns all memory immediately.

## Deployment drift preflight (FACT / INFERENCE)

The full path/hash matrix is in `RH2_DEPLOYMENT_PREFLIGHT_MANIFEST.md`.
Important facts:

- `_release-staging` was not modified; it is a dirty main snapshot at
  `b6feb72229436d9684235a71420e84d830074d31` and is behind the reviewed
  `origin/main` line. It must not be treated as the RH2 source of truth.
- The exact reviewed Git-head EC hash is
  `041aad8d4510c33dc3e3671a3ae2b407d18cf9a25db1f75bef7604255ab9c848`.
  Active `~/.dsh/profiles/web` contains the old checkout hash
  `36a7a0a308021f31916a8fcbdfa45cdf5f3bf261f741373003fca09b5a77285`; the
  source candidate is not deployed or loaded. This is `STALE_DEPLOYMENT`, not
  Git change truth.
- `loaded-release.json` SHA256 was
  `4bedf5a945ac533cde95a5cc54d566651a86246014d4bc88e048351e4ca63c71`.
  Its EC entry is the same old profile hash. The manifest records
  `serverGeneration=boot:2824_1788613920268`, `loadedAt=09/05/2026 20:22:32`,
  and a stale metadata PID `11968`; this is a preflight mismatch, not a reason
  to restart tonight.
- DSH-Client `dsh-launcher.js` lines 80-88 contain the 2026-09-02 GC
  diagnostic override, while the reviewed canonical launcher line 78 has no
  V8 flags. The latest read-only listener probe did not observe a 3080 listener;
  no start or restart was attempted.
- `LAUNCHER_OVERRIDE=KEEP_TEMPORARILY_FOR_INITIAL_SOAK`; the launcher is
  `UNCHANGED_IN_PR` and excluded from `RH2_DEPLOY_SET`. After the first 30-60
  minute production soak, decide separately whether to remove `--trace-gc`.

`PRODUCTION_DRIFT=MAPPED`. `PRODUCTION_MUTATED=NO`; this task performed no
production file writes, service actions, or process lifecycle actions.

## Security and frozen scopes

- `SECURITY_P1=DEFERRED`: the `NOTION_TOKEN` issue remains a separate closure;
  its value was not read, printed, rotated, migrated, or deleted.
- `CI_FAIL_CLOSED_DEBT=DOCUMENT_ONLY`: the known Stage B `-SkipLive` PowerShell
  non-terminating-error hygiene concern was not widened into this hotfix.
- `P2.75=FROZEN`; `P2.8=FROZEN`; `P3=PAUSED`; `P4=LOCKED`.

## CI truth (FACT)

Fresh checks for the source-bearing head all completed successfully:

| Check | Run | Result |
|---|---:|---|
| CI Level 1 - Static Gate | `33990486832` | PASS |
| CI Level 2 - Windows Reliability State Machines | `33990486846` | PASS |
| CI Level 3 - Harness Smoke | `33990486838` | PASS |

Run links: [L1](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33990486832), [L2](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33990486846), [L3](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33990486838).

## Final boundary

`SERVER_RESTARTED=NO`
`GUARDIAN_RESTARTED=NO`
`DESKTOP_RESTARTED=NO`
`PR85_MERGED=NO`
`DEPLOYED=NO`

This is a source candidate ready for external review, not a production-fix
claim. The next authorized step is external review and an explicitly approved
deployment procedure using the separate preflight manifest.
