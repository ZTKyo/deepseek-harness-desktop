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

function Test-Server {
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
    foreach ($root in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'))) {
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
    Write-Host 'DSH server is not running. Starting `dsh web` ...'
    $dsh = Find-Dsh
    $dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $log = Join-Path $dataRoot 'logs\dsh-server-3080.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/S /C ""' + $dsh + '" web > "' + $log + '" 2>&1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $env:USERPROFILE
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-Host "Waiting for $Url ... (server log: $log)"
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
