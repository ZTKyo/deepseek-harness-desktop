# Test-ColdStartCredentialGate.ps1 - Phase 02 Security-Hardening SH-R4.
#
# REAL, repeatable, self-contained Harness cold-start credential gate.
#
# The controller (this script) is DELIBERATELY decoupled from the DSH host
# lifetime: it spawns an INDEPENDENT worker process (Start-Process) that runs
# the three phases. IMPORTANT (SH-R5): Start-Process does NOT guarantee the
# worker is outside the DSH process tree on Windows - the child can still sit
# under the host's job/process tree and be killed when the host restarts. The
# reliable guarantee is: (1) the worker runs restore + normal cold boot in its
# try/finally BEFORE any exit, and (2) if the worker itself is killed mid-way,
# the guardian's orphan-lock backstop re-raises the host, and the credentials
# file is restored by the worker's finally whenever the worker does exit. The
# worker persists its results to a JSON file the controller waits on, and wraps
# every credential mutation in try/finally
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
#   -KillInjection: SH-R6 fault injection - after the worker mutates the
#              credential (removes NOTION_TOKEN), the CONTROLLER force-kills the
#              worker (Stop-Process -Force) and asserts the CONTROLLER (the
#              restore owner, independent of the kill target) restored the file
#              byte-for-byte (SHA256) with DACL unchanged, before the normal
#              host/Notion cold boot proceeds. Proves restore does NOT depend
#              on the worker's finally.

param(
    [switch]$SkipLive,
    [switch]$DryRun,
    [switch]$KillInjection
)

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { $script:pass++; if ($Detail) { Write-Host "PASS  $Name  $Detail" } else { Write-Host "PASS  $Name" } }
    else { $script:fail++; if ($Detail) { Write-Host "FAIL  $Name  $Detail" } else { Write-Host "FAIL  $Name" } }
}

# ---- SH-R6: the CONTROLLER is the restore owner -----------------------------
# It captures the original bytes/SHA256/DACL BEFORE spawning the worker, so the
# credential can be restored even if the worker (a possible DSH-tree child) is
# hard-killed mid-mutation. NEVER touches the token value - only bytes.
# (capture block runs after the live paths are defined below)

function Restore-OriginalCredential {
    param([switch]$Assert)
    if ($null -ne $originalCredBytes -and $originalCredBytes.Length -gt 0) {
        [System.IO.File]::WriteAllBytes($credsFile, $originalCredBytes)
    }
    if ($Assert) {
        $shaNow = (Get-FileHash -LiteralPath $credsFile -Algorithm SHA256).Hash
        $daclNow = (icacls $credsFile 2>&1 | Out-String)
        Check 'R1 credential SHA256 restored by CONTROLLER' ($shaNow -eq $originalCredSha) ("sha=" + $shaNow.Substring(0, 12))
        Check 'R2 credential DACL unchanged by CONTROLLER restore' ($daclNow -eq $originalCredDacl) ('dacl-identical=' + ($daclNow -eq $originalCredDacl))
    }
}

# ---- controller-side live probes (used by KillInjection acceptance) ----------
function Wait-HttpReady2([int]$MaxSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($MaxSeconds)
    while ((Get-Date) -lt $deadline) {
        try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 8; if ($r.StatusCode -eq 200) { return $true } } catch { }
        Start-Sleep -Seconds 3
    }
    return $false
}
function Get-NotionMcpLoaded2 {
    [pscustomobject]$result = @{ probe_ok = $false; notion_loaded = $false; tool_count = 0; error = '' }
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='npx.exe' OR Name='cmd.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -match 'notion-mcp-server' }
        $list = @($procs)
        $result.probe_ok = $true
        $result.tool_count = $list.Count
        $result.notion_loaded = ($list.Count -gt 0)
        return $result
    } catch {
        $result.error = $_.Exception.Message
        return $result
    }
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

