# Test-ColdStartCredentialGate.ps1 - Phase 02 Security-Hardening SH-R3-1.
#
# REAL Harness cold-start runtime gate. Unlike Test-CredentialPreflight.ps1
# (which exercises the helper + source contracts only), this test performs an
# actual host restart under three phases and verifies the live runtime:
#
#   Phase A (NEGATIVE): with NOTION_TOKEN removed (bad/missing credential) the
#       host must still boot HTTP 200 (other plugins fine), mcp-notion must NOT
#       be loaded (the `disabled: !!js "!process.env.NOTION_TOKEN"` safe-degrade
#       works for real), and the EC recovery chain must be unaffected.
#   Phase B (RESTORE): the credential store is restored to its original state.
#   Phase C (NORMAL): one more cold boot; mcp-notion must load again.
#
# The credential VALUE is never written by this script - it reads the live
# credential line, removes/restores it via file surgery that only touches the
# YAML line, and never echoes the token. Never rotates or deletes anything.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <this> [-SkipLive]
#        -SkipLive: only validate the orchestration contract (no restart).

param([switch]$SkipLive)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { $script:pass++; if ($Detail) { Write-Host "PASS  $Name  $Detail" } else { Write-Host "PASS  $Name" } }
    else { $script:fail++; if ($Detail) { Write-Host "FAIL  $Name  $Detail" } else { Write-Host "FAIL  $Name" } }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$restartScript = Join-Path $repoRoot 'restart-dsh-server-delayed.ps1'
$credsFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$patchFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'

function Get-HttpStatus([int]$Port = 3080) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8
        return [int]$r.StatusCode
    } catch { return -1 }
}

function Get-NotionMcpLoaded {
    # Best-effort live probe: ask the host for the notion MCP tool list. A
    # healthy loaded MCP returns data; when the entry is disabled it is absent.
    try {
        $probe = @'
const res = await fetch("http://127.0.0.1:3080/api/host.tools", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: "notion-probe", method: "host.tools", payload: {} })
});
const body = await res.json();
const names = [];
function walk(v) { if (!v) return; if (Array.isArray(v)) { v.forEach(walk); return; } if (typeof v === "object") { if (typeof v.name === "string") names.push(v.name); Object.values(v).forEach(walk); } }
walk(body);
console.log("NOTION_TOOLS", JSON.stringify(names.filter(n => n.toLowerCase().includes("notion") || n.startsWith("notion_"))));
'@
        $tmp = Join-Path $env:TEMP 'notion-probe.mjs'
        [System.IO.File]::WriteAllText($tmp, $probe, (New-Object System.Text.UTF8Encoding($false)))
        $out = node $tmp 2>&1 | Out-String
        if ($out -match 'NOTION_TOOLS\s+\[(.*?)\]') { return ($Matches[1].Trim() -ne '') }
        return $false
    } catch { return $false }
}

function Remove-CredentialRef([string]$Ref) {
    $lines = Get-Content -LiteralPath $credsFile -Encoding UTF8
    $out = @(); $removed = $false
    foreach ($l in $lines) {
        if ($l -match ("^[ \t]*" + [regex]::Escape($Ref) + "[ \t]*:")) { $removed = $true; continue }
        $out += $l
    }
    if ($removed) { [System.IO.File]::WriteAllLines($credsFile, $out, (New-Object System.Text.UTF8Encoding($false))) }
    return $removed
}

