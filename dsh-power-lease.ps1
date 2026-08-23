# dsh-power-lease.ps1 - finite, independently observable DSH Power Request lease.
#
# This process never changes a power plan, lid action, registry, BIOS, or service.
# It owns a thread-scoped ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED request only
# while it is alive, reasserts it periodically, and always releases it on exit.
param(
    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 2700,
    [string]$LeaseId = ("dsh-lease-" + [guid]::NewGuid().ToString('N')),
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'DSHHarness\state\power-lease.json'),
    [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'DSHHarness\logs\power-lease.log'),
    [string]$StopFile = ''
)

$ErrorActionPreference = 'Stop'
$stateDirectory = Split-Path -Parent $StatePath
$logDirectory = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Force -Path $stateDirectory, $logDirectory | Out-Null

function Write-LeaseLog([string]$Message) {
    try {
        Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    } catch {}
}

function Write-LeaseState([string]$Phase, [string]$Detail, [bool]$RequestActive) {
    $payload = [ordered]@{
        leaseId = $LeaseId
        pid = $PID
        startedAt = $script:StartedAt
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        phase = $Phase
        durationSeconds = $DurationSeconds
        deadlineAt = $script:Deadline.ToUniversalTime().ToString('o')
        requestActive = $RequestActive
        detail = $Detail
    }
    $temporary = "$StatePath.tmp-$PID"
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

Add-Type -Namespace DshPowerLease -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$ES_AWAYMODE_REQUIRED = [uint32]64
$script:StartedAt = Get-Date
$script:Deadline = $script:StartedAt.AddSeconds($DurationSeconds)
$exitCode = 0
$phase = 'starting'

try {
    $result = [DshPowerLease.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED)
    if ($result -eq 0) { throw ("SetThreadExecutionState failed win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $phase = 'active'
    Write-LeaseState $phase 'system_required_awaymode_required' $true
    Write-LeaseLog "lease=$LeaseId pid=$PID active durationSeconds=$DurationSeconds"

    while ((Get-Date) -lt $script:Deadline) {
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) {
            $phase = 'stopped_by_monitor'
            Write-LeaseLog "lease=$LeaseId stop signal observed"
            break
        }
        Start-Sleep -Seconds 15
        $result = [DshPowerLease.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED)
        if ($result -eq 0) { throw ("lease reassert failed win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
        Write-LeaseState 'active' 'system_required_awaymode_required' $true
    }
    if ($phase -eq 'active') { $phase = 'completed' }
} catch {
    $exitCode = 1
    $phase = 'failed'
    Write-LeaseLog "lease=$LeaseId failed class=$($_.Exception.GetType().Name)"
} finally {
    try { $null = [DshPowerLease.Native]::SetThreadExecutionState($ES_CONTINUOUS) } catch {}
    try { Write-LeaseState $phase 'request_released' $false } catch {}
    Write-LeaseLog "lease=$LeaseId phase=$phase released exitCode=$exitCode"
}

exit $exitCode
