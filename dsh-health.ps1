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

    $apiState = ''
    $wsState = ''
    $apiComponentReady = $false
    if ($api) {
        if ($api.State -eq 'api_ready') { $apiState = 'api_ready'; $apiComponentReady = $true }
        elseif ($api.State -eq 'client_ready') { $apiState = 'client_ready'; $apiComponentReady = $true }
        else { $apiState = [string]$api.State }
    }
    $wsRequired = [bool]$IncludeWebSockets
    $wsComponentReady = $false
    if ($ws) { $wsState = [string]$ws.State; if ($ws.State -eq 'client_ready') { $wsComponentReady = $true } }

    # R2 Blocker 2 (FULL_READY semantics): LIVENESS is process/HTTP alive only;
    # READINESS is the set of required components. When IncludeWebSockets=false the
    # ONLY required component is API readiness. When IncludeWebSockets=true every
    # required component must succeed for FULL_READY. A mix (API PASS + WS FAIL, or
    # API FAIL + WS PASS) is PARTIAL/DEGRADED and NEVER resets HEALTHY and NEVER
    # escalates to a restart. ONLY sustained all-required-component failure can
    # reach RECOVERY_ELIGIBLE.
    $requiredCount = 1 + $(if ($wsRequired) { 1 } else { 0 })
    $okCount = 0
    if ($apiComponentReady) { $okCount++ }
    if ($wsRequired -and $wsComponentReady) { $okCount++ }
    $ready = ($requiredCount -gt 0 -and $okCount -eq $requiredCount)   # FULL success
    $partialReady = (-not $ready -and $okCount -ge 1)                  # some but not all
    $readiness = if ($ready) { 'full' } elseif ($partialReady) { 'partial' } else { 'unready' }

    $errorClass = ''
    $failureSignal = ''
    if ($partialReady) {
        # some components ok, not all -> PARTIAL. Diagnostic value, not a request-level
        # total failure. Never resets HEALTHY, never escalates to restart.
        $errorClass = 'partial_ready'
        $failureSignal = 'partial'
    } elseif (-not $ready) {
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
        apiReady         = [bool]$apiComponentReady
        wsReady          = [bool]$wsComponentReady
        ready            = [bool]$ready
        partialReady     = [bool]$partialReady
        readiness        = [string]$readiness
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
    $partial    = if ($null -ne $Snapshot.partialReady) { [bool]$Snapshot.partialReady } else { $false }
    $readiness  = if ($Snapshot.readiness) { [string]$Snapshot.readiness } else { if ($ready) { 'full' } elseif ($partial) { 'partial' } else { 'unready' } }
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

    # R2 Blocker 2: PARTIAL success (some required readiness component ok, not all).
    # A single component's success must NOT mask another component's long-term failure,
    # but PARTIAL == server IS responding, so it is NEVER a restart-eligible condition.
    # Record state as DEGRADED and do NOT advance the failure streak (a partial is not
    # a total request-level failure). This keeps the health state honest (visible in
    # dsh-health state + incident) without ever escalating a partial to recovery_eligible.
    if ($partial) {
        $next = _carry $base $failures $nowMs
        $next.state = 'degraded'
        $next.lastTransitionReason = "partial readiness ($readiness; api=$($Snapshot.apiState) ws=$($Snapshot.wsState)); degraded, no restart"
        $out.Action = 'degrade'
        $out.State = 'degraded'
        $out.Reason = "partial readiness ($readiness); no restart"
        $out.NextState = $next
        $out.Diagnostic = [pscustomobject]@{ windowSec = 0; failures = $failures; partial = $true; readiness = $readiness }
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
#
# R2 Blocker 3 (no leak outside the bundle): every value that enters the bundle is
# passed through Invoke-DshRedactText so a sensitive-looking value (token, bearer,
# api key, password, secret, credential, PEM private key) can NEVER be written to an
# incident file. The scan helper Test-DshIncidentRedaction is used by the E2E to
# prove a supplied sensitive fixture is absent from the serialized bundle.
function Invoke-DshRedactText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return [string]$Text }
    $t = [string]$Text
    # 1. JSON key:value for known secret keys: "token":"<val>" -> "token":"***"
    $t = $t -replace '(?i)"(token|access_token|refresh_token|api[_-]?key|apikey|password|passwd|pwd|secret|client_secret|credential[s]?)"\s*:\s*"[^"]*"', '"$1":"***"'
    # 2. Authorization scheme header + Bearer token
    $t = $t -replace '(?i)("authorization"\s*:\s*")(bearer\s+)?[A-Za-z0-9._~+/=-]+', '$1$2***'
    $t = $t -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', '$1***'
    # 3. env/assignment style VALUE=<token>
    $t = $t -replace '(?i)((?:token|api[_-]?key|apikey|password|passwd|pwd|secret|credential)\s*=\s*)[^\s;]+', '$1***'
    # 4. PEM private-key blocks
    $t = $t -replace '(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----', '***PRIVATE KEY REDACTED***'
    return $t
}

function ConvertTo-DshRedactedJson([object]$Obj, [int]$Depth = 12) {
    $raw = ($Obj | ConvertTo-Json -Depth $Depth -Compress)
    return (Invoke-DshRedactText $raw)
}

