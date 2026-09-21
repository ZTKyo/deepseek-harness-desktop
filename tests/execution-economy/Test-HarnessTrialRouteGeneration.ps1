# Test-HarnessTrialRouteGeneration.ps1
# Execution Economy v1 — Stage B: REAL Harness Trial Route generation.
#
# Creates a UNIQUE temporary trial route, then drives a REAL Harness agent
# session through the Harness LLM runtime (no direct HTTP bypass):
#   mutate agent-default-model -> TEMP_ROUTE_ID / stealth/ox-alpha
#   session.create (default model) -> session.prompt('Reply exactly: OK')
#   -> wait for turn/end reason=completed -> verify provider/model recorded
#   -> restore agent-default-model to original value (finally)
#
# NOTE: session.selectModel persists the selection into agent-default-model
# (user layer), so this test does NOT use selectModel; it mutates
# agent-default-model directly and ALWAYS restores it in finally.
#
# Probe budget: settings RPC 5-10s, generation bounded wait 45s, max 1 retry,
# never 300s. No GUI/screenshot/Vision. Never reads/prints credentials.
#
# MANUAL/LIVE validation: requires live DSH server + OPENROUTER_API_KEY in
# the Harness credential seam. Not part of public PR CI.
#
# Exit: 0 = PASS, 1 = FAIL.

param(
    [int]$Port = 3080
)

$ErrorActionPreference = 'Continue'
$failCount = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}

function Invoke-Rpc([string]$Method, $Payload, [int]$TimeoutSec = 15) {
    $body = @{ type = 'client-request'; rpcId = ('gv-' + [guid]::NewGuid().ToString('N')); method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 20
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/$Method" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
        return $resp.result
    } catch { return @{ ok = $false; error = @{ message = $_.Exception.Message } } }
}

$TEMP_ROUTE_ID = 'openrouter-ee-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "TEMP_ROUTE_ID: $TEMP_ROUTE_ID"
$sessionId = $null

# --- snapshot stable state ---
$snap = Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }
$stableModels = @()
$preRoutes = @()
if ($snap.ok) {
    $ns = $snap.value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
    $stableModels = @($ns.user.providers.openrouter.models)
    $preRoutes = @($ns.user.providers.PSObject.Properties | ForEach-Object { $_.Name })
}
$primSnap = Invoke-Rpc 'settings.describe' @{ ns = 'agent-default-model' }
$primBefore = ($primSnap.value.namespaces | Where-Object { $_.ns -eq 'agent-default-model' }).value
Write-Host "stable models: $($stableModels.Count) | primary before: $($primBefore.provider)/$($primBefore.model)"

