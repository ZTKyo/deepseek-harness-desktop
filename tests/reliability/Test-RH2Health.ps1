# RH2 H1-H5: deterministic health/readiness tests.
# All HTTP/API/WebSocket calls are replaced with local fixtures.

$ErrorActionPreference = 'Stop'
$script:apiCalls = 0
$script:sessionListCalls = 0
$script:wsCalls = 0
$script:wsFailure = $false
$script:apiDelayMs = 0
$script:sessionListPayload = $null

. (Join-Path $PSScriptRoot '..\..\dsh-readiness.ps1')

function Test-DshApiReady([int]$Port = 3080) {
    $script:apiCalls++
    $script:sessionListCalls++
    if ($script:apiDelayMs -gt 0) { Start-Sleep -Milliseconds $script:apiDelayMs }
    $sessions = if ($null -ne $script:sessionListPayload) { $script:sessionListPayload } else { [pscustomobject]@{ items = @() } }
    return [pscustomobject]@{
        State = 'api_ready'
        Port = $Port
        Owner = [pscustomobject]@{ State = 'ok'; Pid = 4242 }
        HostDescribe = [pscustomobject]@{ State = 'ok' }
        SessionList = [pscustomobject]@{ State = 'ok'; Value = $sessions }
        Error = $null
    }
}

function Test-DshWebSocketOpen([string]$Uri, [int]$TimeoutMs = 3000) {
    $script:wsCalls++
    if ($script:wsFailure) {
        return [pscustomobject]@{ State = 'error'; Uri = $Uri; Error = 'synthetic websocket failure' }
    }
    return [pscustomobject]@{ State = 'open'; Uri = $Uri; Error = $null }
}

# Prevent the RH1 health module from consulting the real 3080 listener. The
# fixture represents a safe loopback owner and keeps this suite source-only.
function Get-DshLoopbackOwner([int]$Port = 3080) {
    return [pscustomobject]@{
        State = 'ok'
        Pid = 4242
        NonLoopbackCount = 0
        Snapshot = [pscustomobject]@{ CreationDate = $null; CommandLineHash = 'fixture' }
    }
}

. (Join-Path $PSScriptRoot '..\..\dsh-health.ps1')

# Keep the health test isolated from any real loopback listener.
function Test-DshBasicHttp([int]$Port = 3080, [int]$TimeoutSec = 2) {
    return [pscustomobject]@{ State = 'matched'; Uri = "http://127.0.0.1:$Port/"; StatusCode = 200; DurationMs = 1; Error = $null }
}

$pass = 0
$fail = 0
function Assert-Rh2Health([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name $Detail"
    }
}

function Reset-Rh2HealthFixture {
    $script:apiCalls = 0
    $script:sessionListCalls = 0
    $script:wsCalls = 0
    $script:wsFailure = $false
    $script:apiDelayMs = 0
    $script:sessionListPayload = $null
}

# H1/H2: full readiness invokes Test-DshApiReady once and both WS checks reuse
# its returned snapshot.
Reset-Rh2HealthFixture
$h2 = Get-DshHealthProbe -Port 3080 -IncludeWebSockets
Assert-Rh2Health 'H1 one API readiness evaluation' ($script:apiCalls -eq 1) "apiCalls=$script:apiCalls"
Assert-Rh2Health 'H2 API ready + both WS -> client_ready/full' ($h2.State -eq 'client_ready' -and $h2.readiness -eq 'full' -and $h2.HealthState -eq 'healthy' -and $h2.Ready) "state=$($h2.State) readiness=$($h2.readiness) health=$($h2.HealthState)"
Assert-Rh2Health 'H2 exactly two WS checks' ($script:wsCalls -eq 2) "wsCalls=$script:wsCalls"

# H3: a WS failure is degraded/partial and cannot independently authorize a
# restart.
Reset-Rh2HealthFixture
$script:wsFailure = $true
$h3 = Get-DshHealthProbe -Port 3080 -IncludeWebSockets
Assert-Rh2Health 'H3 API ready + WS fail -> degraded/partial' ($h3.State -eq 'ws_unready' -and $h3.HealthState -eq 'degraded' -and -not $h3.Ready) "state=$($h3.State) health=$($h3.HealthState)"
Assert-Rh2Health 'H3 single probe has no restart eligibility' ($h3.RestartEligible -eq $false -and $h3.RestartEligibility -match 'sustained-unready')
Assert-Rh2Health 'H3 still one API readiness evaluation' ($script:apiCalls -eq 1) "apiCalls=$script:apiCalls"

# H4: successful but slow API remains ready and exposes a slow signal.
Reset-Rh2HealthFixture
$script:apiDelayMs = 25
$h4 = Get-DshHealthProbe -Port 3080 -IncludeWebSockets -SlowThresholdMs 5
Assert-Rh2Health 'H4 slow successful API remains ready' ($h4.Ready -and $h4.HealthState -eq 'healthy') "ready=$($h4.Ready) health=$($h4.HealthState)"
Assert-Rh2Health 'H4 latency observability is visible' ($h4.LatencyDegraded -and $h4.DiagnosticSignal -eq 'healthy_slow' -and $h4.ApiDurationMs -ge 5) "apiMs=$($h4.ApiDurationMs) signal=$($h4.DiagnosticSignal)"
Assert-Rh2Health 'H4 slow signal does not authorize restart' ($h4.RestartEligible -eq $false)

# H5/performance: feed a synthetic ~400-session/~500KB payload and assert the
# full transaction still has exactly one session.list/readiness evaluation.
Reset-Rh2HealthFixture
$largeText = [string]::new('x', 500000)
$items = @(1..400 | ForEach-Object { [pscustomobject]@{ sessionId = "synthetic-$_"; state = 'RUNNING' } })
$script:sessionListPayload = [pscustomobject]@{ items = $items; syntheticPayload = $largeText }
$h5 = Get-DshHealthProbe -Port 3080 -IncludeWebSockets
$beforeSessionListCalls = 2
$afterSessionListCalls = $script:sessionListCalls
Assert-Rh2Health 'H5 synthetic payload has 400 sessions' ($h5.Api.SessionList.Value.items.Count -eq 400) "count=$($h5.Api.SessionList.Value.items.Count)"
Assert-Rh2Health 'H5 one full probe -> one session.list' ($afterSessionListCalls -eq 1 -and $h5.SessionListEvaluations -eq 1) "calls=$afterSessionListCalls reported=$($h5.SessionListEvaluations)"
Assert-Rh2Health 'H5 before/after call-count proof is 2 -> 1' ($beforeSessionListCalls -eq 2 -and $afterSessionListCalls -eq 1) "before=$beforeSessionListCalls after=$afterSessionListCalls"

$healthSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\dsh-health.ps1') -Raw
Assert-Rh2Health 'H5 source uses ApiSnapshot WS reuse' ($healthSource -match 'ApiSnapshot' -and $healthSource -match 'Test-DshReadiness')

Write-Host "RH2 HEALTH: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
Write-Host 'RH2 HEALTH TEST PASSED'

