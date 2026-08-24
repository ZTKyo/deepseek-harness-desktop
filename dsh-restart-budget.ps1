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
        candidateIdentity = $null  # Phase 02 R4: {attemptId,pid,generation} of the candidate
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
            candidateIdentity = if ($null -ne $value.candidateIdentity) { $value.candidateIdentity } else { $null }
        }
        return $merged
    } catch {
        # Phase 02 R4 (Step 7): corrupt/torn state -> QUARANTINE (fail-closed).
        # Do NOT silently return a fresh default (that would turn corruption into
        # "budget recovered available"). Quarantine the file and surface a
        # circuit_open state so callers fail closed until an operator clears it.
        try {
            $q = "$($script:DshRestartBudgetPath).quarantined-$([guid]::NewGuid().ToString('N'))"
            Move-Item -LiteralPath $script:DshRestartBudgetPath -Destination $q -Force -ErrorAction SilentlyContinue
        } catch { }
        $def = Get-DshRestartBudgetDefault
        $def.lastReason = 'BUDGET_CORRUPT_QUARANTINED'
        $def.pauseUntil = ([DateTimeOffset]::Now).AddMinutes(30).ToString('o')
        return $def
    }
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
# Phase 02 R4 (Step 7): candidate is bound to {attemptId, pid, generation} so a
# later Confirm must prove SAME candidate before it may reset the budget.
function Register-DshRestartCandidate {
    param([string]$AttemptId = $null, [int]$ProcessId = 0, [string]$Generation = $null)
    $s = Read-DshRestartBudget
    $s.candidateAt = [DateTimeOffset]::Now.ToString('o')
    $s.candidateReady = $true
    $s.candidateIdentity = @{ attemptId = $AttemptId; pid = $ProcessId; generation = $Generation } | ConvertTo-Json -Compress
    Write-DshRestartBudget $s
    return $s
}

# Phase 02: check whether the stable window has elapsed since candidate_ready.
# Phase 02 R4 (Step 7): reads the window from env AT CALL TIME (tests mutate
# DSH_RESTART_STABLE_WINDOW_SEC between cases; a load-time cache would freeze it).
function Get-DshStableWindowSec {
    if ($env:DSH_RESTART_STABLE_WINDOW_SEC) { return [int]$env:DSH_RESTART_STABLE_WINDOW_SEC }
    return $script:DshRestartStableWindowSec
}
function Test-DshRestartStableWindow {
    $s = Read-DshRestartBudget
    if (-not $s.candidateReady) { return $false }
    $cand = Convert-DshDate $s.candidateAt
    if (-not $cand) { return $false }
    return ((([DateTimeOffset]::Now) - $cand).TotalSeconds -ge (Get-DshStableWindowSec))
}

# Phase 02 R4 (Step 7): a commit may ONLY reset the budget when it can prove it
# is the SAME candidate (attemptId + pid) AND the stable window elapsed.
# Stale/foreign confirm -> fail-closed (no reset). Returns @{Committed, Reason}.
function Test-DshCandidateIdentityMatch {
    param([string]$AttemptId = $null, [int]$ProcessId = 0, [string]$Generation = $null)
    $s = Read-DshRestartBudget
    if (-not $s.candidateReady) { return $false }
    if ($s.candidateIdentity) {
        try {
            $ident = $s.candidateIdentity | ConvertFrom-Json
            # candidate bound to identity: caller MUST prove the same identity
            # (fail-closed: empty caller identity cannot commit a bound candidate)
            if ($ident.attemptId -and (-not $AttemptId -or ($ident.attemptId -ne $AttemptId))) { return $false }
            if ($ident.pid -and $ident.pid -gt 0 -and (-not $ProcessId -or $ProcessId -le 0 -or ([int]$ident.pid -ne $ProcessId))) { return $false }
            # Phase 02 R5 (R4-B2 + Addendum): generation is part of the identity.
            # A candidate bound to an identity MUST carry a non-empty generation —
            # an empty/blank generation is NOT a valid identity and can never be
            # committed (registration-time authority; the candidate should have
            # failed-closed at registration when generation was missing).
            $identGen = if ($ident.PSObject.Properties.Name -contains 'generation') { [string]$ident.generation } else { '' }
            if (-not $identGen) { return $false }
            if ($Generation -and ($identGen -ne $Generation)) { return $false }
            if (-not $Generation) { return $false }
        } catch { return $false }
    }
    return (Test-DshRestartStableWindow)
}

# Phase 02: commit success only after stable window + re-verification.
# Caller is responsible for the second readiness + COMMIT_READY check before
# calling this; this function records the commit timestamp and resets the budget.
# Phase 02 R4 (Step 7): verifies SAME candidate identity before reset.
function Confirm-DshRestartStable {
    param([string]$AttemptId = $null, [int]$ProcessId = 0, [string]$Generation = $null)
    if (-not (Test-DshCandidateIdentityMatch -AttemptId $AttemptId -ProcessId $ProcessId -Generation $Generation)) {
        return [pscustomobject]@{ Committed = $false; Reason = 'stale_or_foreign_candidate' }
    }
    $s = Read-DshRestartBudget
    $s.windowStart = $null
    $s.attempts = 0
    # Phase 02 R5 (R4-B2): a normal commit clears the SHORT 10-min window only.
    # The HOURLY crash history (hourWindowStart/hourAttempts) is PRESERVED so a
    # stable-then-crash storm can still open the circuit — one success must not
    # erase the past hour of failures.
    $s.pauseUntil = $null
    $s.candidateAt = $null
    $s.candidateReady = $false
    $s.candidateIdentity = $null
    $s.stableCommitAt = [DateTimeOffset]::Now.ToString('o')
    $s.lastSuccess = [DateTimeOffset]::Now.ToString('o')
    Write-DshRestartBudget $s
    return [pscustomobject]@{ Committed = $true; Reason = 'committed'; Budget = $s }
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
    if ($cand) { $stableOk = ((([DateTimeOffset]::Now) - $cand).TotalSeconds -ge (Get-DshStableWindowSec)) }
    if (-not $stableOk) {
        # Candidate exists but stable window not elapsed -> NOT commit-worthy.
        $s.lastReason = 'success-before-stable-window: budget NOT reset'
        Write-DshRestartBudget $s
        return $s
    }
    return (Confirm-DshRestartStable)
}
