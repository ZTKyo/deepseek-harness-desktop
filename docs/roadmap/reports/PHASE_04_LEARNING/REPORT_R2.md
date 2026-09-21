# PHASE 04 LEARN — R2 REPORT (adversarial-review corrections)

**Date:** 2026-09-21
**Executor:** Harness (main control)
**Baseline:** `f7d45fe0045b993151fe67180bf4583b9aba82e6` (R1 shipped state), branch `p4-learning-r1`
**R1 code commit:** `ede575e4fac958f73ad15ae490647191c6cc0463`
**Worktree:** `.worktree-p4-learning-r1` (isolated; production profile untouched)
**Status:** `P4_LEARN_R2 = COMPLETE` — 5 proven R1 defects fixed, 274 unit assertions green
(+54 vs R1), 59 E2E assertions green (+1), 0 regressions introduced.

---

## 1. Why R2 exists

R1 passed its own 220-assertion suite and its 58-assertion real-session E2E — and was still
wrong. An **adversarial review** (deliberately attacking the shipped code rather than
re-running its tests) proved five defects by direct experiment. R1's green suite did not
catch them because the suite tested the *intended* behaviour, and every defect lived in the
gap between intent and implementation.

R2 is the correction pass. Each fix is locked by a regression test that fails on R1 code.

---

## 2. The five proven defects

Evidence: `docs/roadmap/evidence/P4_LEARN_R2_DEFECT_BEFOREAFTER.txt` — R1's logic
reconstructed verbatim and run against the same inputs. **19 / 19 checks changed behaviour,
0 unchanged.**

### D1 — `\b` word boundaries are ASCII-only, so every Chinese keyword was dead

`\b` is defined against `\w` (ASCII). CJK characters are not `\w`, so `\b报错\b` can never
match inside `这里报错了`. Every CJK keyword in R1 was unreachable — the plugin silently
learned nothing from Chinese sessions.

| input | R1 | R2 |
|---|---|---|
| `报错` / `失败了` / `这里报错了` / `程序崩溃了` / `无法启动` / `配置错误` | `null` | `failure` |
| `已修复` / `问题解决了` / `测试通过` / `跑通了` | `null` | `resolution` |

**Fix:** separate `latin` and `cjk` regexes per pattern; CJK patterns carry no `\b`.

**Real-session impact (3227 surface nodes, 44252 zstd frames):** signals detected
**161 → 769**; distinct candidate titles **152 → 754**.

### D2 — first-match-wins inverted the meaning of a turn

R1 listed `failure` first in the array and `break`-ed on first match. A turn saying
*"fixed the error"* was therefore classified `failure` — the exact opposite of its meaning,
and the label drives what gets learned.

| input | R1 | R2 |
|---|---|---|
| `fixed the error` | `failure` | `resolution` |
| `resolved the failure` | `failure` | `resolution` |
| `the crash was fixed` | `failure` | `resolution` |

**Fix:** patterns declared strongest-first (`resolution` → `correction` → `failure`), so the
first match is now the strongest semantic, not the earliest array entry.

### D3 — no failure↔resolution pairing (every fixed bug looked like an open wound)

R1 only listed matched keywords; it never asked whether a failure was subsequently resolved.
A session where everything was fixed was indistinguishable from one where nothing was.

**Fix:** `resolved` (a `resolution` exists *after* a `failure`, by `seq`) and
`unresolvedFailureSeqs` (failures no later resolution covers).

| input | R1 | R2 |
|---|---|---|
| failure then later resolution | *(concept absent)* | `resolved=true`, gap list empty |
| lone failure | *(concept absent)* | `resolved=false`, gap `[10]` |
| resolution **before** failure | *(concept absent)* | `resolved=false`, gap `[11]` — seq order is respected |

**Real-session impact:** 9 windows contain a failure; R2 now separates them into
**6 resolved / 3 genuinely open**.

### D4 — harness-injected text was being learned as experience

`<system-reminder>` blocks are injected by the harness, not spoken by the user. R1's
`isPluginSourced` guard only covered some event shapes, so injected text reached the digest.
In the reviewed session, injected blocks produced real candidate signals whose titles *were*
the injected text.

**Fix:** `stripInjectedContent()` — content-level defence, independent of event metadata.
Handles closed blocks, unterminated blocks (truncated logs), and injection-only turns
(which are dropped entirely and counted as `injectedSkipped`).

| input | R1 | R2 |
|---|---|---|
| injection-only turn | signal `true` | signal `false`, turn dropped |

### D5 — caller-supplied `nodeSeqs` were trusted as-is