try {
    # --- create unique temp route ---
    $profile = @{
        displayName = 'EE Live Gen Temp'
        apiKeyEnv   = 'OPENROUTER_API_KEY'
        api         = 'openai-completions'
        baseURL     = 'https://openrouter.ai/api/v1'
        timeoutMs   = 20000
        models      = @(@{ id = 'stealth/ox-alpha'; name = 'Ox Alpha (EE live)'; contextWindow = 1048576; maxTokens = 131072; input = @('text', 'image') })
    }
    $m = Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'set'; path = @('providers', $TEMP_ROUTE_ID); value = $profile }) }
    Assert ($m.ok) 'T1 route created' $(if (-not $m.ok) { $m.error.message })
    Start-Sleep -Milliseconds 2000

    $models = Invoke-Rpc 'llm.models' @{}
    $grp = $null
    if ($models.ok) { $grp = $models.value.groups | Where-Object { $_.id -eq $TEMP_ROUTE_ID } }
    Assert ($null -ne $grp) 'T2 route visible in llm.models'

    # --- point default model at trial route (restored in finally) ---
    $pm = Invoke-Rpc 'settings.mutate' @{ ns = 'agent-default-model'; ops = @(@{ op = 'set'; path = @('provider'); value = $TEMP_ROUTE_ID }, @{ op = 'set'; path = @('model'); value = 'stealth/ox-alpha' }) }
    Assert ($pm.ok) 'primary pointed at trial route' $(if (-not $pm.ok) { $pm.error.message })
    Start-Sleep -Milliseconds 1500

    # --- create fresh session (uses default model = trial route) ---
    $sc = Invoke-Rpc 'session.create' @{ cwd = $env:USERPROFILE }
    $sessionId = $sc.value.sessionId
    Assert ($null -ne $sessionId) 'T3 session created' $(if (-not $sc.ok) { $sc.error.message })

    # --- prompt through the Harness runtime ---
    if ($sessionId) {
        $prompt = @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = 'Reply exactly: OK' }) }
        $pr = Invoke-Rpc 'session.prompt' $prompt 20
        Assert ($pr.ok) 'T3 prompt accepted' $(if (-not $pr.ok) { $pr.error.message })

        # wait for turn/end with reason.kind=completed (bounded, no 300s)
        $deadline = (Get-Date).AddSeconds(45)
        $completed = $false
        $lastReason = ''
        while ((Get-Date) -lt $deadline -and -not $completed) {
            Start-Sleep -Seconds 3
            $hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId } 10
            if ($hist.ok -and $hist.value) {
                foreach ($e in @($hist.value.events)) {
                    if ($e.event.type -eq 'turn/end') {
                        $rk = $e.event.data.reason.kind
                        if ($rk) { $lastReason = $rk }
                        if ($rk -eq 'completed') { $completed = $true }
                    }
                }
            }
        }
        Assert $completed 'T3 turn reached completed state' "reason.kind=$lastReason"

        # --- verify provider/model recorded as TEMP_ROUTE_ID / stealth/ox-alpha ---
        $foundRoute = $false
        $foundModel = $false
        $assistantText = ''
        $hist2 = Invoke-Rpc 'session.history' @{ sessionId = $sessionId } 10
        if ($hist2.ok -and $hist2.value) {
            foreach ($e in @($hist2.value.events)) {
                $j = $e.event | ConvertTo-Json -Depth 8 -Compress
                if ($j -match [regex]::Escape($TEMP_ROUTE_ID)) { $foundRoute = $true }
                if ($j -match 'stealth/ox-alpha') { $foundModel = $true }
                # best-effort assistant text extraction (transport PASS does not depend on it)
                if ($e.event.type -eq 'assistant') {
                    $c = $e.event.data.message.content
                    if ($c) { $assistantText = ($c | Out-String).Trim() }
                }
            }
        }
        Write-Host "route recorded: $foundRoute | model recorded: $foundModel"
        Write-Host "assistant output (best-effort): '$assistantText'"
        Assert ($foundRoute -and $foundModel) 'T4 provider/model recorded as TEMP_ROUTE_ID/stealth/ox-alpha'
        # transport PASS per spec 6: generation completed through Harness runtime,
        # even if exact 'OK' differs or assistant text is not surfaced in history
        Assert $completed 'T6 generation transport completed through Harness runtime'
    }
}
finally {
    # --- fail-safe cleanup + restore primary ---
    Write-Host '== CLEANUP =='
    # restore primary FIRST (so a lingering default never points at the temp route)
    $restore = Invoke-Rpc 'settings.mutate' @{ ns = 'agent-default-model'; ops = @(@{ op = 'set'; path = @('provider'); value = $primBefore.provider }, @{ op = 'set'; path = @('model'); value = $primBefore.model }) }
    Assert ($restore.ok) 'primary restored' "$($primBefore.provider)/$($primBefore.model)"
    # remove temp route
    Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'unset'; path = @('providers', $TEMP_ROUTE_ID) }) } | Out-Null
    Start-Sleep -Milliseconds 1500
    $snapC = Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }
    $nsC = $snapC.value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
    $absent = ($null -eq $nsC.user.providers.$TEMP_ROUTE_ID)
    Assert $absent 'T8 temp route removed from settings'
    $modelsC = Invoke-Rpc 'llm.models' @{}
    $absentR = $true
    if ($modelsC.ok) { $absentR = ($null -eq ($modelsC.value.groups | Where-Object { $_.id -eq $TEMP_ROUTE_ID })) }
    Assert $absentR 'T8 temp route removed from runtime registry'
    $stableC = @($nsC.user.providers.openrouter.models)
    $routesC = @($nsC.user.providers.PSObject.Properties | ForEach-Object { $_.Name })
    Assert ($stableC.Count -eq $stableModels.Count) 'T4 stable catalog intact' "stable=$($stableModels.Count) final=$($stableC.Count)"
    Assert ($routesC.Count -eq $preRoutes.Count) 'existing routes intact' "before=$($preRoutes.Count) after=$($routesC.Count)"
    $primC = ($(Invoke-Rpc 'settings.describe' @{ ns = 'agent-default-model' }).value.namespaces | Where-Object { $_.ns -eq 'agent-default-model' }).value
    Assert ($primC.provider -eq $primBefore.provider -and $primC.model -eq $primBefore.model) 'T5 primary unchanged (restored)' "$($primC.provider)/$($primC.model)"
    if (-not ($absent -and $absentR)) { Write-Host 'CLEANUP FAILED (residue)'; $script:failCount++ }
}

$sw.Stop()
Write-Host ''
Write-Host ("Wall clock: {0:N0}s" -f $sw.Elapsed.TotalSeconds)
Write-Host "TEMP_ROUTE_ID: $TEMP_ROUTE_ID | session: $sessionId"
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (real Harness Trial Route generation)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