# ---- SH-R6: capture the original credential BEFORE any mutation --------------
$originalCredBytes = $null
$originalCredSha = $null
$originalCredDacl = $null
if (Test-Path $credsFile) {
    $originalCredBytes = [System.IO.File]::ReadAllBytes($credsFile)
    $originalCredSha = (Get-FileHash -LiteralPath $credsFile -Algorithm SHA256).Hash
    $originalCredDacl = (icacls $credsFile 2>&1 | Out-String)
}

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
if ($KillInjection) { $workerArgs += '-WaitForKillMarker' }
# Start-Process spawns the worker as a new process. SH-R5/R6 note: this does NOT
# guarantee it is outside the DSH process tree; the REAL safety contract is the
# CONTROLLER as restore owner (it captured the original bytes above and can
# restore even if the worker is hard-killed) + the worker's try/finally as a
# best-effort fast path + the guardian's orphan-lock backstop for the host.
$workerProc = Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArgs -WindowStyle Hidden -PassThru
Write-Host "worker pid=$($workerProc.Id) result=$workerResult"

# ---- SH-R6 fault injection: hard-kill the worker AFTER it mutated ------------
# The worker (with -WaitForKillMarker) removes NOTION_TOKEN, writes a marker
# file, then parks. We force-kill it here - its finally never runs - and the
# CONTROLLER restores the credential. This proves restore does NOT depend on
# the worker's finally.
if ($KillInjection) {
    Write-Host '=== KILL INJECTION: waiting for worker mutation marker ==='
    $killMarker = Join-Path $env:TEMP 'coldstart-kill-marker.txt'
    $killDeadline = (Get-Date).AddSeconds(60)
    $markerSeen = $false
    while ((Get-Date) -lt $killDeadline) {
        if (Test-Path $killMarker) { $markerSeen = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $markerSeen) {
        Write-Host 'FAIL  worker did not reach mutation marker in 60s'
        $script:fail++
    } else {
        # force-kill the worker (finally will NOT run)
        Stop-Process -Id $workerProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Check 'K1 worker force-killed (finally bypassed)' ($workerProc.HasExited) ("exited=" + $workerProc.HasExited)
        # CONTROLLER restores + asserts SHA/DACL (the real safety contract)
        Restore-OriginalCredential -Assert
    }
    Remove-Item -LiteralPath $killMarker -Force -ErrorAction SilentlyContinue
}

# ---- controller waits on the worker (poll result file, bounded) -------------
# In KillInjection mode the worker was intentionally killed (restore done by
# the CONTROLLER above), so there is no result file to wait for - skip the poll.
if (-not $KillInjection) {
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
} # end: skip poll in KillInjection mode

if ($KillInjection) {
    # KillInjection already asserted restore via R1/R2; nothing to aggregate.
    Write-Host ''
    Write-Host 'KILL-INJECTION MODE: worker killed, credential restored by CONTROLLER (R1/R2 above).'
    if ($DryRun) {
        Write-Host '(dry-run: normal cold boot acceptance skipped - no real restart)'
    } else {
        # SH-R6 acceptance: after the kill + controller restore, a NORMAL cold
        # boot must still bring the host up with Notion MCP loaded (credential
        # intact).
        Write-Host '=== normal cold boot after kill-injection restore (acceptance) ==='
        & $restartScript -RestartAndWait -DelaySeconds 2 -Port 3080 -TimeoutSec 240 -Reason 'sh-r6-kill-injection-restore' | Out-Null
        $httpOk = Wait-HttpReady2 -MaxSeconds 90
        Check 'K2 host HTTP 200 after kill-injection restore + cold boot' $httpOk ("http=" + $(if ($httpOk) { 200 } else { -1 }))
        $probeK = Get-NotionMcpLoaded2
        Check 'K3 mcp-notion loaded after kill-injection restore' ($probeK.probe_ok -eq $true -and $probeK.notion_loaded -eq $true) ("probe_ok=" + $probeK.probe_ok + " notion_loaded=" + $probeK.notion_loaded + " error=" + $probeK.error)
    }
} elseif (-not $result) {
    Write-Host 'FAIL  worker did not produce a result within 15 minutes'
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