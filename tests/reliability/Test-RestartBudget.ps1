$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Isolate budget state to temp so the real runtime state is untouched
$env:DSH_RESTART_BUDGET_PATH = Join-Path $env:TEMP ("dsh-test-budget-" + [guid]::NewGuid().ToString('N') + ".json")
. (Join-Path $root 'dsh-restart-budget.ps1')

$fail = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:fail++ }
}

# R1: default budget exists and is bounded
$d = Get-DshRestartBudgetDefault
Assert ($null -ne $d) 'R1 default budget exists'
Assert ([int]$d.attempts -eq 0) 'R1 fresh state zero attempts'

# R2: fresh state allows restart
$allowed = Test-DshRestartAllowed
Assert ($allowed.Allowed -eq $true) 'R2 fresh state allows restart' "reason=$($allowed.Reason)"

# R3: register 3 attempts (10-min window budget) -> exhausted
Register-DshRestartAttempt -Reason 'r2-test' | Out-Null
Register-DshRestartAttempt -Reason 'r2-test' | Out-Null
Register-DshRestartAttempt -Reason 'r2-test' | Out-Null
$r3 = Test-DshRestartAllowed
Assert ($r3.Allowed -eq $false) 'R3 budget exhausts after 3 attempts' "reason=$($r3.Reason)"

# R4: circuit open -> still disallowed while paused
$r4 = Test-DshRestartAllowed
Assert ($r4.Allowed -eq $false -and $r4.Reason -eq 'circuit_open') 'R4 circuit stays open' "reason=$($r4.Reason)"

# R5 (Phase 02 R2 strict): success WITHOUT a stable candidate must NOT reset
# (no success shortcut bypasses the stable-window verification).
$before5 = Read-DshRestartBudget
Register-DshRestartSuccess | Out-Null
$after5 = Read-DshRestartBudget
Assert ([int]$after5.attempts -ge [int]$before5.attempts) 'R5 no-candidate success does NOT reset budget' "attempts=$($after5.attempts)"
Assert ($after5.lastReason -match 'NOT reset') 'R5 no-candidate success records NOT-reset reason' "reason=$($after5.lastReason)"
$r5 = Test-DshRestartAllowed
Assert ($r5.Allowed -eq $false) 'R5 budget still exhausted (no reset)' "reason=$($r5.Reason)"

# ========== Phase 02 R1 (BLOCKING-4): stable-window state machine ==========

# R6: candidate does NOT reset attempts (budget still counts)
$env:DSH_RESTART_STABLE_WINDOW_SEC = '30'
Register-DshRestartAttempt -Reason 'stable-test' | Out-Null
Register-DshRestartCandidate -AttemptId 'att-6' -ProcessId 1234 | Out-Null
$b6 = Read-DshRestartBudget
Assert ([int]$b6.attempts -ge 1) 'R6 candidate keeps attempts (no early reset)' "attempts=$($b6.attempts)"
Assert ($b6.candidateReady -eq $true) 'R6 candidateReady flag set'
Assert ($null -ne $b6.candidateAt) 'R6 candidateAt timestamp set'
Assert ($b6.candidateIdentity -match 'att-6') 'R6 candidate identity bound' "id=$($b6.candidateIdentity)"

# R7: stable window not elapsed -> not stable yet
$env:DSH_RESTART_STABLE_WINDOW_SEC = '3600'   # force window far in future
$stable7 = Test-DshRestartStableWindow
Assert ($stable7 -eq $false) 'R7 stable window not elapsed -> not stable' "stable=$stable7"

# R8: budget still NOT reset before commit (attempts remain, circuit could trip)
$b8 = Read-DshRestartBudget
Assert ([int]$b8.attempts -ge 1) 'R8 attempts preserved before commit' "attempts=$($b8.attempts)"

# R9: confirm-stable (commit) resets budget + records stableCommitAt
$env:DSH_RESTART_STABLE_WINDOW_SEC = '0'      # commit path (stable elapsed implied)
Register-DshRestartCandidate -AttemptId 'att-9' -ProcessId 5678 | Out-Null
$commit = Confirm-DshRestartStable -AttemptId 'att-9' -ProcessId 5678
Assert ($commit.Committed -eq $true) 'R9 commit accepted (same candidate)' "reason=$($commit.Reason)"
$b9 = Read-DshRestartBudget
Assert ([int]$b9.attempts -eq 0) 'R9 commit resets attempts' "attempts=$($b9.attempts)"
Assert ($null -ne $b9.stableCommitAt) 'R9 stableCommitAt recorded'
Assert ($b9.candidateReady -eq $false) 'R9 candidate state cleared after commit'
$r9 = Test-DshRestartAllowed
Assert ($r9.Allowed -eq $true) 'R9 allowed after commit' "reason=$($r9.Reason)"

# ========== Phase 02 R4 (Step 7): exact generation + corruption safety ==========

# R10: FOREIGN candidate (different attemptId/pid) cannot commit
Register-DshRestartAttempt -Reason 'r10-test' | Out-Null
Register-DshRestartCandidate -AttemptId 'att-real' -ProcessId 1111 | Out-Null
$env:DSH_RESTART_STABLE_WINDOW_SEC = '0'
$foreign = Confirm-DshRestartStable -AttemptId 'att-evil' -ProcessId 2222
Assert ($foreign.Committed -eq $false) 'R10 foreign candidate rejected' "reason=$($foreign.Reason)"
$b10 = Read-DshRestartBudget
Assert ([int]$b10.attempts -ge 1) 'R10 budget NOT reset by foreign confirm' "attempts=$($b10.attempts)"

# R11: same-candidate commit works after foreign was rejected
$ok = Confirm-DshRestartStable -AttemptId 'att-real' -ProcessId 1111
Assert ($ok.Committed -eq $true) 'R11 same-candidate commit accepted' "reason=$($ok.Reason)"

# R12: CORRUPT budget file -> quarantined, fail-closed (not fresh-available)
[System.IO.File]::WriteAllText($env:DSH_RESTART_BUDGET_PATH, '{corrupt!!not-json', (New-Object System.Text.UTF8Encoding($false)))
$corrupt = Test-DshRestartAllowed
Assert ($corrupt.Allowed -eq $false) 'R12 corrupt budget -> not allowed (fail-closed)' "reason=$($corrupt.Reason)"
$quarantined = Get-ChildItem (Split-Path $env:DSH_RESTART_BUDGET_PATH) -Filter "*.quarantined-*" -ErrorAction SilentlyContinue | Select-Object -First 1
Assert ($null -ne $quarantined) 'R12 corrupt budget quarantined (not fresh-available)' "file=$($quarantined.Name)"

# R13: after quarantine, state is fresh but flagged (lastReason=QUARANTINED)
$b13 = Read-DshRestartBudget
Assert ($b13.lastReason -match 'QUARANTINED') 'R13 post-quarantine flagged' "reason=$($b13.lastReason)"

Write-Host ""
if ($fail -eq 0) { Write-Host "RESULT: PASS (restart budget state machine + stable window + generation/corruption)" } else { Write-Host "RESULT: FAIL ($fail)" }
Remove-Item -LiteralPath $env:DSH_RESTART_BUDGET_PATH -Force -ErrorAction SilentlyContinue
Get-ChildItem (Split-Path $env:DSH_RESTART_BUDGET_PATH) -Filter "*.quarantined-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
exit $fail
