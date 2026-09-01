# dsh-health.ps1 - single source of truth for DSH server liveness/readiness.
#
# RH1 Reliability Hotfix (Part B/C/E).
#
# Purpose: separate LIVENESS from READINESS so the guardian NEVER restarts a
# just-slow / briefly-unready server. The guardian (and the restart/start
# scripts via the shared helpers here) consult this module for one health
# decision instead of each implementing its own single-bit "up/down" probe.
#
# States (persisted so they survive guardian restarts):
#   healthy                 - last probe was fully ready (B4: full success resets)
#   degraded                - a readiness miss, below candidate thresholds
#   hard_unhealthy_candidate- >=N consecutive unready AND >= candidate window
#   recovery_eligible       - >=N consecutive unready AND >= recovery window,
#                             only then a restart may be attempted (still gated
#                             by maintenance lock + restart budget + circuit)
#
# Actions returned by Invoke-DshHealthTriage:
#   noop            - ready (reset)
#   degrade         - below thresholds; keep waiting (no restart)
#   hard_candidate  - candidate; caller SHOULD run one independent re-probe
#   restart_eligible- caller may proceed to a budgeted restart (with incident
#                     bundle) + independent re-probe first
#   owner_unsafe    - owner identity is unsafe; alert only (no kill/start)
#   server_absent   - owner=none (liveness loss); caller runs original recovery
#
# Time fields are stored as Unix epoch milliseconds (robust under Windows
# PowerShell 5.1, where [datetime] cannot reliably parse ISO strings carrying a
# UTC offset). Incident bundle (Part C): before killing/restarting an
# owner='ok' (alive but unready) server, New-DshIncidentBundle writes a bounded,
# redacted json file to %LOCALAPPDATA%\DSHHarness\incidents\incident-<ts>.json.
# It never blocks recovery: a write failure is a telemetry failure only.

$healthIdentity = Join-Path $PSScriptRoot 'dsh-process-identity.ps1'
if (-not (Get-Command Get-DshLoopbackOwner -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $healthIdentity)) {
    . $healthIdentity
}
$healthReadiness = Join-Path $PSScriptRoot 'dsh-readiness.ps1'
if (-not (Get-Command Test-DshReadiness -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $healthReadiness)) {
    . $healthReadiness
}

# ---- thresholds (env-overridable; defaults tuned for 30s/60s windows) ----
$script:DshHealthFailThreshold = if ($env:DSH_HEALTH_FAIL_THRESHOLD) { [int]$env:DSH_HEALTH_FAIL_THRESHOLD } else { 3 }
$script:DshHealthCandidateWindowSec = if ($env:DSH_HEALTH_CANDIDATE_WINDOW_SEC) { [int]$env:DSH_HEALTH_CANDIDATE_WINDOW_SEC } else { 30 }
$script:DshHealthRecoveryWindowSec = if ($env:DSH_HEALTH_RECOVERY_WINDOW_SEC) { [int]$env:DSH_HEALTH_RECOVERY_WINDOW_SEC } else { 60 }

function Get-DshHealthStatePath([int]$Port = 3080) {
    if ($env:DSH_HEALTH_STATE_PATH) { return $env:DSH_HEALTH_STATE_PATH }
    return (Join-Path $env:LOCALAPPDATA ("DSHHarness\state\dsh-health-{0}.json" -f $Port))
}
function Get-DshIncidentDir {
    return (Join-Path $env:LOCALAPPDATA 'DSHHarness\incidents')
}

function ConvertTo-DshEpochMs([datetime]$Dt) {
    if ($null -eq $Dt) { return $null }
    return [long]([DateTimeOffset]$Dt).ToUnixTimeMilliseconds()
}

