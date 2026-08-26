# DeepSeek Harness Full Reliability / Architecture / Red-Team Audit

Audit window: 2026-08-23 to 2026-08-24 (Asia/Shanghai)  
Requested mode: `AUDIT ONLY`  
T0 canonical baseline: `main@b9ddc1171eb0602615b9b54ce654fe821f0fd8af`  
T0 candidate snapshot: `fix/phase02-review-r2@25a1d89895c8b2ef654e64b4eff0d5222ba1c023`  
T1 runtime delta: `fix/phase02-review-r2@379a1c35b30bf02d583584757bdfb5da5f31b648`  
T2 closeout canonical: `main@64071dacc11f77af9be8c228088abb2932673cf9`  
State cutoff: `2026-08-23T23:52:09+08:00` (`main=origin/main=64071dac`, server PID 8744)  
Runtime: DSH `0.1.1-rc.2`; official core read-only  

This is a moving-target audit. During the audit an independent Harness optimization task committed `25a1d898` and continued modifying the checkout. Accordingly, this report distinguishes:

- **T0 canonical**: immutable GitHub/main snapshot `b9ddc117` used for the initial full audit.
- **T0 candidate**: immutable local snapshot `25a1d898`; not deployed at that observation.
- **Runtime**: files and processes actually loaded during the observation window.
- **T1 delta/runtime**: `379a1c35` was copied live and loaded at about 23:17; it received a bounded delta review.
- **T2 closeout**: PR #15/#16 moved `main` to `64071dac`, critical main files matched deployment/live, and a 23:41 generation completed stable-window + `COMMIT_READY`. T2 is the final current-state basis. Earlier snapshots remain evidence of behavior/history, not current-source identity.

Confidence labels are used literally: `CONFIRMED` means direct source/runtime/test evidence; `HIGH_CONFIDENCE` means converging indirect evidence; `SUSPECTED` needs a controlled test; `UNKNOWN` was not provable safely. Destructive restart, server-kill, provider-failure, credential, disk-full, and network fault injection was not performed because the live Harness had one active goal and two running sessions. Those cases are marked `TEST_DEFERRED_DUE_TO_ACTIVE_TASK`.

# 1 Executive Summary

| Dimension | Score |
|---|---:|
| **Overall Harness health** | **34 / 100** |
| Production Readiness | 45 / 100 |
| Unattended Readiness | 24 / 100 |
| Long-task Readiness | 28 / 100 |
| Recovery Readiness | 24 / 100 |
| Architecture Cleanliness | 38 / 100 |
| Security | 36 / 100 |
| Maintainability | 44 / 100 |
| Future VPS Readiness | 32 / 100 |

Scoring method: the overall score is the rounded arithmetic mean of the eight equally weighted dimensions (`271 / 8 = 33.875`). Each dimension is the sum of five 0–20 evidence axes documented in §19.0. `0–19` means non-operational/critical; `20–39` means useful only with supervision and release blockers; `40–59` means conditionally usable for bounded workloads; `60–79` means production-capable with material constraints; `80–100` requires demonstrated adversarial and soak evidence. Scores reflect the stated unattended objective, not only whether the UI currently opens.

# 2 Final Verdict

**NOT_READY**

# 3 Top Findings

The verdict means **not ready for the stated unattended, side-effecting, long-running production objective**. It does not mean the desktop Harness is unusable: at the live sample it was `client_ready`, had a unique loopback owner, passed API and both WebSocket checks, and passed the non-provider `COMMIT_READY` gate.

Severity rubric: `P0` is a release blocker capable of violating user authority, duplicating/losing irreversible effects, silently changing an explicit execution boundary, or invalidating core recovery. `P1` is a high-impact unattended reliability/security defect without a proven immediate irreversible event. `P2` is a material operability/scalability/maintainability gap. `P3` is governance or hygiene debt. No finding was classified `P0-EMERGENCY`; the audit found no evidence requiring an uncheckpointed production mutation.

## P0

### P0-01 — Current runtime retains two recovery authorities despite source remediation; legacy verification still uses the wrong revision

**Status:** `CONFIRMED_CURRENT_RUNTIME / SOURCE_REMEDIATED_NOT_ACTIVATED_OR_REGRESSION_PROVEN`  
**Evidence:**

- Execution Continuity independently selects and resumes work in `plugins/execution-continuity.mjs:461-547`.
- Goal Recovery independently enumerates active goals and issues `goal.resume` / `session.prompt` in `goal-recovery.mjs:83-129,224-289`.
- Guardian invokes Goal Recovery independently in `dsh-guardian.ps1:247-256,515-518,553-555`.
- Goal Recovery compares the post-resume projection to the old revision in `goal-recovery.mjs:131-136,240-267`; installed DSH `0.1.1-rc.2` increments revision after a successful resume in `dsh-goal/lib/index.js:619-630,725-733,761-786`.
- Runtime Goal Recovery ledger: 37 claims over 27 generations; 36 `needs_review`, one `resume_sent`, zero verified `resumed_running` or `continue_queued`. This is consistent with the revision mismatch.
- Current T2 main changes the Guardian recovery hook to a no-op (`dsh-guardian.ps1:245-260`) and adds explicit Goal Recovery executor mode (`goal-recovery.mjs:32-65,310-344`). This is a genuine source-level consolidation.
- The active Guardian PID 19892 still started at 17:13, before that source was deployed, so its in-memory function can still invoke the legacy global `--resume` path. Goal Recovery retains that legacy scan and stale-revision verification path. The T2 server loaded new EC, but the process-level authority transition is incomplete.

**Real impact:** In the current loaded process set, a Guardian-triggered restart can still run legacy Goal Recovery while EC also recovers. A successful native resume can be misclassified as unverified, prompting a second continuation. After a controlled Guardian reload the source conflict may close, but that end state is not yet proven.

**Reproduction:** In an isolated fixture, create active goal revision `N`, let native `goal.resume` return revision `N+1`, then run the current Goal Recovery verification and the EC boot scan against the same session. Expect Goal Recovery to reject the valid `N+1` projection while EC can enqueue its own recovery prompt. Do not run against the active production session.

**Root cause:** Recovery responsibility was added in two modules; the documented “coordinator/executor” split is not enforced by the call graph or a shared claim record.

**Affected files:** `plugins/execution-continuity.mjs`, `plugins/execution-continuity-core.mjs`, `goal-recovery.mjs`, `dsh-guardian.ps1`, official `dsh-goal` call surface.

**Recommended minimal fix:** The T2 source direction is correct. Complete it with a checkpointed Guardian reload, remove/disable the legacy global scan in production invocation, bind the executor to an explicit revision-aware EC plan, and verify the new revision returned by native DSH. Do not mark the issue closed until loaded-process attestation and concurrency tests pass.

**Regression test:** One real recovery state machine test covering revision `N→N+1`, concurrent EC/Goal Recovery invocation, one durable claim, one accepted resume, and zero duplicate prompt. Assert the production functions are called, not copied logic.

**Phase block:** **Yes — blocks Phase 02 verification and Phase 03 autonomy.**

### P0-02 — Completion and external side effects have at-least-once replay risk, not deterministic idempotency

**Status:** `CONFIRMED` for the protocol gap; `HIGH_CONFIDENCE` for duplicate external effects because destructive effects were simulated only.  
**Evidence:**

- EC explicitly asks the model to inspect whether prior work completed (`plugins/execution-continuity.mjs:31-32,533-538`); that is a prompt heuristic, not a transaction protocol.
- Each recovery RPC receives a fresh request ID (`:395-402`). `lastResumeAt` is persisted only after prompt acceptance (`:537-543`).
- Official Host creates a new message identity per request. There is no Harness-wide operation key linking tool call, durable result, completion event, and external receipt.
- Goal Recovery has no `WAITING_USER` gate. EC can treat parsing errors as “no pending question” (`:246-287`) and can act from stale intent without revalidating the authoritative current goal phase.
- Current T2 main contains the Completion Truth guard, but it returns `{state:"clean"}` when session events are absent or inspection throws (`plugins/execution-continuity.mjs:474-478,523-525`) and can match a result only by same turn when call IDs do not match (`:505-513`). Both the 23:17 and 23:42 live restarts logged `no session events -> clean fallback` for two recoverable intents and then resumed both. This is repeated current-runtime confirmation.

**Real impact:** If an external message, file move, Git mutation, PR creation, remote API write, or payment-like simulated action succeeds and the result/completion event is lost before EC state persists, restart recovery can execute it again. A user-paused or awaiting-approval task can also be resumed automatically.

**Reproduction:** With a fake side-effect service keyed by operation ID, crash after the service records success but before EC persists `lastResumeAt`; restart and allow recovery. Current design generates a new RPC/message identity, so the fake service observes two logical calls. Repeat with `WAITING_USER` and malformed pending-question state; current parsing is not fail-closed.

**Root cause:** The system conflates executor claims with verified results and has no durable outbox/inbox or stable operation identity across the crash window.

**Affected files:** `plugins/execution-continuity.mjs`, `goal-recovery.mjs`, Host/session prompt integration, tool adapters that perform external writes.

**Recommended minimal fix:** **Immediate containment:** if session events, call/result identity, goal phase, or pending-user state cannot be read, enter `NEEDS_VERIFICATION` and do not resume; remove same-turn matching as a substitute for call identity. **Target contract:** add a durable CAS outbox keyed by `(session, goal, revision, interruptionEpoch, operationId)`; persist intent before enqueue, reuse a stable operation ID, and reconcile durable session events and external receipts before replay. Until tools expose idempotency keys and receipts, document generic side effects as **at-least-once**.

**Regression test:** Crash at every boundary: before enqueue, after durable enqueue, after external success, after result append, and before intent commit. Verify exactly one visible result and, for idempotent fixture tools, exactly one external mutation. Include `WAITING_USER`, `USER_PAUSED`, `BLOCKED`, `CANCELLED`, and `COMPLETED` cases.

**Phase block:** **Yes — blocks unattended side-effecting use and Phase 03.**

### P0-03 — Process/restart ownership is split, and transactions treat “worker accepted” as “restart completed”

**Status:** `CONFIRMED`  
**Evidence:**

- The GUI directly starts `dsh web` after a root-HTTP failure (`DSH-Harness-PS.ps1:294-350,2071-2086`) and directly stops the server (`:1702-1718`), bypassing the restart mutex, budget, maintenance lock, boot/safe mode, Node selection, launcher ledger, and client-readiness protocol.
- Startup VBS → watchdog → Guardian, Task Scheduler → Guardian, GUI direct start/stop, delayed restart worker, and launcher are separate process authorities.
- `restart-dsh-server-delayed.ps1:37-66` spawns the real worker and exits success. `dsh-transaction.ps1:231-245,270-280` waits only for that wrapper, then proceeds to verify/rollback. `dsh-safe-mode.ps1:62-69,149-183` similarly reports `Restarted=true` before terminal restart outcome.
- At the runtime sample, server PID 3944 was launched by parent PID 20128 from `_release-staging/dsh-launcher.js`, while the GUI and Guardian were executing deployed `DSH-Client` copies. This is a real source/authority split, not just duplicate files.
- T2 genuinely improved the inner worker: the 23:41 path reached `client_ready`, waited 30 seconds, rechecked readiness, passed `COMMIT_READY`, and committed at 23:43:03. However, the outer detached wrapper returned after spawning at 23:41:47. Callers could therefore advance roughly 76 seconds before the terminal outcome. The 23:17 starter-exit-2 mismatch was a useful precursor, not the final T2 proof.

**Real impact:** GUI and restart worker can race for port 3080, produce `EADDRINUSE`, accept a non-standard instance as healthy, or stop an instance outside the transaction. Transaction rollback can start while the original restart is still in flight, and journal state can diverge from the actual server generation.

**Reproduction:** In an isolated Windows VM, pause the delayed worker after old-server stop, open the GUI, and let its direct start bind 3080; then release the worker. Separately run a transaction with a delayed terminal failure and show that the wrapper exits 0 before the ledger reaches terminal state.

**Root cause:** Helpers expose decision authority instead of sending commands to one process owner; the wrapper protocol has no terminal result keyed to a transaction/generation.

**Affected files:** `DSH-Harness-PS.ps1`, `dsh-guardian.ps1`, `dsh-guardian-watchdog.ps1`, `restart-dsh-server-delayed.ps1`, `start-dsh-server.ps1`, `dsh-transaction.ps1`, `dsh-safe-mode.ps1`, `dsh-launcher.js`, Startup/Task Scheduler entries.

**Recommended minimal fix:** **Immediate containment:** GUI and Transaction must refuse direct start/rollback while a restart transaction or unknown owner is present, and the wrapper must not report success before terminal ledger state. **Target contract:** consolidate the existing Guardian/launcher machinery into one port-scoped Process Authority—this does not require a new daemon/service. GUI, Guardian, transactions, and Safe Mode submit commands to it. Success requires terminal `COMMIT_READY` for `{transactionId, attemptId, port, generation, pid}`.

**Regression test:** Real isolated tests for GUI/worker race, double start, `EADDRINUSE`, old worker death, terminal worker failure, and rollback. Assert one loopback owner and one generation commit.

**Phase block:** **Yes — blocks Phase 02 Reliability P2.**

### P0-04 — Model selection/fallback has competing authorities and can silently replace an explicit session choice

**Status:** `CONFIRMED` for explicit-route override/stale wrapper selection and current-main registry derivation; actual failed dispatch remains `TEST_DEFERRED_DUE_TO_ACTIVE_TASK`.  
**Evidence:**

