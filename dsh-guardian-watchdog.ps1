# dsh-guardian-watchdog.ps1 - lightweight user-session guardian supervisor.
#
# This supervisor is intentionally conservative.  A stale heartbeat is only a
# suspicion: takeover requires repeated observations, a longer threshold,
# strict PID/start-time/Guardian identity, an old-process-gone fence, a
# separate bounded takeover budget, and a fresh new Guardian heartbeat.
param(
    [string]$GuardianPath = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'dsh-guardian.ps1'),
    [int]$Port = 3080,
    [int]$StaleSeconds = 90,
    [int]$TakeoverSeconds = 0,
    [int]$TakeoverMaxAttempts = 2,
    [int]$TakeoverCooldownSeconds = 600,
    [int]$TakeoverWindowSeconds = 900,
    [int]$TakeoverGoneTimeoutSeconds = 20,
    [int]$TakeoverVerifyTimeoutSeconds = 30,
    [int]$TakeoverPollMilliseconds = 500,
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
$script:DshGuardianTakeoverBudgetPath = if ($env:DSH_GUARDIAN_TAKEOVER_BUDGET_PATH) {
    $env:DSH_GUARDIAN_TAKEOVER_BUDGET_PATH
} else {
    Join-Path $stateDir 'guardian-takeover-budget.json'
}
$script:DshGuardianFenceState = $null

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

function ConvertTo-DshGuardianSpawnProcessStartIdentity([object]$Value) {
    $utc = Convert-DshGuardianUtcDate $Value
    if ($null -eq $utc) { return $null }
    try {
        # CIM and Get-Process can expose different sub-millisecond precision.
        # Use one UTC millisecond representation for spawned-child identity only.
        $ticks = $utc.Ticks - ($utc.Ticks % [TimeSpan]::TicksPerMillisecond)
        $normalized = [DateTime]::new($ticks, [DateTimeKind]::Utc)
        return $normalized.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
    } catch { return $null }
}

function Get-DshGuardianTakeoverThresholdSec {
    param(
        [int]$StaleSeconds = 90,
        [int]$RequestedSeconds = 0
    )
    # The resident watchdog observes once per minute.  Three stale windows and
    # a five-minute floor leave room for a slow health/config operation without
    # turning a stuck Guardian into an unbounded no-op.
    $cadenceBound = [Math]::Max(300, ($StaleSeconds * 3))
    if ($RequestedSeconds -gt 0) { return [Math]::Max($RequestedSeconds, $cadenceBound) }
    return $cadenceBound
}

function New-DshGuardianFenceState {
    [pscustomobject]@{
        Phase              = 'HEALTHY'
        IdentityKey        = $null
        FirstSuspectAt     = $null
        ConfirmedStaleAt   = $null
        LastObservedAt     = $null
        ObservationCount   = 0
        LastAgeSeconds     = $null
        LastReason         = $null
        TakeoverAttempts   = 0
        TakeoverAttemptId  = $null
        CooldownUntil      = $null
    }
}

function Get-DshGuardianIdentityKey {
    param(
        [object]$Heartbeat,
        [object]$Process
    )
    $processPid = 0
    try { $processPid = [int]$Heartbeat.pid } catch {}
    $start = Get-DshGuardianProcessStartUtc $Process
    if ($processPid -le 0 -or $null -eq $start) { return $null }
    $generation = [string]$Heartbeat.generation
    return ('{0}|{1:o}|{2}' -f $processPid, $start, $generation)
}

function Test-DshGuardianProcessIdentity {
    param(
        [object]$Heartbeat,
        [object]$Process,
        [int]$MaxStartSkewSeconds = 30
    )
    $processPid = 0
    $heartbeatPid = 0
    try { $processPid = [int]$Process.ProcessId } catch {}
    try { $heartbeatPid = [int]$Heartbeat.pid } catch {}
    $name = [string]$Process.ProcessName
    $cmd = [string]$Process.CommandLine
    $isPowerShell = $name -match '(?i)^(?:powershell|pwsh)(?:\.exe)?$'
    $isWatchdog = $cmd -match '(?i)dsh-guardian-watchdog\.ps1(?:["\s]|$)'
    $hasGuardianCommandLine = $cmd -match '(?i)dsh-guardian\.ps1(?:["\s]|$)'
    $heartbeatStart = Convert-DshGuardianUtcDate $Heartbeat.startedAt
    $processStart = Get-DshGuardianProcessStartUtc $Process
    $base = [ordered]@{
        Proven       = $false
        IsGuardian   = $false
        Pid          = $processPid
        Source       = 'none'
        Reason       = $null
        ProcessStart = $processStart
        StartSkewSec = $null
    }
    if ($processPid -le 0 -or $heartbeatPid -le 0 -or $processPid -ne $heartbeatPid) {
        $base.Reason = 'heartbeat_pid_mismatch'
        return [pscustomobject]$base
    }
    if (-not $isPowerShell) {
        $base.Reason = 'process_not_powershell'
        return [pscustomobject]$base
    }
    if ($isWatchdog) {
        $base.Reason = 'process_is_watchdog'
        return [pscustomobject]$base
    }
    if ($null -eq $heartbeatStart -or $null -eq $processStart) {
        $base.Reason = 'start_time_incomplete'
        return [pscustomobject]$base
    }
    $skew = [Math]::Abs((($processStart - $heartbeatStart).TotalSeconds))
    $base.StartSkewSec = $skew
    if ($skew -gt $MaxStartSkewSeconds) {
        $base.Reason = 'start_time_mismatch'
        return [pscustomobject]$base
    }
    # A visible command line must identify the Guardian specifically.  When
    # Windows hides CommandLine, the heartbeat PID + PowerShell type + matching
    # creation time is the only accepted metadata-only fallback.
    if (-not [string]::IsNullOrWhiteSpace($cmd) -and -not $hasGuardianCommandLine) {
        $base.Reason = 'command_line_not_guardian'
        return [pscustomobject]$base
    }
    $base.Proven = $true
    $base.IsGuardian = $true
    $base.Source = if ($hasGuardianCommandLine) { 'commandline-identity' } else { 'heartbeat-pid-start' }
    $base.Reason = 'pid-start-guardian-identity'
    return [pscustomobject]$base
}

