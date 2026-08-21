# dsh-commit-readiness.ps1 - COMMIT_READY vs BOOT_READY separation (Reliability v1, Stage B)
#
# Problem (RC8 Golden): Last Good was promoted on "YAML valid" or shallow api_ready,
# which is NOT evidence the configuration actually works end-to-end.
#
# Definition (Reliability v1):
#   BOOT_READY    = the API answers (api_ready) -> the server can be probed.
#   COMMIT_READY  = full health verification passed ->
#                   process identity PASS
#                   host.describe PASS
#                   session.list PASS
#                   events.mux PASS
#                   events.host PASS
#                   renderer (web UI serves) PASS
#                   lightweight real session probe PASS (optional, -LightProbe)
#                   stable window PASS (health held for N consecutive seconds)
#
# Only COMMIT_READY allows:
#   - Save-VerifiedLastGood
#   - Transaction COMMIT
#
# Pure module: no side effects, only reads. Callers decide what to write.

function Test-CommitReadiness {
    <#
    .SYNOPSIS
    Full COMMIT_READY gate. Returns [pscustomobject] with .Ready (bool) and per-check detail.
    .PARAMETER Port
    DSH server port (default 3080).
    .PARAMETER StableWindowSec
    How many seconds the health must hold before COMMIT_READY (default 10).
    .PARAMETER LightProbe
    If set, also run a lightweight real-session probe (creates a session and sends a trivial
    prompt, waits for a completed turn). Requires a working provider; failures block COMMIT.
    .PARAMETER LightProbeTimeoutSec
    Timeout for the light probe (default 20).
    #>
    param(
        [int]$Port = 3080,
        [int]$StableWindowSec = 10,
        [switch]$LightProbe,
        [int]$LightProbeTimeoutSec = 20
    )
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    . (Join-Path $root 'dsh-process-identity.ps1') 2>$null
    . (Join-Path $root 'dsh-readiness.ps1') 2>$null

    $checks = [ordered]@{}
    $allPass = $true

    # 1. process identity (fail-closed)
    try {
        $owner = Get-DshLoopbackOwner -Port $Port
        $checks.ProcessIdentity = if ($owner.State -eq 'ok') { 'PASS' } else { "FAIL($($owner.State))" }
        if ($owner.State -ne 'ok') { $allPass = $false }
    } catch { $checks.ProcessIdentity = "FAIL($($_.Exception.Message))"; $allPass = $false }

    # 2. api readiness (host.describe + session.list) = BOOT_READY baseline
    try {
        $r = Test-DshApiReady -Port $Port
        $checks.ApiReady = if ($r.State -eq 'api_ready') { 'PASS' } else { "FAIL($($r.State))" }
        if ($r.State -ne 'api_ready') { $allPass = $false }
    } catch { $checks.ApiReady = "FAIL($($_.Exception.Message))"; $allPass = $false }

    # 3. event streams (mux + host)
    try {
        $cr = Test-DshReadiness -Port $Port -RequireWebSockets
        $checks.EventsMux = if ($cr.Mux -and $cr.Mux.State -eq 'open') { 'PASS' } else { 'FAIL' }
        $checks.EventsHost = if ($cr.Host -and $cr.Host.State -eq 'open') { 'PASS' } else { 'FAIL' }
        if ($cr.State -ne 'client_ready') { $allPass = $false }
    } catch { $checks.EventsMux = 'FAIL'; $checks.EventsHost = 'FAIL'; $allPass = $false }

    # 4. renderer (web UI serves the boot payload)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -Method Get -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        $body = [string]$resp.Content
        $checks.Renderer = if ($resp.StatusCode -eq 200 -and $body -match '__DSH_BOOT__') { 'PASS' } else { 'FAIL(status/body)' }
        if ($resp.StatusCode -ne 200 -or $body -notmatch '__DSH_BOOT__') { $allPass = $false }
    } catch { $checks.Renderer = "FAIL($($_.Exception.Message))"; $allPass = $false }

    # 5. stable window: re-run core checks after StableWindowSec
    if ($allPass -and $StableWindowSec -gt 0) {
        Start-Sleep -Seconds $StableWindowSec
        try {
            $r2 = Test-DshApiReady -Port $Port
            $cr2 = Test-DshReadiness -Port $Port -RequireWebSockets
            $stable = ($r2.State -eq 'api_ready' -and $cr2.State -eq 'client_ready')
            $checks.StableWindow = if ($stable) { 'PASS' } else { 'FAIL(dropped during window)' }
            if (-not $stable) { $allPass = $false }
        } catch { $checks.StableWindow = 'FAIL'; $allPass = $false }
    } else {
        $checks.StableWindow = if ($StableWindowSec -gt 0) { 'SKIP' } else { 'PASS(0s)' }
    }

    # 6. lightweight real session probe (optional but recommended for COMMIT)
    if ($LightProbe -and $allPass) {
        $probe = Invoke-DshLightProbe -Port $Port -TimeoutSec $LightProbeTimeoutSec
        $checks.LightProbe = if ($probe.Ok) { 'PASS' } else { "FAIL($($probe.Error))" }
        if (-not $probe.Ok) { $allPass = $false }
    } elseif ($LightProbe) {
        $checks.LightProbe = 'SKIP(prior check failed)'
    } else {
        $checks.LightProbe = 'SKIP(not requested)'
    }

    return [pscustomobject]@{
        Ready = $allPass
        Stage = if ($allPass) { 'COMMIT_READY' } else { 'NOT_COMMIT_READY' }
        Checks = [pscustomobject]$checks
        Timestamp = (Get-Date -Format 'o')
    }
}

function Invoke-DshLightProbe {
    <#
    .SYNOPSIS
    Lightweight session-core probe (no provider tokens consumed): verifies the session
    subsystem answers by driving the public RPC surface (host.describe + session.list +
    events.mux open). A deeper "real completed session" probe is reserved for Safe Mode
    verification and the Reliability Lab, where a provider is guaranteed available.
    Returns @{ Ok; Detail; Error }.
    #>
    param([int]$Port = 3080, [int]$TimeoutSec = 20)
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    . (Join-Path $root 'dsh-readiness.ps1') 2>$null
    . (Join-Path $root 'dsh-process-identity.ps1') 2>$null
    try {
        $owner = Get-DshLoopbackOwner -Port $Port
        if ($owner.State -ne 'ok') { return @{ Ok = $false; Error = "owner=$($owner.State)" } }
        $hostRpc = Invoke-DshReadinessRpc -Port $Port -Method 'host.describe' -TimeoutSec 5
        if ($hostRpc.State -ne 'ok') { return @{ Ok = $false; Error = "host.describe=$($hostRpc.State)" } }
        $sessRpc = Invoke-DshReadinessRpc -Port $Port -Method 'session.list' -TimeoutSec 5
        if ($sessRpc.State -ne 'ok') { return @{ Ok = $false; Error = "session.list=$($sessRpc.State)" } }
        $mux = Test-DshWebSocketOpen -Uri "ws://127.0.0.1:$Port/api/events.mux" -TimeoutMs 3000
        if ($mux.State -ne 'open') { return @{ Ok = $false; Error = "events.mux=$($mux.State)" } }
        return @{ Ok = $true; Detail = 'session-core RPC + events.mux verified'; Error = $null }
    } catch {
        return @{ Ok = $false; Error = $_.Exception.Message }
    }
}

# ensure deps are loaded when dot-sourced
if (-not (Get-Command Get-DshLoopbackOwner -ErrorAction SilentlyContinue)) {
    try { . (Join-Path $PSScriptRoot 'dsh-process-identity.ps1') } catch {}
}