function Restore-CredentialRef([string]$Ref, [string]$RawLine) {
    $lines = Get-Content -LiteralPath $credsFile -Encoding UTF8
    $exists = $false
    foreach ($l in $lines) { if ($l -match ("^[ \t]*" + [regex]::Escape($Ref) + "[ \t]*:")) { $exists = $true } }
    if (-not $exists) {
        $lines += $RawLine
        [System.IO.File]::WriteAllLines($credsFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    }
}

# ---- contract checks (always run) -------------------------------------------
$patch = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
Check 'deployed patch has disabled safe-degrade' ($patch -match 'disabled:\s*!!js\s*"!process\.env\.NOTION_TOKEN"') ''
Check 'deployed patch env uses process.env' ($patch -match 'NOTION_TOKEN:\s*!!js\s*"process\.env\.NOTION_TOKEN') ''
Check 'deployed patch has no plaintext token' (-not ($patch -match 'NOTION_TOKEN:\s*ntn_')) ''
Check 'starter performs preflight before inject' (Select-String -Path (Join-Path $repoRoot 'start-dsh-server.ps1') -Pattern 'Invoke-DshNotionPreflight' -Quiet) ''
$preflightLog = Join-Path $env:LOCALAPPDATA 'DSHHarness\logs\credential-preflight.log'
Check 'preflight audit log exists' (Test-Path $preflightLog) ''

if ($SkipLive) {
    Write-Host ''
    Write-Host ($script:pass.ToString() + ' passed, ' + $script:fail.ToString() + ' failed (contract-only, live skipped)')
    if ($script:fail -gt 0) { exit 1 }
    exit 0
}

if (-not (Test-Path $restartScript)) { Write-Host "FAIL  restart script missing: $restartScript"; exit 1 }

# ---- Phase A: NEGATIVE cold boot (credential missing/bad) -------------------
Write-Host ''
Write-Host '=== Phase A: NEGATIVE cold boot (NOTION_TOKEN removed) ==='
$line = Get-Content -LiteralPath $credsFile -Encoding UTF8 | Where-Object { $_ -match '^[ \t]*NOTION_TOKEN[ \t]*:' } | Select-Object -First 1
if (-not $line) { Write-Host 'FAIL  NOTION_TOKEN line not found - cannot run negative phase'; exit 1 }
$removed = Remove-CredentialRef 'NOTION_TOKEN'
Check 'A1 credential ref removed for negative boot' $removed ''

& $restartScript -RestartAndWait -DelaySeconds 2 -Port 3080 -TimeoutSec 200 -Reason 'sh-r3-negative-boot' | Out-Null
Start-Sleep -Seconds 5
$status = Get-HttpStatus
Check 'A2 host HTTP 200 after negative cold boot' ($status -eq 200) ("http=" + $status)
$mcpLoaded = Get-NotionMcpLoaded
Check 'A3 mcp-notion NOT loaded (safe-degrade works for real)' (-not $mcpLoaded) ("loaded=" + $mcpLoaded)
# EC recovery chain unaffected: the session intent should still be present & not FAILED_FATAL
$intents = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\execution-intents.json'
$chainOk = $false
if (Test-Path $intents) {
    $j = Get-Content $intents -Raw | ConvertFrom-Json
    $bad = @($j.intents.PSObject.Properties | Where-Object { $_.Value.state -eq 'FAILED_FATAL' })
    $chainOk = ($bad.Count -eq 0)
}
Check 'A4 recovery chain unaffected (no FAILED_FATAL intents)' $chainOk ''
$preLog = Get-Content $preflightLog -Tail 5 -ErrorAction SilentlyContinue | Out-String
Check 'A5 preflight audit log records FAIL/SAFE-DEGRADE' ($preLog -match 'SAFE-DEGRADE') ''

# ---- Phase B: restore credential --------------------------------------------
Write-Host ''
Write-Host '=== Phase B: restore credential ==='
Restore-CredentialRef 'NOTION_TOKEN' $line
$restored = (Get-Content -LiteralPath $credsFile -Encoding UTF8 | Where-Object { $_ -match '^[ \t]*NOTION_TOKEN[ \t]*:' } | Select-Object -First 1) -ne $null
Check 'B1 credential restored' $restored ''

# ---- Phase C: NORMAL cold boot ----------------------------------------------
Write-Host ''
Write-Host '=== Phase C: NORMAL cold boot (credential present) ==='
& $restartScript -RestartAndWait -DelaySeconds 2 -Port 3080 -TimeoutSec 200 -Reason 'sh-r3-normal-boot' | Out-Null
Start-Sleep -Seconds 5
$status2 = Get-HttpStatus
Check 'C1 host HTTP 200 after normal cold boot' ($status2 -eq 200) ("http=" + $status2)
$mcpLoaded2 = Get-NotionMcpLoaded
Check 'C2 mcp-notion loaded again after restore' $mcpLoaded2 ("loaded=" + $mcpLoaded2)

Write-Host ''
Write-Host ($script:pass.ToString() + ' passed, ' + $script:fail.ToString() + ' failed')
if ($script:fail -gt 0) { Write-Host 'COLD-START CREDENTIAL GATE FAILED'; exit 1 }
Write-Host 'COLD-START CREDENTIAL GATE PASSED'
exit 0
