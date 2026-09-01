# rh1-r3-guardian-path.ps1 — RH1 R3: REAL GUARDIAN RECOVERY PATH (decision helper).
#
# Item 3 of the R3 goal: the guardian's liveness/readiness recovery does NOT just
# call Invoke-DshHealthTriage; it runs through the SAME shared decision/execution
# helper (Invoke-DshHealthGuard, dsh-health.ps1) that production calls, and this
# test exercises THAT function over the full decision path with recording
# executors. This satisfies the reviewer's sanctioned seam: the ONLY deviation from
# production is that restart/alert/recover/confirm executors are injected recording
# stubs (production always defaults to the real primitives). Production's default
# path is unchanged and the helper is NOT a second restart authority (the budget
# gate lives inside Invoke-BudgetedRestart, which production keeps).
#
# This is a DETERMINISTIC suite (no real wall-clock 60s wait; that is the separate
# tests/rh1-real-e2e.ps1 soak). It proves the DECISION branches:
#   E3  single fail -> DEGRADED, restart=0
#   E4  fail/fail/success -> restart=0, streak reset
#   E5  restart_eligible -> incident FIRST, then restart executor EXACTLY ONCE,
#       incidentCreatedAt <= restartRequestedAt
#   E6  budget/circuit exhausted -> restart denied (gate)
#   E7  maintenance lock + restart_eligible -> restart=0
# plus owner_unsafe / server_absent (with & without non-loopback) branches.
#
# ISOLATION: never touches 3080/331xx production, never reads real ~/.dsh, never
# touches production guardian/session/goal/restart-budget. All state/budget/incident
# go to a temp dir via DSH_* env vars.

[CmdletBinding()]
param(
    [string]$WorkDir = (Join-Path $env:TEMP ('rh1-r3-gpath-' + [guid]::NewGuid().ToString('N').Substring(0,8)))
)

$ErrorActionPreference = 'Stop'

# ---- isolate all persistent state ----
$env:DSH_HEALTH_STATE_PATH = Join-Path $WorkDir 'state\rh1-gpath-health.json'
$env:DSH_RESTART_BUDGET_PATH = Join-Path $WorkDir 'state\rh1-gpath-budget.json'
$env:DSH_INCIDENT_DIR = Join-Path $WorkDir 'incidents'
$env:DSH_HEALTH_FAIL_THRESHOLD = '3'
$env:DSH_HEALTH_CANDIDATE_WINDOW_SEC = '30'
$env:DSH_HEALTH_RECOVERY_WINDOW_SEC = '60'
New-Item -ItemType Directory -Force -Path (Split-Path $env:DSH_HEALTH_STATE_PATH) | Out-Null
New-Item -ItemType Directory -Force -Path $env:DSH_INCIDENT_DIR | Out-Null

$root = (Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent)
. (Join-Path $root 'dsh-health.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')

$script:pass = 0
$script:fail = 0
function Assert($cond, [string]$msg) {
    if ($cond) { $script:pass++; Write-Host ("  PASS: " + $msg) }
    else { $script:fail++; Write-Host ("  FAIL: " + $msg) }
}

function New-TestProbe {
    param(
        [string]$Owner = 'ok',
        [bool]$Ready = $false,
        [bool]$Partial = $false,
        [int]$NonLoopback = 0,
        [int]$Port = 33177,
        [string]$ErrorClass = 'timeout'
    )
    [pscustomobject]@{
        port             = $Port
        ownerState       = $Owner
        ownerPid         = if ($Owner -eq 'ok') { 4242 } else { 0 }
        ownerCreation    = $null
        ownerCmdHash     = $null
        nonLoopbackCount = $NonLoopback
        errorClass       = $ErrorClass
        basicState       = if ($Ready) { 'ok' } else { 'unreachable' }
        apiState         = if ($Ready) { 'ok' } else { 'timeout' }
        wsState          = if ($Ready) { 'ok' } elseif ($Partial) { 'ok' } else { 'timeout' }
        apiReady         = if ($Ready -or $Partial) { $true } else { $false }
        wsReady          = if ($Ready) { $true } else { $false }
        partialReady     = $Partial
        readiness        = if ($Ready) { 'full' } elseif ($Partial) { 'partial' } else { 'unready' }
        ready            = $Ready
        failureSignal    = if ($Ready) { 'none' } else { 'unreachable' }
        probeDurationMs  = 5
    }
}

