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
    [switch]$Loop,
    [switch]$Library
)

$ErrorActionPreference = 'Continue'
$dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
$logDir = Join-Path $dataRoot 'logs'
$stateDir = Join-Path $dataRoot 'state'
if (-not $Library) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}
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
    $heartbeat = Get-Heartbeat
    $rows = @(Get-DshGuardianIdentityProcesses -Heartbeat $heartbeat)
    $presence = Resolve-DshGuardianPresence -Heartbeat $heartbeat -Processes $rows -MaxAgeSeconds $StaleSeconds
    if (-not $presence.Proven) { return @() }
    return @($rows | Where-Object { $_.ProcessId -eq $presence.Pid })
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

function Convert-DshGuardianUtcDate([object]$Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try {
        if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
        if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
        if ([string]$Value -match '^\d{14}(?:\.\d+)?[+-]\d{3}$') {
            return [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value).ToUniversalTime()
        }
        return [DateTimeOffset]::Parse([string]$Value).UtcDateTime
    } catch { return $null }
}

function Get-DshGuardianProcessStartUtc([object]$Process) {
    foreach ($name in @('StartTime', 'CreationTime', 'CreationDate', 'startedAt')) {
        try {
            $property = $Process.PSObject.Properties[$name]
            if ($null -eq $property) { continue }
            $parsed = Convert-DshGuardianUtcDate $property.Value
            if ($null -ne $parsed) { return $parsed }
        } catch {}
    }
    return $null
}

function Resolve-DshGuardianPresence {
    param(
        [object]$Heartbeat,
        [object[]]$Processes = @(),
        [DateTime]$Now = (Get-Date).ToUniversalTime(),
        [int]$MaxAgeSeconds = 90
    )

    $heartbeatPid = 0
    try { $heartbeatPid = [int]$Heartbeat.pid } catch { $heartbeatPid = 0 }
    $heartbeatUpdated = Convert-DshGuardianUtcDate $Heartbeat.updatedAt
    $age = $null
    try {
        if ($null -ne $Heartbeat.AgeSeconds) { $age = [double]$Heartbeat.AgeSeconds }
    } catch {}
    if ($null -eq $age -and $null -ne $heartbeatUpdated) {
        $age = (($Now.ToUniversalTime()) - $heartbeatUpdated).TotalSeconds
    }
    $hasHeartbeat = $null -ne $Heartbeat -and $heartbeatPid -gt 0
    $fresh = $hasHeartbeat -and $null -ne $age -and $age -ge 0 -and $age -le $MaxAgeSeconds
    $matching = @($Processes | Where-Object {
        try { [int]($_.ProcessId) -eq $heartbeatPid } catch { $false }
    })

    if ($matching.Count -gt 0) {
        $process = $matching[0]
        $identityProven = $true
        $heartbeatStarted = Convert-DshGuardianUtcDate $Heartbeat.startedAt
        $processStarted = Get-DshGuardianProcessStartUtc $process
        if ($null -ne $heartbeatStarted -and $null -ne $processStarted) {
            $identityProven = [Math]::Abs((($processStarted - $heartbeatStarted).TotalSeconds)) -le 30
        }
        if (-not $identityProven) {
            return [pscustomobject]@{
                State = 'ambiguous'; Present = $false; Proven = $false; ShouldStart = $false
                Pid = $heartbeatPid; Source = 'heartbeat-pid-start-mismatch'; Fresh = $fresh
                AgeSeconds = $age; Reason = 'heartbeat PID exists but start time does not match'
            }
        }
        return [pscustomobject]@{
            State = if ($fresh) { 'present' } else { 'stale_live' }
            Present = $true; Proven = $true; ShouldStart = $false
            Pid = $heartbeatPid; Source = if ($fresh) { 'heartbeat-pid' } else { 'stale-heartbeat-live-pid' }
            Fresh = $fresh; AgeSeconds = $age
            Reason = if ($fresh) { 'fresh heartbeat with matching live PID' } else { 'stale heartbeat but matching live PID' }
        }
    }

    # A fresh heartbeat without a live matching PID is ambiguous, not a start
    # signal. An absent/stale heartbeat with no proven guardian is the only
    # start-eligible case.
    if ($fresh) {
        return [pscustomobject]@{
            State = 'ambiguous'; Present = $false; Proven = $false; ShouldStart = $false
            Pid = $heartbeatPid; Source = 'fresh-heartbeat-no-live-pid'; Fresh = $true
            AgeSeconds = $age; Reason = 'fresh heartbeat has no matching live PID'
        }
    }

    $commandLineGuardian = @($Processes | Where-Object {
        $cmd = [string]$_.CommandLine
        $isGuardian = $cmd -match '(?i)dsh-guardian\.ps1'
        $isWatchdog = $cmd -match '(?i)dsh-guardian-watchdog\.ps1'
        return ($isGuardian -and -not $isWatchdog)
    })
    if ($commandLineGuardian.Count -gt 0) {
        $p = $commandLineGuardian[0]
        $commandPid = 0
        try { $commandPid = [int]$p.ProcessId } catch {}
        return [pscustomobject]@{
            State = 'present'; Present = $true; Proven = $true; ShouldStart = $false
            Pid = $commandPid; Source = 'commandline-identity'; Fresh = $false
            AgeSeconds = $age; Reason = 'strong Guardian command-line identity'
        }
    }

    return [pscustomobject]@{
        State = 'absent'; Present = $false; Proven = $false; ShouldStart = $true
        Pid = $null; Source = if ($hasHeartbeat) { 'stale-or-unmatched-heartbeat' } else { 'no-heartbeat' }
        Fresh = $false; AgeSeconds = $age; Reason = 'no proven live Guardian'
    }
}