function Resolve-DshGuardianFenceObservation {
    param(
        [object]$Heartbeat,
        [object[]]$Processes = @(),
        [bool]$ProbeOk = $true,
        [DateTime]$Now = (Get-Date).ToUniversalTime(),
        [int]$MaxAgeSeconds = 90
    )
    $heartbeatPid = 0
    try { $heartbeatPid = [int]$Heartbeat.pid } catch {}
    $updated = Convert-DshGuardianUtcDate $Heartbeat.updatedAt
    $age = $null
    try { if ($null -ne $Heartbeat.AgeSeconds) { $age = [double]$Heartbeat.AgeSeconds } } catch {}
    if ($null -eq $age -and $null -ne $updated) { $age = (($Now.ToUniversalTime()) - $updated).TotalSeconds }
    $hasHeartbeat = $null -ne $Heartbeat -and $heartbeatPid -gt 0
    $fresh = $hasHeartbeat -and $null -ne $age -and $age -ge 0 -and $age -le $MaxAgeSeconds
    $base = [ordered]@{
        IdentityState      = 'AMBIGUOUS'
        Heartbeat          = $Heartbeat
        HeartbeatPid       = $heartbeatPid
        HeartbeatFresh     = [bool]$fresh
        AgeSeconds         = $age
        Process             = $null
        ProcessStart       = $null
        IdentitySource     = 'none'
        CandidateCount     = 0
        Reason             = $null
    }
    if (-not $ProbeOk) {
        $base.Reason = 'identity_probe_failed'
        return [pscustomobject]$base
    }

    $matching = @($Processes | Where-Object {
        try { [int]$_.ProcessId -eq $heartbeatPid } catch { $false }
    })
    $strong = @($Processes | Where-Object {
        $cmd = [string]$_.CommandLine
        ($cmd -match '(?i)dsh-guardian\.ps1(?:["\s]|$)') -and
            ($cmd -notmatch '(?i)dsh-guardian-watchdog\.ps1(?:["\s]|$)')
    })
    $base.CandidateCount = [int]($strong.Count + $matching.Count)
    if ($strong.Count -gt 1) {
        $base.Reason = 'multiple_guardian_candidates'
        return [pscustomobject]$base
    }
    if ($matching.Count -gt 1) {
        $base.Reason = 'multiple_process_rows_for_heartbeat_pid'
        return [pscustomobject]$base
    }
    if ($strong.Count -eq 1 -and ($matching.Count -eq 0 -or [int]$strong[0].ProcessId -ne $heartbeatPid)) {
        $base.Reason = 'other_guardian_candidate_present'
        return [pscustomobject]$base
    }
    if ($matching.Count -eq 1) {
        $identity = Test-DshGuardianProcessIdentity -Heartbeat $Heartbeat -Process $matching[0]
        if (-not $identity.Proven) {
            $base.Reason = $identity.Reason
            return [pscustomobject]$base
        }
        $base.IdentityState = 'PROVEN'
        $base.Process = $matching[0]
        $base.ProcessStart = $identity.ProcessStart
        $base.IdentitySource = $identity.Source
        $base.Reason = if ($fresh) { 'fresh_heartbeat_matching_guardian' } else { 'stale_heartbeat_matching_guardian' }
        return [pscustomobject]$base
    }
    if ($strong.Count -eq 1) {
        $base.Reason = 'guardian_identity_not_bound_to_heartbeat_pid'
        return [pscustomobject]$base
    }
    if ($fresh) {
        $base.Reason = 'fresh_heartbeat_without_matching_process'
        return [pscustomobject]$base
    }
    $base.IdentityState = 'ABSENT'
    $base.Reason = if ($hasHeartbeat) { 'no_proven_live_guardian' } else { 'no_heartbeat_no_guardian' }
    return [pscustomobject]$base
}

function Update-DshGuardianFenceState {
    param(
        [object]$State,
        [object]$Observation,
        [DateTime]$Now = (Get-Date).ToUniversalTime(),
        [int]$StaleSeconds = 90,
        [int]$TakeoverSeconds = 0
    )
    if ($null -eq $State) { $State = New-DshGuardianFenceState }
    $nowUtc = $Now.ToUniversalTime()
    $previous = [string]$State.Phase
    $action = 'NONE'
    $threshold = Get-DshGuardianTakeoverThresholdSec -StaleSeconds $StaleSeconds -RequestedSeconds $TakeoverSeconds
    $State.LastObservedAt = $nowUtc.ToString('o')
    $State.LastAgeSeconds = $Observation.AgeSeconds
    $State.LastReason = $Observation.Reason

    if ($Observation.IdentityState -eq 'AMBIGUOUS') {
        $State.Phase = 'AMBIGUOUS_FAIL_CLOSED'
        $State.IdentityKey = $null
        return [pscustomobject]@{ State = $State; Phase = $State.Phase; PreviousPhase = $previous; Action = $action; ThresholdSeconds = $threshold; Reason = $Observation.Reason }
    }
    if ($Observation.IdentityState -eq 'ABSENT') {
        if ($previous -in @('CONFIRMED_STALE', 'TAKEOVER_ELIGIBLE')) {
            $State.Phase = 'TAKEOVER_ELIGIBLE'
            $action = 'TAKEOVER'
        } elseif ($previous -notin @('TAKEOVER_IN_PROGRESS', 'TAKEOVER_VERIFIED')) {
            $State.Phase = 'AMBIGUOUS_FAIL_CLOSED'
        }
        return [pscustomobject]@{ State = $State; Phase = $State.Phase; PreviousPhase = $previous; Action = $action; ThresholdSeconds = $threshold; Reason = $Observation.Reason }
    }

    if ($Observation.HeartbeatFresh) {
        $State.Phase = 'HEALTHY'
        $State.IdentityKey = Get-DshGuardianIdentityKey -Heartbeat $Observation.Heartbeat -Process $Observation.Process
        $State.FirstSuspectAt = $null
        $State.ConfirmedStaleAt = $null
        $State.ObservationCount = 0
        return [pscustomobject]@{ State = $State; Phase = $State.Phase; PreviousPhase = $previous; Action = $action; ThresholdSeconds = $threshold; Reason = $Observation.Reason }
    }

    $identityKey = Get-DshGuardianIdentityKey -Heartbeat $Observation.Heartbeat -Process $Observation.Process
    if ($previous -notin @('SUSPECT_STALE', 'CONFIRMED_STALE', 'TAKEOVER_ELIGIBLE') -or
        ($State.IdentityKey -and $identityKey -and $State.IdentityKey -ne $identityKey)) {
        $State.Phase = 'SUSPECT_STALE'
        $State.IdentityKey = $identityKey
        $State.FirstSuspectAt = $nowUtc.ToString('o')
        $State.ConfirmedStaleAt = $null
        $State.ObservationCount = 1
    } else {
        $State.ObservationCount = [int]$State.ObservationCount + 1
        $State.IdentityKey = $identityKey
        if ($previous -eq 'SUSPECT_STALE' -and [double]$Observation.AgeSeconds -ge $threshold) {
            $State.Phase = 'CONFIRMED_STALE'
            $State.ConfirmedStaleAt = $nowUtc.ToString('o')
        } elseif ($previous -eq 'CONFIRMED_STALE' -and [double]$Observation.AgeSeconds -ge $threshold) {
            $State.Phase = 'TAKEOVER_ELIGIBLE'
            $action = 'TAKEOVER'
        } elseif ($previous -eq 'TAKEOVER_ELIGIBLE') {
            $action = 'TAKEOVER'
        }
    }
    return [pscustomobject]@{ State = $State; Phase = $State.Phase; PreviousPhase = $previous; Action = $action; ThresholdSeconds = $threshold; Reason = $Observation.Reason }
}