- Live EC selects and overwrites provider/model (`plugins/execution-continuity.mjs:359-390,550-575,630-704`). Runtime EC logs show an explicit AgentRouter Sol selection replaced by a DeepSeek route after compaction was unavailable.
- OpenRouter and CommandCode wrappers prefer stale `agent.options.model` (`openrouter-router.mjs:229-234`, `commandcode-router.mjs:121-130`) instead of the current session selection.
- Pure integration probes reproduced: an explicit OpenRouter Ox selection emitted the previous Sol route; an explicit CommandCode Muse selection emitted the previous DeepSeek route. The 9/9 exact-model unit test covers only core functions and missed this host integration.
- In frozen `25a1d898`, `model-registry.mjs` was inactive. It is now imported by EC in canonical T2 main and loaded by the current server. `modelCandidates()` splits keys such as `deepseek/...`, `qwen/...`, `stealth/...`, and `meta/...` into provider IDs, while live configured providers are `xiaomi`, `opencode`, `opencode-qwen`, `opencode-free`, `openrouter`, `agentrouter-openai`, `agentrouter-anthropic`, `commandcode`, and `bai`. Several derived tuples are therefore unregistered. EC also still selects/applies `pendingFallback`, contradicting the merged documentation’s “Router unique fallback authority” claim.

**Real impact:** A user-selected model can be silently changed; current-main fallback can target an unregistered, smaller-context, text-only, or protocol-incompatible route. The agent may finish under a different cost, privacy, reasoning, or capability boundary than the user chose.

**Reproduction:** In an isolated profile, switch the current session from the default to OpenRouter Ox or CommandCode Muse, leave `agent.options.model` stale, and issue a request through each wrapper; observe the emitted provider/model tuple. Trigger EC recovery after an overflow and compare the explicit selection with the logged recovery route.

**Root cause:** Official session-local selection, provider routers, EC recovery, guards, and static registries each retain partial model authority.

**Affected files:** `plugins/execution-continuity.mjs`, `plugins/openrouter-router*.mjs`, `plugins/commandcode-router*.mjs`, `plugins/model-selection-guard*.mjs`, `plugins/provider-registry-core.mjs`, `plugins/model-registry.mjs`, settings and official session-selection API.

**Recommended minimal fix:** Remove model selection from EC. Preserve explicit selections and fail loudly by default. Keep one opt-in cross-provider fallback owner using a pure tuple registry keyed by `(provider, model, protocol)` with provenance and runtime verification; re-resolve the full call configuration on every switch.

**Regression test:** Real session switches through wrapper + guard + recovery for explicit and auto modes; validate exact provider/model/protocol, modalities, JSON/tool support, context window, and reasoning controls. Unknown required capabilities must fail closed.

**Phase block:** **Yes — blocks Phase 02 simplification and any autonomous fallback.**

## P1

### P1-01 — Standard worker now completes a real stable commit, but the budget is unbound, bypassable, and corrupt-state fail-open

**Status:** `CONFIRMED_PARTIAL_REMEDIATION`  
**Evidence:** T2 deployed legacy-field compatibility (`dsh-restart-budget.ps1:41-64`), a 60-second readiness wait (`restart-dsh-server-delayed.ps1:154-163`), and `client_ready → 30s stable window → second readiness → COMMIT_READY → commit` (`:165-198`). The 23:41–23:43 live restart completed that full path; `stableCommitAt` was persisted and the lock released. Remaining defects are direct:

- Candidate state contains only timestamp/boolean, not attempt, port, PID, creation time, command hash, or generation (`dsh-restart-budget.ps1:35-37,127-140`). Commit checks whichever owner exists later, not continuity of the candidate generation.
- `Confirm-DshRestartStable` still clears `hourAttempts/hourWindowStart`; alternate Guardian/normal-start paths call the backward-compatible immediate-success alias, and the loaded Guardian is pre-fix.
- Malformed JSON or missing `attempts` returns a fresh default; wrong types can fail during casts (`:44-64,97,113`).
- The worker treats every starter exit except 75 as advisory (`restart-dsh-server-delayed.ps1:133-142`); only exit 0 was exercised at T2.

**Real impact:** The normal T2 path is materially safer, but a different generation can satisfy commit, alternate callers can reset early, repeated stable-then-crash cycles can erase the hourly history, and corrupt state can reopen the circuit.

**Reproduction:** Isolated crash-storm test: make each generation reach readiness, survive 31 seconds, then exit; run ten cycles. Corrupt the budget file between two cycles. Current logic can reset or recreate the budget instead of opening the circuit.

**Root cause:** Stable readiness exists, but the budget record is not an identity-bound transaction and the compatibility alias still exposes unvalidated mutation authority.

**Affected files:** `dsh-restart-budget.ps1`, `dsh-guardian.ps1`, `start-dsh-server.ps1`, `restart-dsh-server-delayed.ps1`, Level 2 CI test.

**Recommended minimal fix:** Bind candidate/commit to `{attemptId, port, generation, pid, creationTime}`, enforce elapsed stable time inside Confirm, preserve hourly attempts across short successes, and fail closed/quarantine corrupt state.

**Regression test:** Ten 31-second crashes, same-generation validation, stale confirm, corrupt/concurrent budget writers, reboot, and exact hourly circuit-open assertions using production functions.

**Phase block:** **Yes — Reliability P2 blocker.**

### P1-02 — Verified LastGood has real split-brain and is not an atomic set

**Status:** `CONFIRMED`  
**Evidence:** Current settings, `verified-lastgood/settings`, and `guardian-lastgood/settings` had three different SHA-256 hashes while both metadata files claimed the same verification time/stage. `Save-VerifiedLastGood` copies files individually without a set manifest or atomic pointer (`dsh-verified-lastgood.ps1:53-93`); Guardian trusts its mirror (`dsh-guardian.ps1:404-419`).

**Real impact:** Recovery from invalid YAML can restore a mixed configuration that was never the set proven by `COMMIT_READY`, while metadata still claims it was verified.

**Reproduction:** In an isolated profile, interrupt set copy between settings and patch, then invoke Guardian recovery. Compare restored set hashes with the verified manifest; current implementation has no manifest capable of rejecting the torn set.

**Root cause:** Per-file copying and duplicate LastGood locations without an atomic, content-addressed set authority.

**Affected files:** `dsh-verified-lastgood.ps1`, `dsh-guardian.ps1`, verified/guardian LastGood directories and metadata.

**Recommended minimal fix:** Stage a complete set in a new directory, record path+hash manifest, fsync/validate it, then atomically switch one `current` pointer. Guardian restores only that exact verified set.

**Regression test:** Kill at every copy boundary, mutate one mirror, and prove restore refuses all hash/meta mismatches.

**Phase block:** **Yes — Reliability v1 cannot remain VERIFIED.**

### P1-03 — Context overflow recovery can retry unchanged requests, while long-context capability is unproved

**Status:** `CONFIRMED` for the compaction call defect; long-context readiness is `UNKNOWN` above the demonstrated range.  
**Evidence:** EC calls `compactNow(agent, undefined, source)`; installed `dsh-compaction-basic` dereferences `signal.throwIfAborted()` at `lib/index.js:926-933`. Runtime logs contain repeated `COMPACT-UNAVAILABLE` followed by retries. The passing compaction-scope test uses a permissive mock. Repository evidence demonstrates a maximum approximately 242,595-token input; 51.7M is aggregate traffic, not one context. No 500K/800K/1M integration test exists.

**Real impact:** Overflow can loop without reducing context, then invoke a cross-provider fallback with a smaller or unknown window. Multi-hour work can lose reasoning continuity or silently change model.

**Reproduction:** Use a real compaction service and an `INVALID_REQUEST` overflow variant, require a valid `AbortSignal`, and measure context before/after retry. Test 500K and 1M synthetic histories with bounded tool outputs and a mid-tool restart.

**Root cause:** Error normalization, compaction API contract, fallback compatibility, and context truth are owned by different layers.

**Affected files:** `plugins/execution-continuity.mjs`, official compaction plugin, context-budget/tool-output-offload code, provider/model registries.

**Recommended minimal fix:** Normalize overflow once, invoke the official compaction API with a real signal, retry only after measurable reduction, and require fallback context/capability >= current request. Do not advertise 1M until empirically verified.

**Regression test:** One compaction maximum per incident, no unchanged retry, 500K/800K/1M thresholds, two compactions, restart mid-tool, and exact model/config preservation.

**Phase block:** **Yes for long-task/unattended claims; not a claim that future Phase 03 itself must already exist.**

### P1-04 — Real credentials and a private key are duplicated in plaintext and readable by sandbox worker identities

**Status:** `CONFIRMED`; no public Git leak was confirmed.  
**Evidence:** Credential-shaped values exist in `~/.dsh/.credentials.yaml`, multiple credential/config/patch backups, a plaintext environment-key backup, live profile configuration, session/cache artifacts, and a Desktop TLS private-key file. ACL inspection grants the local `CodexSandboxUsers` group read access to several of these paths; the Desktop Harness tree also has an unresolved SID with write/delete rights. `telegram-alert.ps1:15-18,36-38` can place a token in process arguments. `dsh-event-notify.mjs:98-102,183-199` logs shortened payload text without field-level redaction. A 47-commit public-history pattern scan found only the deliberate fake CI sentinel; no real tracked secret was confirmed.

**Real impact:** Any process or agent running under that local sandbox group can read provider, Telegram, Notion, or TLS material; backups multiply the exposure and notification/process arguments can create secondary copies.

**Reproduction:** As a non-admin sandbox-group test identity, attempt read-only open of each secret container and inspect process command lines with synthetic tokens. Scan rotated notification logs with synthetic secret canaries. Never use real values in a test.

**Root cause:** Secrets are treated as ordinary profile/config/backup files; ACL inheritance, retention, command-line construction, and redaction are not part of one credential policy.

**Affected files/locations:** `~/.dsh/.credentials.yaml`, live `cordis.patch.yml`, `_backup*`, DSH-Client backups, session/cache state, Desktop TLS key, `telegram-alert.ps1`, `dsh-event-notify.mjs`, completion notification adapter.

**Recommended minimal fix:** In a separately authorized security change, move secrets to a credential authority, restrict ACLs, remove tokens from arguments, redact structured fields before persistence/notification, inventory and then retire backups, and rotate exposed credentials only with explicit authorization.

**Regression test:** ACL test from the sandbox identity, synthetic-secret history/config/log/process scan, backup-retention test, and notification redaction test.

**Phase block:** **Yes — local production/security blocker; not classified as public compromise.**

### P1-05 — Readiness and CI provide green signals that do not prove the deployed custom runtime

**Status:** `CONFIRMED`  
**Evidence:** GUI uses root HTTP, start/Guardian use API readiness, delayed restart uses `client_ready`, and commit readiness uses a stronger but generation-unbound two-pass check. No CI workflow changed from T0 to T2. Level 3 still boots stock DSH `0.1.0-rc.8` with an empty profile, while runtime is `0.1.1-rc.2` with 18 custom patches; its failure path can warn and exit success. Level 1/2 trigger for PR-to-main and a separate push branch, not direct main push. Branch protection requires two named checks, but `enforce_admins=false`; signatures, linear history, and conversation resolution are not required. PR #15 passed all three configured jobs and PR #16 passed two, yet several tests reimplement logic or assert source strings. Merged `REPORT_R2.md` claims six blockers/ten acceptance criteria closed and `IMPLEMENTATION_COMPLETE`, while also awaiting external review; current Completion Truth runtime logs and registry/budget source contradict closure. The report is a claim, not proof.

**Real impact:** A PR/main can be green while the actual plugin graph, official-core version, restart path, or runtime copy is broken. Admin bypass can evade the gate.

**Reproduction:** Introduce a synthetic plugin startup failure in an isolated CI profile: Level 3’s current stock/empty-profile path remains green. Modify a production function while leaving copied test logic intact: the test can still pass.

**Root cause:** Test layers validate different artifacts and definitions; deployment/runtime manifest identity is absent from the required gate.

**Affected files:** `.github/workflows/ci-level1.yml`, `ci-level2.yml`, `ci-level3-partial.yml`, `ci-level4.yml`, readiness scripts, deployment manifest/process.

**Recommended minimal fix:** Required CI must build and boot the exact release profile against the supported DSH version, fail closed, verify source→deployment manifest hashes, load all active plugins, and run production-function tests. Enforce checks for administrators or establish an auditable exception process.

**Regression test:** Deliberate bad plugin, version skew, deployment-hash drift, direct-main push, and copied-logic mutation tests must all fail the required gate.

**Phase block:** **Yes — release-governance blocker.**

### P1-06 — Lock identity, stale detection, and Guardian supervision are not fail-safe

**Status:** `CONFIRMED`  
**Evidence:** Maintenance-lock write failure logs but does not stop the restart worker (`restart-dsh-server-delayed.ps1:88-99`). Orphan detection checks PID liveness but not creation time, command hash, port, or nonce (`dsh-guardian.ps1:279-304`); partial JSON can remain “fresh legacy” for ten minutes. Guardian’s stuck-goal logic combines any active goal with the newest global session mtime and can call direct restart outside the normal budget (`:424-431,542-555`). Watchdog sees an alive Guardian with stale heartbeat and deliberately does not kill/start it (`dsh-guardian-watchdog.ps1:80-95`).

**Real impact:** PID reuse or torn locks can block/release incorrectly; healthy long reasoning can be killed or a stuck goal masked by another session; an alive-but-hung Guardian can permanently remove automatic recovery.

**Reproduction:** Isolated tests for PID reuse, partial lock write, lock-write denial, two sessions with only one progressing, four-hour synthetic thinking, and a Guardian that keeps its PID but stops heartbeats.

**Root cause:** Identity is reduced to PID/file age, progress is global rather than goal-bound, and supervisor policy refuses takeover of hung owners.

**Affected files:** `restart-dsh-server-delayed.ps1`, `dsh-guardian.ps1`, `dsh-guardian-watchdog.ps1`, `dsh-process-identity.ps1`.

**Recommended minimal fix:** Atomically write a signed/hashed ownership record with PID creation time, command/script hash, port, generation, and transaction nonce; fail closed if it cannot be written. Bind progress to the active session/goal and define a fenced Guardian takeover protocol.