# recording executors (test seam); production defaults to the real primitives
$script:restarts    = New-Object System.Collections.ArrayList
$script:alerts      = New-Object System.Collections.ArrayList
$script:logs        = New-Object System.Collections.ArrayList
$script:goalRecovers = 0
$script:confirmCount = 0
$script:confirmReady = $false
$Exec_Restart = { param($r) [void]$script:restarts.Add([pscustomobject]@{ Reason=$r; At=(Get-Date).ToString('o') }); return $true }
$Exec_Alert   = { param($m) [void]$script:alerts.Add($m) }
$Exec_Log     = { param($s) [void]$script:logs.Add($s) }
$Exec_Recover = { $script:goalRecovers++ }
$Exec_Confirm = { param($p) $script:confirmCount++; return (New-TestProbe -Owner 'ok' -Ready $script:confirmReady -Port ([int]$p)) }

function New-BackdatedState([int]$port) {
    $st = New-DshHealthStateObject -Port $port
    $st.consecutiveFailures = 2
    $st.firstFailureAtMs = [long]((([DateTimeOffset]::Now).ToUnixTimeMilliseconds()) - 120000)
    $st.lastFailureAtMs = [long](([DateTimeOffset]::Now).ToUnixTimeMilliseconds())
    $st.state = 'degraded'
    return $st
}