function Get-DshGuardianTakeoverBudgetDefault {
    [pscustomobject]@{
        Valid          = $true
        windowStart    = $null
        attempts       = 0
        cooldownUntil  = $null
        lastAttempt    = $null
        lastResult     = $null
        oldPid         = 0
        oldStart       = $null
    }
}

function Convert-DshGuardianBudgetDate([object]$Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return [DateTimeOffset]::Parse([string]$Value) } catch { return $null }
}

function Read-DshGuardianTakeoverBudget {
    param([string]$Path = $script:DshGuardianTakeoverBudgetPath)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return (Get-DshGuardianTakeoverBudgetDefault) }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $required = @('windowStart', 'attempts', 'cooldownUntil', 'lastAttempt', 'lastResult', 'oldPid', 'oldStart')
        foreach ($name in $required) {
            if ($raw.PSObject.Properties.Name -notcontains $name) { throw ('missing takeover budget field: ' + $name) }
        }
        $attempts = [int]$raw.attempts
        if ($attempts -lt 0 -or $attempts -gt 100) { throw 'invalid takeover attempt count' }
        foreach ($name in @('windowStart', 'cooldownUntil', 'lastAttempt', 'oldStart')) {
            $value = $raw.$name
            if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value) -and $null -eq (Convert-DshGuardianBudgetDate $value)) {
                throw ('invalid takeover budget date: ' + $name)
            }
        }
        return [pscustomobject]@{
            Valid         = $true
            windowStart   = $raw.windowStart
            attempts      = $attempts
            cooldownUntil = $raw.cooldownUntil
            lastAttempt   = $raw.lastAttempt
            lastResult    = $raw.lastResult
            oldPid        = [int]$raw.oldPid
            oldStart      = $raw.oldStart
        }
    } catch {
        return [pscustomobject]@{ Valid = $false; Reason = 'takeover_budget_corrupt' }
    }
}

function Write-DshGuardianTakeoverBudget {
    param(
        [object]$Value,
        [string]$Path = $script:DshGuardianTakeoverBudgetPath
    )
    try {
        $dir = Split-Path -Parent $Path
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $tmp = "$Path.tmp-$PID"
        [ordered]@{
            windowStart   = $Value.windowStart
            attempts      = [int]$Value.attempts
            cooldownUntil = $Value.cooldownUntil
            lastAttempt   = $Value.lastAttempt
            lastResult    = $Value.lastResult
            oldPid        = [int]$Value.oldPid
            oldStart      = $Value.oldStart
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Test-DshGuardianTakeoverAllowed {
    param(
        [string]$Path = $script:DshGuardianTakeoverBudgetPath,
        [int]$MaxAttempts = 2,
        [int]$WindowSeconds = 900,
        [DateTimeOffset]$Now = [DateTimeOffset]::Now
    )
    $budget = Read-DshGuardianTakeoverBudget -Path $Path
    if (-not $budget.Valid) { return [pscustomobject]@{ Allowed = $false; Reason = $budget.Reason; Budget = $budget } }
    $window = Convert-DshGuardianBudgetDate $budget.windowStart
    if ($null -eq $window -or (($Now - $window).TotalSeconds -ge $WindowSeconds)) {
        $budget.windowStart = $Now.ToString('o')
        $budget.attempts = 0
        $budget.cooldownUntil = $null
    }
    $cooldown = Convert-DshGuardianBudgetDate $budget.cooldownUntil
    if ($cooldown -and $cooldown -gt $Now) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'takeover_cooldown'; PauseUntil = $cooldown; Budget = $budget }
    }
    if ([int]$budget.attempts -ge $MaxAttempts) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'takeover_budget_exhausted'; PauseUntil = $cooldown; Budget = $budget }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = 'takeover_allowed'; PauseUntil = $null; Budget = $budget }
}

function Test-DshGuardianStartAllowed {
    param(
        [string]$Path = $script:DshGuardianTakeoverBudgetPath,
        [int]$MaxAttempts = 2,
        [int]$WindowSeconds = 900,
        [DateTimeOffset]$Now = [DateTimeOffset]::Now
    )
    # The absent-path start gate shares the takeover budget authority and is
    # deliberately read-only: a missing/default budget permits cold boot.
    $gate = Test-DshGuardianTakeoverAllowed -Path $Path -MaxAttempts $MaxAttempts -WindowSeconds $WindowSeconds -Now $Now
    return [pscustomobject]@{
        Allowed    = [bool]$gate.Allowed
        Reason     = $gate.Reason
        PauseUntil = $gate.PauseUntil
        Budget     = $gate.Budget
    }
}

function Register-DshGuardianTakeoverAttempt {
    param(
        [string]$Path = $script:DshGuardianTakeoverBudgetPath,
        [int]$MaxAttempts = 2,
        [int]$WindowSeconds = 900,
        [int]$OldPid = 0,
        [string]$OldStart = $null,
        [DateTimeOffset]$Now = [DateTimeOffset]::Now
    )
    $gate = Test-DshGuardianTakeoverAllowed -Path $Path -MaxAttempts $MaxAttempts -WindowSeconds $WindowSeconds -Now $Now
    if (-not $gate.Allowed) { return [pscustomobject]@{ Registered = $false; Reason = $gate.Reason; Budget = $gate.Budget } }
    $budget = $gate.Budget
    $budget.attempts = [int]$budget.attempts + 1
    $budget.lastAttempt = $Now.ToString('o')
    $budget.lastResult = 'in_progress'
    $budget.oldPid = $OldPid
    $budget.oldStart = $OldStart
    if (-not (Write-DshGuardianTakeoverBudget -Value $budget -Path $Path)) {
        return [pscustomobject]@{ Registered = $false; Reason = 'takeover_budget_write_failed'; Budget = $budget }
    }
    return [pscustomobject]@{ Registered = $true; Reason = 'takeover_attempt_registered'; Budget = $budget }
}