**Regression test:** Production-function tests for PID reuse, torn/foreign lock, access denial, multi-session progress, long-thinking false positive, and hung-Guardian takeover.

**Phase block:** **Yes — Reliability P2 blocker.**

### P1-07 — Tests labeled isolated/`SkipLive` wrote into real production state

**Status:** `CONFIRMED`  
**Evidence:** During snapshot testing, Transaction/Safe Mode/Reliability Lab fixtures created records in the actual `%LOCALAPPDATA%\DSHHarness\tx-checkpoints` and `state\tx-journal.json` despite `SkipLive`/isolation intent. The journal reached 36 records and the checkpoint directory 280 files / about 1.14 MB. Testing stopped when this was detected; records were preserved under audit-only rules.

**Real impact:** A CI/local audit can pollute recovery state, consume retention, or influence later diagnosis while still reporting PASS. On a different test path this could trigger a real recovery action.

**Reproduction:** Set a clean temporary root and execute the current Stage C/E/Lab tests; monitor writes outside the root with Process Monitor or filesystem snapshots. Current path resolution reaches real LocalAppData.

**Root cause:** Production state paths are resolved inside dot-sourced scripts and are not dependency-injected; tests isolate input fixtures but not all side effects.

**Affected files:** Stage C/E reliability tests, `dsh-transaction.ps1`, `dsh-safe-mode.ps1`, `dsh-reliability-lab.ps1`, CI jobs invoking `SkipLive`.

**Recommended minimal fix:** Require an explicit state-root parameter/interface and deny access outside a test temp root; run under a test identity without production-profile permissions.

**Regression test:** Filesystem allowlist assertion proving zero writes to `~/.dsh`, `%LOCALAPPDATA%\DSHHarness`, deployment, or live profile.

**Phase block:** **Yes for claiming the present suite as safe production proof.**

## P2

### P2-01 — Runtime state, WebView data, backups, and session scans have no demonstrated 30-day bound

**Status:** `CONFIRMED` for current sizes; future rate is `SUSPECTED`.  
**Evidence:** `%LOCALAPPDATA%\DSHHarness` was about 1.05 GB / 6,129 files (WebView/Edge data dominant); deployed DSH-Client about 852 MB / 7,131 files; `.dsh/sessions` about 162 MB / 428 files; 22 deployment backup directories about 132 MB. Goal and transaction ledgers grow append-only/file-per-claim. Several plugin Maps/listeners lack a proven apply/dispose bound.

**Real impact:** Disk, startup, recovery scan, backup, and forensic time grow; an actual memory leak cannot be distinguished from workload without a long soak baseline.

**Reproduction:** 1/7/30-day soak with fixed workload; record RSS/private bytes, listener/timer counts, file count/bytes, session-scan latency, and HMR apply/dispose deltas.

**Root cause:** Retention and lifecycle limits are component-local or absent, and there is no resource SLO.

**Affected components:** WebView profiles, sessions, deployment backups, transaction/goal ledgers, notification logs, OpenRouter/Vision/offload/notify listeners.

**Recommended minimal fix:** Define measured retention and lifecycle budgets; add compaction/rotation and HMR disposal only after tests prove which artifacts are authoritative.

**Regression test:** 30-day accelerated soak and 100 apply/dispose cycles with zero net listener/timer/child growth.

**Phase block:** No immediate interactive block; **blocks Phase 06 always-on**.

### P2-02 — T2 canonical content aligns with deployment/live, but loaded-process attestation is not continuous

**Status:** `CONFIRMED_PARTIAL_REMEDIATION`  
**Evidence:** T2 current `main=origin/main=64071dac`. Normalized comparison found 35/37 audited root text files equal to deployment; the two absent files were non-runtime deploy/lab utilities. Live plugins/config had 22/24 equal, with only machine-specific `cordis.patch.yml` different and a test file absent. All critical runtime files checked—Guardian, restart budget/worker, Goal Recovery, EC core/EC, registry—matched current main. The 23:41 server generation loaded T2 EC, but Guardian PID 19892 still held 17:13 pre-fix code. Content correspondence is therefore strong; process-generation attestation is still incomplete.

**Real impact:** Current disk layers are substantially aligned, but a report or PASS can still be incorrectly applied to an already-running process. The stale Guardian is the concrete example.

**Reproduction:** Generate a manifest for canonical, deployment, live profile, and loaded command lines; compare at boot and release time.

**Root cause:** Deployment copies files without one signed content manifest consumed by both boot and CI.

**Affected files:** release/deployment scripts, `cordis.patch.yml`, desktop shortcut, Startup/Task Scheduler entries, launcher paths.

**Recommended minimal fix:** One release manifest containing commit, DSH version, plugin IDs, and hashes; every boot entry logs and validates it. Machine-specific settings are separately declared, not silently diffed.

**Regression test:** Deliberate single-file drift, candidate-only plugin, stale shortcut, and mixed launcher/Guardian paths must fail attestation.

**Phase block:** No longer a Phase 01 canonical-content blocker; still blocks complete Phase 02 runtime attestation.

### P2-03 — Plugin lifecycle and notification privacy need integration proof

**Status:** `HIGH_CONFIDENCE`  
**Evidence:** OpenRouter registers listeners at `plugins/openrouter-router.mjs:203,303` but its returned object at `:366-374` has no explicit listener disposer. Vision, tool-output-offload, and completion-notify also register listeners without captured disposers. Host automatic disposal is unproved. Completion/event notifications pass or log user payload snippets; current logs had no scanned `sk-`/Authorization hit, but no structured redaction guarantee exists.

**Real impact:** Repeated plugin application/HMR can duplicate callbacks, retain memory, multiply provider calls or notifications, and preserve sensitive user content in logs.

**Reproduction:** Apply/dispose the real plugin graph 100 times, compare listener/timer counts, then inject synthetic secrets into completion events and inspect process arguments/log rotations.

**Root cause:** Lifecycle and privacy contracts are implicit and untested across host integration.

**Affected files:** `plugins/openrouter-router.mjs`, `vision-bridge.mjs`, `tool-output-offload.mjs`, `completion-notify.mjs`, `dsh-event-notify.mjs`.

**Recommended minimal fix:** Capture/unregister all listeners through host lifecycle primitives; centralize field-aware notification redaction and avoid message/token command-line arguments.

**Regression test:** HMR soak plus synthetic-secret end-to-end notification test.

**Phase block:** No for basic Phase 02 operation; yes for unattended/always-on release.

### P2-04 — Vision admission and bridge behavior disagree about the current route

**Status:** `HIGH_CONFIDENCE`  
**Evidence:** Official host admission uses current session model metadata and can reject an image before the bridge if that model is text-only. The bridge reads stale `agent.options`, performs direct provider fetches outside official routing/accounting/retry, may send an image sequentially to multiple providers, and caches by attachment ID including transient failures (`vision-bridge.mjs:197-258,287-305,312-375,489-507`).

**Real impact:** Image requests may be rejected before fallback, disclosed to more providers than expected, or answered with a stale description for a different question.

**Reproduction:** Switch session routes before upload; ask two prompt-distinct questions about the same attachment; inject one transient vision failure; record providers contacted and cache behavior.

**Root cause:** Admission, current selection, fallback, direct transport, and cache key are split across official Host and the bridge.

**Affected files:** `plugins/vision-bridge.mjs`, session selection metadata, provider/guard registries.

**Recommended minimal fix:** Use authoritative current-session/request selection, disclose only to an explicitly selected compatible provider, include prompt/model/version in cache keys, and never cache transient failures.

**Regression test:** Admission, in-session switch, one-provider disclosure, prompt-sensitive cache, and transient-failure retry tests.

**Phase block:** No for text-only Phase 02; yes for trusted multimodal autonomy.

## P3

### P3-01 — CI supply-chain and review controls are weaker than the reliability claims

**Status:** `CONFIRMED`  
**Evidence:** Actions are referenced by mutable version tags rather than commit SHAs; a package is installed without an immutable lock in CI. Required conversation resolution, signed commits, and linear history are disabled; administrators can bypass required checks. Level 4’s scheduled comment says nightly while cron is weekly, and its secret pattern is narrow.

**Real impact:** CI behavior can drift independently of source, and governance can permit a green-looking but insufficient release.

**Reproduction:** Resolve current action/package digests, compare after upstream tag/package changes, and exercise an admin bypass in a test branch policy.

**Root cause:** Governance optimized for iteration speed without a release-specific hardened lane.

**Affected files/settings:** `.github/workflows/*`, branch protection, dependency installation.

**Recommended minimal fix:** Pin third-party actions/dependencies for release workflows and require the deployment/runtime gate on protected main, including administrators or logged exceptions.

**Regression test:** Policy-as-code check for immutable refs, required job names, and admin enforcement.

**Phase block:** No immediate runtime block; required before production release.

### P3-02 — Archived and duplicate code increases audit ambiguity

**Status:** `CONFIRMED`  
**Evidence:** Canonical snapshot contains 45 PowerShell and 46 MJS files; 26 plugin files with 18 active patch entries; archived plugin/root-script copies include byte-identical or near-identical active implementations. Deployment contains 22 backup directories. Backups were not loaded by the sampled manifest, so this is not an “archived code is active” finding.

**Real impact:** Search results, audits, secret scans, and future edits can target the wrong copy; storage and disclosure surface grow.

**Reproduction:** Map every executable file to manifest/caller/boot entry and compare archive hashes to active sources.

**Root cause:** Retention accumulated without an authoritative inventory and deletion criteria.

**Affected areas:** `docs/_archived`, deployment `_backup*`, test files inside `plugins`, root wrappers.

**Recommended minimal fix:** Keep a generated inventory with owner/caller/status; retire only after a release-retention and rollback test.

**Regression test:** CI fails when an executable copy has no classified owner or when archived files are production-loaded.

**Phase block:** No; cleanup follows authority and recovery repairs.

# 4 Authority Map

## 4.1 Claimed versus actual control flow

The prior Phase 01/02 narrative implies a mostly linear system:

```text
GitHub verified main
  -> deployed DSH-Client
  -> live web profile
  -> one Guardian/process owner
  -> one EC recovery coordinator
  -> thin Goal Recovery executor
  -> provider routers
  -> official DSH session/goal truth
```

The current call graph is instead:

```text
GitHub main 64071dac (T2 canonical; includes T0/T1 code via PR #15/#16)
       |
       +--> T0 b9ddc117 / 25a1d898 and T1 379a1c35 retained as audit snapshots
       |
       +--> DSH-Client deployment -----------------------------+
                |                                               |
                +--> Desktop GUI -- direct start/stop ----------+--> :3080 owner
                +--> Startup VBS -> watchdog -> Guardian -------+       |
                +--> Scheduled Task -> Guardian ----------------+       +--> official DSH core
                +--> delayed restart -> launcher/worker --------+       |      |
                                                                    live profile/plugins
                                                                        |
                       +----------------------+-------------------------+------------------+
                       |                      |                         |                  |
                    EC recovery        legacy Goal Recovery      provider routers   official Host
                       |                      |                         |                  |
                       +-- resume/prompt -----+-- old Guardian may     +-- fallback       +-- session/goal
                       |                         still invoke scan
                       +-- model fallback                                / selection       durable truth
```

T2 source removes Guardian’s recovery decision, but the loaded Guardian is older than that change. The critical issue is therefore both authority design and atomic rollout/attestation: disk source can be corrected while a long-running process retains old authority.

## 4.2 Responsibility-by-responsibility map

| Responsibility | Prior/nominal authority | Actual current decision makers | Authoritative fact that should win | Assessment |
|---|---|---|---|---|
| 1. Process Authority | Guardian/launcher | GUI, Guardian, delayed worker, normal starter, launcher, clean reclaim | One fenced port/generation owner | **Conflict** |
| 2. Server restart | Guardian/restart transaction | GUI direct start/stop, Guardian direct and budgeted paths, delayed worker, Safe Mode/Transaction wrappers | One terminal restart ledger | **Conflict** |
| 3. Task recovery | EC | T2 source: EC; loaded runtime: EC plus pre-fix Guardian/legacy Goal Recovery | One coordinator with durable claim | **Transition conflict** |
| 4. Goal resume | Native goal API through Goal Recovery | EC plus legacy global scan still callable by loaded Guardian | Official session/goal CAS + one recovery plan | **Transition conflict** |
| 5. Model/provider selection | Current session + provider router | Official session, OpenRouter, CommandCode, guards, EC, current registry | Official current session exact tuple | **Conflict** |
| 6. Model fallback | Provider routers | OpenRouter, CommandCode, EC; dormant provider-registry policy | One explicit/opt-in fallback owner | **Conflict** |
| 7. Retry/backoff | Official provider adapter | Official adapter, routers, EC, Guardian/restart budgets | Layer-specific typed incidents, one owner per layer | **Overlapping** |
| 8. Capability truth | Official model resolution | Official metadata, settings, provider registry, guards, vision bridge, current registry | Official resolved `(provider,model,protocol)` plus verified overrides | **Shadow truths** |
| 9. Context-window truth | Provider/model metadata | Multiple hardcoded tables/config values | Route-specific empirically verified tuple | **Drift-prone** |
| 10. Vision capability | Official admission | Official Host, guard, bridge, registry | Current-session resolved route before disclosure | **Conflict** |
| 11. Completion truth | Session events / goal | EC prompt heuristic and goal projection | Durable tool result + external receipt + goal event | **Missing cross-layer truth** |
| 12. `WAITING_USER` | Native/UI state | EC store/parser; Goal Recovery ignores it | Authoritative current session/goal pending approval | **Fail-open path** |
| 13. Readiness | Readiness module | GUI HTTP, start/Guardian API, delayed `client_ready`, commit gate | Layered readiness tied to same generation | **Four definitions** |
| 14. Commit readiness | `Test-CommitReadiness` | Script only; callers can bypass or use weaker gate | Same pid/generation through stable window | **Incomplete** |
| 15. Last Good | Verified LastGood | verified set plus Guardian mirror | One atomic hash-manifested set | **Split-brain** |
| 16. Transaction rollback | transaction state machine | Transaction plus async restart and Safe Mode label | Terminal generation-aware transaction | **False terminal semantics** |
| 17. Golden | Git/release baseline | Golden, checkpoints, deployment backups, LastGood sometimes described together | Immutable release baseline only | **Concept sound; use blurred** |
| 18. Session identity | Official session store/API | Official store; EC session-keyed intent | Official durable session ID | **Mostly correct; EC scope too coarse** |
| 19. Goal identity | Official goal ref/revision | Official API; Goal Recovery compares stale revision | Official `(goalId,revision)` CAS | **Verification bug** |
| 20. Secret Authority | Credentials/config | credentials YAML, patch, env backup, config backups, process args | One credential store with least-privilege ACL | **No single authority** |
| 21. Deployment/Manifest Authority | GitHub main / release process | Canonical main, moving checkout, DSH-Client copy, live profile, loaded processes | One content-addressed release manifest consumed at deploy and boot | **Missing continuous attestation** |

