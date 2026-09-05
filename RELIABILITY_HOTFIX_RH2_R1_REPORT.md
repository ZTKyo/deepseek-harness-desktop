# HARNESS RELIABILITY HOTFIX RH2 — R1 SOURCE CANDIDATE

## Scope and identity

- Scope: `SOURCE-ONLY`, `TEST-ONLY`; canonical Git `main` baseline.
- `MAIN_SHA`: `563ce43d59c5a46a7e663cee804f6e4609d1f70d`
- `BRANCH`: `hotfix/reliability-rh2-freeze-p1`
- Source hotfix commit at report generation: `09dd1ee20736ce334f088c250bc65a5abf326cc3`
- `HEAD_SHA` at source/CI submission: `f9d69b552b3c19fa77912c7cd83f31e3b6b5179f`
- PR: [#85](https://github.com/ZTKyo/deepseek-harness-desktop/pull/85)
- `P2.75 = FROZEN`, `P2.8 = FROZEN`, `P3 = PAUSED`, `P4 = LOCKED`.

The canonical source worktree was isolated from the existing dirty main
worktree. The main worktree's pre-existing roadmap/evidence changes were not
staged or modified by RH2.

## Changed files

Production-source candidates:

- `.github/workflows/ci-level2.yml` — RH2 deterministic suites are an actual Level 2 step.
- `plugins/execution-continuity.mjs`
- `dsh-readiness.ps1`
- `dsh-health.ps1` — preserves the canonical RH1 health state machine and adds RH2 single-snapshot/latency diagnostics.
- `dsh-healthcheck.ps1` — wires the existing one-shot health command to the single-snapshot library.
- `dsh-guardian-watchdog.ps1`

Tests:

- `tests/reliability/test-rh2-ec.mjs`
- `tests/reliability/Test-RH2Health.ps1`
- `tests/reliability/Test-RH2Watchdog.ps1`
- Existing continuity tests were changed only to import canonical repo-relative modules instead of the live profile; no production files are read or changed by those tests.

## P1 defect closure

### P1-A / P1-B / P1-G — EC recovery live-lock and stale failure truth

Before:

- `session.prompt` failure logged `RESUME-FAILED`, wrote `WAITING_PROVIDER`, and
  scheduled `nextRetryAt` without incrementing `resumeRetryCount` or persisting
  the actual recovery failure.
- Ownership errors could therefore repeat every recovery interval and an old
  provider/model error could remain in the intent store.

After:

- All post-gate recovery failures use one `recordResumeFailure` exit.
- `OWNERSHIP_CONFLICT`, `INVALID_SESSION`, and `INVALID_REQUEST` are typed and
  immediately fail closed to `FAILED_FATAL` with `autoResume=false`, durable
  `lastFailure`, `lastFailureAt`, `failureClass`, and manual-review reason.
- `TIMEOUT`, `NETWORK`, provider-transient, and `UNKNOWN` failures consume the
  same persisted `resumeRetryCount` budget. Retries are due-state/backoff only;
  count is independent of error text. Retry number 9 after eight allowed
  attempts becomes `FAILED_FATAL` and is not returned by `listDue` or the direct
  resume guard.
- Only accepted `RESUME-OK` resets the transient resume budget and clears
  `nextRetryAt`; the latest failure record remains historical evidence until a
  later failure replaces it.

Recovery classification:

| Failure class | Category | Disposition | Durable state |
| --- | --- | --- | --- |
| `OWNERSHIP_CONFLICT` | permanent | no blind prompt; manual review | `FAILED_FATAL` immediately |
| `INVALID_SESSION` | permanent | no blind retry; manual review | `FAILED_FATAL` immediately |
| `INVALID_REQUEST` | permanent | no blind retry; manual review | `FAILED_FATAL` immediately |
| `TIMEOUT` / `NETWORK` | transient | backoff, shared count budget | `WAITING_NETWORK`, cap+1 terminal |
| `PROVIDER_TRANSIENT` | transient | backoff, shared count budget | `WAITING_PROVIDER`, cap+1 terminal |
| `UNKNOWN` | unknown/retryable | bounded attempts, then fail closed | `WAITING_PROVIDER`, cap+1 terminal |

### P1-C — EC API RPC hard timeout

`apiRpc` now creates an `AbortController`, aborts after a finite default
`10,000 ms` deadline, and races the complete fetch plus response JSON parse
against that deadline. The test-only `rpcTimeoutMs` override and
`EC_API_RPC_TIMEOUT_MS` configuration path are capped at `60,000 ms`. Timeout
errors carry `failureClass=TIMEOUT`, `category=transient`, and an explicit
`EC_API_TIMEOUT` code. The abandoned request receives the abort signal and its
rejection is handled, so a late mock/transport settlement cannot create an
unhandled rejection or hold the recovery caller pending.

Boundedness proof for the ownership path: `BEFORE=unbounded periodic prompt`;
`AFTER=exactly 1 prompt + FAILED_FATAL/manual-review`, with no due-state retry.

### P1-D / P1-E — health call deduplication and latency observability

Before, the full health path evaluated `Test-DshApiReady`, then called
`Test-DshReadiness -RequireWebSockets`, which evaluated API readiness again.
The resulting full transaction performed two `session.list` calls.

After, `Test-DshReadiness` accepts an optional precomputed `ApiSnapshot`.
`Get-DshHealthProbe -IncludeWebSockets` evaluates API readiness once and sends
that exact snapshot to the WebSocket-only portion. The result exposes
`ApiDurationMs`, `ProbeDurationMs`, `SlowThresholdMs`, `LatencyDegraded`, and a
`healthy_slow` diagnostic signal while retaining `Ready=true` for a successful
slow probe. A single probe always reports `RestartEligible=false`; no latency
signal is a restart trigger. The existing `dsh-healthcheck.ps1` now consumes
one full health result instead of making separate API and WebSocket readiness
transactions.

Synthetic call-count proof: `session.list` calls per full probe changed from
`BEFORE=2` to `AFTER=1` with approximately 400 fixture sessions and a 500 KB
fixture payload.

### P1-F — Guardian watchdog false-negative presence detection

Before, `Get-GuardianProcess` required a nonblank CIM `CommandLine` containing
the Guardian script. A scheduled Guardian with blank CommandLine was treated
as absent, causing duplicate `Process.Start` attempts and mutex churn.

After, steady-state presence uses the multi-signal resolver:

1. heartbeat PID and freshness;
2. live process with matching PID;
3. heartbeat/process start-time agreement when available;
4. CommandLine as a strong secondary identity signal.

Fresh heartbeat plus matching live PID is present even with blank CommandLine.
Stale heartbeat plus a sufficiently proven live PID is logged as stale and is
not duplicated or killed. Start-time ambiguity is fail-safe no-kill/no-start.
Only no proven live Guardian with no fresh heartbeat is start-eligible. After a
spawn request, `Process.Start` is not reported as healthy; confirmation requires
a fresh heartbeat/PID pair. The Guardian's existing
`DSHGuardian.SingleInstance` mutex remains an independent safety backstop.
No Guardian rewrite or second supervisor was added.

## Deterministic verification

RH2 suites, integrated in `.github/workflows/ci-level2.yml`:

- `node tests/reliability/test-rh2-ec.mjs` — EC1-EC6: **21/21 PASS**.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tests/reliability/Test-RH2Health.ps1` — H1-H5: **13/13 PASS**.
- `powershell -NoProfile -ExecutionPolicy Bypass -File tests/reliability/Test-RH2Watchdog.ps1` — G1-G7: **11/11 PASS**.

Relevant existing regressions passed in the isolated worktree:

- EC crash-safe **33/33**, fault injection **38/38**, R5 addendum EC **90/90**.
- EC Router bridge **14/14**, completion truth **18/18**, capacity resolver **6/6**,
  runtime capacity adapter **13/13**, model registry **33/33**, resume defer **12/12**.
- P1-A WAITING_USER **12/12**, multitask recovery **6/6**, compaction scope
  **18/18**, nonrecoverable states **19/19**, real event-schema question gate
  PASS, canonical EC verifier PASS.
- Restart budget PASS; isolated Stage B LastGood PASS; Stage C transaction
  PASS; Stage D boot mode PASS; Stage E Safe Mode PASS; reliability lab
  **9/9**; launcher arguments **33/33**.
- Context-memory **72/72**, P3 autonomy state core **104/104**, exact-model
  preservation **9/9**, native multimodal **25/25**, credential-preflight
  negative/contract suite **36/36**.
- Node syntax parse PASS for all repository JavaScript modules; PowerShell
  syntax parse PASS for all repository PowerShell modules; YAML gate **5/5**;
  PowerShell secret-pattern gate PASS; node secret scan PASS; secret fixtures
  **6/6**; `.gitignore` and roadmap integrity gates PASS.

The local active-credential cold-start/restart acceptance and local live DSH
smoke were not run because they require reading or mutating active credential
or process lifecycle state. The external sanitized CI smoke is the permitted
isolated live-equivalent gate and is recorded below.

## Deployment drift (record only; not canonicalized)

RH2 did not copy staging into the deployed client or active profile. The
following read-only baseline hashes show why this branch is a source candidate,
not a deployed claim:

| File / location | Canonical source or RH2 source SHA256 | Current deployed SHA256 |
| --- | --- | --- |
| `plugins/execution-continuity.mjs` / active profile | `7577793A5E82D28EC295F3B39B5C6A153C50C13854B0D689544E19DD6E943407` | `36A7A0A308021F31916A8FCBDFA45CDF5F3BF261F741373003FCA09B5A77285F` |
| `dsh-readiness.ps1` | `A8698D93658523DEE45C6F39643E2ED925289442004CD81F0D9D1CE1DEF27D19` | `B0B5B78C5897354EA94FF1FD99EA86057EDB909A08FC3DA881F648467A423238` |
| `dsh-health.ps1` | `5EECE4E20AF0C6C422136A5072FF9BE4DF2109A095CBA2108CE28C36E1654C6B` | `26935C932F22A4D680CCF4E6C0363AFAD12F88FE6C1614D6EEB9856E66C7FBAD` |
| `dsh-healthcheck.ps1` | `7CAF3DEB23F170E382D668664977B558EFAC49711478151EDC00BD9D6D9A4D47` | `E9E520BD2BB78C694AAB0370A8A23027734F9F9743A0A0A2F006BE56C76CF958` |
| `dsh-guardian-watchdog.ps1` | `50A2615FF4656DEFAAAA174066E7A81BCDF42535093EB184863A46D9236DD7B3` | `CAFEF5F6768058637C1314737680DB19E3E708E318F8B75A6A09054C66098F84` |
| `dsh-launcher.js` | unchanged canonical source `17446AE801A8A1B8A95BC1ACE7FD8060D522247F6F2C789C7AA147ADFAD05FDE` | `100E70820112F5885416A88222FE29812EAA199C9B1E9DA7E506B97CFD4B5F14` |
| `start-dsh-server.ps1` | unchanged canonical source `C6D11D1EFB8B6E85C480A7AF5B9D5B6160FB4E69F7CC323A96D955E2697E4D9B` | `C6D11D1EFB8B6E85C480A7AF5B9D5B6160FB4E69F7CC323A96D955E2697E4D9B` |

The active profile and loaded runtime were left unchanged. The launcher
diagnostic differences remain an explicit `RUNTIME_DIAGNOSTIC_OVERRIDE /
DEPLOYMENT_DRIFT` item for a separate deploy review. A future deployment
transaction must first back up and hash the current profile/client set, sync
only the reviewed RH2 files, validate source/deployed/loaded identity, and
perform its own restart/rollback acceptance. That is DESIGN ONLY in this PR.

## Secret issue — separately deferred

`SECURITY_P1_SEPARATE_CLOSURE_REQUIRED` remains open as a separate security
transaction. The intended mechanism remains credential preflight plus a secret
reference; RH2 did not read, print, copy, rotate, or modify the active profile
credential, and did not mix credential rotation into the reliability hotfix.

## CI state and rollback

- Local L1-equivalent static/security gates: PASS.
- Local L2-equivalent state-machine and RH2 gates: PASS.
- External PR L1: **SUCCESS** — run [33973889828](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33973889828), head `f9d69b552b3c19fa77912c7cd83f31e3b6b5179f`.
- External PR L2: **SUCCESS** — run [33973889865](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33973889865), head `f9d69b552b3c19fa77912c7cd83f31e3b6b5179f`.
- External PR L3: **SUCCESS** — run [33973889809](https://github.com/ZTKyo/deepseek-harness-desktop/actions/runs/33973889809), head `f9d69b552b3c19fa77912c7cd83f31e3b6b5179f`; sanitized ephemeral-port smoke passed externally.
- Local live lifecycle gates remain skipped by the source-only boundary.

Rollback for this source candidate is limited to the isolated branch: review
can revert commit `09dd1ee20736ce334f088c250bc65a5abf326cc3` or remove the
hotfix worktree/branch. No production rollback is needed because production
was not changed. No merge, deploy, restart, or P3/P4 restoration is included.

Final state at report generation: `RH2_SOURCE = AWAITING_EXTERNAL_REVIEW`,
`PRODUCTION = UNCHANGED`.