# ---- LEVEL 2: lightweight loopback liveness (short timeout, never treats a
# non-2xx response as death - a 503 means the server is alive but unready). ----
function Test-DshBasicHttp([int]$Port = 3080, [int]$TimeoutSec = 1) {
    $base = "http://127.0.0.1:$Port/"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # LIVENESS, not readiness: a server that ANSWERS (any HTTP status, incl. 4xx/5xx)
    # is ALIVE. Only a no-response transport failure (refused / timeout / other) is a
    # liveness loss. On PS7+ -SkipHttpErrorCheck returns 4xx/5xx without throwing; on
    # PS5.1 a 4xx/5xx WebException must be classified 'matched' with its real status so
    # a live-but-unready server is never mistaken for dead.
    $skipHttp = $PSVersionTable.PSVersion.Major -ge 7
    try {
        if ($skipHttp) {
            $r = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop -SkipHttpErrorCheck
        } else {
            $r = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        }
        $sw.Stop()
        return [pscustomobject]@{ State = 'matched'; Port = $Port; HttpStatus = [int]$r.StatusCode; Ms = [int]$sw.ElapsedMilliseconds }
    } catch {
        $sw.Stop()
        $msg = $_.Exception.Message
        # PS5.1 path: an HTTP error response still means the server answered -> alive.
        $respStatus = $null
        try { if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $respStatus = [int]$_.Exception.Response.StatusCode } } catch { }
        if (-not $respStatus) {
            try { if ($_.Exception.StatusCode) { $respStatus = [int]$_.Exception.StatusCode } } catch { }
        }
        if ($respStatus -and $msg -notmatch 'unable to connect|connection refused|actively refused|no connection could be made|target machine') {
            return [pscustomobject]@{ State = 'matched'; Port = $Port; HttpStatus = $respStatus; Ms = [int]$sw.ElapsedMilliseconds }
        }
        $isRefused = ($msg -match 'unable to connect|connection refused|actively refused|no connection could be made|target machine')
        if ($isRefused) {
            return [pscustomobject]@{ State = 'refused'; Port = $Port; HttpStatus = $null; Ms = [int]$sw.ElapsedMilliseconds }
        }
        if ($msg -match 'timed out|operation has timed out|timeout') {
            return [pscustomobject]@{ State = 'timeout'; Port = $Port; HttpStatus = $null; Ms = [int]$sw.ElapsedMilliseconds }
        }
        return [pscustomobject]@{ State = 'error'; Port = $Port; HttpStatus = $null; Ms = [int]$sw.ElapsedMilliseconds; Error = $msg }
    }
}

# ---- build a full probe snapshot (LEVEL1 owner + LEVEL2 http + LEVEL3 rpc) ----
function Get-DshHealthProbe([int]$Port = 3080, [switch]$IncludeWebSockets) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $owner = Get-DshLoopbackOwner -Port $Port
    $basic = Test-DshBasicHttp -Port $Port
    $api = Test-DshApiReady -Port $Port
    $ws = $null
    if ($IncludeWebSockets) { $ws = Test-DshReadiness -Port $Port -RequireWebSockets }

    $ready = $false
    $apiState = ''
    $wsState = ''
    if ($api) {
        if ($api.State -eq 'api_ready') { $ready = $true; $apiState = 'api_ready' }
        elseif ($api.State -eq 'client_ready') { $ready = $true; $apiState = 'client_ready' }
        else { $apiState = [string]$api.State }
    }
    if ($ws) { $wsState = [string]$ws.State; if ($ws.State -eq 'client_ready') { $ready = $true } }

    $errorClass = ''
    $failureSignal = ''
    if (-not $ready) {
        if ($owner.State -in @('ambiguous', 'identity_mismatch', 'error')) {
            $errorClass = 'owner_unsafe'; $failureSignal = 'owner'
        } elseif ($owner.State -eq 'none') {
            $errorClass = 'owner_absent'; $failureSignal = 'owner'
        } elseif ($basic.State -eq 'refused') {
            $errorClass = 'connection_refused'; $failureSignal = 'basic'
        } elseif ($basic.State -eq 'timeout') {
            $errorClass = 'timeout'; $failureSignal = 'basic'
        } elseif ($apiState -eq 'api_unready' -or $apiState -like 'rpc_*') {
            $errorClass = 'api_unready'; $failureSignal = 'api'
        } elseif ($wsState -ne '' -and $wsState -notlike 'client_ready') {
            $errorClass = 'ws_unready'; $failureSignal = 'ws'
        } else {
            $errorClass = 'unready'; $failureSignal = 'readiness'
        }
    }

    $sw.Stop()
    return [pscustomobject]@{
        ts               = (Get-Date).ToString('o')
        port             = $Port
        ownerState       = [string]$owner.State
        ownerPid         = $owner.Pid
        ownerCreation    = if ($owner.Snapshot) { $owner.Snapshot.CreationDate } else { $null }
        ownerCmdHash     = if ($owner.Snapshot) { $owner.Snapshot.CommandLineHash } else { $null }
        nonLoopbackCount = [int]$owner.NonLoopbackCount
        basicState       = [string]$basic.State
        basicHttpStatus  = $basic.HttpStatus
        apiState         = $apiState
        wsState          = $wsState
        ready            = [bool]$ready
        failureSignal    = $failureSignal
        errorClass       = $errorClass
        probeDurationMs  = [int]$sw.ElapsedMilliseconds
    }
}

