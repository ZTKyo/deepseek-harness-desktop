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

# R5: success resets budget -> allowed again
Register-DshRestartSuccess | Out-Null
$r5 = Test-DshRestartAllowed
Assert ($r5.Allowed -eq $true) 'R5 success resets budget' "reason=$($r5.Reason)"

Write-Host ""
if ($fail -eq 0) { Write-Host "RESULT: PASS (restart budget state machine)" } else { Write-Host "RESULT: FAIL ($fail)" }
Remove-Item -LiteralPath $env:DSH_RESTART_BUDGET_PATH -Force -ErrorAction SilentlyContinue
exit $fail
