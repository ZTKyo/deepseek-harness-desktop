# dsh-readiness.ps1 - layered, request-level DSH readiness checks.
# Requires dsh-process-identity.ps1 when used against a real listener.

$readinessIdentity = Join-Path $PSScriptRoot 'dsh-process-identity.ps1'
if (-not (Get-Command Get-DshLoopbackOwner -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $readinessIdentity)) {
    . $readinessIdentity
}

function Invoke-DshReadinessRpc([int]$Port, [string]$Method, [int]$TimeoutSec = 4) {
    $base = "http://127.0.0.1:$Port"
    $rpcId = "readiness-$([guid]::NewGuid().ToString('N'))"
    $body = @{ type = 'client-request'; rpcId = $rpcId; method = $Method; payload = @{} } | ConvertTo-Json -Compress
    try {
        $response = Invoke-RestMethod -Uri ("{0}/api/{1}" -f $base, $Method) -Method Post -Body $body -ContentType 'application/json' -Headers @{ host = "127.0.0.1:$Port" } -TimeoutSec $TimeoutSec -ErrorAction Stop
        if ($response.result -and $response.result.ok -eq $true) {
            return [pscustomobject]@{ State = 'ok'; Method = $Method; RpcId = $rpcId; Error = $null }
        }
        return [pscustomobject]@{ State = 'rpc_not_ok'; Method = $Method; RpcId = $rpcId; Error = 'result.ok was not true' }
    } catch {
        return [pscustomobject]@{ State = 'rpc_error'; Method = $Method; RpcId = $rpcId; Error = $_.Exception.Message }
    }
}

function Test-DshApiReady([int]$Port = 3080) {
    $owner = Get-DshLoopbackOwner -Port $Port
    if ($owner.State -ne 'ok') {
        return [pscustomobject]@{ State = "process_$($owner.State)"; Port = $Port; Owner = $owner; HostDescribe = $null; SessionList = $null; Error = $owner.State }
    }
    $hostRpc = Invoke-DshReadinessRpc -Port $Port -Method 'host.describe'
    if ($hostRpc.State -ne 'ok') {
        return [pscustomobject]@{ State = 'api_unready'; Port = $Port; Owner = $owner; HostDescribe = $hostRpc; SessionList = $null; Error = $hostRpc.Error }
    }
    $sessions = Invoke-DshReadinessRpc -Port $Port -Method 'session.list'
    if ($sessions.State -ne 'ok') {
        return [pscustomobject]@{ State = 'api_unready'; Port = $Port; Owner = $owner; HostDescribe = $hostRpc; SessionList = $sessions; Error = $sessions.Error }
    }
    return [pscustomobject]@{ State = 'api_ready'; Port = $Port; Owner = $owner; HostDescribe = $hostRpc; SessionList = $sessions; Error = $null }
}

function Test-DshWebSocketOpen([string]$Uri, [int]$TimeoutMs = 3000) {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutMs)
    try {
        $task = $ws.ConnectAsync([Uri]$Uri, $cts.Token)
        if (-not $task.Wait($TimeoutMs + 500)) {
            return [pscustomobject]@{ State = 'timeout'; Uri = $Uri; Error = 'websocket open timeout' }
        }
        if ($task.IsFaulted) {
            $message = if ($task.Exception -and $task.Exception.InnerException) { $task.Exception.InnerException.Message } else { 'websocket open failed' }
            return [pscustomobject]@{ State = 'error'; Uri = $Uri; Error = $message }
        }
        if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            return [pscustomobject]@{ State = 'open'; Uri = $Uri; Error = $null }
        }
        return [pscustomobject]@{ State = 'not_open'; Uri = $Uri; Error = [string]$ws.State }
    } catch {
        return [pscustomobject]@{ State = 'error'; Uri = $Uri; Error = $_.Exception.Message }
    } finally {
        try { $cts.Dispose() } catch {}
        try { $ws.Dispose() } catch {}
    }
}

function Test-DshReadiness([int]$Port = 3080, [switch]$RequireWebSockets, [object]$ApiSnapshot = $null) {
    # RH2 (P1-D): a full health transaction may supply the already-computed
    # API readiness snapshot.  WebSocket checks must not call
    # Test-DshApiReady a second time (and therefore must not repeat
    # host.describe/session.list).
    $api = if ($null -ne $ApiSnapshot) { $ApiSnapshot } else { Test-DshApiReady -Port $Port }
    if ($api.State -ne 'api_ready') { return $api }
    if (-not $RequireWebSockets) { return $api }

    $mux = Test-DshWebSocketOpen -Uri "ws://127.0.0.1:$Port/api/events.mux"
    $hostWs = Test-DshWebSocketOpen -Uri "ws://127.0.0.1:$Port/api/events.host"
    if ($mux.State -eq 'open' -and $hostWs.State -eq 'open') {
        return [pscustomobject]@{ State = 'client_ready'; Port = $Port; Owner = $api.Owner; HostDescribe = $api.HostDescribe; SessionList = $api.SessionList; Mux = $mux; Host = $hostWs; Error = $null }
    }
    return [pscustomobject]@{ State = 'ws_unready'; Port = $Port; Owner = $api.Owner; HostDescribe = $api.HostDescribe; SessionList = $api.SessionList; Mux = $mux; Host = $hostWs; Error = 'one or both event streams did not open' }
}