Duplicate seqs amplified counts and corrupted provenance anchors; out-of-order seqs made the
output depend on call order, breaking the "same input → same output" contract.

| input | R1 | R2 |
|---|---|---|
| `[0,0,0,1]` → turnCount | `4` | `2` |
| `[0,0,0,1]` → sourceEventSeqs | `[0,0,0,1]` | `[0,1]` |
| `[1,0]` → turn order | `[1,0]` | `[0,1]` |

**Fix:** canonicalize (dedupe + sort) before use; signals sorted by `seq`.

---

## 3. Two bugs I introduced and caught

Recorded deliberately — a correction pass that claims a clean sweep is not trustworthy.

### 3.1 I broke the E2E's title assertion (false negative)

After D1, the signal turn became a Chinese turn containing a newline. The E2E check compared
`oneLine(title)` (which collapses `\s+` → `' '`) against **raw** turn text via `includes()`,
so the collapsed space could never match the raw `\n`. **E2E dropped 58 → 57 PASS.**

The assertion was fragile and had been passing by luck. Fixed by normalizing whitespace on
*both* sides, and I added a **negative control** asserting that an invented title is still
rejected — so the assertion cannot pass vacuously. E2E: **59 PASS** (+1 = the control).

### 3.2 I silently dropped an English keyword (capability regression)

R2's English keyword sets are supersets of R1's **except** `actually`, which I had dropped
from `correction` while adding `corrected`. Real-session evidence showed English titles
disappearing. Restored, and locked by a test asserting **every** R1 English keyword still
produces a signal.

After the restore, the "R1-only titles (lost)" set on the real session is **empty** — R2 is a
strict capability superset of R1, not a trade.

---

## 4. Verification actually performed

| Suite | Result |
|---|---|
| `tests/learn/test-learn-core.mjs` | **274 PASS / 0 FAIL** (R1: 220) |
| `tests/learn/run-learn-real-e2e.mjs` | **59 PASS / 0 FAIL** (R1: 58) |
| `tests/learn/run-ac7-regression.ps1` | **GREEN=19, RED=1** — same as R1 |
| Real-session quality probe | signals 161→769, titles 152→754, lost titles **0** |

Evidence artifacts:
- `docs/roadmap/evidence/P4_LEARN_R2_UNIT_OUTPUT.txt`
- `docs/roadmap/evidence/P4_LEARN_R2_E2E_OUTPUT.txt`
- `docs/roadmap/evidence/P4_LEARN_R2_DEFECT_BEFOREAFTER.txt`

**Regression discipline.** The one RED (`tests/install-plugin/verify-install-plugin.mjs`,
13 pass / 2 fail) was **not** assumed unrelated. I reverted my plugin changes to pristine
`HEAD` and re-ran it: identical 13/2. It is pre-existing plugin-sync drift
(`install-plugin --check`), untouched by this work. R1 recorded the same failure (§5.5).

The regression tests were also shown to be **non-vacuous**: against R1's reconstructed logic
all 19 behaviour checks differ, i.e. the new tests genuinely fail on the old code.

---

## 5. Explicitly NOT done (scope boundaries)

- **No new capability.** R2 only corrects R1's signal/digest correctness. Auto-activation,
  promotion, and recall semantics are unchanged.
- **No threshold tuning.** The higher signal count is a *correctness* gain (dead CJK patterns
  now fire), not a loosened threshold. Candidate volume is intentionally not capped here —
  candidates are `PROPOSED` and cost nothing until a human approves them.
- **CJK keyword coverage is a starting set**, not a linguistic model. It is heuristic and
  deterministic by design.
- **D4 is content-level defence, not a complete injection boundary.** It strips
  `<system-reminder>`-style blocks; a novel injection wrapper would need a new pattern.

---

## 6. Rollback

Nothing in production was touched; all work is in `.worktree-p4-learning-r1`.

```powershell
cd "C:\Users\Administrator\Desktop\sdeepseek harness\.worktree-p4-learning-r1"
git checkout -- plugins/learn-core.mjs plugins/learn.mjs          # revert code only
git checkout -- tests/learn/                                    # revert tests too
```

---

## 7. Verdict

`P4_LEARN_R2 = COMPLETE`. Five proven defects fixed, each locked by a regression test that
fails on R1 code; two self-inflicted bugs found and fixed; zero regressions introduced
(the single RED is proven pre-existing). R2 strictly supersets R1's detection capability.

**The honest headline:** R1 shipped green and was still wrong in five ways. The value of R2
is not the five fixes — it is that adversarial review, not the test suite, found them.