# 5 Recovery Architecture

## 5.1 Process recovery

Current process recovery has useful primitives: unique loopback-owner checks fail closed on ambiguous ownership; Node v22 selection is explicit; launcher/runtime ledgers record child identity; `client_ready` requires API plus two WebSocket channels. The sampled runtime passed all of these.

It is nevertheless not a transaction because GUI, Guardian, and wrapper paths can bypass one another. The maintenance lock is not a fence, worker terminal completion is not propagated, and a live-but-hung Guardian has no takeover. Current guarantee is therefore:

> The system often returns one healthy loopback server after a normal restart, but it cannot prove exactly one authorized restart transaction or bounded recovery under races/crash storms.

## 5.2 Task recovery

EC stores session-scoped intent and legacy Goal Recovery stores generation claims. T2 source makes EC the coordinator and Guardian’s hook a no-op, but the loaded Guardian predates that change and legacy global scan/revision code remains callable. EC persistence uses a shared temporary file without lock/CAS/fsync/quarantine, callers can ignore persistence failure, and incident counters are not reliably reset. The live intent store contained three intents: two `RUNNING`, one `COMPLETED`; both running intents had `autoResume=true`, retry/fallback residue, and recent error state.

Current guarantee:

> Recovery is best-effort, at-least-once prompt enqueue. It is not exactly-once task continuation and does not prove the same goal revision resumed.

## 5.3 Model recovery

Official DSH owns current-session selection and provider call configuration, while provider routers can perform provider-specific fallback. EC adds a cross-provider fallback layer and persists used candidates across incidents. This breaks explicit selection and can carry stale reasoning/max-token settings into another protocol.

Current guarantee:

> A failed task may continue on some reachable route, but exact route, equivalent capability, context capacity, and user selection are not guaranteed.

## 5.4 Completion recovery

The durable session log can show tool calls/results and goal events, but the Harness has no general external receipt ledger. EC’s recovery instruction asks the model to inspect prior completion. This can reduce duplicates when evidence is clear, but cannot close the crash window between external success and durable result.

Current guarantee:

> Executor claim and native prompt acceptance are observable; verified external completion is not uniformly represented. Generic side effects are at-least-once.

## 5.5 Observed restart timeline

One non-destructive historical restart path was reconstructed from runtime logs:

| Stage | Observed time | Interpretation |
|---|---:|---|
| Restart request accepted | 19:41:39 | Preparation begins |
| Old server exits | about 19:41:44 | Preparation about 5 s |
| New plugin graph ready | about 19:41:50 | New process booting |
| `client_ready` | about 19:41:58 | User-facing control plane usable |
| EC `RESUME-OK` | about 19:41:59 | Prompt accepted, not task completion |
| `COMMIT_READY` for this exact historical generation | `UNKNOWN` | Not recorded as a generation-bound terminal result |
| Stable commit in T0 | not present | T0 committed at `client_ready` |

Estimated **USER-UNAVAILABLE TIME** for this sample was about **14 seconds**, not the entire preparation/stability window. One successful sample does not prove worker survival under every Windows job/parent termination mode.

T2 supplied a full stable-worker timeline:

| Stage | T2 observed time | Interpretation |
|---|---:|---|
| Outer detach/spawn returns | 23:41:47 | Caller acceptance, not terminal outcome |
| Worker restart begins | 23:41:49 | Budgeted worker owns transaction |
| Old server stopped | 23:41:53 | User-unavailable interval begins |
| New server process created | 23:41:55 | Boot begins |
| EC plugin ready | about 23:42:00 | Plugin graph running |
| EC resumes two intents | 23:42:16 / 23:42:20 | Prompt accepted; Completion Truth had failed open |
| Worker records `client_ready` | 23:42:21 | Strict user-unavailable interval about 28 s |
| Stable recheck | 23:42:53 | 30-second window completed |
| `COMMIT_READY` | 23:43:02 | Control-plane commit gate passed |
| Stable commit / lock release | 23:43:03 | Terminal worker outcome, about 76 s after outer return |

T2 demonstrates a real standard-path improvement. It also quantifies the remaining wrapper problem: a caller waiting on the outer script can proceed more than a minute before the worker’s terminal result.

# 6 Source of Truth

## 6.1 Discovered environment

The paths suggested in the request were not all current:

- `C:\Users\Administrator\DSH-Client` did not exist.
- `C:\Users\Administrator\deepseek-harness` existed but was empty/non-Git.
- Active working checkout: `C:\Users\Administrator\Desktop\sdeepseek harness\_release-staging`. It is **not** itself canonical; the canonical source identity is the verified Git object on GitHub `main`.
- Stale clean upload clone: `...\output\gh-upload\deepseek-harness-desktop` at older `main@4d1c794...`.
- Public origin: `ZTKyo/deepseek-harness-desktop`.
- Live deployment: `...\Desktop\sdeepseek harness\DSH-Client`.
- Live profile: `~/.dsh/profiles/web`.
- Official core: `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`, version `0.1.1-rc.2`; audited read-only.
- CLI environment: Node `24.15.0`, npm `11.12.1`; live server used WorkBuddy-bundled Node `22.22.2`.

## 6.2 Observed source-to-process chain

```text
GitHub/main 64071dac (T2 canonical Git truth)
             |
             +-- normalized critical hashes equal --> DSH-Client root
             +-- normalized critical hashes equal --> ~/.dsh/profiles/web
                                          |
                                          +-- cordis.patch.yml: 18 explicit patch IDs
                                          +-- EC imports model-registry as a dependency
             |
desktop/startup/task/restart boot entries -+
             v
_release-staging/dsh-launcher.js -> official DSH core bin.js web --port 3080
             v
live Node generation PID 8744 (T2 code) + Guardian PID 19892 (pre-T2 in memory)
```

T2 provides strong content correspondence, not a signed causal deployment record. The server parent still invokes `_release-staging/dsh-launcher.js`, while GUI and Guardian launch from DSH-Client; the audited launcher contents matched current main. The Desktop shortcut targets `DSH-Client\DSH Harness PS.cmd`. The stale Guardian demonstrates why disk equality is not loaded-process equality.

## 6.3 Canonical/candidate/runtime comparison

| Layer | Observed identity | Result |
|---|---|---|
| GitHub `main` at closeout | `64071dac` | Canonical; PR #15 code and PR #16 docs merged |
| T0 canonical archive | `b9ddc117` | Immutable initial baseline, now historical |
| Frozen T0 candidate | `25a1d898` | Immutable audit snapshot; registry inactive there |
| T1 delta | `379a1c35` | Historical runtime delta later incorporated into main |
| T2 main root → deployment | 35/37 audited text files logically exact; two non-runtime deploy/lab utilities absent | Runtime root correspondence confirmed |
| T2 main plugins/config → live profile | 22/24 logically exact; machine `cordis.patch.yml` differs; test file absent | Runtime plugin correspondence confirmed with declared exceptions |
| T2 critical source → deployment/live | Guardian, restart budget/worker, Goal Recovery, EC core/EC, registry all logically exact | File-level deployment confirmed |
| T2 loaded server | Node PID 8744 / launcher 23836, started 23:41:55 | Stable restart and current EC load confirmed |
| Stale loaded Guardian | PID 19892, started 17:13 | Holds pre-remediation authority despite matching file on disk |
| Source/live explicit patch IDs | 18 vs 18, same ID set | Manifest membership aligned; imported dependencies are not represented as patch IDs |
| Backup plugin copies | present, not in live patch manifest | Inactive at sample; retention/security risk, not runtime authority |
| Official core | npm `0.1.1-rc.2` | Separate dependency; correctly treated read-only |

At T2, Phase 01’s GitHub-main canonical choice and current disk correspondence are strongly supported. The remaining Source-of-Truth defect is continuous loaded-process attestation, not current unexplained file drift.

## 6.4 Git/release facts

- PR #15 merged the Phase 02 code through `6d2a068`: Static/secret/syntax, Reliability state-machine, and DSH boot/readiness smoke all reported success. PR #16 merged Report R2/current-status docs with the two required checks successful.
- PR #13/#14 remain historical P2-0/docs merges; green configuration-specific checks are not runtime certification.
- Remote tags include Phase 01 save-complete variants, Phase 02 P2-0, and rc8.
- Main branch protection required `Static + secret + syntax gate` and `Reliability state machine tests`, with strict status checks.
- Administrator enforcement was disabled; force-push/delete were disabled; signatures, linear history, and conversation resolution were not required; no ruleset supplied an additional gate.

# 7 Reliability

## 7.1 Current health versus recovery proof

At T0:

- PID 3944 uniquely owned `127.0.0.1:3080`; Tailscale had separate non-loopback listeners and was **not** a port conflict.
- `host.describe` and `session.list` succeeded.
- Both required WebSockets opened.
- `Test-CommitReadiness` exited 0 with Process/API/WebSockets/Renderer/StableWindow PASS; `LightProbe` was not requested.

At T1 after the optimizer’s 23:17 restart:

- PID 20432 uniquely owned loopback 3080 under launcher PID 24952; both started at 23:17:15.
- `Test-DshReadiness -RequireWebSockets` returned `client_ready`; the corrected state-based wrapper exited 0.
- `Test-CommitReadiness -StableWindowSec 2` exited 0 with Process/API/two WebSockets/Renderer/StableWindow PASS; `LightProbe=SKIP(not requested)`.

At T2 after the 23:41 restart:

- PID 8744 uniquely owned loopback 3080 under launcher PID 23836.
- The worker logged starter exit 0, `client_ready`, a 30-second stable window, a second `client_ready`, `COMMIT_READY: True`, then stable commit at 23:43:03.
- Budget state recorded `stableCommitAt`; maintenance lock was absent after commit.
- There was **no provider/tool completed-turn probe** in any sample. The commit gate’s control-plane checks must not be described as a provider probe.

This proves current control-plane availability. It does not discharge the P0/P1 recovery findings.

## 7.2 Restart, budget, lock, and supervision

- Historical Guardian/worker logs recorded rapid restart clusters and repeated `server not ready ownerState=none` cases.
- T2 proves the standard delayed worker can complete the new stable-window path. The resulting budget had `attempts=0`, `hourAttempts=0`, `candidateReady=false`, and `stableCommitAt=23:43:02`.
- The commit is still not bound to the same PID/generation; hourly history is cleared; corrupt JSON fails open; alternate start/Guardian aliases can reset immediately.
- Lock write failure is non-fatal; orphan identity is PID-only; stop authorization lacks creation-time/command-hash binding.
- Guardian can restart from its stale-goal path outside the normal budget.
- Watchdog restarts a missing Guardian but does not fence and replace an alive-but-stale one.
- Current Guardian source is improved, but PID 19892 has not reloaded it.

## 7.3 Readiness ladder

The correct concepts already exist and should be retained, but callers must converge:

| Level | Intended meaning | Current consumers | Defect |
|---|---|---|---|
| `BOOT_READY` | process/port/API booted | start/Guardian approximations | Different checks |
| `CLIENT_READY` | API + required WebSockets | delayed worker/readiness | Good primitive; sometimes treated as final success |
| `COMMIT_READY` | process/API/WS/renderer/stable | commit script | Second pass not bound to same pid/generation |
| `TASK_READY` | provider/tool/task path actually works | none as a release gate | Missing |

## 7.4 Transaction, Safe Mode, Boot Mode

- Transaction names the expected phases, but async restart acceptance breaks the `BOOT→VERIFY→STABILIZE→COMMIT/ROLLBACK` ordering.
- A transaction can label `finalState=SAFE_MODE` without actually entering Safe Mode.
- Safe Mode’s `Restarted=true` can precede terminal restart success.
- Boot Mode’s compatibility default (`missing file = normal`) is reasonable. A present but corrupt/unknown mode should fail safe, not silently become normal.
- Existing Stage D/E tests validate state preparation and `-NoRestart`; they do not prove a real safe cold boot and exit.

## 7.5 LastGood, checkpoint, deployment backup, Golden

These must remain distinct:

| Artifact | Correct purpose | Current issue |
|---|---|---|
| Transaction checkpoint | Roll back one mutation | Test paths can write production; async restart can race rollback |
| Verified LastGood | Exact runtime set proven by commit gate | Split-brain, non-atomic per-file copy |
| Deployment backup | Operator recovery/retention | Many copies, credentials included, no demonstrated policy |
| Golden | Immutable release baseline | Concept is correct; must not be auto-promoted from syntax validity |

# 8 Task Continuity

## 8.1 Durable state observed

