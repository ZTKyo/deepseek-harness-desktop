# dsh-restart-budget.ps1 - persistent, bounded restart budget.
# Callers must hold dsh-process-identity.ps1's restart mutex while mutating it.
#
# Phase 02 Reviewer Round 1 (BLOCKING-4): stable-window state machine.
#   candidate_ready -> stable window -> readiness + COMMIT_READY -> committed success
# client_ready alone is a CANDIDATE, it does NOT reset the budget. The budget is
# reset (committed) only after a stable window passes AND a second readiness +
# COMMIT_READY check passes. A crash / health failure inside the stable window
# does NOT clear the budget (the attempts stay).

# stable window in seconds before a restart is considered stable (default 30s).
# Rationale: client_ready means the server answers; COMMIT_READY additionally
# requires process identity + events.mux/host + renderer + stable window + light
# probe. 30s is a conservative default that avoids counting transient flapping
# as success while not meaningfully extending user-unavailable time (the server
# is already usable at client_ready; the budget commit is bookkeeping only).
$script:DshRestartStableWindowSec = if ($env:DSH_RESTART_STABLE_WINDOW_SEC) { [int]$env:DSH_RESTART_STABLE_WINDOW_SEC } else { 30 }

$script:DshRestartBudgetPath = if ($env:DSH_RESTART_BUDGET_PATH) {
    $env:DSH_RESTART_BUDGET_PATH
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state\restart-budget.json'
}

function Get-DshRestartBudgetDefault {
    [pscustomobject]@{
        windowStart = $null
        attempts = 0
        hourWindowStart = $null
        hourAttempts = 0
        pauseUntil = $null
        lastReason = $null
        lastAttempt = $null
        lastSuccess = $null
        candidateAt = $null        # Phase 02: candidate_ready timestamp
        candidateReady = $false    # Phase 02: server reached client_ready
        stableCommitAt = $null     # Phase 02: stable-window commit timestamp
    }
}

function Read-DshRestartBudget {
    if (-not (Test-Path -LiteralPath $script:DshRestartBudgetPath)) { return (Get-DshRestartBudgetDefault) }
    try {
        $value = Get-Content -LiteralPath $script:DshRestartBudgetPath -Raw | ConvertFrom-Json
        if ($null -eq $value.attempts) { return (Get-DshRestartBudgetDefault) }
        # Merge defaults so legacy files (written before Phase 02 added
        # candidateAt/candidateReady/stableCommitAt) always carry the new fields.
        # ConvertFrom-Json objects are fixed-property; rebuild a fresh object.
        $def = Get-DshRestartBudgetDefault
        $merged = [pscustomobject]@{
            windowStart      = if ($null -ne $value.windowStart) { $value.windowStart } else { $def.windowStart }
            attempts         = $value.attempts
            hourWindowStart  = if ($null -ne $value.hourWindowStart) { $value.hourWindowStart } else { $def.hourWindowStart }
            hourAttempts     = if ($null -ne $value.hourAttempts) { $value.hourAttempts } else { $def.hourAttempts }
            pauseUntil       = if ($null -ne $value.pauseUntil) { $value.pauseUntil } else { $def.pauseUntil }
            lastReason       = if ($null -ne $value.lastReason) { $value.lastReason } else { $def.lastReason }
            lastAttempt      = if ($null -ne $value.lastAttempt) { $value.lastAttempt } else { $def.lastAttempt }
            lastSuccess      = if ($null -ne $value.lastSuccess) { $value.lastSuccess } else { $def.lastSuccess }
            candidateAt      = if ($null -ne $value.candidateAt) { $value.candidateAt } else { $def.candidateAt }
            candidateReady   = if ($null -ne $value.candidateReady) { $value.candidateReady } else { $def.candidateReady }
            stableCommitAt   = if ($null -ne $value.stableCommitAt) { $value.stableCommitAt } else { $def.stableCommitAt }
        }
        return $merged
    } catch { return (Get-DshRestartBudgetDefault) }
}

function Write-DshRestartBudget($Value) {
    $dir = Split-Path -Parent $script:DshRestartBudgetPath
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = "$($script:DshRestartBudgetPath).tmp-$PID"
    $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
    try { Move-Item -LiteralPath $tmp -Destination $script:DshRestartBudgetPath -Force -ErrorAction Stop }
    catch {
        Remove-Item -LiteralPath $script:DshRestartBudgetPath -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $tmp -Destination $script:DshRestartBudgetPath -Force
    }
}

function Convert-DshDate([object]$Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return [DateTimeOffset]::Parse([string]$Value) } catch { return $null }
}