function Get-DshGuardianIdentityProcesses([object]$Heartbeat = $null) {
    $result = @()
    try {
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop)
        $result += @($rows | ForEach-Object {
            [pscustomobject]@{
                ProcessId = [int]$_.ProcessId
                ProcessName = [string]$_.Name
                CommandLine = [string]$_.CommandLine
                CreationDate = $_.CreationDate
            }
        })
    } catch {
        TraceW ('process probe error: ' + $_.Exception.Message)
    }
    $heartbeatPid = 0
    try { $heartbeatPid = [int]$Heartbeat.pid } catch {}
    if ($heartbeatPid -gt 0 -and -not @($result | Where-Object { $_.ProcessId -eq $heartbeatPid })) {
        try {
            $p = Get-Process -Id $heartbeatPid -ErrorAction Stop
            if ([string]$p.ProcessName -match '(?i)^powershell') {
                $result += [pscustomobject]@{
                    ProcessId = [int]$p.Id
                    ProcessName = [string]$p.ProcessName
                    CommandLine = ''
                    StartTime = $p.StartTime
                }
            }
        } catch {}
    }
    return @($result)
}

function Confirm-DshGuardianSpawn {
    param(
        [int]$ExpectedPid,
        [object]$Heartbeat,
        [object[]]$Processes = @(),
        [DateTime]$Now = (Get-Date).ToUniversalTime(),
        [int]$MaxAgeSeconds = 90
    )
    $presence = Resolve-DshGuardianPresence -Heartbeat $Heartbeat -Processes $Processes -Now $Now -MaxAgeSeconds $MaxAgeSeconds
    # Spawn verification is stricter than steady-state presence: a command
    # line alone (or a stale heartbeat) cannot turn Process.Start success into
    # a healthy claim. Require the fresh authoritative heartbeat/PID pair.
    $verified = $presence.Proven -and $presence.Fresh -and $presence.Source -eq 'heartbeat-pid' -and
        $presence.Pid -gt 0 -and ($ExpectedPid -le 0 -or $presence.Pid -eq $ExpectedPid)
    return [pscustomobject]@{
        State = if ($verified) { 'verified' } else { 'unverified' }
        Verified = $verified
        Pid = $presence.Pid
        Presence = $presence
    }
}

function Invoke-WatchdogCheck {
    $heartbeat = Get-Heartbeat
    $processes = @(Get-DshGuardianIdentityProcesses -Heartbeat $heartbeat)
    $presence = Resolve-DshGuardianPresence -Heartbeat $heartbeat -Processes $processes -MaxAgeSeconds $StaleSeconds
    if ($presence.State -eq 'present') {
        TraceW ("guardian healthy pid=$($presence.Pid) heartbeatAge=$([int]$presence.AgeSeconds)s source=$($presence.Source) port=$Port")
        return
    }
    if ($presence.State -eq 'stale_live') {
        TraceW ("guardian heartbeat stale; live Guardian pid=$($presence.Pid); no kill/start")
        return
    }
    if (-not $presence.ShouldStart) {
        TraceW ("guardian identity ambiguous; no kill/start reason=$($presence.Reason)")
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
        # Process.Start only proves a child was requested. Do not call that a
        # healthy Guardian until a heartbeat/PID identity is observed.
        $postHeartbeat = Get-Heartbeat
        $postProcesses = @(Get-DshGuardianIdentityProcesses -Heartbeat $postHeartbeat)
        $verification = Confirm-DshGuardianSpawn -ExpectedPid ([int]$proc.Id) -Heartbeat $postHeartbeat -Processes $postProcesses -MaxAgeSeconds $StaleSeconds
        if ($verification.Verified) {
            TraceW ("guardian spawn verified pid=$($verification.Pid) port=$Port noKeepAwake=$NoKeepAwake noLidGuard=$NoLidGuard")
        } else {
            TraceW ("guardian spawn unverified pid=$($proc.Id); heartbeat/identity not confirmed; no healthy claim")
        }
    } catch {
        TraceW ('guardian start error: ' + $_.Exception.Message)
    }
}

if ($Library) { return }

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