# Scan a serialized bundle (or arbitrary text) for leak of any known-sensitive value.
# Deterministic redaction guard used by the E2E / CI. Returns @{ Clean; Hits }.
function Test-DshIncidentRedaction([string]$Json, [string[]]$KnownSensitive = @()) {
    $hits = @()
    foreach ($s in $KnownSensitive) {
        if ($s -and $Json -match [regex]::Escape($s)) { $hits += $s }
    }
    # also scan for un-redacted secret-looking JSON pairs / PEM headers
    foreach ($re in @('(?i)"(?:authorization|bearer|token|api[_-]?key|password|secret)"\s*:\s*"[^"*][^"]*"',
                      '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]+')) {
        foreach ($m in [regex]::Matches($Json, $re)) { if ($m.Value -notmatch '\*\*\*') { $hits += $m.Value } }
    }
    return [pscustomobject]@{ Clean = ($hits.Count -eq 0); Hits = $hits }
}


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
            basicHttpStatus = $Snapshot.basicHttpStatus
            apiState        = [string]$Snapshot.apiState
            wsState         = [string]$Snapshot.wsState
            apiReady        = if ($null -ne $Snapshot.apiReady) { [bool]$Snapshot.apiReady } else { $false }
            wsReady         = if ($null -ne $Snapshot.wsReady) { [bool]$Snapshot.wsReady } else { $false }
            ready           = if ($null -ne $Snapshot.ready) { [bool]$Snapshot.ready } else { $false }
            partialReady    = if ($null -ne $Snapshot.partialReady) { [bool]$Snapshot.partialReady } else { $false }
            readiness       = [string]$Snapshot.readiness
            failureSignal   = [string]$Snapshot.failureSignal
            errorClass      = [string]$Snapshot.errorClass
            probeDurationMs = [int]$Snapshot.probeDurationMs
        }
        healthState = [pscustomobject]@{
            state               = [string]$HealthState.state
            consecutiveFailures = if ($null -ne $HealthState.consecutiveFailures) { [int]$HealthState.consecutiveFailures } else { 0 }
            maxFailures         = if ($null -ne $HealthState.maxFailures) { [int]$HealthState.maxFailures } else { 0 }
            firstFailureAtMs    = $HealthState.firstFailureAtMs
            lastFailureAtMs     = $HealthState.lastFailureAtMs
            lastHealthyAtMs     = $HealthState.lastHealthyAtMs
            errorClass          = [string]$Snapshot.errorClass
            readiness           = [string]$Snapshot.readiness
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
                startedAt   = $rt.startedAt
                updatedAt   = $rt.updatedAt
                exitCode    = $rt.exitCode
            }) -Force
        }
    } catch {}

    # best-effort: live process telemetry for the owning pid (never the launcher);
    # no sensitive values are read into the bundle (path is fine, no cmdline args).
    try {
        if ($Snapshot.ownerPid -and $Snapshot.ownerPid -gt 0) {
            $op = Get-Process -Id ([int]$Snapshot.ownerPid) -ErrorAction Stop
            $incident | Add-Member -NotePropertyName process -NotePropertyValue ([pscustomobject]@{
                pid          = [int]$op.Id
                startTime    = $op.StartTime
                cpuSeconds   = [math]::Round($op.TotalProcessorTime.TotalSeconds, 1)
                rssBytes     = [int64]$op.WorkingSet64
                handleCount  = [int]$op.HandleCount
                path         = if ($op.Path) { [string]$op.Path } else { $null }
            }) -Force
        }
    } catch {}

    # best-effort: presence-only task telemetry (goal + session activity). We read
    # ONLY file existence / timestamps / counts — NEVER session bodies or prompts.
    try {
        $dshHome = Join-Path $env:USERPROFILE '.dsh'
        $task = [pscustomobject]@{ activeGoalExists = $false; goalFileCount = 0; runningSessionCount = 0; newestSessionWriteAt = $null }
        $goalDir = Join-Path $dshHome 'goals'
        if (Test-Path -LiteralPath $goalDir) {
            $gf = @(Get-ChildItem -LiteralPath $goalDir -File -Filter *.json -ErrorAction SilentlyContinue)
            $task.goalFileCount = $gf.Count
            # active-goal proxy: a goal state file touched in the last 15 min (presence only)
            $task.activeGoalExists = [bool]($gf | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-15) })
        }
        $sessDir = Join-Path $dshHome 'sessions'
        if (Test-Path -LiteralPath $sessDir) {
            $sess = @(Get-ChildItem -LiteralPath $sessDir -File -Filter *.json -Recurse -ErrorAction SilentlyContinue)
            $task.runningSessionCount = @($sess | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }).Count
            if ($sess.Count -gt 0) { $task.newestSessionWriteAt = ($sess | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime }
        }
        $incident | Add-Member -NotePropertyName taskPresence -NotePropertyValue $task -Force
    } catch {}

    # best-effort: bounded redacted tail of the per-port server log (append-kept
    # boot diagnostics; never blocks recovery on a read failure).
    try {
        $logPath = Join-Path $env:LOCALAPPDATA ("DSHHarness\logs\dsh-server-{0}.log" -f $Port)
        if (Test-Path -LiteralPath $logPath) {
            $tail = (Get-Content -LiteralPath $logPath -Tail 200 -ErrorAction Stop) -join "`n"
            $incident | Add-Member -NotePropertyName serverLog -NotePropertyValue ([pscustomobject]@{
                path      = $logPath
                tailLines = 200
                tail      = (Invoke-DshRedactText $tail)
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

    # redaction guard: never allow a sensitive-looking value into the bundle.
    # Single choke point: every value passes Invoke-DshRedactText.
    $raw = ConvertTo-DshRedactedJson -Obj $incident -Depth 12

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
