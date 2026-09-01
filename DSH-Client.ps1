# DSH-Client.ps1 - Edge app-mode fallback launcher for the DeepSeek Harness Web GUI.
# Primary client: "DSH Harness.exe" (native WebView2). Use this .cmd/ps1 only if the
# native client cannot initialize WebView2 on your machine.
#
# Behavior:
#   1. Checks http://127.0.0.1:3080; if the server is down, starts `dsh web` (hidden, logged).
#   2. Waits until the server responds (up to 90s).
#   3. Opens http://127.0.0.1:3080 in a standalone Edge app window (no tabs/address bar)
#      with an isolated profile under %LOCALAPPDATA%\DSHHarness\EdgeProfile.
param(
    [switch]$NoServer,      # skip auto-starting the dsh server
    [string]$Url = "http://127.0.0.1:3080"
)
$ErrorActionPreference = 'Stop'

# RH1 D1 (single health source): reuse the canonical layered probe when present,
# so the client and the guardian/health module agree on liveness+readiness.
try { . (Join-Path $PSScriptRoot 'dsh-health.ps1') } catch { }

function Test-Server {
    # RH1 D1: layered liveness + readiness; HTTP 200 == fully ready. A non-200
    # (alive but unready) or a network error returns $false. Never kills/starts
    # anything; the canonical start authority owns recovery.
    if (Get-Command Test-DshBasicHttp -ErrorAction SilentlyContinue) {
        try {
            $basic = Test-DshBasicHttp -Port 3080 -TimeoutSec 2
            return ($basic.State -eq 'matched' -and $basic.HttpStatus -eq 200)
        } catch { return $false }
    }
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Find-Dsh {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) {
        $dir = Split-Path $cmd.Source
        foreach ($cand in @("$dir\dsh.cmd", "$dir\dsh.exe", $cmd.Source)) {
            if ($cand -and (Test-Path $cand)) { return $cand }
        }
    }
    foreach ($root in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'), 'D:\C盘迁移\开发缓存\npm-cache\_npx')) {
        if (Test-Path $root) {
            foreach ($d in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue)) {
                $cand = Join-Path $d.FullName 'node_modules\.bin\dsh.cmd'
                if (Test-Path $cand) { return $cand }
            }
        }
    }
    return 'dsh'
}

$serverUp = Test-Server
if (-not $serverUp) {
    if ($NoServer) {
        Write-Host "DSH server not running on $Url, and -NoServer was given. Nothing to connect to." -ForegroundColor Yellow
        exit 1
    }
    Write-Host 'DSH server is not running. Starting server via the single start authority (start-dsh-server.ps1)...'
    # RH1 Part A (single authority): the ONLY production start path is
    # start-dsh-server.ps1 -> dsh-launcher.js -> bundled Node v22 -> dsh web.
    # It sanitizes env, owns the restart lock, and appends to the per-port log
    # (it never truncates). Spawn it detached so it does not inherit this
    # process's output pipes.
    $starter = Join-Path $PSScriptRoot 'start-dsh-server.ps1'
    if (-not (Test-Path $starter)) {
        Write-Host "start-dsh-server.ps1 not found at $starter; cannot start server (single authority)." -ForegroundColor Yellow
        exit 1
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -Port 3080'
    $psi.UseShellExecute = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $env:USERPROFILE
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-Host "Started (append-only per-port log under %LOCALAPPDATA%\DSHHarness\logs). Waiting for $Url ..."
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Server) { $serverUp = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $serverUp) {
        Write-Host 'Server did not come up within 90s; opening the URL anyway in 5s...' -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

# Launch standalone Edge app window with an isolated profile.
$edge = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
    Write-Host 'Edge not found; falling back to the default browser.' -ForegroundColor Yellow
    Start-Process $Url
    exit 0
}

$profile = Join-Path $env:LOCALAPPDATA 'DSHHarness\EdgeProfile'
$args = @("--app=$Url", "--user-data-dir=$profile", '--window-size=1500,950', '--no-first-run', '--no-default-browser-check')
Start-Process -FilePath $edge -ArgumentList $args
Write-Host "Opened $Url in a standalone window." -ForegroundColor Green