- 327 sessions returned by the live API.
- One active goal and two running sessions; hence destructive fault injection was deferred.
- EC intent store: three intents, two `RUNNING`, one `COMPLETED`; retry/context/fallback state persisted on the running records.
- Goal Recovery: 37 claim files over 27 generations, overwhelmingly `needs_review` and no verified resumed-running result.
- Transaction journal/checkpoint growth included audit-test fixtures because isolation was incomplete.

## 8.2 State-machine gaps

- Intent identity is session-scoped, not `(session, goal, revision, turn, operation)` scoped.
- One shared `.tmp` and no lock/CAS permit concurrent writers or torn-state loss.
- Persistence failure can be ignored by callers.
- Retry/fallback/resume counters are not reliably reset on success/new goal.
- The 15-second due scan launches all due sessions without applying the configured semaphore.
- `RESUME-OK` means native enqueue accepted; it does not mean the recovered task ran or completed.
- Missing-session, API-unavailable, cancelled, paused, and waiting-user transitions lack one authoritative table enforced across both recovery systems.
- Current Completion Truth scans backward over events and calls `events.some(...)` for each side-effect call (`:482-517`), making the check O(n²) in a large session. This is not the primary correctness blocker, but it can lengthen restart recovery at the very context sizes the Harness targets.

## 8.3 What continuity can and cannot guarantee

| Claim | Current evidence |
|---|---|
| Resume after an ordinary restart | **Often works; one observed prompt accepted** |
| Resume the exact same goal revision | **Not proven; current Goal Recovery check is wrong** |
| Never resume `WAITING_USER`/paused | **Not guaranteed on all paths** |
| Never double-resume | **Not guaranteed** |
| Exactly-once external side effect | **Not guaranteed** |
| Bounded multi-session recovery | **Not proven through production timer** |
| Corrupt-state recovery | **Incomplete/fail-open paths** |
| Six/twelve-hour unattended continuity | **Not production-ready** |

# 9 Model System

## 9.1 Correct underlying authority

Official DSH already provides the right center of gravity:

- Persisted default from settings plus `dsh-agent-default-model`.
- Current session selection from `dsh-host-apiproxy`.
- Prompt-time snapshot from `dsh-agent`.
- Exact tuple resolution/call configuration from `dsh-llm` / adapter.

Custom modules should consume those facts rather than infer model family from strings.

## 9.2 Current routing layers

| Layer | Legitimate responsibility | Actual overreach/defect |
|---|---|---|
| OpenRouter router | Provider-specific auto route/fallback | Stale session model, schema compatibility gaps, error message can mask numeric 429/503, fallback index not reset |
| CommandCode router | Provider-specific routing | Stale session model |
| Model selection guard | Reject invalid combinations | Static shadow facts; preserves stale reasoning/max-token controls on replacement |
| Provider registry | Advisory capability facts | Mixes facts with mutable health/lifecycle/economy/promotion policy; dormant second policy engine |
| EC | Task interruption recovery | Selects cross-provider fallback and overwrites explicit choice |
| Vision bridge | Temporary multimodal adapter | Stale selection, direct provider transport, disclosure/cache inconsistencies |
| Current model registry integration | Proposed shared truth | Inactive in 25a; canonical/loaded in T2, still model-ID keyed and EC derives provider IDs absent current settings |

## 9.3 Capability and fallback requirements

A minimal shared registry is acceptable only as a **pure module**, not a service or mutable capability database. Its key must be `(provider, model, protocol)`, and each fact needs provenance, confidence, and `verifiedAt`. Runtime official metadata wins; empirical route-specific overrides can narrow claims. Unknown required modality/context/schema/tool/reasoning support must fail closed.

Explicit user selection must be preserved. Cross-provider recovery, if retained, must be opt-in and validate the entire route: model existence, protocol, modality, tool/schema support, context, reasoning format, cost/privacy boundary, and complete call configuration. It must reset incident state on success/new turn.

## 9.4 Error-path observations

- 401/403 should be fatal for that credential/route, not trigger blind retry.
- 429/quota and 5xx/timeout/reset require typed, bounded provider-layer fallback. Generic error text currently can hide numeric status in OpenRouter classification.
- Strict JSON fallback can include a route without verified structured JSON support.
- Reasoning controls can be carried across incompatible adapters.
- `verifyActualModel` exists but has no production caller, so selected versus actually served model is not attested.

# 10 Context & Long Task

## 10.1 Context truth

Multiple modules/configs contain context and capability facts. Candidate comments even mix “characters” with token semantics. No evidence proves that all advertised million-token routes accept the configured protocol, tools, reasoning history, and exact model tuple at that size.

The strongest repository evidence found was roughly 242K tokens on a cache-miss input. Aggregate 51.7M token traffic is not a one-context stress result. Claims for 500K, 800K, or near 1M remain `UNKNOWN`.

## 10.2 Compaction and tool outputs

- Official compaction is the right owner, but EC calls it with an invalid signal and can retry unchanged input.
- Overflow matching is fragmented between official exact codes and provider messages.
- Tool-output offload is a valuable existing capability and should not be removed before a replacement passes exact-surface tests.
- No test proves that old tool output, compacted history, fallback replay, and restart recovery produce one coherent reasoning history at 500K+.

## 10.3 Duration readiness

| Workload | Current assessment | Why |
|---|---|---|
| Up to ~2 hours, supervised | **CONDITIONAL** | Current control plane is healthy; offload exists; operator can catch routing/recovery errors |
| Around 6 hours, unattended | **NOT READY** | Stale detection, counters, dual recovery, compaction, and fallback state can accumulate |
| 12+ hours / very large context | **NOT READY / UNKNOWN** | No soak or 500K–1M proof; resource/restart/idempotency gaps dominate |

The limiting factor is not only context-window size. It is whether one task identity, one model/configuration, one recovery claim, and one set of side effects survive every restart/overflow boundary.

# 11 Security

## 11.1 Confirmed exposure map

No secret value is reproduced in this report.

| Secret/content type | Confirmed location class | Exposure | Public Git status |
|---|---|---|---|
| Provider API credentials | `~/.dsh/.credentials.yaml`, credential backups, client-config backups, plaintext environment-key backup | Plaintext; several paths readable by sandbox worker group | No real tracked hit confirmed |
| Notion token | Live profile patch plus patch/checkpoint/Golden/backup copies and one session artifact | Duplicated; model/session context exposure possible | No real tracked hit confirmed |
| Telegram token | Credentials/backups; curl URL/argument construction | Local read plus process-command-line risk | No real tracked hit confirmed |
| TLS private key | Desktop Harness tree | Sandbox-group read ACL; tree also has unresolved write/delete SID | Not tracked |
| User completion/event text | Notification arguments and rotated logs | Payload privacy; shortened but not field-redacted | Runtime-only |
| Session projection/cache | `.dsh` state/cache | May contain secret-shaped or user-provided text | Not tracked |

The public Git history scan covered the 47-commit T0 history, then rescanned all 12 files added/changed through T2; current history contained 52 commits. The new delta had zero secret-shaped hits, and the only earlier tracked `sk-` form was an intentional fake CI sentinel. This is evidence against a **confirmed public repository leak**, not proof that every high-entropy secret pattern is absent.

## 11.2 ACL and local-agent boundary

`CodexSandboxUsers` had read/execute access through inheritance on the `.dsh` tree, credential files/backups, live patch, session projection cache, Desktop Harness tree, and TLS key. Since autonomous workers can inspect ordinary files, plaintext credentials inside those roots are in their readable trust domain. That conflicts with least privilege even if no remote leak occurs.

The unresolved SID with write/delete access on the Desktop tree must be identified before it is removed; audit-only rules prohibit guessing or modifying it.

## 11.3 Notification and command-line boundary

- Telegram credentials are interpolated into a curl URL/argument, so process inspection can reveal them.
- Completion text is passed as a process argument by one notification path.
- Event notification logs append shortened payload text without structured redaction.
- Current rotated logs contained no scanned provider-key/Authorization marker, but user content can still be sensitive and the pattern set is not complete.

## 11.4 Security actions deliberately not taken

- No key was printed, copied into the report, revoked, rotated, or deleted.
- No ACL or owner was changed.
- No browser profile/cookie store was opened beyond scoped metadata checks.
- No public history rewrite or force-push was attempted.

These require a separately checkpointed and authorized remediation because rotation can disrupt the active task and external services.

# 12 CI / Test Quality

## 12.1 Tests executed against frozen snapshots

The test result is separated from what it actually proves.

| Test group | Result | What it proves | What it does not prove |
|---|---:|---|---|
| PowerShell parse of reliability scripts | PASS | Syntax under PowerShell 5.1 for sampled files | Runtime ownership, races, terminal restart |
| T0 25a / T2 RestartBudget R1–R9 | PASS | Declared stable-window state transitions | Same-generation binding, corrupt/concurrent writers, hourly six-attempt storm, wrapper terminal propagation |
| T0 canonical b9 RestartBudget | PASS | Historical immediate-success behavior | Current T2 behavior; retained only as timeline evidence |
| T2 Completion Truth | 9/9 PASS | Replicated classifier rules on synthetic events | Imports no production function; omits missing events, exceptions, same-turn collision; live fail-open repeated |
| Launcher args | 33/33 PASS | Argument construction | Parent/job survival and boot transaction |
| Exact model core | 9/9 PASS | Pure selection helpers | Wrapper/current-session integration; live probes reproduced failure |
| Native multimodal | 25/25 PASS | Core/mock policy | Official admission + live bridge/provider behavior |
| CommandCode router | 51/51 PASS | Router core | Stale host `agent.options` integration |
| Model selection guard | 21/21 PASS | Guard core | End-to-end exact selected route |
| EC fault injection | 38/38 PASS | Mocked state transitions | Dual authority, external receipts, live timer concurrency |
| EC crash-safe | 33/33 PASS | Many source/fixture assertions | Exact crash boundary with durable Host/external effect |
| Compaction scope | 15/15 PASS | Permissive mock call scope | Real compaction’s required `AbortSignal` |
| Multi-task | 6/6 PASS | Reimplemented loop behavior | Production due timer/semaphore |
| Waiting-user | 12/12 PASS | IntentStore reload/gate helper | Boot recovery and Goal Recovery no-prompt behavior |
| Stage B/C/D/E, Final Drill, Reliability Lab | PASS | State preparation and selected offline checks | Real safe cold boot, actual rollback, terminal restart; some tests wrote production state |
| Live Commit Readiness, `LightProbe` not requested | PASS | Current process/API/WS/renderer/stable control plane | No provider/tool completed-turn probe existed |

## 12.2 Specific false-assurance patterns

1. **Copied logic:** P2 orphan-lock and multi-task tests reproduce simplified logic instead of invoking the production path.
2. **Source-string assertions:** Some crash-safe tests prove that code text exists, not that the crash state machine works.
3. **Permissive mocks:** Compaction mock accepts `undefined` signal while the installed implementation throws.
4. **State-label assertions:** Final Drill accepts a toxic marker remaining present and checks only the resulting label; Safe Mode tests use `-NoRestart`.
5. **Wrong artifact:** Level 3 boots stock rc8 with no custom plugins, not the deployed rc2 graph.
6. **Fail-open CI:** Level 3 can warn and exit success when readiness fails.
7. **Unsafe isolation:** `SkipLive` fixtures reached real LocalAppData state.
8. **Coverage omission:** P2 orphan/stable-window and many continuity integration tests are not required workflows.
9. **Live-path coupling:** Some tests hardcode the Administrator live profile, so a clean checkout can accidentally test deployed files.

## 12.3 CI/release gate conclusion

Recent green checks are useful static/unit evidence but are not release proof. A production gate must test a content-addressed release bundle, exact DSH dependency, actual 18-plugin manifest, same-generation readiness, one controlled provider/tool smoke (or an explicit offline substitute), and rollback from a real boot failure.

# 13 Simplification Candidates

The safest simplification removes authority first, then files. `DELETE_SAFE` is intentionally rare because backups and adapters may still be rollback dependencies.

| Component | Current responsibility | Overlap | Decision | Risk | Recommended action |
|---|---|---|---|---|---|
| Official DSH core | Session/goal/model/host primitives | Custom modules sometimes shadow facts | **KEEP** | Low if read-only | Continue consuming public APIs; do not patch installed core |
| Unique loopback ownership check | Reject ambiguous/foreign owner | Used by multiple starts | **KEEP / MERGE** | Low | Keep fail-closed logic, expose through one Process Authority |
| GUI direct `dsh web` and direct stop | Convenience recovery/control | Guardian/starter/worker | **MERGE** | High | Convert to commands to Process Authority; remove direct authority after race tests |
| Startup watchdog + Scheduled Guardian entry | Guardian bootstrap | Two bootstrap authorities | **MERGE** | Medium | One owner; second becomes explicit recovery adapter with fencing |
| Normal starter + delayed starter + clean reclaim | Start/restart/reclaim | Shared process decisions | **MERGE** | High | One generation-aware command surface; retain thin compatibility adapters temporarily |
| Goal Recovery independent scan | Goal discovery/resume | EC recovery | **DELETE_AFTER_TEST** | High | Retain only as plan executor after EC single-authority regression |
| EC task intent/recovery metadata | Continuity | Goal Recovery | **KEEP / MERGE** | High | Narrow to coordinator; strengthen identity/CAS/user gates |
| EC model fallback | Cross-provider rescue | OpenRouter/CommandCode/provider policy | **DELETE_AFTER_TEST** | High | Remove selection from EC once explicit-route recovery tests pass |
| Current model registry | Proposed truth | Official metadata + provider registry/guards | **BACKLOG** | High | Already canonical/loaded; do not certify Phase 02 closure until redesigned as pure tuple module and exact routes pass |
| Provider registry health/lifecycle/economy/promotion | Facts plus future policy | Routers and future Phase 04 | **BACKLOG** | Medium | Split immutable facts from policy; no hidden promotion engine |
| Four readiness implementations | HTTP/API/WS/renderer checks | Same concept, different semantics | **MERGE** | High | One layered API tied to pid/generation; callers choose named level |
| Verified and Guardian LastGood mirrors | Rollback set | Duplicate authorities | **MERGE** | High | One atomic, hash-manifested set; Guardian consumes only it |
| Vision bridge | Interim multimodal path | Official admission/provider transport | **KEEP** | Medium | Keep until exact native replacement; constrain selection/disclosure/cache |
| Tool-output offload | Context control | Compaction/history pruning | **KEEP** | Medium | Preserve; add large-context/restart regressions |
| Event notification rotation | Bounded log retention | Notification paths | **KEEP** | Low | Rotation is useful; add redaction and rate metrics |
| Ask-Telegram/completion adapters | User notification/input | Multiple notification processes | **LEGACY_ADAPTER** | Medium | Keep compatibility while removing tokens/messages from command line |
| Tests stored in `plugins` | Test implementation | `tests/` tree | **MERGE** | Low | Move after import/path update; keep coverage |
| Archived active-code copies | Historical rollback/reference | Git history and active source | **DELETE_AFTER_TEST** | Medium | Retention inventory first; remove secret-bearing copies separately |
| Deployment `_backup*` directories | Operator rollback | Git, Golden, LastGood, checkpoints | **DELETE_AFTER_TEST** | High | Define retention and prove restoration before cleanup |
| DSH reliability lab | Diagnostic orchestration | CI/stage scripts | **KEEP / BACKLOG** | Medium | Make state root injectable before treating as safe lab |