function Complete-DshGuardianTakeoverBudget {
    param(
        [string]$Path = $script:DshGuardianTakeoverBudgetPath,
        [int]$WindowSeconds = 900,
        [DateTimeOffset]$Now = [DateTimeOffset]::Now
    )
    $budget = Read-DshGuardianTakeoverBudget -Path $Path
    if (-not $budget.Valid) { return $false }
    $window = Convert-DshGuardianBudgetDate $budget.windowStart
    if ($null -eq $window -or (($Now - $window).TotalSeconds -ge $WindowSeconds)) {
        $budget.windowStart = $Now.ToString('o')
        $budget.attempts = 0
    }
    $budget.cooldownUntil = $null
    $budget.lastResult = 'verified'
    return Write-DshGuardianTakeoverBudget -Value $budget -Path $Path
}

function Fail-DshGuardianTakeoverBudget {
    param(
        [string]$Path = $script:DshGuardianTakeoverBudgetPath,
        [int]$CooldownSeconds = 600,
        [string]$Reason = 'takeover_failed',
        [DateTimeOffset]$Now = [DateTimeOffset]::Now
    )
    $budget = Read-DshGuardianTakeoverBudget -Path $Path
    if (-not $budget.Valid) { return $false }
    $budget.cooldownUntil = $Now.AddSeconds($CooldownSeconds).ToString('o')
    $budget.lastResult = $Reason
    return Write-DshGuardianTakeoverBudget -Value $budget -Path $Path
}

function ConvertTo-DshGuardianProcessProbeResult([object]$Value) {
    if ($null -eq $Value) { return [pscustomobject]@{ ProbeOk = $false; Processes = @() } }
    $names = @($Value.PSObject.Properties.Name)
    if ($names -contains 'ProbeOk' -and $names -contains 'Processes') {
        return [pscustomobject]@{ ProbeOk = [bool]$Value.ProbeOk; Processes = @($Value.Processes) }
    }
    return [pscustomobject]@{ ProbeOk = $true; Processes = @($Value) }
}

function Start-DshGuardianCanonicalProcess {
    param(
        [string]$GuardianScript,
        [int]$PortNumber,
        [bool]$NoKeepAwakeFlag = $false,
        [bool]$NoLidGuardFlag = $false
    )
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $GuardianScript, '-Port', [string]$PortNumber)
    if ($NoKeepAwakeFlag) { $args += '-NoKeepAwake' }
    if ($NoLidGuardFlag) { $args += '-NoLidGuard' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.UseShellExecute = $true
    $psi.WindowStyle = 'Hidden'
    $psi.Arguments = (($args | ForEach-Object {
        $s = [string]$_
        if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s }
    }) -join ' ')
    return [System.Diagnostics.Process]::Start($psi)
}

function ConvertTo-DshGuardianSpawnIdentity {
    param(
        [object]$Process,
        [string]$TakeoverAttemptId
    )
    $processPid = 0
    try { $processPid = [int]$Process.Id } catch {}
    if ($processPid -le 0) { try { $processPid = [int]$Process.ProcessId } catch {} }
    $processStart = Get-DshGuardianProcessStartUtc $Process
    $processName = [string]$Process.ProcessName
    $commandLine = [string]$Process.CommandLine
    $base = [ordered]@{
        Proven             = $false
        Pid                = $processPid
        ProcessStart       = $processStart
        ProcessStartIdentity = ConvertTo-DshGuardianSpawnProcessStartIdentity $processStart
        ProcessName        = $processName
        CommandLine        = $commandLine
        TakeoverAttemptId = $TakeoverAttemptId
        Reason             = $null
    }
    if ($processPid -le 0) { $base.Reason = 'spawned_process_pid_missing'; return [pscustomobject]$base }
    if ($null -eq $processStart) { $base.Reason = 'spawned_process_start_time_missing'; return [pscustomobject]$base }
    if ($null -eq $base.ProcessStartIdentity) { $base.Reason = 'spawned_process_start_identity_missing'; return [pscustomobject]$base }
    if ($processName -notmatch '(?i)^(?:powershell|pwsh)(?:\.exe)?$') {
        $base.Reason = 'spawned_process_not_powershell'
        return [pscustomobject]$base
    }
    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and
        (($commandLine -notmatch '(?i)dsh-guardian\.ps1(?:["\s]|$)') -or
         ($commandLine -match '(?i)dsh-guardian-watchdog\.ps1(?:["\s]|$)'))) {
        $base.Reason = 'spawned_process_command_line_not_guardian'
        return [pscustomobject]$base
    }
    $base.Proven = $true
    $base.Reason = 'spawned_pid_start_identity_recorded'
    return [pscustomobject]$base
}

function Test-DshGuardianSpawnedProcessIdentity {
    param(
        [object]$SpawnIdentity,
        [object]$Process
    )
    $processPid = 0
    try { $processPid = [int]$Process.ProcessId } catch {}
    if ($processPid -le 0) { try { $processPid = [int]$Process.Id } catch {} }
    $processStart = Get-DshGuardianProcessStartUtc $Process
    $processStartIdentity = ConvertTo-DshGuardianSpawnProcessStartIdentity $processStart
    $processName = [string]$Process.ProcessName
    $commandLine = [string]$Process.CommandLine
    $base = [ordered]@{
        Proven       = $false
        Pid          = $processPid
        ProcessStart         = $processStart
        ProcessStartIdentity = $processStartIdentity
        Reason               = $null
    }
    if ($null -eq $SpawnIdentity -or -not $SpawnIdentity.Proven) {
        $base.Reason = 'spawn_identity_not_proven'
        return [pscustomobject]$base
    }
    if ($processPid -ne [int]$SpawnIdentity.Pid) {
        $base.Reason = 'spawned_pid_mismatch'
        return [pscustomobject]$base
    }
    if ($null -eq $processStart -or $null -eq $processStartIdentity -or
        $null -eq $SpawnIdentity.ProcessStart -or [string]::IsNullOrWhiteSpace([string]$SpawnIdentity.ProcessStartIdentity)) {
        $base.Reason = 'spawned_start_time_incomplete'
        return [pscustomobject]$base
    }
    if ($processStartIdentity -cne [string]$SpawnIdentity.ProcessStartIdentity) {
        $base.Reason = 'spawned_start_time_mismatch'
        return [pscustomobject]$base
    }
    if ($processName -notmatch '(?i)^(?:powershell|pwsh)(?:\.exe)?$') {
        $base.Reason = 'spawned_process_not_powershell'
        return [pscustomobject]$base
    }
    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and
        (($commandLine -notmatch '(?i)dsh-guardian\.ps1(?:["\s]|$)') -or
         ($commandLine -match '(?i)dsh-guardian-watchdog\.ps1(?:["\s]|$)'))) {
        $base.Reason = 'spawned_process_command_line_not_guardian'
        return [pscustomobject]$base
    }
    $base.Proven = $true
    $base.Reason = 'spawned_pid_start_identity_matches'
    return [pscustomobject]$base
}

