## Summary
- Watchdog R1 per Notion 02.8: lightweight observation layer over the existing Supervisor authority — no second Task DB/Engine/Router/Billing Authority.
- **watchdog-core.mjs** (pure): 7-state projection + UI-layer OFFLINE/UNKNOWN; progress-signal stall detection (2 confirmations, NOT pure duration); bounded recovery (idempotent commandId `WD:g<gen>:CORRECTION:<seq>` + episode 1/daily 3 budget + P3-goal denylist + CORRECTION/steer only); redacted schema (objective≤80, cost=UNAVAILABLE — zero guessing).
- **watchdog.mjs** (host plugin): 60s read-only loop over supervisor-bridge `get_snapshot`/`get_state`; snapshot persisted to `~/.dsh/watchdog/last-snapshot.json`; Telegram state-change push (existing alert channel); read-only routes `/watchdog/health|status`.
- **supervisor-mcp-adapter**: read-only proxy `/watchdog/*` with an independent watchdog token (3-way token separation; reuses existing p275 tunnel — no new ports).
- **mobile-widget**: zero-dependency Android read-only widget V1 (aapt2+javac+d8+zipalign+apksigner; INTERNET only, zero mutation). Keystore/APK excluded via .gitignore (repo has no tracked binaries convention).
- **tests/watchdog**: 27-case suite (projection/stall/budget/idempotency/denylist/redaction) + host smoke + patch YAML validation; wired into CI L2.

## Verification (T1–T12 all PASS, real evidence)
- Unit 27/27 (re-run post-restart, exit 0)
- Auth: no token→401, valid→200 on 3080; 8091 proxy 200 same response, wrong token→401
- Live projection: state=AWAITING_REVIEW, provider bai/glm-5.3-flash (source=settings.agent-default-model), cost all UNAVAILABLE
- Controlled restart: source==deployed==loaded (snapshot keeps refreshing = loaded proof)
- Widget: BUILD OK, apksigner verified, aapt badging exit 0, only INTERNET permission
- YAML patch validated (19 top-level entries)

## Honest findings (REPORT_R1.md §5)
- F1: live-fire recovery drill not executed in R1 (would inject real mutations into the active goal — self-referential risk); covered by core unit tests + bridge-side double budget gate; proposed as controlled test-goal exercise post-review.
- F2: Telegram push implemented but no real state transition has occurred since deploy — fires on first real transition.
- F3: phone-side install/config is a user action (token delivered via secure channel, not chat).

## Rollback
Delete watchdog section in cordis.patch.yml (plugin → QUARANTINED) / revert adapter segment / branch not merging has zero effect on main (anchor fd26b08).

Docs: `docs/roadmap/reports/PHASE_02_8_WATCHDOG_MOBILE_MONITOR/{GAP_AUDIT,REPORT_R1}.md`