# 14 Resource Growth

## 14.1 Current resource sample

The process sample was taken during an active autonomous task and includes browser/tool children. It is **not** an idle baseline and does not by itself prove a leak.

| Group/artifact | Observed size |
|---|---:|
| Server launcher tree | 17 processes; ~1.53 GB working set; ~1.16 GB private bytes |
| GUI tree | 10 processes; ~1.43 GB working set; ~1.22 GB private bytes |
| Guardian/watchdog group | 4 processes; ~296 MB working set |
| Telegram bot | ~101 MB working set |
| VPS tunnel | ~131 MB working set |
| `%LOCALAPPDATA%\DSHHarness` | ~1.05 GB / 6,129 files; WebView/Edge data dominant |
| DSH-Client deployment tree | ~852 MB / 7,131 files; browser bridge and backups dominant |
| `.dsh/sessions` | ~162 MB / 428 files; 17 changed in 24 h, 366 in 7 d |
| DSH logs | ~43.8 MB |
| Notify log rotation | current + three backups, each about 10 MB; total disk bound about 40 MB |
| Transaction checkpoints | ~1.14 MB / 280 files, including audit fixture pollution |
| Goal Recovery ledger | 37 files / ~12 KB over 27 generations |

## 14.2 1-day / 7-day / 30-day risk model

These are bounded projections from one snapshot, not measured forecasts.

| Horizon | Expected dominant growth | Risk | Confidence / required proof |
|---|---|---|---|
| 1 day | Session files, WebView cache, event write churn, new recovery/checkpoint entries | Low-to-medium disk risk; current RAM baseline already high | `HIGH_CONFIDENCE` for activity; leak rate `UNKNOWN` |
| 7 days | Hundreds of session files may be touched; session scans and backups accumulate | Medium startup/recovery-scan and forensic cost | Current sample had 366 session files changed in 7 d; measure latency |
| 30 days | Linear proxy for sessions could add hundreds of MB; event-driven backup copies can dominate; append-only ledgers/file count continue | High always-on disk/scan/retention risk without policy | `SUSPECTED`; needs controlled soak and retention simulation |

The notification log is **not** an unbounded disk-growth finding because rotation caps retained copies; high write rate still affects I/O and privacy. The more credible unbounded surfaces are sessions, backup directories, recovery/checkpoint file counts, EC state history/counters, and plugin listener/Map lifecycle.

## 14.3 Performance risks to measure

- Full-session enumeration on each recovery event as the session count grows.
- Per-session Maps in routers/vision/continuity without explicit eviction.
- Listener/timer duplication across HMR/apply cycles.
- Browser/WebView child accumulation after UI crashes/reloads.
- JSON rewrite cost and corruption window as state grows.
- Restart storms multiplying logs, notifications, and recovery scans.

# 15 Future Roadmap Compatibility

## Phase 03 — AUTONOMY

**Status: BLOCKED by current Phase 02 architecture.** Native Session/Goal plus EC metadata can support autonomy, but only after EC is the single task-recovery coordinator, goal/revision/operation identity is durable, user authority fails closed, and external side effects have explicit semantics. Building a second Task Engine would make recovery less reliable.

## Phase 04 — LEARN

**Status: ARCHITECTURALLY AT RISK, not missing-feature failure.** Git branches, tests, CI, Transaction, and Golden are appropriate promotion primitives. The current provider registry’s health/lifecycle/economy/promotion mixture should not become a hidden learning service. Learning proposals must remain advisory until one explicit, audited promotion gate validates them.

## Phase 05 — RESTORE

**Status: CONCEPTS PRESENT, IMPLEMENTATION NOT TRUSTWORTHY.** Checkpoint, LastGood, Golden, Safe Mode, Boot Mode, and Transaction are the right vocabulary. Restore cannot be trusted until restart completion is terminal, LastGood is atomic/content-addressed, Safe Mode is a real boot state, and rollback is tested against actual files/generations.

## Phase 06 — ALWAYS-ON / VPS

**Status: NOT READY.** On a VPS, `systemd` should be the sole process authority. Port the readiness/transaction/recovery contracts, not the whole Windows Guardian/GUI/watchdog authority stack. Required prerequisites are secret isolation, disk/ledger retention, bounded multi-session recovery, provider outage policy, graceful shutdown, single-instance fencing, and 30-day soak evidence.

# 16 Adversarial Failure Matrix

`DEFERRED` means the live fault was deliberately not injected because active work was present. Static or isolated evidence is still shown.

| # | Failure scenario | Expected behavior | Current behavior | Evidence | Risk | Verdict |
|---:|---|---|---|---|---|---|
| 1 | Server process crash | One fenced restart, same task resumed once | T2 standard worker reached stable commit; GUI/direct paths and loaded recovery transition remain | T2 live restart + authority map | Duplicate start/resume outside normal path | **PARTIAL / DEFERRED** |
| 2 | Guardian process exits | Supervisor starts exactly one current Guardian | Watchdog can replace a missing process; Task Scheduler is a second bootstrap | Startup/task/process inspection | Double bootstrap/version drift | **PARTIAL** |
| 3 | Guardian alive but hung | Heartbeat fence replaces stale owner | Watchdog explicitly does not kill/start an alive stale Guardian | `dsh-guardian-watchdog.ps1:80-95` | Permanent loss of recovery | **FAIL** |
| 4 | Restart worker dies with old host/job | Independent worker survives or transaction fails terminally | Multiple normal restarts succeeded; survival for all Windows job modes and terminal propagation remain unproved | Parent tree/log + T2 wrapper source | Server stays down, orphan lock | **UNKNOWN / DEFERRED** |
| 5 | Orphan/partial maintenance lock | Validate full identity; atomically take over or fail closed | PID-only; partial JSON can block as fresh; lock write failure continues | Guardian/worker source | Stuck or unsafe restart | **FAIL** |
| 6 | PID reuse / foreign process on 3080 | Refuse stop unless pid+creation+command+port+generation match | Unique loopback check is good; stop/lock identity lacks full tuple | Process-identity source | Wrong process stop or false takeover | **PARTIAL** |
| 7 | GUI opens during worker restart | GUI observes transaction and cannot start independently | GUI can issue direct `dsh web` | GUI source | `EADDRINUSE`, mixed generation | **FAIL / DEFERRED** |
| 8 | Ten generations crash after 31 s | Hourly circuit opens and remains open | T2 waits 30 s on standard path, then clears hourly attempts; corrupt state fails open | Current budget source + historical clusters | Infinite stable-then-crash loop | **FAIL / DEFERRED** |
| 9 | Four-hour healthy reasoning turn | Progress model avoids false kill | Guardian uses global session mtime + any active goal, then direct restart | Guardian source | Kills healthy long task | **FAIL / DEFERRED** |
| 10 | EC and Goal Recovery wake together | One CAS claim, one resume | T2 source consolidates, but loaded Guardian can still invoke legacy scan | Process age + EC/Goal/Guardian source | Double resume until rollout proven | **FAIL current runtime** |
| 11 | Native resume changes revision N→N+1 | Verify returned new revision | Legacy Goal Recovery compares old revision; path remains callable by loaded Guardian | Source + 36/37 needs-review ledger | False failure and second prompt | **FAIL current runtime** |
| 12 | `WAITING_USER` at restart | All recovery paths fail closed | EC parser errors can mean “no pending”; legacy scan has no equivalent gate | Current EC + legacy loaded path; narrow test only | Crosses user approval boundary | **FAIL** |
| 13 | Paused/blocked/cancelled/completed goal | Never auto-resume unless explicit policy | EC can act from stale intent; complete handling not unified across systems | Source state transitions | Unauthorized or stale work | **FAIL / DEFERRED** |
| 14 | Four sessions due simultaneously | Global semaphore/budget bounds work | Timer launches all due sessions without configured semaphore | EC timer source; multitask test reimplements loop | Recovery storm/starvation | **FAIL** |
| 15 | Session API temporarily unavailable | Defer without corrupting durable semantic state | Mixed defer/retry paths; Goal ledger accumulates review claims | Ledger: nine post-resume list failures | State pollution/retry storm | **PARTIAL** |
| 16 | Intent JSON torn/corrupt/concurrent write | Quarantine, CAS, recover last valid snapshot | Shared `.tmp`, no lock/fsync/quarantine; persistence failure can be ignored | IntentStore source | Lost/merged intent | **FAIL / DEFERRED** |
| 17 | External write succeeds, tool result lost, crash | Reconcile stable operation ID/receipt; never repeat | New prompt/RPC identity; prompt asks model to check | EC/Host call chain | Duplicate message/file/API/Git write | **FAIL (simulated)** |
| 18 | Payment-like action succeeds, receipt lost | Never replay without authoritative receipt | No generic receipt/idempotency contract | Architecture inspection only; no real payment | Irreversible duplicate | **FAIL (logic simulation only)** |
| 19 | Explicit session model, then recover | Preserve exact tuple or fail loudly | EC has overwritten explicit selection; wrappers read stale model | Runtime EC log + pure probes | Silent cost/privacy/capability change | **FAIL** |
| 20 | Current registry fallback derivation | Resolve an existing configured exact tuple | T2 EC splits registry prefixes into provider IDs absent live settings | Current `model-registry.mjs` + EC + provider-key enumeration | Fallback can target unregistered route | **FAIL design; live failure injection deferred** |
| 21 | Provider returns 429/quota | Typed bounded fallback; reset on new incident | Message can mask code; fallback index persists | OpenRouter/EC source | No fallback or permanently exhausted chain | **FAIL / provider live test deferred** |
| 22 | Provider returns 401/403 | Stop route, surface credential problem, no blind loop | Fatal classification exists in parts; cross-layer behavior not proven | Static source tests | Credential lockout/retry noise | **PARTIAL / DEFERRED** |
| 23 | Provider 5xx/timeout/reset | Bounded same-layer retry then compatible fallback | Official and custom retry layers overlap; exact route result not attested | Router/EC source | Duplicate calls, silent switch | **PARTIAL / DEFERRED** |
| 24 | Strict JSON request falls back | Only schema-capable route | Current OpenRouter chain can include unverified/non-structured route | Router core registry | Invalid output/agent corruption | **FAIL** |
| 25 | Context overflow, compaction available | Compact once with valid signal; retry smaller request | EC passes undefined signal; logs show `COMPACT-UNAVAILABLE` and retries | Installed compaction + runtime log | Loop/no progress | **FAIL** |
| 26 | Overflow fallback has smaller/unknown window | Reject incompatible fallback | Current registry unknown context can fail open; multiple static truths remain | Registry/context inspection | Repeat overflow/silent truncation | **FAIL** |
| 27 | Image on text-only current route | Resolve explicit compatible route before disclosure | Official admission can reject before bridge | Host/bridge call order | Feature unavailable despite fallback | **FAIL / DEFERRED** |
| 28 | Same image, new question, transient failure | Prompt-sensitive cache; one allowed provider; transient errors not cached | Attachment-only cache/direct sequential providers possible | Vision bridge source | Stale answer/privacy expansion | **FAIL / DEFERRED** |
| 29 | Cross-provider reasoning replay | Re-resolve entire call config/protocol | Old reasoning/max-token controls can survive switch | Guard/router source | Protocol errors or reasoning corruption | **FAIL / DEFERRED** |
| 30 | Disk becomes full during state write | Preserve last valid state; stop safely; alert | No proven atomic/quota policy across ledgers/sessions/backups | Storage/state design | Corruption and unrecoverable restart | **UNKNOWN / DEFERRED** |
| 31 | Invalid YAML / torn LastGood copy | Restore exact verified set only | YAML is not auto-promoted, which is good; LastGood mirrors are split and copies non-atomic | Hash comparison + LastGood source | Restore unverified mixed config | **FAIL** |
| 32 | Plugin throws during boot | Isolate optional plugin, report degraded mode, dispose partial state | Broad catches vary; exact 18-plugin boot failure not in required CI | Plugin/CI inspection | Whole Harness boot failure or half-init | **UNKNOWN / DEFERRED** |
| 33 | HMR/apply repeated 100 times | Zero net listeners/timers/children | Several listeners lack proven disposer | Plugin source | Duplicate calls/memory leak | **SUSPECTED / DEFERRED** |
| 34 | Git/deployment/process drift | Boot/release attestation blocks any mismatch | T2 critical disk files align, but no automatic manifest gate and Guardian remains stale in memory | T2 hashes + process creation times | Correct files, wrong loaded generation | **PARTIAL** |
| 35 | Credential missing/rotated | Typed unavailable state; no secret logging/retry storm | Secret storage is duplicated; rotation path not safely tested | Credential/config inspection | Outage and stale-copy reuse | **UNKNOWN / DEFERRED** |
| 36 | Browser/WebView crashes | UI restarts without creating second server or orphan children | GUI owns direct process actions; no soak evidence | Process tree/GUI source | Child/process growth or server race | **UNKNOWN / DEFERRED** |
| 37 | Windows sleep/lid/Modern Standby | Timers rebase; no stale false positive/restart storm | Power handling exists but current full cycle not retested | Power/Guardian source; historical evidence only | False recovery after wake | **UNKNOWN / DEFERRED** |
| 38 | Future VPS disconnect/reboot | `systemd` sole owner; durable task resumes once | Phase 06 is not implemented; current Windows multi-authority stack is not portable as-is | Architecture mapping | Future double supervisors/unbounded restart | **N/A current phase; architectural blocker** |

