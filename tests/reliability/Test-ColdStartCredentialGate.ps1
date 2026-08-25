# Test-ColdStartCredentialGate.ps1 - Phase 02 Security-Hardening SH-R4.
#
# REAL, repeatable, self-contained Harness cold-start credential gate.
#
# The controller (this script) is DELIBERATELY decoupled from the DSH host
# lifetime: it spawns an INDEPENDENT worker process (Start-Process) that runs
# the three phases. When the negative cold boot restarts/stops the DSH host,
# the worker is NOT a child of the host, so it always survives to run
# restore + normal cold boot. The worker persists its results to a JSON file
# the controller waits on, and wraps every credential mutation in try/finally
# with a byte-for-byte restore of the original credentials file.
#
#   Phase A (NEGATIVE): NOTION_TOKEN removed -> restart -> require
#       probe_ok == true && notion_loaded == false (host 200, other plugins ok,
#       recovery chain unaffected). The Notion probe is STRUCTURED:
#       { probe_ok, notion_loaded, tool_count, error } - a failed probe is NOT
#       treated as "notion not loaded".
#   Phase B (RESTORE): original credentials file bytes restored (byte-for-byte).
#   Phase C (NORMAL): one more cold boot -> notion_loaded must be true.
#
# Failure safety: if ANY phase throws, the worker's finally block restores the
# credentials file byte-for-byte BEFORE exiting non-zero. The controller then
# reports the stuck/failed state. NEVER rotates or deletes anything.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <this> [-SkipLive]
#   -SkipLive: contract checks only (no restart, CI-safe).
#   -DryRun:   launch the worker but skip actual restarts (orchestration test,
#              injects -NoRestart into the worker) - used to prove the
#              controller/worker independence and rollback without touching the
#              live host.

param(
    [switch]$SkipLive,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { $script:pass++; if ($Detail) { Write-Host "PASS  $Name  $Detail" } else { Write-Host "PASS  $Name" } }
    else { $script:fail++; if ($Detail) { Write-Host "FAIL  $Name  $Detail" } else { Write-Host "FAIL  $Name" } }
}

# ---- all live runtime paths, defined UP FRONT (SH-R4 fix: $preflightLog was
#      referenced but never defined in SH-R3) ---------------------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$restartScript = Join-Path $repoRoot 'restart-dsh-server-delayed.ps1'
$credsFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$patchFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
$preflightLog = Join-Path $env:LOCALAPPDATA 'DSHHarness\logs\credential-preflight.log'
$intentsFile = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\execution-intents.json'
$workerScript = Join-Path $here 'coldstart-gate-worker.ps1'
$workerResult = Join-Path $env:TEMP ("coldstart-gate-result-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')

# ---- contract checks (always run; template file in contract mode) -----------
if ($SkipLive -or $DryRun) {
    $patchTemplate = Join-Path $repoRoot 'plugins\cordis.patch.yml'
    $patch = Get-Content -LiteralPath $patchTemplate -Raw -Encoding UTF8
    Check 'patch template has disabled safe-degrade' ($patch -match 'disabled:\s*!!js\s*"!process\.env\.NOTION_TOKEN"') ''
    Check 'patch template env uses process.env' ($patch -match 'NOTION_TOKEN:\s*!!js\s*"process\.env\.NOTION_TOKEN') ''
    Check 'patch template has no plaintext token' (-not ($patch -match 'NOTION_TOKEN:\s*ntn_')) ''
} else {
    $patch = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Check 'deployed patch has disabled safe-degrade' ($patch -match 'disabled:\s*!!js\s*"!process\.env\.NOTION_TOKEN"') ''
    Check 'deployed patch env uses process.env' ($patch -match 'NOTION_TOKEN:\s*!!js\s*"process\.env\.NOTION_TOKEN') ''
    Check 'deployed patch has no plaintext token' (-not ($patch -match 'NOTION_TOKEN:\s*ntn_')) ''
}
Check 'starter performs preflight before inject' (Select-String -Path (Join-Path $repoRoot 'start-dsh-server.ps1') -Pattern 'Invoke-DshNotionPreflight' -Quiet) ''
$helper = Join-Path $repoRoot 'dsh-credential-preflight.ps1'
Check 'preflight helper has auditable log function' ((Test-Path $helper) -and (Select-String -Path $helper -Pattern 'Write-DshPreflightResultLog' -Quiet)) ''
Check 'worker script exists' (Test-Path $workerScript) $workerScript
if ($SkipLive -or $DryRun) {
    Check 'preflight log path is defined for live mode' (-not [string]::IsNullOrWhiteSpace($preflightLog)) ''
}

if ($SkipLive) {
    Write-Host ''
    Write-Host ($script:pass.ToString() + ' passed, ' + $script:fail.ToString() + ' failed (contract-only, live skipped)')
    if ($script:fail -gt 0) { exit 1 }
    exit 0
}

# ---- live: spawn an INDEPENDENT controller of the DSH server restart --------
if (-not (Test-Path $restartScript)) { Write-Host "FAIL  restart script missing: $restartScript"; exit 1 }

Write-Host ''
Write-Host '=== spawning independent worker (decoupled from DSH host lifetime) ==='
$workerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$workerScript`"",
    '-CredsFile', "`"$credsFile`"",
    '-PatchFile', "`"$patchFile`"",
    '-PreflightLog', "`"$preflightLog`"",
    '-IntentsFile', "`"$intentsFile`"",
    '-RestartScript', "`"$restartScript`"",
    '-ResultFile', "`"$workerResult`"",
    '-Port', '3080')
if ($DryRun) { $workerArgs += '-NoRestart' }
# Start-Process makes the worker a sibling of THIS process (not a child of the
# DSH server), so it survives the negative cold boot.
$workerProc = Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArgs -WindowStyle Hidden -PassThru
Write-Host "worker pid=$($workerProc.Id) result=$workerResult"

# ---- controller waits on the worker (poll result file, bounded) -------------
$deadline = (Get-Date).AddMinutes(15)
$result = $null
while ((Get-Date) -lt $deadline) {
    if (Test-Path $workerResult) {
        try { $result = Get-Content -LiteralPath $workerResult -Raw -Encoding UTF8 | ConvertFrom-Json; break }
        catch { Start-Sleep -Seconds 2 }
    }
    if ($workerProc.HasExited) {
        if (-not (Test-Path $workerResult)) { Start-Sleep -Seconds 3; if (Test-Path $workerResult) { $result = Get-Content -LiteralPath $workerResult -Raw -Encoding UTF8 | ConvertFrom-Json } }
        if (-not $result) {
            Write-Host ('FAIL  worker exited early (code ' + $workerProc.ExitCode + ') without a result file')
            $script:fail++
            break
        }
    }
    Start-Sleep -Seconds 3
}

if (-not $result) {
    Write-Host 'FAIL  worker did not produce a result within 8 minutes'
    $script:fail++
} else {
    foreach ($item in $result.checks) {
        Check $item.name ([bool]$item.ok) ([string]$item.detail)
    }
}

# ---- cleanup ----------------------------------------------------------------
Remove-Item -LiteralPath $workerResult -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ($script:pass.ToString() + ' passed, ' + $script:fail.ToString() + ' failed')
if ($script:fail -gt 0) { Write-Host 'COLD-START CREDENTIAL GATE FAILED'; exit 1 }
Write-Host 'COLD-START CREDENTIAL GATE PASSED'
exit 0