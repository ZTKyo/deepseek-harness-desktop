# restart-dsh-server-delayed.ps1 - apply cordis.patch.yml by restarting the 3080 server.
# Phase 02 P2-0 (Automatic Restart Ownership & Worker Survival):
#   When invoked from the Harness/Agent tool context, the caller's process tree is
#   a CHILD of the DSH server itself. Stopping the server would therefore kill this
#   worker mid-restart (R4 evidence: restart log truncated after validate, old server
#   exitCode=-1, maintenance lock left behind, guardian paused self-heal, manual
#   Desktop relaunch required).
#   Fix: -Detach (default) spawns the REAL restart work in a WMI-created detached
#   process (parent = WmiPrvSE.exe, NOT the DSH tree). The detached worker owns the
#   whole stop -> start -> verify -> finally-cleanup-lock lifecycle, so it survives
#   the old server shutdown and always releases the maintenance lock.
# Log: %LOCALAPPDATA%\DSHHarness\logs\restart-apply-patch.log
param(
    [int]$DelaySeconds = 2,
    [int]$Port = 3080,
    [switch]$Detach,          # default ON: spawn detached worker via WMI
    [switch]$WorkerMode       # internal: run the actual restart logic (spawned by Detach)
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:LOCALAPPDATA "DSHHarness\logs\restart-apply-patch.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$lockFile = Join-Path $env:USERPROFILE '.dsh\guardian-maintenance.lock'

function Write-Log([string]$msg) {
    Add-Content $log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# ---------- DETACH MODE: spawn the worker in an independent process ----------
# The caller (agent tool tree) is a child of the DSH server. If we run the restart
# here, stopping the server kills us before finally{} can release the lock. So we
# re-invoke this script as a NEW process via Start-Process (hidden window). Even if
# the new process is still under the DSH tree, the guardian now detects an orphaned
# maintenance lock (worker PID dead -> clears lock -> takes over restart), so a dead
# worker can NEVER wedge self-heal. This is the equivalent lock-lost takeover.
if (-not $WorkerMode) {
    $useDetach = $Detach -or (-not $env:DSH_RESTART_WORKER_MODE)
    if ($useDetach) {
        Write-Log ("detach: spawning worker for port $Port (delay=$DelaySeconds)")
        # Use short path (8.3) to avoid spaces breaking the -Command string
        $shortRoot = try { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { $root }
        $shortSelf = Join-Path $shortRoot 'restart-dsh-server-delayed.ps1'
        # Use -Command with dot-source (NOT -File): WMI/Start-Process created
        # processes cannot load .ps1 via -File in some contexts (verified).
        $inner = '. "' + $shortSelf + '" -WorkerMode -DelaySeconds ' + $DelaySeconds + ' -Port ' + $Port
        $env:DSH_RESTART_WORKER_MODE = '1'   # nested call must not re-detach
        try {
            # Start-Process hidden window (verified working). Even if the worker dies
            # with the DSH tree, the guardian's orphaned maintenance-lock detection
            # clears the lock and takes over recovery (backstop).
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = 'powershell.exe'
            $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'
            $psi.UseShellExecute = $true
            $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
            $proc = [System.Diagnostics.Process]::Start($psi)
            if ($proc) {
                Write-Log ("detach: worker spawned via Start-Process pid=$($proc.Id) (guardian orphan takeover as backstop)")
                exit 0
            }
            Write-Log "detach: Start-Process returned no process"
        } catch {
            Write-Log ("detach: Start-Process failed: $($_.Exception.Message)")
        }
        Write-Log "detach: spawn failed; running inline (risk: worker may die with server; guardian orphan takeover is the backstop)"
    }
    # Fallback (no detach / spawn unavailable): run inline. NOTE: if the caller is the
    # agent tool tree this may still die with the server, but the guardian's orphaned
    # maintenance-lock detection will clear the lock and take over recovery.
    if (-not $env:DSH_RESTART_WORKER_MODE) { $env:DSH_RESTART_WORKER_MODE = '1' }
}

# ================= WORKER MODE: real restart logic =================
. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-readiness.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')

Start-Sleep -Seconds $DelaySeconds
Write-Log ("restart begin (port {0})" -f $Port)

$restartLock = Enter-DshRestartLock
if (-not $restartLock) {
    Write-Log ("restart skipped: another start/restart transaction owns the lock")
    exit 75
}

# maintenance lock: tell the guardian to stay out of the way while we restart
# (otherwise it auto-starts a second instance -> EADDRINUSE crash + alert spam).
# Phase 02 P2-0: lock payload now records the worker PID so the guardian can
# detect a dead (lost) worker and take over recovery.
$lockPayload = @{ pid = $PID; ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); port = $Port } | ConvertTo-Json -Compress
try { Set-Content -Path $lockFile -Value $lockPayload -Encoding UTF8 } catch { Write-Log "lock write failed: $($_.Exception.Message)" }

try {

$budgetGate = Test-DshRestartAllowed
if (-not $budgetGate.Allowed) { throw "restart budget blocked: $($budgetGate.Reason)" }
Register-DshRestartAttempt 'delayed-restart' | Out-Null

# stop the old DSH server only after loopback ownership is proven
$owner = Get-DshLoopbackOwner -Port $Port
if ($owner.State -eq 'ok') {
    Write-Log ("validated DSH loopback PID {0} creation={1} cmdHash={2}" -f $owner.Pid, $owner.Snapshot.CreationDate, $owner.Snapshot.CommandLineHash)
    $stop = Stop-DshLoopbackOwner -Port $Port -ExpectedPid $owner.Pid
    Write-Log ("stop result: {0} reason={1}" -f $stop.State, $stop.Reason)
    if ($stop.State -ne 'stopped') { throw "DSH loopback owner was not stopped: $($stop.State)" }
} elseif ($owner.State -eq 'none') {
    Write-Log ("no DSH loopback owner; nonLoopbackListeners={0}" -f $owner.NonLoopbackCount)
} else {
    Write-Log ("restart aborted: unsafe owner state={0} pid={1} nonLoopbackListeners={2}" -f $owner.State, $owner.Pid, $owner.NonLoopbackCount)
    throw "Unsafe DSH loopback owner state: $($owner.State)"
}
$free = ((Get-DshLoopbackOwner -Port $Port).State -eq 'none')
Write-Log ("DSH loopback free: {0}" -f $free)
if (-not $free) { throw 'DSH loopback port is still occupied; refusing to start a second instance' }

# start fresh via the standard autostart guard (detached, no window)
$starter = Join-Path $root 'start-dsh-server.ps1'
if (Test-Path $starter) {
    # Do not invoke the starter through `&`: its detached server child can inherit
    # this process's output pipes, leaving the restart transaction hung forever
    # even after the starter itself has exited. A shell-executed hidden child has
    # no redirected handles; wait only for that direct starter process.
    $starterPsi = New-Object System.Diagnostics.ProcessStartInfo
    $starterPsi.FileName = 'powershell.exe'
    $starterPsi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -Port ' + $Port + ' -LockAlreadyHeld'
    $starterPsi.UseShellExecute = $true
    $starterPsi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $starterProc = [System.Diagnostics.Process]::Start($starterPsi)
    if (-not $starterProc) { throw 'Unable to launch start-dsh-server.ps1' }
    $starterProc.WaitForExit()
    $starterCode = $starterProc.ExitCode
    Write-Log ("starter exit code: {0}" -f $starterCode)
    # Phase 02 R2: starter exit code is advisory only. start-dsh-server.ps1
    # returns 2 when client_ready is not reached within its own short window,
    # but the launcher/server it spawned continues booting to client_ready on
    # its own (observed 2026-08-23 23:17: server 20432 reached client_ready
    # moments after starter exited 2). We do NOT fail here; the stable-window
    # readiness + COMMIT_READY check below is the authoritative verification.
    # exit 75 = restart lock held by another transaction (concurrent restart).
    if ($starterCode -eq 75) { throw "start-dsh-server.ps1: another restart transaction owns the lock" }
} else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/S /C ""dsh" web --port ' + $Port + ' > "' + (Join-Path $env:LOCALAPPDATA ("DSHHarness\logs\dsh-server-" + $Port + ".log")) + '" 2>&1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $env:USERPROFILE
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

# verify actual DSH readiness, not only a root-page HTTP 200.
# Phase 02 R2: wait up to 60s for client_ready (the starter may have exited
# before its own short window saw client_ready; the server keeps booting).
$ready = $null
for ($i = 0; $i -lt 60; $i++) {
    $ready = Test-DshReadiness -Port $Port -RequireWebSockets
    if ($ready.State -eq 'client_ready') { break }
    Start-Sleep -Seconds 1
}
Write-Log ("readiness: {0} error={1} (waited {2}s)" -f $ready.State, $ready.Error, $i)
if ($ready.State -ne 'client_ready') { throw "DSH client readiness failed: $($ready.State)" }

# Phase 02 Reviewer Round 1 (BLOCKING-4): stable-window commit.
# client_ready = candidate stage only (does NOT reset budget). We wait a stable
# window, then re-verify readiness + COMMIT_READY, and only then commit success
# (which resets the budget). A crash inside the window does not clear attempts.
Register-DshRestartCandidate | Out-Null
$stableSec = if ($env:DSH_RESTART_STABLE_WINDOW_SEC) { [int]$env:DSH_RESTART_STABLE_WINDOW_SEC } else { 30 }
Write-Log ("stable window: waiting {0}s before commit" -f $stableSec)
Start-Sleep -Seconds $stableSec

# Re-verify after the window: readiness + COMMIT_READY.
$ready2 = Test-DshReadiness -Port $Port -RequireWebSockets
Write-Log ("stable re-check readiness: {0} error={1}" -f $ready2.State, $ready2.Error)
if ($ready2.State -ne 'client_ready') { throw "stable re-check failed: $($ready2.State)" }

# COMMIT_READY: full runtime surface (process identity + host.describe + session.list
# + events.mux/host + renderer + stable window + light probe). Budget resets ONLY here.
$crScript = Join-Path $root 'dsh-commit-readiness.ps1'
$commitOk = $false
if (Test-Path $crScript) {
    try {
        . $crScript
        if (Get-Command Test-CommitReadiness -ErrorAction SilentlyContinue) {
            $gate = Test-CommitReadiness -Port $Port -StableWindowSec 2 -LightProbe:$false
            $commitOk = ($gate -and $gate.Ready -eq $true)
            Write-Log ("COMMIT_READY: {0} stage={1}" -f $commitOk, $(if ($gate) { $gate.Stage } else { 'n/a' }))
        }
    } catch {
        Write-Log ("COMMIT_READY error: {0}" -f $_.Exception.Message)
    }
}
if (-not $commitOk) { throw "COMMIT_READY failed after stable window; budget NOT reset" }

Confirm-DshRestartStable | Out-Null
Write-Log "restart committed (stable window + COMMIT_READY; budget reset)"
} finally {
    # release maintenance lock (guardian resumes auto-recovery)
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-Log ("maintenance lock released")
    Exit-DshRestartLock $restartLock
}
