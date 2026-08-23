# Run-OxAlphaContinuationTests.ps1
# Ox-Alpha Continuation Diagnosis — A/B/C/D orchestration.
#
# Run A: ox-alpha baseline (no continuation policy)
# Run B: DeepSeek control (same task, same conditions)
# Run C: ox-alpha + CONTINUATION DISCIPLINE policy (if B/C conditions met)
# Run D: ox-alpha + policy, new workspace, GAMMA/DELTA content (repro)
#
# Each run: unique openrouter-continuation-test-<guid> route (A/C/D) or
# deepseek route (B), snapshot+mutate+restore primary, isolated workspace,
# try/finally cleanup. No manual "continue" ever injected.
# Machine-first only: no GUI/screenshot/Vision.

param([int]$Port = 3080)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

function Invoke-Rpc([string]$Method, $Payload, [int]$TimeoutSec = 15) {
    $body = @{ type = 'client-request'; rpcId = ('or-' + [guid]::NewGuid().ToString('N')); method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 20
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/$Method" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
        return $resp.result
    } catch { return @{ ok = $false; error = @{ message = $_.Exception.Message } } }
}

$baseTask = (Get-Content "$env:TEMP\ee-cont-task.txt" -Raw)

function New-OxRoute {
    $route = 'openrouter-continuation-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $profile = @{
        displayName = 'Continuation Test Route'
        apiKeyEnv   = 'OPENROUTER_API_KEY'
        api         = 'openai-completions'
        baseURL     = 'https://openrouter.ai/api/v1'
        timeoutMs   = 30000
        models      = @(@{ id = 'stealth/ox-alpha'; name = 'Ox Alpha (cont test)'; contextWindow = 1048576; maxTokens = 131072; input = @('text', 'image') })
    }
    $m = Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'set'; path = @('providers', $route); value = $profile }) }
    if (-not $m.ok) { throw "route create failed: $($m.error.message)" }
    Start-Sleep -Milliseconds 2000
    return $route
}

function Remove-Route([string]$route) {
    Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'unset'; path = @('providers', $route) }) } | Out-Null
    Start-Sleep -Milliseconds 1200
}

function Restore-Primary($prim) {
    Invoke-Rpc 'settings.mutate' @{ ns = 'agent-default-model'; ops = @(@{ op = 'set'; path = @('provider'); value = $prim.provider }, @{ op = 'set'; path = @('model'); value = $prim.model }) } | Out-Null
    Start-Sleep -Milliseconds 1000
}

function New-IsolatedWorkspace {
    $ws = Join-Path $env:TEMP ('ee-cont-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $ws | Out-Null
    return $ws
}

function Remove-Workspace($ws) {
    Remove-Item $ws -Recurse -Force -ErrorAction SilentlyContinue
}

# snapshot primary once
$primSnap = Invoke-Rpc 'settings.describe' @{ ns = 'agent-default-model' }
$prim = ($primSnap.value.namespaces | Where-Object { $_.ns -eq 'agent-default-model' }).value
Write-Host "Primary snapshot: $($prim.provider)/$($prim.model)"

# ============ Run A: Ox-alpha baseline (no policy) ============
Write-Host "`n============ RUN A: ox-alpha baseline ============"
$routeA = $null; $wsA = $null
try {
    $routeA = New-OxRoute
    $wsA = New-IsolatedWorkspace
    Write-Host "OX_ROUTE: $routeA | ws: $wsA"
    $resultA = & "$root\Invoke-ContinuationRun.ps1" -Port $Port -RouteProvider $routeA -Model 'stealth/ox-alpha' -Workspace $wsA -TaskPrompt $baseTask -TaskTag 'A-oxalpha-baseline' -PollBudgetSec 420
    $resultA | Out-File "$env:TEMP\runA.json" -Encoding utf8
    Write-Host "Run A done: turnEnd=$($resultA.turnEnd) wallClock=$($resultA.wallClockSec)s tools=$($resultA.toolCalls) steps=$($resultA.steps)"
}
finally {
    if ($routeA) { Remove-Route $routeA }
    if ($wsA) { Remove-Workspace $wsA }
    Restore-Primary $prim
    Write-Host "Run A cleanup done"
}

# ============ Run B: DeepSeek control ============
Write-Host "`n============ RUN B: DeepSeek control ============"
$routeB = $null; $wsB = $null
try {
    $routeB = 'openrouter-continuation-deepseek-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $profileB = @{
        displayName = 'Continuation DeepSeek Control'
        apiKeyEnv   = 'OPENROUTER_API_KEY'
        api         = 'openai-completions'
        baseURL     = 'https://openrouter.ai/api/v1'
        timeoutMs   = 30000
        models      = @(@{ id = 'deepseek/deepseek-v4-flash-0731'; name = 'DeepSeek V4 Flash (cont control)'; contextWindow = 1310720; maxTokens = 393216 })
    }
    $mB = Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'set'; path = @('providers', $routeB); value = $profileB }) }
    if (-not $mB.ok) { throw "route B create failed: $($mB.error.message)" }
    Start-Sleep -Milliseconds 2000
    $wsB = New-IsolatedWorkspace
    Write-Host "route: $routeB | ws: $wsB | model: deepseek/deepseek-v4-flash-0731"
    $resultB = & "$root\Invoke-ContinuationRun.ps1" -Port $Port -RouteProvider $routeB -Model 'deepseek/deepseek-v4-flash-0731' -Workspace $wsB -TaskPrompt $baseTask -TaskTag 'B-deepseek-control' -PollBudgetSec 420
    $resultB | Out-File "$env:TEMP\runB.json" -Encoding utf8
    Write-Host "Run B done: turnEnd=$($resultB.turnEnd) wallClock=$($resultB.wallClockSec)s tools=$($resultB.toolCalls) steps=$($resultB.steps)"
}
finally {
    if ($routeB) { Remove-Route $routeB }
    if ($wsB) { Remove-Workspace $wsB }
    Restore-Primary $prim
    Write-Host "Run B cleanup done"
}

Write-Host "`n=== Summary ==="
Write-Host "A: $($resultA.turnEnd) / $($resultA.wallClockSec)s / tools=$($resultA.toolCalls) / steps=$($resultA.steps) / futureTense=$($resultA.futureTensePattern)"
Write-Host "B: $($resultB.turnEnd) / $($resultB.wallClockSec)s / tools=$($resultB.toolCalls) / steps=$($resultB.steps) / futureTense=$($resultB.futureTensePattern)"
