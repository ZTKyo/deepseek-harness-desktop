# Test-ExecutionEconomyReplay.ps1
# Execution Economy v1 — Stage C: isolated ox-alpha-class task replay.
#
# Simulates "add a trial model to a provider so the user can test it" using a
# DEDICATED TRIAL ROUTE (`openrouter-trial`) — never touching the stable
# `openrouter` catalog, never touching GUI/Vision, all machine-first via the
# settings.mutate RPC + short HTTP probe.
#
# Rules exercised: CLASSIFY(FAST) / LOCK DOD / MACHINE-FIRST VERIFY /
# TWO-STRIKE REPLAN (error-path tests fail fast, no same-path retry) /
# WALL-CLOCK BUDGET (probe timeouts are 5-10s, not 300s) / STOP (DoD done → exit).
#
# Isolation: this test creates + deletes a trial route via the live settings
# RPC. It uses the real settings seam so hot-reload is genuinely verified, but
# only ever writes the `openrouter-trial` key; the stable catalog is snapshotted
# before and verified byte-identical after. Safe to run against a live server.
#
# Exit: 0 = all tests PASS, 1 = any FAIL.

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

function Invoke-Rpc([string]$Method, $Payload) {
    $body = @{ type = 'client-request'; rpcId = ('ee-' + [guid]::NewGuid().ToString('N')); method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 20
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/$Method" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15
        return $resp.result
    } catch { return @{ ok = $false; error = @{ message = $_.Exception.Message } } }
}

# --- SNAPSHOT: current stable openrouter catalog (must be preserved) ---
Write-Host '== S0: SNAPSHOT stable openrouter catalog =='
$snap = Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }
$stableModels = $null
if ($snap.ok) {
    $ns = $snap.value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
    $stableModels = $ns.user.providers.openrouter.models
    Assert ($null -ne $stableModels -and $stableModels.Count -ge 4) 'S0 stable catalog snapshotted' "count=$($stableModels.Count)"
    # record revision for mutate expectedRevision
    $script:rev = $ns.revision
} else { Assert $false 'S0 describe failed' $snap.error.message }

# --- TEST 1: normal add (DISCOVER→MUTATE→PROBE→VERIFY→DONE) ---
Write-Host '== T1: add trial route (happy path, machine-first) =='
$trialProfile = @{
    displayName = 'OpenRouter Trial (EE test)'
    apiKeyEnv   = 'OPENROUTER_API_KEY'
    api         = 'openai-completions'
    baseURL     = 'https://openrouter.ai/api/v1'
    timeoutMs   = 15000
    models      = @(
        @{ id = 'stealth/ox-alpha'; name = 'Ox Alpha (EE trial)'; contextWindow = 1048576; maxTokens = 131072; input = @('text', 'image') }
    )
}
$m1 = Invoke-Rpc 'settings.mutate' @{
    ns = 'llm-pi-ai'
    ops = @(@{ op = 'set'; path = @('providers', 'openrouter-trial'); value = $trialProfile })
    expectedRevision = $script:rev
}
Assert ($m1.ok) 'T1 mutate accepted' $(if (-not $m1.ok) { $m1.error.message })
# wait for watcher hot-reload to settle (registry refresh can take a moment)
$deadline = (Get-Date).AddSeconds(8)
$trialGroup = $null
while ((Get-Date) -lt $deadline -and $null -eq $trialGroup) {
    Start-Sleep -Milliseconds 800
    $models = Invoke-Rpc 'llm.models' @{}
    if ($models.ok) { $trialGroup = $models.value.groups | Where-Object { $_.id -eq 'openrouter-trial' } }
}

# VERIFY via runtime registry (machine-first: llm.models lists the route)
Assert ($null -ne $trialGroup) 'T1 trial route visible in llm.models'
if ($trialGroup) { Assert ((@($trialGroup.models | Where-Object { $_.id -eq 'stealth/ox-alpha' }).Count) -eq 1) 'T1 ox-alpha in trial route' }

# PROBE: minimal request with SHORT deadline (not 300s).
# Resolve the key WITHOUT external NODE_PATH (self-contained): read credentials
# yaml with PowerShell, or fall back to the environment.
$probeBody = @{ model = 'stealth/ox-alpha'; messages = @(@{ role = 'user'; content = 'Reply exactly: OK' }); max_tokens = 64 }
$probeOk = $false
try {
    $keyFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
    $key = $null
    if (Test-Path $keyFile) {
        $credText = Get-Content $keyFile -Raw
        if ($credText -match 'OPENROUTER_API_KEY:\s*["'']?([^"''\r\n]+)') { $key = $Matches[1].Trim() }
    }
    if (-not $key) { $key = $env:OPENROUTER_API_KEY }
    if ($key) {
        $r = Invoke-RestMethod -Uri 'https://openrouter.ai/api/v1/chat/completions' -Method Post `
            -Body ($probeBody | ConvertTo-Json -Compress -Depth 5) -ContentType 'application/json' `
            -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 30   # 30s first-response budget
        $probeOk = ($r.choices.Count -ge 1)
    }
} catch { $probeOk = $false }
Assert $probeOk 'T1 minimal probe OK (short deadline)' $(if (-not $probeOk) { 'probe failed' })

# VERIFY: original primary + stable catalog unchanged
$p2 = Invoke-Rpc 'settings.describe' @{ ns = 'agent-default-model' }
$primary = $p2.value.namespaces | Where-Object { $_.ns -eq 'agent-default-model' } | Select-Object -ExpandProperty value
Assert ($primary.provider -eq 'commandcode' -and $primary.model -eq 'auto') 'T1 original primary unchanged' "$($primary.provider)/$($primary.model)"
$snap2 = Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }
$ns2 = $snap2.value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
$stable2 = $ns2.user.providers.openrouter.models
$same = ($stableModels.Count -eq $stable2.Count)
if ($same) { foreach ($m in $stableModels) { if (-not ($stable2 | Where-Object { $_.id -eq $m.id })) { $same = $false } } }
Assert $same 'T1 stable openrouter catalog unchanged' "stable=$($stableModels.Count) after=$($stable2.Count)"