# ---- default persistable state object ----
function New-DshHealthStateObject([int]$Port = 3080) {
    return [pscustomobject]@{
        version                = 1
        port                   = $Port
        state                  = 'healthy'
        consecutiveFailures    = 0
        maxFailures            = 0
        firstFailureAtMs       = $null
        lastFailureAtMs        = $null
        lastHealthyAtMs        = $null
        lastProbeSummary       = $null
        lastTransitionAtMs     = $null
        lastTransitionFrom     = $null
        lastTransitionReason   = $null
    }
}

function Get-DshHealthState([int]$Port = 3080) {
    $path = Get-DshHealthStatePath -Port $Port
    if (-not (Test-Path -LiteralPath $path)) { return (New-DshHealthStateObject -Port $Port) }
    try {
        $v = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($null -eq $v.state) { return (New-DshHealthStateObject -Port $Port) }
        return $v
    } catch {
        return (New-DshHealthStateObject -Port $Port)
    }
}

function Set-DshHealthState([object]$State, [int]$Port = 3080) {
    $path = Get-DshHealthStatePath -Port $Port
    try {
        $dir = Split-Path $path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        ($State | ConvertTo-Json -Depth 8 -Compress) | Set-Content -LiteralPath $path -Encoding UTF8
    } catch {
        Write-Output ("DSH-HEALTH: state persist failed: {0}" -f $_.Exception.Message)
    }
}