function Wait-DshGuardianSpawnGone {
    param(
        [object]$SpawnIdentity,
        [scriptblock]$GetProcesses,
        [int]$TimeoutSeconds = 20,
        [int]$PollMilliseconds = 500
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try { $probe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $null) } catch {
            return [pscustomobject]@{ Gone = $false; Reason = 'spawn_identity_probe_failed_while_waiting_gone' }
        }
        if (-not $probe.ProbeOk) {
            return [pscustomobject]@{ Gone = $false; Reason = 'spawn_identity_probe_failed_while_waiting_gone' }
        }
        $same = @($probe.Processes | Where-Object {
            (Test-DshGuardianSpawnedProcessIdentity -SpawnIdentity $SpawnIdentity -Process $_).Proven
        })
        if ($same.Count -eq 0) { return [pscustomobject]@{ Gone = $true; Reason = 'spawned_identity_gone' } }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        if ($PollMilliseconds -gt 0) { Start-Sleep -Milliseconds $PollMilliseconds }
    } while ($true)
    return [pscustomobject]@{ Gone = $false; Reason = 'spawned_identity_survived_cleanup_timeout' }
}

function Invoke-DshGuardianSpawnCleanup {
    param(
        [object]$SpawnIdentity,
        [object]$PreviousHeartbeat,
        [int]$StaleSeconds = 90,
        [scriptblock]$GetHeartbeat,
        [scriptblock]$GetProcesses,
        [scriptblock]$StopProcess,
        [int]$GoneTimeoutSeconds = 20,
        [int]$PollMilliseconds = 500
    )
    $result = [ordered]@{
        Preserved       = $false
        CleanupState    = 'NOT_SAFE_TO_CLEAN'
        Reason          = $null
        Pid             = if ($null -ne $SpawnIdentity) { $SpawnIdentity.Pid } else { 0 }
        TakeoverAttemptId = if ($null -ne $SpawnIdentity) { $SpawnIdentity.TakeoverAttemptId } else { $null }
        Verification    = $null
        Actions         = @()
    }
    if ($null -eq $SpawnIdentity -or -not $SpawnIdentity.Proven) {
        $result.Reason = 'spawn_identity_not_proven'
        return [pscustomobject]$result
    }
    try { $latestHeartbeat = & $GetHeartbeat } catch {
        $result.Reason = 'cleanup_heartbeat_probe_failed'
        return [pscustomobject]$result
    }
    try { $probe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $latestHeartbeat) } catch {
        $result.Reason = 'cleanup_identity_probe_failed'
        return [pscustomobject]$result
    }
    if (-not $probe.ProbeOk) {
        $result.Reason = 'cleanup_identity_probe_failed'
        return [pscustomobject]$result
    }
    $verification = Confirm-DshGuardianTakeover -ExpectedPid ([int]$SpawnIdentity.Pid) -Heartbeat $latestHeartbeat `
        -Processes $probe.Processes -PreviousHeartbeat $PreviousHeartbeat -MaxAgeSeconds $StaleSeconds
    if ($verification.Verified) {
        $result.Preserved = $true
        $result.CleanupState = 'CANCELLED_VALID_GUARDIAN'
        $result.Reason = 'fresh_new_guardian_verified_at_cleanup_boundary'
        $result.Verification = $verification
        return [pscustomobject]$result
    }
    $exact = @($probe.Processes | Where-Object {
        (Test-DshGuardianSpawnedProcessIdentity -SpawnIdentity $SpawnIdentity -Process $_).Proven
    })
    if ($exact.Count -eq 0) {
        $samePid = @($probe.Processes | Where-Object {
            try { [int]$_.ProcessId -eq [int]$SpawnIdentity.Pid } catch { $false }
        })
        if ($samePid.Count -eq 0) {
            $result.CleanupState = 'PROVEN'
            $result.Reason = 'spawned_identity_already_gone'
        } else {
            $result.Reason = 'spawned_pid_present_identity_changed'
        }
        return [pscustomobject]$result
    }
    if ($exact.Count -ne 1) {
        $result.Reason = 'spawned_identity_ambiguous'
        return [pscustomobject]$result
    }
    try {
        & $StopProcess ([int]$SpawnIdentity.Pid)
        $result.Actions = @('stop-unverified-spawned-guardian:{0}' -f $SpawnIdentity.Pid)
    } catch {
        $result.Reason = 'unverified_spawned_guardian_stop_failed'
        return [pscustomobject]$result
    }
    $gone = Wait-DshGuardianSpawnGone -SpawnIdentity $SpawnIdentity -GetProcesses $GetProcesses `
        -TimeoutSeconds $GoneTimeoutSeconds -PollMilliseconds $PollMilliseconds
    if ($gone.Gone) {
        $result.CleanupState = 'PROVEN'
        $result.Reason = 'unverified_spawned_guardian_stopped_and_gone'
        $result.Actions += 'unverified-spawned-guardian-identity-gone'
    } else {
        $result.Reason = $gone.Reason
    }
    return [pscustomobject]$result
}

function Wait-DshGuardianProcessGone {
    param(
        [object]$OldHeartbeat,
        [int]$OldPid,
        [DateTime]$OldStart,
        [scriptblock]$GetProcesses,
        [int]$TimeoutSeconds = 20,
        [int]$PollMilliseconds = 500
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $probe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $OldHeartbeat)
        if (-not $probe.ProbeOk) { return [pscustomobject]@{ Gone = $false; Reason = 'identity_probe_failed_while_waiting_gone' } }
        $same = @($probe.Processes | Where-Object {
            $identity = Test-DshGuardianProcessIdentity -Heartbeat $OldHeartbeat -Process $_
            $identity.Proven -and $identity.Pid -eq $OldPid -and $null -ne $identity.ProcessStart -and
                ([Math]::Abs((($identity.ProcessStart - $OldStart).TotalSeconds)) -le 30)
        })
        if ($same.Count -eq 0) { return [pscustomobject]@{ Gone = $true; Reason = 'old_identity_gone' } }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        if ($PollMilliseconds -gt 0) { Start-Sleep -Milliseconds $PollMilliseconds }
    } while ($true)
    return [pscustomobject]@{ Gone = $false; Reason = 'old_identity_survived_stop_timeout' }
}