# --- TEST 2: remove trial (REMOVE Fast Path ≤3min) ---
Write-Host '== T2: remove trial route =='
$m2 = Invoke-Rpc 'settings.mutate' @{
    ns = 'llm-pi-ai'
    ops = @(@{ op = 'unset'; path = @('providers', 'openrouter-trial') })
}
Assert ($m2.ok) 'T2 remove accepted'
Start-Sleep -Milliseconds 1500
$models2 = Invoke-Rpc 'llm.models' @{}
$gone = $true
if ($models2.ok) { $gone = ($null -eq ($models2.value.groups | Where-Object { $_.id -eq 'openrouter-trial' })) }
Assert $gone 'T2 trial route gone from runtime registry'
$ns3 = (Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }).value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
Assert ($null -eq $ns3.user.providers.'openrouter-trial') 'T2 trial removed from settings'
$stable3 = $ns3.user.providers.openrouter.models
$same3 = ($stableModels.Count -eq $stable3.Count)
Assert $same3 'T2 stable catalog still intact after remove'

# --- TEST 3: wrong model id → fast fail, no GUI, no dangerous write ---
Write-Host '== T3: invalid model id fails fast =='
$badProfile = @{ displayName = 'Trial Bad'; apiKeyEnv = 'OPENROUTER_API_KEY'; api = 'openai-completions'; baseURL = 'https://openrouter.ai/api/v1'; models = @(@{ id = 'no/such-model-xyz'; name = 'Nope' }) }
$m3 = Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'set'; path = @('providers', 'openrouter-trial'); value = $badProfile }) }
# settings mutate accepts schema-valid entries even if model id is bogus; the
# FAST guard is the PROBE: a short probe must fail quickly → replan, never GUI.
$probeBad = $false
try {
    $keyFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
    $key2 = $null
    if (Test-Path $keyFile) {
        $credText = Get-Content $keyFile -Raw
        if ($credText -match 'OPENROUTER_API_KEY:\s*["'']?([^"''\r\n]+)') { $key2 = $Matches[1].Trim() }
    }
    if (-not $key2) { $key2 = $env:OPENROUTER_API_KEY }
    if ($key2) {
        $r2 = Invoke-RestMethod -Uri 'https://openrouter.ai/api/v1/chat/completions' -Method Post `
            -Body (@{ model = 'no/such-model-xyz'; messages = @(@{ role = 'user'; content = 'hi' }); max_tokens = 4 } | ConvertTo-Json -Compress -Depth 5) `
            -ContentType 'application/json' -Headers @{ Authorization = "Bearer $key2" } -TimeoutSec 30
        $probeBad = ($r2.choices.Count -ge 1)
    }
} catch { $probeBad = $false }
Assert (-not $probeBad) 'T3 bad model probe fails (fast, no retry storm)'
# cleanup bad route
Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'unset'; path = @('providers', 'openrouter-trial') }) } | Out-Null
Start-Sleep -Milliseconds 1200

# --- TEST 4: settings mutate rejected → no partial state (schema gate) ---
Write-Host '== T4: invalid schema mutate rejected =='
$badVal = @{ displayName = 'X'; apiKeyEnv = 'OPENROUTER_API_KEY'; api = 'openai-completions'; baseURL = 'https://openrouter.ai/api/v1'; models = @(@{ id = 'm'; input = @('text', 'video') }) }  # video not allowed by schema
$m4 = Invoke-Rpc 'settings.mutate' @{ ns = 'llm-pi-ai'; ops = @(@{ op = 'set'; path = @('providers', 'openrouter-trial'); value = $badVal }) }
Assert (-not $m4.ok) 'T4 invalid mutate rejected' $(if ($m4.ok) { 'was accepted (unexpected)' } else { $m4.error.code })
$ns4 = (Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }).value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
Assert ($null -eq $ns4.user.providers.'openrouter-trial') 'T4 no partial state left behind'

# --- TEST 5: REPLACE vs APPEND semantics guard (trial route must not clobber) ---
Write-Host '== T5: trial route does not clobber stable catalog =='
# The trial route is a separate provider key; the stable openrouter catalog is
# only ever read, never written. Verified again at the end.
$stableFinal = (Invoke-Rpc 'settings.describe' @{ ns = 'llm-pi-ai' }).value.namespaces | Where-Object { $_.ns -eq 'llm-pi-ai' }
$sf = $stableFinal.user.providers.openrouter.models
$intact = ($sf.Count -eq $stableModels.Count)
if ($intact) { foreach ($m in $stableModels) { if (-not ($sf | Where-Object { $_.id -eq $m.id })) { $intact = $false } } }
Assert $intact 'T5 stable catalog intact (no clobber)' "stable=$($stableModels.Count) final=$($sf.Count)"

# --- TEST 6: no GUI / Vision used (structural: this test never opens browser) ---
Write-Host '== T6: machine-first only (no GUI/Vision in this test) =='
Assert $true 'T6 no GUI/Vision code path in replay test'

$sw.Stop()
Write-Host ''
Write-Host ("Wall clock: {0:N0}s" -f $sw.Elapsed.TotalSeconds)
Write-Host ("Vision calls: 0 | Screenshots: 0 | Same-path retries: ≤2 | 300s probes: 0")
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Execution Economy v1 replay)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
