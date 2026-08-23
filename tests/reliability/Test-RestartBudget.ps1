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
Register-DshRestartCandidate | Out-Null
$b6 = Read-DshRestartBudget
Assert ([int]$b6.attempts -ge 1) 'R6 candidate keeps attempts (no early reset)' "attempts=$($b6.attempts)"
Assert ($b6.candidateReady -eq $true) 'R6 candidateReady flag set'
Assert ($null -ne $b6.candidateAt) 'R6 candidateAt timestamp set'

# R7: stable window not elapsed -> not stable yet
$env:DSH_RESTART_STABLE_WINDOW_SEC = '3600'   # force window far in future
$stable7 = Test-DshRestartStableWindow
Assert ($stable7 -eq $false) 'R7 stable window not elapsed -> not stable' "stable=$stable7"

# R8: budget still NOT reset before commit (attempts remain, circuit could trip)
$b8 = Read-DshRestartBudget
Assert ([int]$b8.attempts -ge 1) 'R8 attempts preserved before commit' "attempts=$($b8.attempts)"

# R9: confirm-stable (commit) resets budget + records stableCommitAt
$env:DSH_RESTART_STABLE_WINDOW_SEC = '0'      # commit path (stable elapsed implied)
Register-DshRestartCandidate | Out-Null
$commit = Confirm-DshRestartStable | Out-Null
$b9 = Read-DshRestartBudget
Assert ([int]$b9.attempts -eq 0) 'R9 commit resets attempts' "attempts=$($b9.attempts)"
Assert ($null -ne $b9.stableCommitAt) 'R9 stableCommitAt recorded'
Assert ($b9.candidateReady -eq $false) 'R9 candidate state cleared after commit'
$r9 = Test-DshRestartAllowed
Assert ($r9.Allowed -eq $true) 'R9 allowed after commit' "reason=$($r9.Reason)"

Write-Host ""
if ($fail -eq 0) { Write-Host "RESULT: PASS (restart budget state machine + stable window)" } else { Write-Host "RESULT: FAIL ($fail)" }
Remove-Item -LiteralPath $env:DSH_RESTART_BUDGET_PATH -Force -ErrorAction SilentlyContinue
exit $fail