# ---- PURE triage. Deterministic given (Snapshot, CurrentState, Now). No I/O. ----
# Returns @{ Action; State; Reason; NextState; Diagnostic }.
function Invoke-DshHealthTriage(
    [object]$Snapshot,
    [object]$CurrentState,
    [datetime]$Now = $null,
    [int]$FailThreshold = $script:DshHealthFailThreshold,
    [int]$CandidateWindowSec = $script:DshHealthCandidateWindowSec,
    [int]$RecoveryWindowSec = $script:DshHealthRecoveryWindowSec
) {
    if (-not $Now) { $Now = Get-Date }
    $nowMs = ConvertTo-DshEpochMs $Now
    $base = if ($CurrentState -and $CurrentState.state) { $CurrentState } else { (New-DshHealthStateObject -Port ([int]($Snapshot.port))) }
    $out = [pscustomobject]@{
        Action      = 'noop'
        State       = [string]$base.state
        Reason      = ''
        NextState   = $base
        Diagnostic  = $null
    }

    $ready      = [bool]$Snapshot.ready
    $ownerState = [string]$Snapshot.ownerState
    $failures   = 0
    $firstMs    = $null
    if ($CurrentState -and $null -ne $CurrentState.consecutiveFailures) { $failures = [int]$CurrentState.consecutiveFailures }
    if ($CurrentState -and $null -ne $CurrentState.firstFailureAtMs) {
        try { $firstMs = [long]$CurrentState.firstFailureAtMs } catch { $firstMs = $null }
    }

    $probeSummary = [pscustomobject]@{
        ownerState      = $ownerState
        basicState      = [string]$Snapshot.basicState
        apiState        = [string]$Snapshot.apiState
        wsState         = [string]$Snapshot.wsState
        errorClass      = [string]$Snapshot.errorClass
        failureSignal   = [string]$Snapshot.failureSignal
        probeDurationMs = [int]$Snapshot.probeDurationMs
    }

    # helper to build a follow-on state derived from the current one
    function _carry([object]$cur, [int]$newFailures, [long]$nowMs2) {
        $n = New-DshHealthStateObject -Port ([int]($Snapshot.port))
        $n.consecutiveFailures = $newFailures
        $n.maxFailures = [math]::Max($newFailures, $failures)
        $n.firstFailureAtMs = if ($firstMs) { $firstMs } else { $nowMs2 }
        $n.lastFailureAtMs = $nowMs2
        $n.lastProbeSummary = $probeSummary
        $n.lastTransitionAtMs = $nowMs2
        $n.lastTransitionFrom = [string]$base.state
        return $n
    }

    # B4: any full success -> reset to healthy
    if ($ready) {
        $next = New-DshHealthStateObject -Port ([int]($Snapshot.port))
        $next.state = 'healthy'
        $next.lastHealthyAtMs = $nowMs
        $next.lastTransitionAtMs = $nowMs
        $next.lastTransitionFrom = [string]$base.state
        $next.lastTransitionReason = 'full success; reset (B4)'
        $next.lastProbeSummary = $probeSummary
        $out.Action = 'noop'
        $out.State = 'healthy'
        $out.Reason = 'ready; reset'
        $out.NextState = $next
        return $out
    }

    # unsafe owner identity -> alert only (preserve existing guardian behavior)
    if ($ownerState -notin @('ok', 'none')) {
        $next = _carry $base ($failures + 1) $nowMs
        $next.state = 'degraded'
        $next.lastTransitionReason = "owner unsafe: $ownerState"
        $out.Action = 'owner_unsafe'
        $out.State = 'degraded'
        $out.Reason = "owner unsafe: $ownerState"
        $out.NextState = $next
        return $out
    }

    # liveness loss (owner=none) -> restore path handled by caller
    if ($ownerState -eq 'none') {
        $next = _carry $base ($failures + 1) $nowMs
        $next.state = 'degraded'
        $next.lastTransitionReason = 'server absent (owner=none)'
        $out.Action = 'server_absent'
        $out.State = 'degraded'
        $out.Reason = 'server absent (owner=none)'
        $out.NextState = $next
        return $out
    }

    # owner=ok but not ready -> progressive health candidate
    $newFailures = $failures + 1
    $windowSec = 0.0
    if ($firstMs -and $nowMs -and $firstMs -le $nowMs) {
        $windowSec = [math]::Max(0.0, [math]::Round((($nowMs - $firstMs) / 1000.0), 1))
    }
    $next = _carry $base $newFailures $nowMs
    $next.port = [int]($Snapshot.port)

    if ($newFailures -ge $FailThreshold -and $windowSec -ge $RecoveryWindowSec) {
        $next.state = 'recovery_eligible'
        $next.lastTransitionReason = "consistent unready: failures=$newFailures window=${windowSec}s"
        $out.Action = 'restart_eligible'
        $out.State = 'recovery_eligible'
        $out.Reason = "consistent unready: failures=$newFailures window=${windowSec}s"
    } elseif ($newFailures -ge $FailThreshold -and $windowSec -ge $CandidateWindowSec) {
        $next.state = 'hard_unhealthy_candidate'
        $next.lastTransitionReason = "consecutive unready: failures=$newFailures window=${windowSec}s"
        $out.Action = 'hard_candidate'
        $out.State = 'hard_unhealthy_candidate'
        $out.Reason = "consecutive unready: failures=$newFailures window=${windowSec}s"
    } else {
        $next.state = 'degraded'
        $next.lastTransitionReason = "unready below thresholds: failures=$newFailures window=${windowSec}s"
        $out.Action = 'degrade'
        $out.State = 'degraded'
        $out.Reason = "unready below thresholds: failures=$newFailures window=${windowSec}s"
    }
    $out.NextState = $next
    $out.Diagnostic = [pscustomobject]@{ windowSec = $windowSec; failures = $newFailures }
    return $out
}