# 17 What NOT To Change

1. **Do not patch the installed official DSH core.** Its native session, goal CAS, current-session model selection, model resolution, and compaction surfaces should remain dependency boundaries.
2. **Do not replace GitHub verified main as canonical truth with staging, live profile, Golden, or a generated report.** Add attestation between layers instead.
3. **Keep ambiguous/foreign loopback ownership fail-closed.** Tailscale’s non-loopback listeners were not the 3080 conflict; do not weaken identity checks to “make restart work.”
4. **Keep explicit Node v22 live-server selection, launcher/runtime ledger, and dual-WebSocket `client_ready` checks.** They are useful verified primitives.
5. **Keep readiness layered.** Merge implementations, but preserve the distinction between boot, client, commit, and task readiness.
6. **Keep “YAML parses” separate from “Verified LastGood.”** Never auto-promote syntax-valid configuration.
7. **Keep Golden, transaction checkpoint, Verified LastGood, and deployment backup as different concepts.** Consolidate authority, not semantics.
8. **Keep notification log rotation.** Add redaction; do not remove the working disk bound.
9. **Keep tool-output offload and the vision bridge until native replacements pass exact integration tests.** Their current defects justify containment, not abrupt deletion.
10. **Do not create a capability database/service.** If unification is needed, use one pure tuple-keyed module plus official runtime facts.
11. **Do not make ordinary crash readiness depend on a paid provider call.** Use deterministic control-plane gates; reserve provider smoke for release/diagnostic policy.
12. **Do not certify current `model-registry`/EC routing merely because 19/19 unit tests and PR checks pass.** It derives provider IDs absent the current settings and has no live failure-route proof.
13. **Do not delete backup/archive copies before retention, rollback, and credential-migration tests.** Some contain secrets and require controlled handling.
14. **Do not treat future Phase 03–06 features as current defects.** The current defect is that Phase 02 authority boundaries would obstruct them.
15. **Do not run destructive recovery tests while an active goal/session is present.** Use a cloned profile/VM and content-addressed fixture.

# 18 Recommended Repair Order

No repair was executed in this audit.

## P0 — establish authority and safety semantics

1. **Use T2 `64071dac` as the repair baseline and pause further production promotion** until a content/process manifest is captured. This is a release recommendation, not an audit action or rollback request.
2. **Create one Process Authority contract** for start/stop/restart/reclaim; make GUI, Guardian, Transaction, Safe Mode, and wrappers clients. This must precede restart-budget and rollback proof.
3. **Make restart terminal and generation-bound:** `{transactionId, attemptId, port, pid, creationTime, generation}`; wrapper acceptance cannot advance Transaction.
4. **Finish activating the chosen EC coordinator design:** checkpoint/reload Guardian, eliminate production use of the legacy global scan, make Goal Recovery execute only an explicit plan, and fix native revision `N→N+1` verification.
5. **Add durable recovery/operation identity and fail-closed user gates.** Establish at-least-once versus exactly-once contract before enabling autonomous external writes.
6. **Remove model selection from EC** and preserve explicit current-session tuple. Withhold Phase 02 registry/fallback closure until tuple-level integration tests pass.

Dependencies: process fencing enables trustworthy restart tests; single task authority enables idempotency testing; exact route authority enables safe context/fallback tests.

## P1 — make recovery artifacts and gates truthful

7. Bind stable-window/budget commit to the same generation, retain hourly crash attempts, and quarantine corrupt/concurrent budget state.
8. Replace duplicate LastGood mirrors with one atomic hash-manifested set; then repair Transaction/Safe Mode to wait for terminal generation state and perform real rollback/boot.
9. Merge readiness implementations into one layered API and make required CI boot the exact release bundle/profile/core version, fail closed, and verify manifest hashes.
10. Fix test state-root injection before running reliability/fault suites again; add filesystem-deny assertions.
11. In a separately authorized security operation, restrict secret ACLs, migrate credentials, remove command-line secrets/content, redact notifications, inventory backups, then rotate affected credentials.
12. Fix compaction API/error normalization and require compatible route/context/config before any bounded fallback.

Dependencies: do not rotate/delete credentials or backups before inventory and rollback; do not call Reliability v1 verified until LastGood/transaction tests are real.

## P2 — harden lifecycle, retention, and future portability

13. Add 100-cycle plugin apply/dispose and 30-day accelerated soak/resource SLO tests; then add listener disposal and retention limits where measurements fail.
14. Consolidate duplicated wrappers/tests/archives only after caller inventory and rollback tests; move executable tests out of plugin runtime directories.
15. Validate vision admission/disclosure/cache behavior and exact-route reasoning/schema compatibility.
16. Design Phase 03 on native Session/Goal + EC metadata, Phase 04 on explicit Git/test/CI promotion, Phase 05 on repaired restore primitives, and Phase 06 with `systemd` as the sole process owner.

# 19 Evidence Appendix

## 19.0 Scoring worksheet

For every dimension, `score = F + A + C + V + S`, where each axis is 0–20:

- `F` — current functional evidence: 0 absent; 5 fragile/static only; 10 bounded real use; 15 strong integration evidence; 20 adversarially proven.
- `A` — authority/boundary correctness: 0 uncontrolled; 5 major conflicts; 10 bounded overlaps; 15 one clear owner with minor gaps; 20 single enforced authority.
- `C` — failure containment: 0 unsafe/replay-prone; 5 major fail-open paths; 10 partial bounded recovery; 15 tested fail-closed behavior; 20 proven disaster containment.
- `V` — verification depth: 0 claims only; 5 source/mock evidence; 10 mixed unit/integration; 15 realistic fault coverage; 20 release+soak+fault proof.
- `S` — operational sustainability: 0 untenable; 5 manual/high-growth; 10 bounded with known debt; 15 measured maintainability/retention; 20 proven 30-day operation.

| Dimension | F | A | C | V | S | Total | Primary evidence driving deductions |
|---|---:|---:|---:|---:|---:|---:|---|
| Production Readiness | 17 | 5 | 6 | 10 | 7 | **45** | T2 main/deployment and stable commit are real; P0-01–04, P1-01/02/05 still prevent release claim |
| Unattended Readiness | 10 | 3 | 3 | 3 | 5 | **24** | P0-01/02/03; waiting-user and side-effect replay; destructive/soak tests deferred |
| Long-task Readiness | 11 | 4 | 3 | 2 | 8 | **28** | ~242K evidence and offload exist; P1-03, stale kill, O(n²) Completion Truth; no 500K–1M/soak proof |
| Recovery Readiness | 11 | 3 | 3 | 4 | 3 | **24** | T2 standard stable commit works; P0-01–03, P1-01/02/06 and repeated fail-open Completion Truth remain |
| Architecture Cleanliness | 13 | 6 | 5 | 6 | 8 | **38** | T2 canonical disk layers align and source narrows recovery; loaded Guardian/model/restart authority conflicts remain |
| Security | 10 | 4 | 5 | 8 | 9 | **36** | No confirmed public Git leak; P1-04 local plaintext/ACL/argument risks; redaction/rotation partly present |
| Maintainability | 13 | 8 | 7 | 8 | 8 | **44** | Current main/content aligned and docs/tests broad; P1-05/07, copied logic, lifecycle and stale process remain |
| Future VPS Readiness | 8 | 5 | 5 | 6 | 8 | **32** | Stable/readiness/ledger primitives improved; Windows authorities, retention, secret and soak gaps block Phase 06 |

Arithmetic check: `45 + 24 + 28 + 24 + 38 + 36 + 44 + 32 = 271`; `round(271 / 8) = 34`.

## 19.1 Baseline, immutable artifacts, and audit integrity

| Evidence | Value |
|---|---|
| T2 current canonical commit | `64071dacc11f77af9be8c228088abb2932673cf9` |
| Frozen T0 canonical | `b9ddc1171eb0602615b9b54ce654fe821f0fd8af` |
| Frozen T0 candidate | `25a1d89895c8b2ef654e64b4eff0d5222ba1c023` |
| T1 delta | `379a1c35b30bf02d583584757bdfb5da5f31b648` |
| Official runtime package | `@deepseek-ai/dsh 0.1.1-rc.2` |
| CLI/runtime Node | CLI `24.15.0`; server `22.22.2` |
| T0 active-work observation | 327 sessions, one active goal, two running sessions |
| Destructive test status | `TEST_DEFERRED_DUE_TO_ACTIVE_TASK` |
| Intended audit writes | Report, audit state notes, immutable evidence copies outside production |
| Unintended audit effect | Isolation intent was violated: reliability fixtures wrote tx records/checkpoints into real LocalAppData. Testing stopped; records were not deleted. No production configuration/behavior was intentionally changed. |
| Concurrent non-audit mutation | The user’s optimizer committed/deployed/restarted T1, then merged PR #15/#16 and restarted T2 while the audit was in progress |

Immutable archives:

| Artifact | Local evidence path | SHA-256 |
|---|---|---|
| T0 canonical source archive | `work/full-harness-audit-20260823/snapshots/main-b9ddc117.zip` | `AE119B30E454333D68E1F279B0D52B8082299BEFA45C72BC010EB97CD684113A` |
| Frozen candidate archive | `work/full-harness-audit-20260823/snapshots/candidate-25a1d898.zip` | `BCBDA335345BA27F3E27DA091ED3D23952763F058EA729DA5FBADEB8647C1166` |
| T2 canonical source archive | `work/full-harness-audit-20260823/snapshots/main-64071dac.zip` | `CB501586D1044567E3AA1DCF13DAAA545A0FBC1B2FD408493A70B89CEA37C739` |
| Official-core evidence archive | `work/full-harness-audit-20260823/snapshots/official-core-0.1.1-rc.2.zip` | `55BFE48F8138F13F2806E288D9FF928C687334DDBD3F9AED774EC31738A8C90D` |

Official-core files supporting this audit were copied read-only into that evidence archive:

| File | SHA-256 |
|---|---|
| `package.json` | `DC930C0B18158F49AE3753CEAF6B1B7AE71DC6C8F45C85A2D679B142024ADDF7` |
| `dsh-goal/lib/index.js` | `E7388A80076E031D10E20A2AEC4B6F9740588E7BB8B76516BA2FD28DC2F29481` |
| `dsh-compaction-basic/lib/index.js` | `144202A0F150B9B7984842D6316808AEFCBDF14E7A890805CB0819F4CC69740F` |
| `dsh-host-apiproxy/lib/index.js` | `8E32FFC951F499849C155E30CB30813AF5ED7ABB11008653125092299B693D9F` |
| `dsh-agent/lib/index.js` | `E7E40C5CA66D9827A5084C5C0C68983F9685842BB9B6D604803D4CB4642BB263` |
| `dsh-llm/lib/index.js` | `90DE54C106866D9333DDC312176E14DF75E7C5EE1D6E54443174A827302276FD` |
| `dsh-llm-pi-ai/lib/index.js` | `E183A9CDDE703B47485410BD68D247C8BECDB277C390F0F91C6DD28718D350E2` |

T2 normalized source→deployment/live hashes (CRLF/LF normalized) were identical on both sides:

| File | Normalized SHA-256 |
|---|---|
| `dsh-guardian.ps1` | `01A158A11190074B84797889DAC9ADA068406838CE5C37E1CAED9275B049C013` |
| `dsh-restart-budget.ps1` | `488A5F43BD9AB871A3947686EACF116E0677D45DBA5ED3A929D781F599309607` |
| `restart-dsh-server-delayed.ps1` | `32DA72C1A1C7244E0EA2EB2562362F10057AD86A4F5CA38BF01CB8EEE99FF994` |
| `goal-recovery.mjs` | `2200790D17FF787A5852FE192616F715F0323BAFA8B68A56C005FC38E5D0D2AB` |
| `plugins/execution-continuity-core.mjs` | `C2508E825BC619B59047758AAF6BE67CF911EAFEBB8C10484A2639400F51371D` |
| `plugins/execution-continuity.mjs` | `1A6E504BB09185D613C7B1BE6709402A4B678E1102F78775A15515E7F0F2BD8F` |
| `plugins/model-registry.mjs` | `209F2FC12C1B681C87DEE8D6E6454C92FB61EEB220F756C55D37490C218AAB4F` |

## 19.2 Reproducible command/evidence ledger

Sensitive values were never printed. Paths below use the discovered locations; commands are read-only except the report/evidence copies and the already-disclosed test fixture writes.

