# start-dsh-server.ps1 - login autostart guard for the DSH web server.
#
# Runs at sign-in (Startup folder shortcut "DSH Server Autostart").
# Behavior:
#   * If the DSH web server already answers on the port, does NOTHING (no duplicate).
#   * Otherwise starts `dsh web --port <Port>` DETACHED (no console, output to log),
#     so it keeps running even after every window is closed.
# No windows are shown; the console (if any) hides itself immediately.
param(
    [int]$Port = 3080,
    [switch]$LockAlreadyHeld
)
$ErrorActionPreference = 'Stop'

# ---- environment sanitization (2026-08-15 hardening) ----
# Strip host-app injected vars (WorkBuddy/genie safe-delete, Claude/CodeBuddy
# shims, NODE_OPTIONS require-hooks, BASH_ENV/PYTHONPATH shims, oversized
# product config) so the dsh server / guardian always boot clean. Injections
# previously blocked credential writes, caused writer-lock stalls, and the
# oversized ACC_PRODUCT_CONFIG_V3 (479KB) broke process spawning (env block
# > 64KB).
foreach ($v in (Get-ChildItem Env: | Where-Object {
    $_.Name -like 'CODEBUDDY_*' -or $_.Name -like 'WORKBUDDY_*' -or $_.Name -like 'CLAUDE_*' -or
    $_.Name -like 'CLIENT_INFO_*' -or $_.Name -like 'SERVER__*' -or $_.Name -like 'HERMES_*' -or
    $_.Name -like 'GALILEO_*' -or $_.Name -like 'EFC_*' -or
    $_.Name -eq 'ACC_PRODUCT_CONFIG_V3' -or $_.Name -eq 'NODE_OPTIONS' -or $_.Name -eq 'BASH_ENV' -or
    $_.Name -eq 'PYTHONPATH' -or $_.Name -eq 'GENIE_TRASH_DIR' -or $_.Name -eq 'ELECTRON_RUN_AS_NODE' -or
    $_.Name -eq 'HMCloud' -or $_.Name -eq 'DISABLE_AUTOUPDATER' -or $_.Name -eq 'DOTNET_SYSTEM_CONSOLE_USEUTF8ENCODING' -or
    $_.Name -eq 'ORIGINAL_XDG_CURRENT_DESKTOP'
})) { Remove-Item "Env:$($v.Name)" -ErrorAction SilentlyContinue }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-readiness.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')
$url  = "http://127.0.0.1:$Port/"

function Test-Server {
    try {
        $script:LastReadiness = Test-DshReadiness -Port $Port
        return ($script:LastReadiness.State -in @('api_ready','client_ready'))
    } catch { $script:LastReadiness = $null; return $false }
}

function Find-Dsh {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) {
        $dir = Split-Path $cmd.Source
        foreach ($cand in @("$dir\dsh.cmd", "$dir\dsh.exe", $cmd.Source)) {
            if ($cand -and (Test-Path $cand)) { return $cand }
        }
    }
    foreach ($r2 in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'))) {
        if (Test-Path $r2) {
            foreach ($d in (Get-ChildItem $r2 -Directory -ErrorAction SilentlyContinue)) {
                $cand = Join-Path $d.FullName 'node_modules\.bin\dsh.cmd'
                if (Test-Path $cand) { return $cand }
            }
        }
    }
    return 'dsh'
}

# Select a known-good Node v22 runtime. System Node v24 crashes on
# ERR_UNSUPPORTED_DIR_IMPORT for secret-gate-client/browser plugins, so we
# prefer (1) the DSH-Client-bundled copy (node-runtime\node.exe), then
# (2) the WorkBuddy-managed v22.22.2 (fixed version, not a "latest dir scan",
# so a future WorkBuddy node upgrade cannot silently switch runtimes).
function Select-NodeRuntime {
    foreach ($c in @((Join-Path $root 'node-runtime\node.exe'),
 )) {
        if (Test-Path $c) { return $c }
    }
    return 'node'
}

$restartLock = $null
if (-not $LockAlreadyHeld) {
    $restartLock = Enter-DshRestartLock
    if (-not $restartLock) {
        Write-Error 'Another DSH start/restart transaction owns the lock.'
        exit 75
    }
}
$script:StartExitCode = 0
$budgetOwned = $false