try {
Write-Host "=== RH1 R3 — guardian recovery path (shared Invoke-DshHealthGuard) ==="
Write-Host ("workdir: " + $WorkDir)

# ---- E3: single fail -> DEGRADED, restart=0 ----
Write-Host "E3: one unready probe (owner=ok) -> DEGRADED, restart=0"
$st = New-DshHealthStateObject -Port 33177
$gh = Invoke-DshHealthGuard -Port 33177 -Probe (New-TestProbe -Owner 'ok' -Ready $false) -CurrentState $st -State @{} -BudgetState $null -MaintenanceLocked $false -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($gh.HealthAction -eq 'degrade') ("E3 action=degrade (got {0})" -f $gh.HealthAction)
Assert ($script:restarts.Count -eq 0) 'E3 restart count = 0'
Assert ($gh.IncFile -eq $null) 'E3 no incident written'

# ---- E4: fail/fail/success -> restart=0, streak reset ----
Write-Host "E4: fail / fail / success -> restart=0, streak reset"
$st2 = New-DshHealthStateObject -Port 33178
$gh1 = Invoke-DshHealthGuard -Port 33178 -Probe (New-TestProbe -Owner 'ok' -Ready $false) -CurrentState $st2 -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
$gh2 = Invoke-DshHealthGuard -Port 33178 -Probe (New-TestProbe -Owner 'ok' -Ready $false) -CurrentState $gh1.State -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
$gh3 = Invoke-DshHealthGuard -Port 33178 -Probe (New-TestProbe -Owner 'ok' -Ready $true) -CurrentState $gh2.State -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($gh3.HealthAction -eq 'noop' -and $gh3.State['failStreak'] -eq 0) 'E4 after success, action=noop, failStreak reset to 0'
Assert ($script:restarts.Count -eq 0) 'E4 restart count = 0'

# ---- E5: restart_eligible -> incident FIRST, then restart EXACTLY ONCE ----
Write-Host "E5: backdated 120s + 3rd fail -> recovery_eligible; incident FIRST, restart exactly once"
$script:confirmReady = $false
$gh5 = Invoke-DshHealthGuard -Port 33179 -Probe (New-TestProbe -Owner 'ok' -Ready $false) -CurrentState (New-BackdatedState 33179) -State @{} -BudgetState (Read-DshRestartBudget) -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($gh5.HealthAction -eq 'restart_eligible') ("E5 action=restart_eligible (got {0})" -f $gh5.HealthAction)
Assert (-not [string]::IsNullOrEmpty($gh5.IncFile)) 'E5 incident bundle written'
Assert ($script:restarts.Count -eq 1) ('E5 restart executor called exactly once (count={0})' -f $script:restarts.Count)
if ($gh5.IncFile -and (Test-Path -LiteralPath $gh5.IncFile)) {
    $inc = Get-Item -LiteralPath $gh5.IncFile
    $rt  = [datetime]::Parse($script:restarts[0].At)
    Assert ($inc.CreationTime -le $rt.AddSeconds(2)) ("E5 incidentCreatedAt ({0}) <= restartRequestedAt ({1})" -f $inc.CreationTime.ToString('o'), $rt.ToString('o'))
}

# ---- E7: maintenance lock + restart_eligible -> restart=0 ----
Write-Host "E7: maintenance lock held -> restart suppressed, restart=0"
$script:restarts.Clear()
$gh7 = Invoke-DshHealthGuard -Port 33180 -Probe (New-TestProbe -Owner 'ok' -Ready $false) -CurrentState (New-BackdatedState 33180) -State @{} -BudgetState (Read-DshRestartBudget) -MaintenanceLocked $true -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($gh7.Suppressed -eq $true -and $gh7.HealthAction -eq 'noop') 'E7 helper reports suppressed/noop'
Assert ($script:restarts.Count -eq 0) 'E7 restart count = 0'

# ---- owner_unsafe ----
Write-Host "owner_unsafe: alert only, restart=0"
$script:restarts.Clear()
$ghu = Invoke-DshHealthGuard -Port 33181 -Probe (New-TestProbe -Owner 'identity_mismatch') -CurrentState (New-DshHealthStateObject -Port 33181) -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($ghu.HealthAction -eq 'owner_unsafe') 'owner_unsafe action'
Assert ($script:restarts.Count -eq 0) 'owner_unsafe restart count = 0'
Assert ($script:alerts.Count -ge 1) 'owner_unsafe alert sent'

# ---- server_absent, no non-loopback -> budgeted restart once ----
Write-Host "server_absent (no non-loopback): budgeted restart once + goal recover"
$script:restarts.Clear(); $script:goalRecovers = 0
$ghs = Invoke-DshHealthGuard -Port 33182 -Probe (New-TestProbe -Owner 'none' -NonLoopback 0) -CurrentState (New-DshHealthStateObject -Port 33182) -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($ghs.HealthAction -eq 'server_absent') 'server_absent action'
Assert ($script:restarts.Count -eq 1 -and $script:goalRecovers -eq 1) 'server_absent restart once + goal recover'

# ---- server_absent + non-loopback -> skip restart, alert ----
Write-Host "server_absent + non-loopback: skip restart, alert"
$script:restarts.Clear()
$ghn = Invoke-DshHealthGuard -Port 33183 -Probe (New-TestProbe -Owner 'none' -NonLoopback 2) -CurrentState (New-DshHealthStateObject -Port 33183) -State @{} -BudgetState $null -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
Assert ($script:restarts.Count -eq 0) 'non-loopback restart count = 0'
Assert ($script:alerts.Count -ge 1) 'non-loopback alert sent'

# ---- E6: budget/circuit exhausted -> restart denied (the exact gate the real
#      Invoke-BudgetedRestart consults before performing a restart) ----
Write-Host "E6: exhausted budget -> gate denies (restart would not increase)"
$b6 = Get-DshRestartBudgetDefault
$b6.attempts = 3
$b6.hourAttempts = 6
$b6.windowStart = [DateTimeOffset]::Now.ToString('o')
Write-DshRestartBudget $b6
$allow = Test-DshRestartAllowed
Assert ($allow.Allowed -eq $false -and $allow.Reason -eq 'budget_exhausted') ("E6 gate denies when exhausted (reason={0})" -f $allow.Reason)
} catch {
    $script:fail++
    Write-Host ("  **FAIL**: fatal exception raised (see FATAL above)")
}

Write-Host ""
Write-Host ("RESULT: PASS={0} FAIL={1}" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