function Confirm-DshGuardianTakeover {
    param(
        [int]$ExpectedPid,
        [object]$Heartbeat,
        [object[]]$Processes = @(),
        [object]$PreviousHeartbeat = $null,
        [DateTime]$Now = (Get-Date).ToUniversalTime(),
        [int]$MaxAgeSeconds = 90
    )
    $observation = Resolve-DshGuardianFenceObservation -Heartbeat $Heartbeat -Processes $Processes -Now $Now -MaxAgeSeconds $MaxAgeSeconds
    $generation = [string]$Heartbeat.generation
    $previousGeneration = [string]$PreviousHeartbeat.generation
    $sequence = 0
    try { $sequence = [int]$Heartbeat.sequence } catch {}
    $phaseEntered = Convert-DshGuardianUtcDate $Heartbeat.phaseEnteredAt
    $verified = $observation.IdentityState -eq 'PROVEN' -and $observation.HeartbeatFresh -and
        $observation.HeartbeatPid -eq $ExpectedPid -and
        -not [string]::IsNullOrWhiteSpace($generation) -and $sequence -gt 0 -and $null -ne $phaseEntered -and
        ([string]::IsNullOrWhiteSpace($previousGeneration) -or $generation -ne $previousGeneration) -and
        [string]$Heartbeat.phase -notmatch '(?i)^exit$'
    $reason = if ($verified) { 'fresh_new_guardian_heartbeat_verified' }
        elseif ([string]::IsNullOrWhiteSpace($generation)) { 'new_guardian_generation_missing' }
        elseif ($sequence -le 0 -or $null -eq $phaseEntered) { 'new_guardian_progress_metadata_missing' }
        else { $observation.Reason }
    return [pscustomobject]@{
        Verified     = [bool]$verified
        State        = if ($verified) { 'TAKEOVER_VERIFIED' } else { 'AMBIGUOUS_FAIL_CLOSED' }
        Pid          = $observation.HeartbeatPid
        Generation   = $generation
        Sequence     = $sequence
        Observation  = $observation
        Reason       = $reason
    }
}

function New-DshGuardianTakeoverFailure {
    param(
        [object]$State,
        [string]$BudgetPath,
        [int]$CooldownSeconds,
        [string]$Reason,
        [DateTimeOffset]$Now,
        [object]$Cleanup = $null,
        [object[]]$Actions = @(),
        [object]$SpawnIdentity = $null
    )
    $null = Fail-DshGuardianTakeoverBudget -Path $BudgetPath -CooldownSeconds $CooldownSeconds -Reason $Reason -Now $Now
    $State.Phase = 'AMBIGUOUS_FAIL_CLOSED'
    $State.LastReason = $Reason
    return [pscustomobject]@{
        Verified = $false
        State = $State
        Phase = $State.Phase
        Reason = $Reason
        Actions = @($Actions)
        Cleanup = $Cleanup
        SpawnIdentity = $SpawnIdentity
        UnverifiedChildCleanup = if ($null -eq $Cleanup) { 'NOT_APPLICABLE' } elseif ($Cleanup.CleanupState -eq 'PROVEN') { 'PROVEN' } elseif ($Cleanup.CleanupState -eq 'CANCELLED_VALID_GUARDIAN') { 'CANCELLED_VALID_GUARDIAN' } else { 'NOT_SAFE_TO_CLEAN' }
    }
}