try {
# already running? nothing to do.
if (Test-Server) { return }

if (-not $LockAlreadyHeld) {
    $budgetGate = Test-DshRestartAllowed
    if (-not $budgetGate.Allowed) {
        Add-Content -Path (Join-Path $env:LOCALAPPDATA 'DSHHarness\autostart.log') `
            -Value ("{0}  start skipped by restart budget: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $budgetGate.Reason) -Encoding UTF8
        throw "restart budget blocked: $($budgetGate.Reason)"
    }
    Register-DshRestartAttempt 'start-script' | Out-Null
    $budgetOwned = $true
}

$dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
# Force the selected Node v22 runtime into PATH (dsh.cmd / tools resolve 'node').
$nodeExe = Select-NodeRuntime
if ($nodeExe -and $nodeExe -ne 'node' -and (Test-Path $nodeExe)) {
    $env:PATH = (Split-Path $nodeExe) + ';' + $env:PATH
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
# Per-port log: the running server holds its log handle, so a shared name would
# block any new instance's redirect (observed 2026-08-14: recovery failed with
# "file in use"). Each port gets its own log: dsh-server-<port>.log
$log = Join-Path $dataRoot ("logs\dsh-server-" + $Port + ".log")
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

# Find dsh entry point (lib/bin.js) directly, bypassing dsh.cmd.
# dsh.cmd resolves 'node' via PATH which may hit system Node v24 (crashes on
# ESM directory import). Calling node.exe + lib/bin.js directly avoids this.
$dshEntry = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $dshEntry)) {
    # fallback: search npx cache
    $npxCache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    if (Test-Path $npxCache) {
        foreach ($d in (Get-ChildItem $npxCache -Directory -ErrorAction SilentlyContinue)) {
            $cand = Join-Path $d.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
            if (Test-Path $cand) { $dshEntry = $cand; break }
        }
    }
}

# Use the bundled/managed Node v22 (system v24 crashes on ERR_UNSUPPORTED_DIR_IMPORT).
$nodeExe = Select-NodeRuntime

# Use dsh-launcher.js to spawn the server detached (bypasses cmd.exe which
# was causing the server process to die shortly after startup).
$launcher = Join-Path $root 'dsh-launcher.js'
$launcherNode = $nodeExe
if (-not (Test-Path $launcherNode)) { $launcherNode = 'node' }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $launcherNode
$psi.Arguments = '"' + $launcher + '" "' + $nodeExe + '" "' + $dshEntry + '" ' + $Port + ' "' + $log + '"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $env:USERPROFILE
try {
    $launcherProc = [System.Diagnostics.Process]::Start($psi)
    Add-Content -Path (Join-Path $dataRoot 'autostart.log') `
        -Value ("{0}  started dsh runner on port {1} launcherPid={2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Port, $launcherProc.Id) -Encoding UTF8

    # Launcher creation is not service success. First wait for API readiness,
    # then require both client event streams before returning success.
    $apiReady = $false
    $lastReady = $null
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        $lastReady = Test-DshReadiness -Port $Port
        if ($lastReady.State -eq 'api_ready' -or $lastReady.State -eq 'client_ready') { $apiReady = $true; break }
    }
    if (-not $apiReady) {
        Add-Content -Path (Join-Path $dataRoot 'autostart.log') `
            -Value ("{0}  FAILED DSH API readiness state={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $(if($lastReady){$lastReady.State}else{'unknown'})) -Encoding UTF8
        $script:StartExitCode = 2
    } else {
        $clientReady = Test-DshReadiness -Port $Port -RequireWebSockets
        Add-Content -Path (Join-Path $dataRoot 'autostart.log') `
            -Value ("{0}  DSH API readiness={1} client readiness={2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $lastReady.State, $clientReady.State) -Encoding UTF8
        if ($clientReady.State -ne 'client_ready') { $script:StartExitCode = 2 }
        elseif ($budgetOwned) { Register-DshRestartSuccess | Out-Null }
    }
} catch {
    Add-Content -Path (Join-Path $dataRoot 'autostart.log') `
        -Value ("{0}  FAILED to start dsh web: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message) -Encoding UTF8
    $script:StartExitCode = 1
}
} finally {
    if ($restartLock) { Exit-DshRestartLock $restartLock }
}
if ($script:StartExitCode -ne 0) { exit $script:StartExitCode }