# ---- Part C: bounded, redacted incident bundle written before a controlled
# restart of an owner='ok' (alive but unready) server. Best-effort; never
# blocks recovery. Field names are stable and shared with dsh-health state. ----
function New-DshIncidentBundle(
    [int]$Port = 3080,
    [object]$Snapshot = $null,
    [object]$HealthState = $null,
    [object]$BudgetState = $null,
    [string]$Reason = 'server unhealthy'
) {
    if (-not $Snapshot) { $Snapshot = Get-DshHealthProbe -Port $Port }
    if (-not $HealthState) { $HealthState = Get-DshHealthState -Port $Port }

    $incident = [pscustomobject]@{
        ts               = (Get-Date).ToString('o')
        port             = [int]$Port
        reason           = [string]$Reason
        ownerState       = [string]$Snapshot.ownerState
        ownerPid         = $Snapshot.ownerPid
        ownerCreation    = $Snapshot.ownerCreation
        ownerCmdHash     = $Snapshot.ownerCmdHash
        nonLoopbackCount = [int]$Snapshot.nonLoopbackCount
        probe            = [pscustomobject]@{
            basicState      = [string]$Snapshot.basicState
            apiState        = [string]$Snapshot.apiState
            wsState         = [string]$Snapshot.wsState
            failureSignal   = [string]$Snapshot.failureSignal
            errorClass      = [string]$Snapshot.errorClass
            probeDurationMs = [int]$Snapshot.probeDurationMs
        }
        healthState = [pscustomobject]@{
            state               = [string]$HealthState.state
            consecutiveFailures = if ($null -ne $HealthState.consecutiveFailures) { [int]$HealthState.consecutiveFailures } else { 0 }
            firstFailureAtMs    = $HealthState.firstFailureAtMs
            lastFailureAtMs     = $HealthState.lastFailureAtMs
            errorClass          = [string]$Snapshot.errorClass
            lastProbeSummary    = $HealthState.lastProbeSummary
        }
    }

    # best-effort: running-server runtime ledger for identity/pid/gen; never throws.
    $runtimePath = Join-Path $env:LOCALAPPDATA ("DSHHarness\logs\dsh-runtime-{0}.json" -f $Port)
    try {
        if (Test-Path -LiteralPath $runtimePath) {
            $rt = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
            $incident | Add-Member -NotePropertyName runtime -NotePropertyValue ([pscustomobject]@{
                state       = [string]$rt.state
                port        = [string]$rt.port
                childPid    = $rt.childPid
                launcherPid = $rt.launcherPid
                entryHash   = $rt.entryHash
            }) -Force
        }
    } catch {}

    try {
        if ($BudgetState) {
            $incident | Add-Member -NotePropertyName budget -NotePropertyValue ([pscustomobject]@{
                attempts     = if ($null -ne $BudgetState.attempts) { [int]$BudgetState.attempts } else { 0 }
                hourAttempts = if ($null -ne $BudgetState.hourAttempts) { [int]$BudgetState.hourAttempts } else { 0 }
                pauseUntil   = $BudgetState.pauseUntil
                lastReason   = $BudgetState.lastReason
            }) -Force
        }
    } catch {}

    # redaction guard: never allow a sensitive-looking value into the bundle
    $raw = ($incident | ConvertTo-Json -Depth 10 -Compress)
    $raw = $raw -replace '(?i)(token|secret|password|api[_-]?key|authorization|bearer|credential)["\s]*:[^,}]*', '$1":"***"'

    $dir = Get-DshIncidentDir
    try {
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $file = Join-Path $dir ("incident-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        $raw | Set-Content -LiteralPath $file -Encoding UTF8
        return $file
    } catch {
        return $null
    }
}

function Reset-DshHealthState([int]$Port = 3080) {
    Set-DshHealthState (New-DshHealthStateObject -Port $Port) -Port $Port
}
