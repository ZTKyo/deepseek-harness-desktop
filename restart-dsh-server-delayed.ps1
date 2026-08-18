# restart-dsh-server-delayed.ps1 - apply cordis.patch.yml by restarting the 3080 server.
# Used once by the 2026-08-14 optimization: sleeps first so the current agent turn
# finishes cleanly, then restarts `dsh web` on 3080 with the patched profile.
# Log: %LOCALAPPDATA%\DSHHarness\logs\restart-apply-patch.log
param(
    [int]$DelaySeconds = 120,
    [int]$Port = 3080
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-readiness.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')
$log = Join-Path $env:LOCALAPPDATA "DSHHarness\logs\restart-apply-patch.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

Start-Sleep -Seconds $DelaySeconds
Add-Content $log ("{0}  restart begin (port {1})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Port)

$restartLock = Enter-DshRestartLock
if (-not $restartLock) {
    Add-Content $log ("{0}  restart skipped: another start/restart transaction owns the lock" -f (Get-Date -Format 'HH:mm:ss'))
    exit 75
}

# maintenance lock: tell the guardian to stay out of the way while we restart
# (otherwise it auto-starts a second instance -> EADDRINUSE crash + alert spam)
$lockFile = Join-Path $env:USERPROFILE '.dsh\guardian-maintenance.lock'
try { Set-Content -Path $lockFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) -Encoding UTF8 } catch {}

try {

$budgetGate = Test-DshRestartAllowed
if (-not $budgetGate.Allowed) { throw "restart budget blocked: $($budgetGate.Reason)" }
Register-DshRestartAttempt 'delayed-restart' | Out-Null

# stop the old DSH server only after loopback ownership is proven
$owner = Get-DshLoopbackOwner -Port $Port
if ($owner.State -eq 'ok') {
    Add-Content $log ("{0}  validated DSH loopback PID {1} creation={2} cmdHash={3}" -f (Get-Date -Format 'HH:mm:ss'), $owner.Pid, $owner.Snapshot.CreationDate, $owner.Snapshot.CommandLineHash)
    $stop = Stop-DshLoopbackOwner -Port $Port -ExpectedPid $owner.Pid
    Add-Content $log ("{0}  stop result: {1} reason={2}" -f (Get-Date -Format 'HH:mm:ss'), $stop.State, $stop.Reason)
    if ($stop.State -ne 'stopped') { throw "DSH loopback owner was not stopped: $($stop.State)" }
} elseif ($owner.State -eq 'none') {
    Add-Content $log ("{0}  no DSH loopback owner; nonLoopbackListeners={1}" -f (Get-Date -Format 'HH:mm:ss'), $owner.NonLoopbackCount)
} else {
    Add-Content $log ("{0}  restart aborted: unsafe owner state={1} pid={2} nonLoopbackListeners={3}" -f (Get-Date -Format 'HH:mm:ss'), $owner.State, $owner.Pid, $owner.NonLoopbackCount)
    throw "Unsafe DSH loopback owner state: $($owner.State)"
}
$free = ((Get-DshLoopbackOwner -Port $Port).State -eq 'none')
Add-Content $log ("{0}  DSH loopback free: {1}" -f (Get-Date -Format 'HH:mm:ss'), $free)
if (-not $free) { throw 'DSH loopback port is still occupied; refusing to start a second instance' }

# start fresh via the standard autostart guard (detached, no window)
$starter = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'start-dsh-server.ps1'
if (Test-Path $starter) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter -Port $Port -LockAlreadyHeld
    $starterCode = $LASTEXITCODE
    Add-Content $log ("{0}  starter exit code: {1}" -f (Get-Date -Format 'HH:mm:ss'), $starterCode)
    if ($starterCode -ne 0) { throw "start-dsh-server.ps1 failed with exit code $starterCode" }
} else {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/S /C ""dsh" web --port ' + $Port + ' > "' + (Join-Path $env:LOCALAPPDATA ("DSHHarness\logs\dsh-server-" + $Port + ".log")) + '" 2>&1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $env:USERPROFILE
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

# verify actual DSH readiness, not only a root-page HTTP 200
$ready = Test-DshReadiness -Port $Port -RequireWebSockets
Add-Content $log ("{0}  readiness: {1} error={2}" -f (Get-Date -Format 'HH:mm:ss'), $ready.State, $ready.Error)
if ($ready.State -ne 'client_ready') { throw "DSH client readiness failed: $($ready.State)" }
Register-DshRestartSuccess | Out-Null
} finally {
    # release maintenance lock (guardian resumes auto-recovery)
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Add-Content $log ("{0}  maintenance lock released" -f (Get-Date -Format 'HH:mm:ss'))
    Exit-DshRestartLock $restartLock
}