function Test-DshRestartAllowed {
    $now = [DateTimeOffset]::Now
    $s = Read-DshRestartBudget
    $window = Convert-DshDate $s.windowStart
    $hour = Convert-DshDate $s.hourWindowStart
    $pause = Convert-DshDate $s.pauseUntil
    if ($window -and (($now - $window).TotalMinutes -ge 10)) { $s.windowStart = $null; $s.attempts = 0 }
    if ($hour -and (($now - $hour).TotalHours -ge 1)) { $s.hourWindowStart = $null; $s.hourAttempts = 0 }
    $pause = Convert-DshDate $s.pauseUntil
    if ($pause -and $pause -gt $now) {
        Write-DshRestartBudget $s
        return [pscustomobject]@{ Allowed = $false; Reason = 'circuit_open'; PauseUntil = $pause; Budget = $s }
    }
    if ([int]$s.attempts -ge 3 -or [int]$s.hourAttempts -ge 6) {
        $s.pauseUntil = $now.AddMinutes(15).ToString('o')
        Write-DshRestartBudget $s
        return [pscustomobject]@{ Allowed = $false; Reason = 'budget_exhausted'; PauseUntil = [DateTimeOffset]::Parse($s.pauseUntil); Budget = $s }
    }
    Write-DshRestartBudget $s
    return [pscustomobject]@{ Allowed = $true; Reason = 'allowed'; PauseUntil = $null; Budget = $s }
}

function Register-DshRestartAttempt([string]$Reason) {
    $now = [DateTimeOffset]::Now
    $s = Read-DshRestartBudget
    $window = Convert-DshDate $s.windowStart
    $hour = Convert-DshDate $s.hourWindowStart
    if (-not $window -or (($now - $window).TotalMinutes -ge 10)) { $s.windowStart = $now.ToString('o'); $s.attempts = 0 }
    if (-not $hour -or (($now - $hour).TotalHours -ge 1)) { $s.hourWindowStart = $now.ToString('o'); $s.hourAttempts = 0 }
    $s.attempts = [int]$s.attempts + 1
    $s.hourAttempts = [int]$s.hourAttempts + 1
    $s.lastReason = [string]$Reason
    $s.lastAttempt = $now.ToString('o')
    # a new attempt invalidates any previous candidate state
    $s.candidateAt = $null
    $s.candidateReady = $false
    $s.stableCommitAt = $null
    Write-DshRestartBudget $s
    return $s
}

# Phase 02: mark that the new server reached client_ready (candidate stage).
# Does NOT reset the budget; attempts stay until stable-window commit.
function Register-DshRestartCandidate {
    $s = Read-DshRestartBudget
    $s.candidateAt = [DateTimeOffset]::Now.ToString('o')
    $s.candidateReady = $true
    Write-DshRestartBudget $s
    return $s
}

# Phase 02: check whether the stable window has elapsed since candidate_ready.
function Test-DshRestartStableWindow {
    $s = Read-DshRestartBudget
    if (-not $s.candidateReady) { return $false }
    $cand = Convert-DshDate $s.candidateAt
    if (-not $cand) { return $false }
    return ((([DateTimeOffset]::Now) - $cand).TotalSeconds -ge $script:DshRestartStableWindowSec)
}

# Phase 02: commit success only after stable window + re-verification.
# Caller is responsible for the second readiness + COMMIT_READY check before
# calling this; this function records the commit timestamp and resets the budget.
function Confirm-DshRestartStable {
    $s = Read-DshRestartBudget
    $s.windowStart = $null
    $s.attempts = 0
    $s.hourWindowStart = $null
    $s.hourAttempts = 0
    $s.pauseUntil = $null
    $s.candidateAt = $null
    $s.candidateReady = $false
    $s.stableCommitAt = [DateTimeOffset]::Now.ToString('o')
    $s.lastSuccess = [DateTimeOffset]::Now.ToString('o')
    Write-DshRestartBudget $s
    return $s
}

# Phase 02 R2: Register-DshRestartSuccess is a STRICT commit — it only resets
# the budget when the stable-window contract is satisfied (candidate_ready was
# registered AND the stable window has elapsed). Legacy callers that never
# registered a candidate are treated as NOT commit-worthy: we record a warning
# marker but do NOT reset attempts, so a success shortcut cannot bypass the
# stable-window verification. Use Confirm-DshRestartStable for the explicit
# verified path.
function Register-DshRestartSuccess {
    $s = Read-DshRestartBudget
    if ($s.candidateReady -ne $true) {
        # No candidate registered -> cannot prove stability. Do NOT reset.
        $s.lastReason = 'success-without-stable-candidate: budget NOT reset'
        Write-DshRestartBudget $s
        return $s
    }
    $cand = Convert-DshDate $s.candidateAt
    $stableOk = $false
    if ($cand) { $stableOk = ((([DateTimeOffset]::Now) - $cand).TotalSeconds -ge $script:DshRestartStableWindowSec) }
    if (-not $stableOk) {
        # Candidate exists but stable window not elapsed -> NOT commit-worthy.
        $s.lastReason = 'success-before-stable-window: budget NOT reset'
        Write-DshRestartBudget $s
        return $s
    }
    return (Confirm-DshRestartStable)
}
