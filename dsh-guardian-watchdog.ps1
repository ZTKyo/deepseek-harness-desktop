# dsh-guardian-watchdog.ps1 - lightweight user-session guardian supervisor.
#
# This supervisor is intentionally conservative: it starts a guardian only
# when no live guardian process is present.  It never kills a stale or
# identity-ambiguous process; a later, explicitly authorized recovery test can
# exercise that boundary without making the normal logon path destructive.
param(
    [string]$GuardianPath = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'dsh-guardian.ps1'),
    [int]$Port = 3080,
    [int]$StaleSeconds = 90,
    [switch]$NoKeepAwake,
    [switch]$NoLidGuard,
    [switch]$Loop
)

$ErrorActionPreference = 'Continue'
$dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
$logDir = Join-Path $dataRoot 'logs'
$stateDir = Join-Path $dataRoot 'state'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logPath = Join-Path $logDir 'guardian-supervisor.log'
$heartbeatPath = Join-Path $stateDir 'guardian-heartbeat.json'

function TraceW([string]$Message) {
    try {
        if (Test-Path $logPath) {
            $fi = Get-Item -LiteralPath $logPath
            if ($fi.Length -gt 1MB) {
                Move-Item -LiteralPath $logPath -Destination (Join-Path $logDir 'guardian-supervisor.old.log') -Force -ErrorAction SilentlyContinue
            }
        }
        Add-Content -LiteralPath $logPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
    } catch {}
}

function Get-GuardianProcess {
    $expected = [IO.Path]::GetFullPath($GuardianPath)
    try {
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop)
        return @($rows | Where-Object {
            $cmd = [string]$_.CommandLine
            if (-not $cmd) { return $false }
            $isGuardian = $cmd -match '(?i)dsh-guardian\.ps1'
            $isWatchdog = $cmd -match '(?i)dsh-guardian-watchdog\.ps1'
            $pathMatch = $cmd.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
            return ($isGuardian -and -not $isWatchdog -and $pathMatch)
        })
    } catch {
        TraceW ('process probe error: ' + $_.Exception.Message)
        return @()
    }
}

function Get-Heartbeat {
    if (-not (Test-Path -LiteralPath $heartbeatPath)) { return $null }
    try {
        $h = Get-Content -LiteralPath $heartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json
        # PowerShell 7 may materialize ISO-8601 JSON values as a UTC
        # DateTime, while Windows PowerShell 5.1 keeps them as strings.  Do
        # not cast a UTC DateTime to string (that drops the `Z` and shifts the
        # timestamp by the local offset); normalize each representation
        # explicitly to UTC.
        if ($h.updatedAt -is [DateTime]) {
            $updated = $h.updatedAt.ToUniversalTime()
        } elseif ($h.updatedAt -is [DateTimeOffset]) {
            $updated = $h.updatedAt.UtcDateTime
        } else {
            $updated = [DateTimeOffset]::Parse([string]$h.updatedAt).UtcDateTime
        }
        $age = ((Get-Date).ToUniversalTime() - $updated).TotalSeconds
        $h | Add-Member -NotePropertyName AgeSeconds -NotePropertyValue $age -Force
        return $h
    } catch {
        TraceW ('heartbeat probe error: ' + $_.Exception.Message)
        return $null
    }
}

function Invoke-WatchdogCheck {
    # Force an array so the single-process case behaves identically on
    # Windows PowerShell 5.1 and PowerShell 7 (`.Count` is not guaranteed on a
    # scalar CIM object in the former).
    $guardian = @(Get-GuardianProcess)
    $heartbeat = Get-Heartbeat
    $fresh = ($null -ne $heartbeat -and [double]$heartbeat.AgeSeconds -le $StaleSeconds)
    if ($guardian.Count -gt 0 -and $fresh) {
        TraceW ("guardian healthy pid=$($guardian[0].ProcessId) heartbeatAge=$([int]$heartbeat.AgeSeconds)s port=$Port")
        return
    }
    if ($guardian.Count -gt 0) {
        $pids = ($guardian | ForEach-Object ProcessId) -join ','
        TraceW ("guardian heartbeat stale or unreadable; live guardian pid(s)=$pids; no kill/start")
        return
    }

    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $GuardianPath, '-Port', [string]$Port)
    if ($NoKeepAwake) { $args += '-NoKeepAwake' }
    if ($NoLidGuard) { $args += '-NoLidGuard' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.UseShellExecute = $true
    $psi.WindowStyle = 'Hidden'
    $psi.Arguments = (($args | ForEach-Object {
        $s = [string]$_
        if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s }
    }) -join ' ')
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        TraceW ("guardian started pid=$($proc.Id) port=$Port noKeepAwake=$NoKeepAwake noLidGuard=$NoLidGuard")
    } catch {
        TraceW ('guardian start error: ' + $_.Exception.Message)
    }
}

if ($Loop) {
    # Resident supervisor mode (Startup-launched): check every 60s forever.
    # This is the primary recovery path; it does not depend on the Task
    # Scheduler repetition window (which expires and left the guardian
    # unprotected after 8/17 21:05).
    TraceW ('watchdog resident loop started (interval=60s) port=' + $Port)
    while ($true) {
        try { Invoke-WatchdogCheck } catch { TraceW ('watchdog loop error: ' + $_.Exception.Message) }
        Start-Sleep -Seconds 60
    }
} else {
    try { Invoke-WatchdogCheck } catch {
        TraceW ('watchdog error: ' + $_.Exception.Message)
        exit 1
    }
    exit 0
}
