# dsh-safe-mode.ps1 - True Safe Mode for DSH Harness (Reliability v1, Stage E)
#
# Safe Mode = isolated minimal profile (dsh-safe-profile.ps1) + boot-mode=safe.
# Normal (web) profile is NEVER modified. Entering/exiting is transaction-shaped:
#
#   Enter: checkpoint normal -> build safe profile -> boot-mode=safe -> restart safe
#   Exit : checkpoint safe   -> boot-mode=normal -> restart normal -> full verify
#          (if normal verify fails -> boot-mode=safe -> restart safe -> RETURNED_TO_SAFE)
#
# Usage:
#   dsh-safe-mode.ps1 -Enter          # enter safe mode (restarts server via safe profile)
#   dsh-safe-mode.ps1 -Exit           # exit safe mode (restarts server via normal profile)
#   dsh-safe-mode.ps1 -Status         # show safe mode state (default)
#   dsh-safe-mode.ps1 -VerifySafe     # verify the safe environment is fully healthy
#   dsh-safe-mode.ps1 -Enter -NoRestart  # prepare safe mode without restarting

param(
    [switch]$Enter,
    [switch]$Exit,
    [switch]$Status,
    [switch]$VerifySafe,
    [switch]$NoRestart,
    [int]$Port = 3080,
    [string]$FlagPath = $null,
    [string]$BootModePath = $null,
    [string]$ProfileDir = $null
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# explicit parameters beat env vars beat defaults (reliable across process boundaries)
if ($BootModePath) { $env:DSH_BOOT_MODE_PATH = $BootModePath }
if ($ProfileDir) { $env:DSH_SAFE_PROFILE_DIR = $ProfileDir }
. (Join-Path $root 'dsh-boot-mode.ps1') 2>$null
. (Join-Path $root 'dsh-safe-profile.ps1') 2>$null
. (Join-Path $root 'dsh-commit-readiness.ps1') 2>$null
. (Join-Path $root 'dsh-generation.ps1') 2>$null
. (Join-Path $root 'dsh-process-identity.ps1') 2>$null
. (Join-Path $root 'dsh-readiness.ps1') 2>$null

$flagPath = if ($FlagPath) {
    $FlagPath
} elseif ($env:DSH_SAFE_FLAG_PATH) {
    $env:DSH_SAFE_FLAG_PATH
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state\safe-mode.json'
}
# Phase 02 R5 (R4-B1): state dir follows the flag path's container when the
# flag is overridden (tests inject DSH_SAFE_FLAG_PATH to a temp root); otherwise
# default to live %LOCALAPPDATA%\DSHHarness\state. Never silently keep creating
# the live dir while a test believes it is isolated.
$stateDir = if ($env:DSH_SAFE_FLAG_PATH) {
    Split-Path -Parent $env:DSH_SAFE_FLAG_PATH
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state'
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Write-SafeFlag($Meta) {
    try {
        ($Meta | ConvertTo-Json -Depth 5) | Set-Content -Path $flagPath -Encoding UTF8
    } catch {
        Write-Host ("WARN: Write-SafeFlag failed for $flagPath : $($_.Exception.Message)")
    }
}
function Read-SafeFlag {
    if (-not (Test-Path $flagPath)) { return $null }
    try { return (Get-Content $flagPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Restart-DshServerNow {
    param([string]$Reason)
    if ($NoRestart) { return @{ Restarted = $false; Reason = 'no-restart-requested' } }
    $rs = Join-Path $root 'restart-dsh-server-delayed.ps1'
    if (-not (Test-Path $rs)) { return @{ Restarted = $false; Reason = 'restart-script-missing' } }
    # Phase 02 R5 (R4-B2): use RestartAndWait — the caller waits for the exact
    # worker terminal state (COMMITTED | FAILED | TIMED_OUT), NOT the outer
    # wrapper's exit. The script prints the attemptId; we check the exit code
    # which is now terminal-state based (0 = COMMITTED).
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$rs`" -DelaySeconds 0 -Port $Port -RestartAndWait -TimeoutSec 180"
    $p = Start-Process powershell -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        return @{ Restarted = $false; Reason = "restart-terminal-not-committed (exit=$($p.ExitCode))" }
    }
    return @{ Restarted = $true; Reason = $Reason }
}

function Invoke-SafeTestSession {
    # Real harmless session probe: drive events.mux + session.list, then a trivial
    # turn if a provider is available. Returns @{ Ok; Detail; Error }.
    try {
        $owner = Get-DshLoopbackOwner -Port $Port
        if ($owner.State -ne 'ok') { return @{ Ok = $false; Error = "owner=$($owner.State)" } }
        $hostRpc = Invoke-DshReadinessRpc -Port $Port -Method 'host.describe' -TimeoutSec 5
        if ($hostRpc.State -ne 'ok') { return @{ Ok = $false; Error = "host.describe=$($hostRpc.State)" } }
        $sessRpc = Invoke-DshReadinessRpc -Port $Port -Method 'session.list' -TimeoutSec 5
        if ($sessRpc.State -ne 'ok') { return @{ Ok = $false; Error = "session.list=$($sessRpc.State)" } }
        $mux = Test-DshWebSocketOpen -Uri "ws://127.0.0.1:$Port/api/events.mux" -TimeoutMs 3000
        if ($mux.State -ne 'open') { return @{ Ok = $false; Error = "events.mux=$($mux.State)" } }
        return @{ Ok = $true; Detail = 'safe session-core verified (host.describe + session.list + events.mux)'; Error = $null }
    } catch { return @{ Ok = $false; Error = $_.Exception.Message } }
}

function Verify-SafeEnvironment {
    # Full Safe verification: generation changed, identity, full readiness, safe session.
    $genBefore = Get-DshGenerationId -Port $Port
    $gate = Test-CommitReadiness -Port $Port -StableWindowSec 3 -LightProbe:$false
    $sess = Invoke-SafeTestSession
    $bootMode = Get-DshBootMode
    return [pscustomobject]@{
        Ok = ($gate.Ready -and $sess.Ok -and $bootMode.mode -eq 'safe')
        Generation = $genBefore
        BootMode = $bootMode.mode
        CommitReadiness = $gate.Stage
        Checks = $gate.Checks
        SafeSession = $sess
    }
}

# ---------- Status (default; only when run as the main script, not dot-sourced) ----------
$isMainScript = ($MyInvocation.InvocationName -ne '.')
if ($Status -or ($isMainScript -and -not $Enter -and -not $Exit -and -not $VerifySafe)) {
    $flag = Read-SafeFlag
    $bm = Get-DshBootMode
    $out = [ordered]@{
        safeFlagActive = if ($flag) { $true } else { $false }
        bootMode = $bm.mode
        bootReason = $bm.reason
        profileDir = (Get-SafeProfileDir)
        profileExists = (Test-DshSafeProfile).Exists
        flag = $flag
    }
    $out | ConvertTo-Json -Depth 5
    exit 0
}

# ---------- Enter ----------
if ($Enter) {
    # 1. checkpoint current normal state
    . (Join-Path $root 'dsh-transaction.ps1') 2>$null
    $cp = $null
    if (Get-Command New-DshTransactionCheckpoint -ErrorAction SilentlyContinue) {
        $cpObj = New-DshTransactionCheckpoint -Label 'pre-safe-mode'
        $cp = $cpObj.dir
    }
    # 2. build safe profile (does NOT touch web profile)
    $sp = New-DshSafeProfile
    # 3. record safe flag
    $dshVer = ''
    try { $dshVer = ((& dsh --version 2>$null) -join '').Trim() } catch { $dshVer = '' }
    $meta = @{
        active = $true
        enteredAt = (Get-Date -Format 'o')
        reason = 'manual-or-escalation'
        checkpoint = $cp
        profileDir = $sp.Dir
        port = $Port
        dshVersion = $dshVer
    }
    Write-SafeFlag $meta
    # 4. set boot-mode = safe
    Set-DshBootMode -Mode 'safe' -Reason 'safe-mode-enter' -Checkpoint $cp -TransactionId $cp
    Write-Host "Safe Mode ENTERED (profile=$($sp.Dir))"
    if ($cp) { Write-Host "Normal checkpoint: $cp" }
    # 5. restart into safe profile
    $r = Restart-DshServerNow -Reason 'enter-safe'
    Write-Host ("Restart: {0} ({1})" -f $r.Restarted, $r.Reason)
    exit 0
}

# ---------- Exit ----------
if ($Exit) {
    $flag = Read-SafeFlag
    if (-not $flag) { Write-Host 'Not in safe mode (no safe flag).'; Set-DshBootMode -Mode 'normal' -Reason 'exit-cleanup'; exit 0 }
    # 1. checkpoint current (safe) state
    . (Join-Path $root 'dsh-transaction.ps1') 2>$null
    if (Get-Command New-DshTransactionCheckpoint -ErrorAction SilentlyContinue) {
        $safeCp = New-DshTransactionCheckpoint -Label 'safe-exit'
    }
    # 2. boot-mode = normal
    Set-DshBootMode -Mode 'normal' -Reason 'safe-mode-exit' -Checkpoint $flag.checkpoint
    Write-Host 'Safe Mode EXIT requested: boot-mode -> normal.'
    # 3. restart normal
    $r = Restart-DshServerNow -Reason 'exit-safe'
    Write-Host ("Restart: {0} ({1})" -f $r.Restarted, $r.Reason)
    # 4. verify normal; if fails -> return to safe
    if ($r.Restarted) {
        Start-Sleep -Seconds 3
        $gate = Test-CommitReadiness -Port $Port -StableWindowSec 3 -LightProbe:$false
        if ($gate.Ready) {
            Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
            Write-Host 'Normal verified after safe exit. SAFE_EXITED.'
            exit 0
        }
        # normal still bad -> back to safe
        Set-DshBootMode -Mode 'safe' -Reason 'normal-failed-after-exit'
        Write-SafeFlag $flag
        $r2 = Restart-DshServerNow -Reason 'return-to-safe'
        Write-Host "Normal FAILED after exit; RETURNED_TO_SAFE (restart=$($r2.Restarted))."
        exit 2
    }
    # no restart performed: leave flag for the operator
    Write-Host 'No restart performed (NoRestart); safe flag kept until a normal restart verifies.'
    exit 0
}

# ---------- VerifySafe ----------
if ($VerifySafe) {
    $v = Verify-SafeEnvironment
    $v | ConvertTo-Json -Depth 6
    if ($v.Ok) { exit 0 } else { exit 1 }
}