function Invoke-DshGuardianTakeover {
    param(
        [object]$Observation,
        [object]$State,
        [string]$GuardianScript,
        [int]$PortNumber = 3080,
        [int]$StaleSeconds = 90,
        [int]$TakeoverSeconds = 0,
        [int]$TakeoverMaxAttempts = 2,
        [int]$TakeoverCooldownSeconds = 600,
        [int]$TakeoverWindowSeconds = 900,
        [int]$TakeoverGoneTimeoutSeconds = 20,
        [int]$TakeoverVerifyTimeoutSeconds = 30,
        [int]$TakeoverPollMilliseconds = 500,
        [string]$BudgetPath = $script:DshGuardianTakeoverBudgetPath,
        [bool]$NoKeepAwakeFlag = $false,
        [bool]$NoLidGuardFlag = $false,
        [scriptblock]$GetHeartbeat,
        [scriptblock]$GetProcesses,
        [scriptblock]$StopProcess,
        [scriptblock]$StartProcess
    )
    if ($null -eq $State) { $State = New-DshGuardianFenceState }
    if ([string]::IsNullOrWhiteSpace($GuardianScript)) { $GuardianScript = Join-Path $PSScriptRoot 'dsh-guardian.ps1' }
    if ($null -eq $GetHeartbeat) { $GetHeartbeat = { Get-Heartbeat } }
    if ($null -eq $GetProcesses) { $GetProcesses = { param($hb) Get-DshGuardianIdentityProcesses -Heartbeat $hb -AsResult } }
    if ($null -eq $StopProcess) { $StopProcess = { param($id) Stop-Process -Id $id -Force -ErrorAction Stop } }
    if ($null -eq $StartProcess) { $StartProcess = { param($path, $port, $noAwake, $noLid) Start-DshGuardianCanonicalProcess -GuardianScript $path -PortNumber $port -NoKeepAwakeFlag $noAwake -NoLidGuardFlag $noLid } }
    if ($State.Phase -ne 'TAKEOVER_ELIGIBLE') {
        return [pscustomobject]@{ Verified = $false; State = $State; Phase = $State.Phase; Reason = 'takeover_not_eligible'; Actions = @() }
    }
    if ($Observation.IdentityState -notin @('PROVEN', 'ABSENT')) {
        $State.Phase = 'AMBIGUOUS_FAIL_CLOSED'
        return [pscustomobject]@{ Verified = $false; State = $State; Phase = $State.Phase; Reason = $Observation.Reason; Actions = @() }
    }
    $now = [DateTimeOffset]::Now
    $oldHeartbeat = $Observation.Heartbeat
    $oldPid = [int]$Observation.HeartbeatPid
    $oldStart = $Observation.ProcessStart
    $oldWasProven = $Observation.IdentityState -eq 'PROVEN'
    $takeoverThreshold = Get-DshGuardianTakeoverThresholdSec -StaleSeconds $StaleSeconds -RequestedSeconds $TakeoverSeconds
    $oldStartText = if ($null -ne $oldStart) { $oldStart.ToString('o') } else { $null }
    $registered = Register-DshGuardianTakeoverAttempt -Path $BudgetPath -MaxAttempts $TakeoverMaxAttempts -WindowSeconds $TakeoverWindowSeconds -OldPid $oldPid -OldStart $oldStartText -Now $now
    if (-not $registered.Registered) {
        $State.Phase = 'AMBIGUOUS_FAIL_CLOSED'
        $State.LastReason = $registered.Reason
        return [pscustomobject]@{ Verified = $false; State = $State; Phase = $State.Phase; Reason = $registered.Reason; Actions = @() }
    }
    $State.Phase = 'TAKEOVER_IN_PROGRESS'
    $State.TakeoverAttempts = [int]$State.TakeoverAttempts + 1
    $State.TakeoverAttemptId = [guid]::NewGuid().ToString('N')
    $actions = [System.Collections.Generic.List[string]]::new()

    $preHeartbeat = & $GetHeartbeat
    $preProbe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $preHeartbeat)
    if (-not $preProbe.ProbeOk) { return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'pre_takeover_identity_probe_failed' -Now $now) }
    $preObservation = Resolve-DshGuardianFenceObservation -Heartbeat $preHeartbeat -Processes $preProbe.Processes -ProbeOk $true -MaxAgeSeconds $StaleSeconds
    if ($oldWasProven) {
        if ($preObservation.IdentityState -ne 'PROVEN' -or $preObservation.HeartbeatFresh -or $null -eq $preObservation.AgeSeconds -or [double]$preObservation.AgeSeconds -lt $takeoverThreshold -or $preObservation.HeartbeatPid -ne $oldPid -or $null -eq $preObservation.ProcessStart -or $null -eq $oldStart -or [Math]::Abs((($preObservation.ProcessStart - $oldStart).TotalSeconds)) -gt 30) {
            return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'old_guardian_identity_changed_before_stop' -Now $now)
        }
        try {
            & $StopProcess $oldPid
            $actions.Add(('stop-old-guardian:{0}' -f $oldPid))
        } catch {
            return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'old_guardian_stop_failed' -Now $now)
        }
        $gone = Wait-DshGuardianProcessGone -OldHeartbeat $preHeartbeat -OldPid $oldPid -OldStart $oldStart -GetProcesses $GetProcesses -TimeoutSeconds $TakeoverGoneTimeoutSeconds -PollMilliseconds $TakeoverPollMilliseconds
        if (-not $gone.Gone) { return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason $gone.Reason -Now $now) }
        $actions.Add('old-guardian-identity-gone')
    }

    $postHeartbeat = & $GetHeartbeat
    $postProbe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $postHeartbeat)
    if (-not $postProbe.ProbeOk) { return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'post_stop_identity_probe_failed' -Now $now) }
    $postObservation = Resolve-DshGuardianFenceObservation -Heartbeat $postHeartbeat -Processes $postProbe.Processes -ProbeOk $true -MaxAgeSeconds $StaleSeconds
    if ($postObservation.IdentityState -eq 'AMBIGUOUS' -or $postObservation.IdentityState -eq 'PROVEN') {
        return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'other_guardian_present_or_identity_ambiguous' -Now $now)
    }

    $spawn = $null
    $spawnIdentity = $null
    try {
        $spawn = & $StartProcess $GuardianScript $PortNumber $NoKeepAwakeFlag $NoLidGuardFlag
        $spawnIdentity = ConvertTo-DshGuardianSpawnIdentity -Process $spawn -TakeoverAttemptId $State.TakeoverAttemptId
        $expectedPid = [int]$spawnIdentity.Pid
        if ($expectedPid -le 0) { throw 'canonical Guardian start returned no PID' }
        $actions.Add(('start-canonical-guardian:{0}' -f $expectedPid))
        if ($spawnIdentity.Proven) {
            $actions.Add(('spawn-identity-recorded:{0}' -f $spawnIdentity.ProcessStart.ToString('o')))
        } else {
            $actions.Add(('spawn-identity-unproven:{0}' -f $spawnIdentity.Reason))
        }
    } catch {
        return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'canonical_guardian_start_failed' -Now $now -SpawnIdentity $spawnIdentity -Actions @($actions))
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TakeoverVerifyTimeoutSeconds)
    do {
        $verifyHeartbeat = & $GetHeartbeat
        $verifyProbe = ConvertTo-DshGuardianProcessProbeResult (& $GetProcesses $verifyHeartbeat)
        if ($verifyProbe.ProbeOk) {
            $verification = Confirm-DshGuardianTakeover -ExpectedPid $expectedPid -Heartbeat $verifyHeartbeat -Processes $verifyProbe.Processes -PreviousHeartbeat $oldHeartbeat -MaxAgeSeconds $StaleSeconds
            if ($verification.Verified) {
                if (-not (Complete-DshGuardianTakeoverBudget -Path $BudgetPath -WindowSeconds $TakeoverWindowSeconds -Now ([DateTimeOffset]::Now))) {
                    return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'takeover_budget_commit_failed' -Now ([DateTimeOffset]::Now) -SpawnIdentity $spawnIdentity -Actions @($actions))
                }
                $State.Phase = 'TAKEOVER_VERIFIED'
                $State.LastReason = $verification.Reason
                $actions.Add('new-guardian-heartbeat-verified')
                return [pscustomobject]@{ Verified = $true; State = $State; Phase = $State.Phase; Reason = $verification.Reason; Actions = @($actions); Verification = $verification; SpawnIdentity = $spawnIdentity; Cleanup = $null; UnverifiedChildCleanup = 'NOT_APPLICABLE' }
            }
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        if ($TakeoverPollMilliseconds -gt 0) { Start-Sleep -Milliseconds $TakeoverPollMilliseconds }
    } while ($true)
    $cleanup = Invoke-DshGuardianSpawnCleanup -SpawnIdentity $spawnIdentity -PreviousHeartbeat $oldHeartbeat `
        -StaleSeconds $StaleSeconds -GetHeartbeat $GetHeartbeat -GetProcesses $GetProcesses `
        -StopProcess $StopProcess -GoneTimeoutSeconds $TakeoverGoneTimeoutSeconds -PollMilliseconds $TakeoverPollMilliseconds
    if ($cleanup.Preserved) {
        if (-not (Complete-DshGuardianTakeoverBudget -Path $BudgetPath -WindowSeconds $TakeoverWindowSeconds -Now ([DateTimeOffset]::Now))) {
            return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'takeover_budget_commit_failed' -Now ([DateTimeOffset]::Now) -Cleanup $cleanup -SpawnIdentity $spawnIdentity -Actions @($actions))
        }
        $State.Phase = 'TAKEOVER_VERIFIED'
        $State.LastReason = $cleanup.Reason
        $actions.Add('new-guardian-heartbeat-verified-at-cleanup-boundary')
        return [pscustomobject]@{ Verified = $true; State = $State; Phase = $State.Phase; Reason = $cleanup.Reason; Actions = @($actions); Verification = $cleanup.Verification; SpawnIdentity = $spawnIdentity; Cleanup = $cleanup; UnverifiedChildCleanup = 'NOT_APPLICABLE' }
    }
    $actions.Add(('unverified-child-cleanup:{0}' -f $cleanup.CleanupState))
    return (New-DshGuardianTakeoverFailure -State $State -BudgetPath $BudgetPath -CooldownSeconds $TakeoverCooldownSeconds -Reason 'new_guardian_takeover_unverified' -Now ([DateTimeOffset]::Now) -Cleanup $cleanup -SpawnIdentity $spawnIdentity -Actions @($actions))
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