| Time (Asia/Shanghai) | Command/probe | Exit/result | Evidence use |
|---|---|---|---|
| 22:10 | Freeze Git snapshots and hash archives | success; hashes above | Immutable main/25a attribution |
| 23:04:41 | `git status --short --branch`; `git log -3`; `git rev-parse main` | exit 0; feature HEAD `379a1c35`, clean; main `b9ddc117` | Moving-tree boundary |
| 23:04–23:18 | Normalized SHA-256 compare (`ReadAllText`, CRLF→LF) for main→deployment/live and T1→deployment/live | exit 0; counts in §6.3 | Direct source/deployment evidence |
| 23:18:50 | `Get-NetTCPConnection -LocalPort 3080`; `Get-CimInstance Win32_Process`; runtime/restart/EC log tails | exit 0 | T1 PID/generation, restart result, Completion Truth behavior |
| 23:20 | `Test-DshReadiness -Port 3080 -RequireWebSockets`, assert `.State -eq 'client_ready'` | exit 0 | Process/API/two WebSockets |
| 23:20 | `Test-CommitReadiness -Port 3080 -StableWindowSec 2` with no `LightProbe` | exit 0; `COMMIT_READY`; provider/tool probe absent | T1 control-plane readiness |
| T1 delta review | `git diff --check 25a1d898..379a1c35`; `node tests/reliability/test-completion-truth.mjs` | exit 0; 9/9 | Syntax/self-consistency only; test copies logic and imports no production function |
| 23:41–23:43 | Read-only reconstruction from `restart-apply-patch.log`, runtime ledger, budget and process state | external restart: stable recheck + `COMMIT_READY` + commit; PID 8744 | T2 real standard-worker success and outer-wrapper timing |
| 23:51–23:52 | `git rev-parse HEAD/main`; `git log`; PR #15/#16 inspection | main/origin/main `64071dac`; PR checks green | T2 canonical transition and docs-as-claims boundary |
| T2 closeout | Freeze `main-64071dac.zip`; normalized main→deployment/live compare; `git diff --check 379a1c35..64071da` | exit 0; archive/hash and 35/37 root, 22/24 plugin results | Current source/deployment evidence |
| Governance sample | `gh api repos/ZTKyo/deepseek-harness-desktop/branches/main/protection` | exit 0 | Strict two-check gate; `enforce_admins=false`; other flags in §6.4 |
| Public-history scan | `git rev-list --all` plus scoped credential-pattern scan | no real tracked-secret hit; one fake CI sentinel | Public Git conclusion only |

One initial readiness wrapper checked a nonexistent `.Ready` field and exited 2 even though the returned state was `client_ready`; it was discarded as wrapper error and rerun with the correct `.State` assertion above. It is not counted as a Harness failure.

## 19.3 Source/call-chain evidence index

| Finding | File / line or function | Commit/layer | Runtime corroboration | Test/log evidence |
|---|---|---|---|---|
| Recovery authority transition | T0 EC/Goal/Guardian paths; T2 Guardian no-op `:245-260`; executor `:32-65,310-344` | T0 source + T2 main | Guardian PID 19892 still pre-fix; EC current | No loaded-process/concurrent N→N+1 test |
| Wrong goal revision | Goal Recovery `:131-136,240-267`; official goal `:619-630,725-733,761-786` | T0 + official snapshot | 36 `needs_review`, one `resume_sent` | Required N→N+1 regression absent |
| Baseline side-effect replay gap | EC `:31-32,395-402,533-543` | `b9ddc117`, T0 loaded | `RESUME-OK` proves enqueue only | Crash-window test absent |
| Current Completion Truth fail-open | EC `:469-527,539-561` | T2 main, deployed/loaded | Both 23:17 and 23:42 generations logged two clean fallbacks followed by resumes | 9/9 test copies rules, omits missing-events/throw/same-turn collision |
| Waiting-user fail-open | T0 EC `:246-287`; Goal Recovery scan path | `b9ddc117` | Not destructively exercised | Existing 12/12 test reloads store only |
| GUI process authority | GUI `:294-350,1702-1718,2071-2086` | T2 main/deployed | Long-running GUI still has direct authority | GUI/worker race absent |
| Async restart completion | outer wrapper `:44-60`; Transaction `:231-245,270-280`; Safe Mode `:62-69,149-183` | T2 main/deployed | Outer spawn 23:41:47; terminal commit 23:43:03 | Stage tests do not wait real generation |
| Stable-budget gap | budget `:35-64,90-152`; worker `:133-198`; Guardian/start success calls | T2 main/deployed | One full stable commit succeeded; state reset recorded | R1–R9 PASS; generation/corrupt/hourly storm absent |
| LastGood split-brain | verified-lastgood `:53-93`; Guardian `:404-419` | `b9ddc117`, deployed | Three settings hashes differ under equivalent meta claims | Torn-copy regression absent |
| Guardian stale/hung | Guardian `:424-431,542-555`; watchdog `:80-95` | T2 file, pre-T2 loaded process | Guardian/watchdog PIDs and start times | Hang/long-thinking test deferred |
| EC model authority | EC fallback paths including `modelCandidates()`/`pendingFallback` | T2 main/loaded | Historical explicit route replacement; docs unique-router claim contradicted by source | Core tests omit host authority |
| Stale wrapper selection | OpenRouter `:229-234`; CommandCode `:121-130` | T2 main/deployed | Pure host-shape probes reproduced wrong tuple | Exact-model 9/9 missed wrapper path |
| Current registry derivation | registry `:22-40,74-89,152-171`; EC `:358-388` | T2 main/deployed/loaded | Derived prefixes absent enumerated live provider keys | Registry 19/19 does not dispatch routes |
| Real compaction mismatch | EC invalid signal call; official compaction `:926-933` | T0 + official snapshot | Repeated `COMPACT-UNAVAILABLE` | Mock compaction 15/15 PASS |
| Vision discrepancy | bridge `:197-258,287-305,312-375,489-507` | T2 main/deployed | Live provider failure not injected | Multimodal core 25/25 PASS |
| Plugin lifecycle | OpenRouter `:203,303,362-374`; Vision `:473,489`; offload `:94-95`; completion `:58` | T2 main | Host auto-disposal unknown | 100-cycle HMR absent |
| Notification privacy | event notify `:66-70,98-102,183-199`; Telegram `:15-18,36-38` | T2 main/deployed | Rotated retained bytes bounded near 40 MB | Current pattern scan clean; synthetic redaction absent |
| CI wrong artifact/fail-open | `.github/workflows/ci-level1.yml` through `ci-level4.yml`; Report R2 claims | T2 main | Runtime rc2/custom graph differs from Level 3 rc8/empty profile | PR #15/#16 green; workflows unchanged |
| Test isolation leak | Transaction/Safe/Lab tests and scripts | frozen snapshots | Real tx journal/checkpoint entries created | Test stopped after detection |

## 19.4 Runtime evidence index

| Artifact | T0 observation | T1 observation | T2 closeout observation |
|---|---|---|---|
| Loopback 3080 | PID 3944, unique DSH owner | PID 20432, unique DSH owner | PID 8744, unique DSH owner; Tailscale only non-loopback |
| Launcher | PID 20128, staging launcher | PID 24952, staging launcher | PID 23836, staging launcher; current-main content matched |
| GUI | PID 10152, deployed GUI | Same long-running deployed GUI | Same process authority remains |
| Guardian/watchdog | PIDs 19892/4156, started before candidate | Same PIDs; new file not loaded | Same Guardian still pre-remediation in memory |
| Readiness | `client_ready`; commit gate PASS | `client_ready`/commit gate exit 0 | Worker stable recheck + `COMMIT_READY` PASS; no provider/tool probe |
| Restart protocol | 19:41 user-unavailable interval about 14 s | 23:17 starter exit 2 while generation became healthy | Outer returned after spawn; worker committed about 76 s later |
| EC | Explicit route replacement/compaction failures; two intents | New EC loaded; two missing-event clean fallbacks/resumes | Same fail-open sequence repeated for two intents at 23:42 |
| Goal Recovery ledger | 37 claims / 27 generations; no verified resumed-running result | Source executor mode added | Current main improved; loaded Guardian/legacy path unverified |
| Restart budget | Old schema, three hourly attempts | T1 transition | Stable commit timestamp present; attempts reset; generation binding absent |
| LastGood | Three settings hashes differed | No audit promotion/repair | T2 did not make set atomic; no audit repair |
| Manifest | 18 patch IDs; backups inactive | Registry loaded as dependency | Current main/live critical hashes align; imported-dependency/process attestation gap remains |

## 19.5 Test attribution

| Target | Tests executed | Result and limitation |
|---|---|---|
| Canonical `b9ddc117` snapshot | Old RestartBudget; P20 fixture; Stage B/C/D/E; Final Drill; Reliability Lab; Router rollback; launcher 33; exact model 9; multimodal 25; CommandCode 51; guard 21; EC fault 38; crash-safe 33 | Declared assertions PASS; several are source/mock/copied-logic tests; Stage tests do not prove terminal live recovery |
| Frozen `25a1d898` snapshot | Stable-window RestartBudget R1–R9; P20 fixture; Stage B/C/D/E; Final Drill; Lab; Router rollback; launcher 33; registry 19; exact 9; multimodal 25; CommandCode 51; guard 21; EC fault 38; crash-safe 33; compaction 15; multitask 6; nonrecoverable 19; waiting-user 12 | Declared assertions PASS; registry inactive in that snapshot; some Stage fixtures wrote real LocalAppData and were stopped |
| T1 `379a1c35` delta | `git diff --check`; Completion Truth 9/9 | PASS, but Completion Truth test reproduces regex/function rules and imports no production EC code; it omits confirmed fail-open cases |
| T2 `64071dac` snapshot/delta | Frozen archive; `git diff --check 379a1c35..64071da`; PR #15 three configured checks; PR #16 two required checks | PASS for declared checks; workflow code unchanged; RestartBudget R1–R9 omits same-generation/corrupt/hourly/wrapper-terminal cases |
| T0 live | Readiness + commit readiness without LightProbe | PASS control plane only |
| T1 live | Readiness + commit readiness without LightProbe | PASS control plane; runtime logs independently confirm new EC behavior |
| T2 live | Standard delayed restart with 30-second window + second readiness + `COMMIT_READY` | PASS one normal path; outer wrapper terminal propagation and fault cases remain untested |

Tests deliberately not run against the active task: server/Guardian/worker kill, GUI/worker race, crash storm, PID reuse, lock access denial, Safe cold boot, real rollback, network/provider outage, credential change, disk full, sleep cycle, HMR stress, 500K–1M context, and external side effects.

## 19.6 Audit limitations

- `b9ddc117`, `25a1d898`, `64071dac`, and the official-core archive are immutable evidence artifacts. T1/T2 received bounded delta/runtime review in addition to the T0 full audit.
- No provider’s current advertised context/modality/reasoning limits were independently network-verified.
- No long-duration idle-versus-load memory soak was available; resource-growth rates remain projections.
- Windows Job Object/breakaway behavior was not fault-injected.
- Exact command environment and process IDs are point-in-time evidence and can change as the active task continues.
- A successful current readiness check cannot prove future failure recovery; a static source defect cannot prove every failure will occur.

## Independent Self-Review

### First-pass findings changed

- Separated current service health from unattended production readiness; retained the live `COMMIT_READY` PASS instead of calling the whole runtime broken.
- Corrected a material first-pass conflation: `model-registry.mjs` was inactive in frozen `25a1d898`; it became a live T1 risk and is now a canonical T2 defect.
- Replaced the unproved “main directly produced deployment” chain with direct normalized hash comparisons and an observed checkout→deployment/live→process chain.
- Recomputed the final T2 score to 34 using the published equal-weight worksheet, crediting canonical disk alignment and one real stable commit without forgiving remaining P0s.
- Recorded the audit-integrity violation from fixture writes rather than claiming the audit caused no production-state mutation.
- Classified local secret exposure as P1 rather than a public-compromise P0 because tracked-history scanning found no real secret.
- Treated notification logs as privacy/high-write-rate risk but removed an “unbounded disk” interpretation because rotation caps retained bytes.

### False positives removed

- Tailscale did not own the loopback 3080 endpoint and was removed as the current port-conflict cause.
- Backup plugin files were not active in the sampled 18-entry patch manifest; they remain retention/security surface only.
- The frozen 25a registry was not a runtime authority; that false-positive attribution was removed.
- Phase 03–06 missing features were not scored as current defects; only Phase 02 architectural blockers were assessed.
- Future VPS disconnect/reboot was changed from a current `FAIL` to `N/A current phase; architectural blocker`.
- Passing unit tests were retained as evidence of their narrow contracts, not dismissed wholesale.

### New findings added

- `SkipLive`/lab tests wrote production LocalAppData transaction state.
- Verified and Guardian LastGood copies carried different settings under equivalent metadata claims.
- The sampled server launcher came from staging while GUI/Guardian came from deployment.
- Public main protection had administrator bypass and required CI did not boot the exact custom runtime.
- T1 Completion Truth failed open in the real 23:17 restart: missing session events were treated as clean and two intents were resumed.
- T2 repeated the same Completion Truth fail-open/resume sequence at 23:42.
- T2 completed a real stable-window + `COMMIT_READY` path, but the outer wrapper returned about 76 seconds before terminal commit.
- T2 current main and critical deployment/live files aligned; the old Guardian process remained a concrete loaded-code exception.
- Immutable official-core evidence and per-snapshot test attribution were added after independent review.

### Remaining uncertainty

- Controlled destructive faults, provider outages, disk-full, sleep, HMR soak, and 500K–1M context behavior remain untested because active work was protected.
- External tools may implement their own idempotency, but the Harness neither requires nor records it; therefore the general guarantee remains at-least-once.
- Plugin host automatic disposer behavior and actual long-term RAM leak rate are unknown.
- T2 addresses part of the source architecture (Guardian no-op hook, Goal Recovery executor mode, durable network defer, standard stable commit), but the old Guardian process is still loaded and Completion Truth/registry/generation/terminal-result defects remain. Any later optimizer commit needs a new immutable delta audit before certification.

The self-review found no evidence supporting `PRODUCTION_READY` or `CONDITIONALLY_READY` for the stated unattended goal. The conservative final verdict remains **NOT_READY**.