function Get-DshGuardianIdentityProcesses([object]$Heartbeat = $null, [switch]$AsResult) {
    $result = @()
    $probeOk = $true
    try {
        $rows = @(Get-CimInstance Win32_Process -Filter "(Name='powershell.exe' OR Name='pwsh.exe')" -ErrorAction Stop)
        $result += @($rows | ForEach-Object {
            [pscustomobject]@{
                ProcessId = [int]$_.ProcessId
                ProcessName = [string]$_.Name
                CommandLine = [string]$_.CommandLine
                CreationDate = $_.CreationDate
            }
        })
    } catch {
        $probeOk = $false
        TraceW ('process probe error: ' + $_.Exception.Message)
    }
    $heartbeatPid = 0
    try { $heartbeatPid = [int]$Heartbeat.pid } catch {}
    if ($heartbeatPid -gt 0 -and -not @($result | Where-Object { $_.ProcessId -eq $heartbeatPid })) {
        try {
            $p = Get-Process -Id $heartbeatPid -ErrorAction Stop
            if ([string]$p.ProcessName -match '(?i)^(?:powershell|pwsh)') {
                $result += [pscustomobject]@{
                    ProcessId = [int]$p.Id
                    ProcessName = [string]$p.ProcessName
                    CommandLine = ''
                    StartTime = $p.StartTime
                }
            }
        } catch {}
    }
    if ($AsResult) {
        return [pscustomobject]@{ ProbeOk = [bool]$probeOk; Processes = @($result) }
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
    $processProbe = Get-DshGuardianIdentityProcesses -Heartbeat $heartbeat -AsResult
    $processes = @($processProbe.Processes)
    $presence = Resolve-DshGuardianPresence -Heartbeat $heartbeat -Processes $processes -MaxAgeSeconds $StaleSeconds
    if (-not $processProbe.ProbeOk) {
        $script:DshGuardianFenceState = (New-DshGuardianFenceState)
        $script:DshGuardianFenceState.Phase = 'AMBIGUOUS_FAIL_CLOSED'
        TraceW 'guardian identity probe failed; no kill/start'
        return
    }
    $observation = Resolve-DshGuardianFenceObservation -Heartbeat $heartbeat -Processes $processes -ProbeOk $true -MaxAgeSeconds $StaleSeconds
    if ($presence.State -eq 'present') {
        if ($observation.IdentityState -eq 'AMBIGUOUS') {
            $script:DshGuardianFenceState = (New-DshGuardianFenceState)
            $script:DshGuardianFenceState.Phase = 'AMBIGUOUS_FAIL_CLOSED'
            TraceW ("guardian identity ambiguous; no kill/start reason=$($observation.Reason)")
            return
        }
        $decision = Update-DshGuardianFenceState -State $script:DshGuardianFenceState -Observation $observation -StaleSeconds $StaleSeconds -TakeoverSeconds $TakeoverSeconds
        $script:DshGuardianFenceState = $decision.State
        TraceW ("guardian healthy pid=$($presence.Pid) heartbeatAge=$([int]$presence.AgeSeconds)s source=$($presence.Source) fence=$($decision.Phase) port=$Port")
        return
    }
    if ($presence.State -eq 'stale_live') {
        $decision = Update-DshGuardianFenceState -State $script:DshGuardianFenceState -Observation $observation -StaleSeconds $StaleSeconds -TakeoverSeconds $TakeoverSeconds
        $script:DshGuardianFenceState = $decision.State
        if ($decision.Action -eq 'TAKEOVER') {
            $takeover = Invoke-DshGuardianTakeover -Observation $observation -State $script:DshGuardianFenceState `
                -GuardianScript $GuardianPath -PortNumber $Port -StaleSeconds $StaleSeconds `
                -TakeoverSeconds $TakeoverSeconds `
                -TakeoverMaxAttempts $TakeoverMaxAttempts -TakeoverCooldownSeconds $TakeoverCooldownSeconds `
                -TakeoverWindowSeconds $TakeoverWindowSeconds -TakeoverGoneTimeoutSeconds $TakeoverGoneTimeoutSeconds `
                -TakeoverVerifyTimeoutSeconds $TakeoverVerifyTimeoutSeconds -TakeoverPollMilliseconds $TakeoverPollMilliseconds `
                -BudgetPath $script:DshGuardianTakeoverBudgetPath -NoKeepAwakeFlag $NoKeepAwake -NoLidGuardFlag $NoLidGuard
            $script:DshGuardianFenceState = $takeover.State
            if ($takeover.Verified) {
                TraceW ("guardian takeover verified pid=$($takeover.Verification.Pid) generation=$($takeover.Verification.Generation)")
            } else {
                $cleanupState = if ($null -ne $takeover.Cleanup) { $takeover.Cleanup.CleanupState } else { 'NOT_APPLICABLE' }
                TraceW ("guardian takeover not verified phase=$($takeover.Phase) reason=$($takeover.Reason) unverifiedChildCleanup=$($takeover.UnverifiedChildCleanup) cleanupState=$cleanupState")
            }
        } else {
            TraceW ("guardian heartbeat stale; live Guardian pid=$($presence.Pid); fence=$($decision.Phase); no kill/start")
        }
        return
    }
    if (-not $presence.ShouldStart) {
        TraceW ("guardian identity ambiguous; no kill/start reason=$($presence.Reason)")
        return
    }

    # Gate: Resolve-DshGuardianPresence must complete before the shared budget
    # gate and the normal absent-path Process.Start edge.
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
    $startGate = Test-DshGuardianStartAllowed -Path $script:DshGuardianTakeoverBudgetPath `
        -MaxAttempts $TakeoverMaxAttempts -WindowSeconds $TakeoverWindowSeconds -Now ([DateTimeOffset]::Now)
    if (-not $startGate.Allowed) {
        TraceW ("guardian start blocked by takeover budget reason=$($startGate.Reason) pauseUntil=$($startGate.PauseUntil)")
        return
    }
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

function Enter-DshGuardianWatchdogMutex {
    try {
        $mutex = New-Object System.Threading.Mutex($false, 'DSHGuardian.Watchdog.SingleInstance')
        $acquired = $false
        try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if ($acquired) { return $mutex }
        $mutex.Dispose()
    } catch {}
    return $null
}

$watchdogMutex = Enter-DshGuardianWatchdogMutex
if ($null -eq $watchdogMutex) {
    TraceW 'watchdog already running; no second supervisor started'
    exit 0
}
try {
    if ($Loop) {
        # Resident supervisor mode (Startup-launched): check every 60s forever.
        # This is the primary recovery path; it does not depend on the Task
        # Scheduler repetition window.
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
    }
} finally {
    try { $watchdogMutex.ReleaseMutex() } catch {}
    try { $watchdogMutex.Dispose() } catch {}
}
