# Set-DshAlwaysOnPowerPolicy.ps1 - bounded, one-shot lid power-policy setup.
#
# This helper is intentionally not a resident process and has no lifecycle
# authority. It only reads/restores the active scheme's lid AC/DC values or
# applies LIDACTION=0 when explicitly requested with -Apply.
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Restore,
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'DSHHarness\state\dsh-lid-power-policy.json'),
    [switch]$Library
)

$ErrorActionPreference = 'Stop'
$script:DshSubButtonsSubgroupGuid = '4f971e89-eebd-4455-a8de-9e59040e7347'
$script:DshLidActionSettingGuid = '5ca83367-6e45-459f-a27b-476b1d01c936'
$script:DshPowerGuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function ConvertTo-DshPowerCfgResult {
    param(
        [object[]]$Raw,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $items = @($Raw)
    $exitCode = 0
    $stdout = @()
    $stderr = @()
    $structured = $false
    if ($items.Count -eq 1 -and $null -ne $items[0] -and $items[0] -isnot [string]) {
        $propertyNames = @($items[0].PSObject.Properties.Name)
        $structured = $propertyNames -contains 'ExitCode'
    }
    if ($structured) {
        $exitCode = [int]$items[0].ExitCode
        if ($items[0].PSObject.Properties.Name -contains 'Stdout') { $stdout = @($items[0].Stdout) }
        if ($items[0].PSObject.Properties.Name -contains 'Stderr') { $stderr = @($items[0].Stderr) }
    } else {
        $stdout = @($items)
    }

    $result = [pscustomobject]@{
        ExitCode = $exitCode
        Stdout = $stdout
        Stderr = $stderr
        Arguments = @($Arguments)
        CommandType = 'powercfg'
    }
    if ($result.ExitCode -ne 0) {
        $diagnostic = @($result.Stderr + $result.Stdout) |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace([string]$diagnostic)) { $diagnostic = 'no diagnostic output' }
        throw ("powercfg command '{0}' failed with exit code {1}: {2}" -f ($Arguments -join ' '), $result.ExitCode, $diagnostic)
    }
    return $result
}

function Invoke-DshPowerCfgCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [scriptblock]$CommandRunner
    )
    if ($CommandRunner) {
        $raw = @(& $CommandRunner $Arguments)
    } else {
        $nativeOutput = @(& powercfg @Arguments 2>&1)
        $nativeExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        $raw = @([pscustomobject]@{
                ExitCode = $nativeExitCode
                Stdout = @($nativeOutput)
                Stderr = @()
            })
    }
    return ConvertTo-DshPowerCfgResult -Raw $raw -Arguments $Arguments
}

function ConvertTo-DshPowerValue {
    param([Parameter(Mandatory = $true)][string]$Value)
    $text = $Value.Trim()
    try {
        if ($text -match '(?i)^0x[0-9a-f]+$') {
            return [uint32]::Parse($text.Substring(2), [System.Globalization.NumberStyles]::AllowHexSpecifier, [System.Globalization.CultureInfo]::InvariantCulture)
        }
        if ($text -match '^\d+$') {
            return [uint32]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture)
        }
    } catch {
        throw "invalid power setting value '$Value'"
    }
    throw "invalid power setting value '$Value'"
}

function ConvertTo-DshPowerHex {
    param([Parameter(Mandatory = $true)][uint32]$Value)
    return ('0x{0:x8}' -f $Value)
}

function Get-DshActiveSchemeGuidFromOutput {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines)

    $text = (@($Lines) -join [Environment]::NewLine)
    $matches = @([regex]::Matches($text, ('(?i)(?<![0-9a-f]){0}(?![0-9a-f])' -f $script:DshPowerGuidPattern)))
    if ($matches.Count -ne 1) {
        throw ("active power scheme output must contain exactly one GUID; found {0}" -f $matches.Count)
    }
    return $matches[0].Value.ToLowerInvariant()
}

function Get-DshLidActionValuesFromQuery {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines)

    $targetGuid = $script:DshLidActionSettingGuid
    $targetBlockCount = 0
    $inTargetBlock = $false
    $acValues = @()
    $dcValues = @()
    foreach ($rawLine in @($Lines)) {
        $line = [string]$rawLine
        $guidMatches = @([regex]::Matches($line, ('(?i)(?<![0-9a-f]){0}(?![0-9a-f])' -f $script:DshPowerGuidPattern)))
        if ($guidMatches.Count -gt 0) {
            $lineGuids = @($guidMatches | ForEach-Object { $_.Value.ToLowerInvariant() })
            $targetOccurrences = @($lineGuids | Where-Object { $_ -eq $targetGuid }).Count
            if ($targetOccurrences -gt 0) {
                $targetBlockCount += $targetOccurrences
                $inTargetBlock = $true
            } elseif ($inTargetBlock) {
                # A different GUID begins the next setting block. Labels are
                # deliberately ignored so English and localized output behave
                # identically.
                $inTargetBlock = $false
            }
            continue
        }
        if (-not $inTargetBlock) { continue }
        $acMatch = [regex]::Match($line, '(?i)(?:Current\s+AC\s+Power\s+Setting\s+Index|当前交流电源设置索引|交流电源设置索引)\s*:\s*(0x[0-9a-f]+|\d+)')
        if ($acMatch.Success) { $acValues += ,(ConvertTo-DshPowerValue $acMatch.Groups[1].Value) }
        $dcMatch = [regex]::Match($line, '(?i)(?:Current\s+DC\s+Power\s+Setting\s+Index|当前直流电源设置索引|直流电源设置索引)\s*:\s*(0x[0-9a-f]+|\d+)')
        if ($dcMatch.Success) { $dcValues += ,(ConvertTo-DshPowerValue $dcMatch.Groups[1].Value) }
    }

    if ($targetBlockCount -ne 1) {
        throw ("LIDACTION setting GUID {0} must have exactly one query block; found {1}" -f $targetGuid, $targetBlockCount)
    }
    if (@($acValues).Count -ne 1 -or @($dcValues).Count -ne 1) {
        throw ("LIDACTION setting GUID {0} must have exactly one AC and one DC current index; AC={1} DC={2}" -f $targetGuid, @($acValues).Count, @($dcValues).Count)
    }
    [pscustomobject]@{
        AcValue = [uint32]$acValues[0]
        DcValue = [uint32]$dcValues[0]
        AcHex = ConvertTo-DshPowerHex $acValues[0]
        DcHex = ConvertTo-DshPowerHex $dcValues[0]
    }
}

function Get-DshPowerPolicySnapshot {
    param(
        [string]$Scheme,
        [scriptblock]$CommandRunner
    )
    $activeResult = Invoke-DshPowerCfgCommand -Arguments @('/getactivescheme') -CommandRunner $CommandRunner
    $activeSchemeGuid = Get-DshActiveSchemeGuidFromOutput -Lines @($activeResult.Stdout)
    $querySchemeGuid = if ([string]::IsNullOrWhiteSpace($Scheme)) { $activeSchemeGuid } else { $Scheme.ToLowerInvariant() }
    if ($querySchemeGuid -notmatch ('(?i)^{0}$' -f $script:DshPowerGuidPattern)) {
        throw "power policy query scheme GUID is malformed: '$Scheme'"
    }

    $queryResult = Invoke-DshPowerCfgCommand -Arguments @('/qh', $querySchemeGuid, $script:DshSubButtonsSubgroupGuid) -CommandRunner $CommandRunner
    $values = Get-DshLidActionValuesFromQuery -Lines @($queryResult.Stdout)
    [pscustomobject]@{
        ActiveSchemeGuid = $activeSchemeGuid
        QuerySchemeGuid = $querySchemeGuid
        SubgroupGuid = $script:DshSubButtonsSubgroupGuid
        SettingGuid = $script:DshLidActionSettingGuid
        AcValue = [uint32]$values.AcValue
        DcValue = [uint32]$values.DcValue
        AcHex = $values.AcHex
        DcHex = $values.DcHex
    }
}

function Assert-DshPowerPolicyMigrationBaseline {
    param(
        [Parameter(Mandatory = $true)][object]$PreMigrationSnapshot,
        [Parameter(Mandatory = $true)][object]$PostStopSnapshot
    )

    $required = @('ActiveSchemeGuid', 'SubgroupGuid', 'SettingGuid', 'AcValue', 'DcValue')
    foreach ($name in $required) {
        if ($PreMigrationSnapshot.PSObject.Properties.Name -notcontains $name -or
            $PostStopSnapshot.PSObject.Properties.Name -notcontains $name) {
            throw "LID_STATE_CHANGED_DURING_MIGRATION: missing exact snapshot field $name"
        }
    }
    $matches = ([string]$PreMigrationSnapshot.ActiveSchemeGuid).ToLowerInvariant() -eq ([string]$PostStopSnapshot.ActiveSchemeGuid).ToLowerInvariant() -and
        ([string]$PreMigrationSnapshot.SubgroupGuid).ToLowerInvariant() -eq ([string]$PostStopSnapshot.SubgroupGuid).ToLowerInvariant() -and
        ([string]$PreMigrationSnapshot.SettingGuid).ToLowerInvariant() -eq ([string]$PostStopSnapshot.SettingGuid).ToLowerInvariant() -and
        [uint32]$PreMigrationSnapshot.AcValue -eq [uint32]$PostStopSnapshot.AcValue -and
        [uint32]$PreMigrationSnapshot.DcValue -eq [uint32]$PostStopSnapshot.DcValue
    if (-not $matches) {
        throw 'LID_STATE_CHANGED_DURING_MIGRATION: post-stop exact LIDACTION differs from pre-migration baseline'
    }
    return $true
}

function ConvertTo-DshStateTimestamp {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime().ToString('o') }
    if ($Value -is [DateTime]) { return ([DateTimeOffset]$Value).ToUniversalTime().ToString('o') }
    return [string]$Value
}

function Read-DshPowerPolicyState {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($name in @('state', 'activeSchemeGuid', 'previousAc', 'previousDc', 'capturedAtUtc')) {
        if ($state.PSObject.Properties.Name -notcontains $name) { throw "power policy state missing $name" }
    }
    $stateName = ([string]$state.state).ToUpperInvariant()
    if ($stateName -notin @('CAPTURED', 'APPLIED', 'FAILED', 'RESTORED')) { throw "invalid power policy state '$stateName'" }
    if ([string]::IsNullOrWhiteSpace([string]$state.capturedAtUtc)) { throw 'power policy state capturedAtUtc is empty' }
    $guid = ([string]$state.activeSchemeGuid).ToLowerInvariant()
    if ($guid -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'power policy state activeSchemeGuid is malformed' }
    [pscustomobject]@{
        State = $stateName
        ActiveSchemeGuid = $guid
        PreviousAc = ConvertTo-DshPowerValue ([string]$state.previousAc)
        PreviousDc = ConvertTo-DshPowerValue ([string]$state.previousDc)
        CapturedAtUtc = ConvertTo-DshStateTimestamp $state.capturedAtUtc
        AppliedAtUtc = if ($state.PSObject.Properties.Name -contains 'appliedAtUtc') { ConvertTo-DshStateTimestamp $state.appliedAtUtc } else { $null }
        RestoredAtUtc = if ($state.PSObject.Properties.Name -contains 'restoredAtUtc') { ConvertTo-DshStateTimestamp $state.restoredAtUtc } else { $null }
        FailedAtUtc = if ($state.PSObject.Properties.Name -contains 'failedAtUtc') { ConvertTo-DshStateTimestamp $state.failedAtUtc } else { $null }
        Failure = if ($state.PSObject.Properties.Name -contains 'failure') { [string]$state.failure } else { $null }
    }
}

function Invoke-DshPowerPolicyAtomicCommit {
    param(
        [Parameter(Mandatory = $true)][string]$TempPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [scriptblock]$CommitFailureInjector
    )
    # Test-only hook runs after temp flush/close and at the final replacement
    # edge. Production callers leave it unset.
    if ($CommitFailureInjector) { $null = & $CommitFailureInjector $TempPath $TargetPath }
    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
        # File.Replace with a same-directory backup keeps the existing target
        # recoverable even if the filesystem reports a mid-replace failure.
        $parent = Split-Path -Parent $TargetPath
        if ([string]::IsNullOrWhiteSpace($parent)) { $parent = (Get-Location).Path }
        $backupPath = Join-Path $parent ('.' + [System.IO.Path]::GetFileName($TargetPath) + '.' + [guid]::NewGuid().ToString('N') + '.bak')
        $replaced = $false
        try {
            [System.IO.File]::Replace($TempPath, $TargetPath, $backupPath, $true)
            $replaced = $true
        } catch {
            # Some failure points can leave the old file at backupPath. Restore
            # it only when the target disappeared; otherwise leave the intact
            # target untouched. If restoration fails, keep the backup evidence.
            if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf) -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                try { [System.IO.File]::Move($backupPath, $TargetPath) } catch { }
            }
            throw
        } finally {
            if ($replaced -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
            }
        }
    } else {
        # Same-directory Move is an atomic rename for a first durable state.
        [System.IO.File]::Move($TempPath, $TargetPath)
    }
}

function Write-DshPowerPolicyState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$State,
        [scriptblock]$CommitFailureInjector
    )
    $parent = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($parent)) { $parent = (Get-Location).Path }
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $json = [ordered]@{
        schema = 2
        state = ([string]$State.State).ToUpperInvariant()
        activeSchemeGuid = ([string]$State.ActiveSchemeGuid).ToLowerInvariant()
        previousAc = [uint32]$State.PreviousAc
        previousDc = [uint32]$State.PreviousDc
        capturedAtUtc = [string]$State.CapturedAtUtc
        appliedAtUtc = if ($null -eq $State.AppliedAtUtc) { $null } else { [string]$State.AppliedAtUtc }
        restoredAtUtc = if ($null -eq $State.RestoredAtUtc) { $null } else { [string]$State.RestoredAtUtc }
        failedAtUtc = if ($null -eq $State.FailedAtUtc) { $null } else { [string]$State.FailedAtUtc }
        failure = if ($null -eq $State.Failure) { $null } else { [string]$State.Failure }
    } | ConvertTo-Json -Depth 5

    $tempPath = Join-Path $parent ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $encoding = New-Object System.Text.UTF8Encoding($true)
        $bytes = $encoding.GetBytes($json + [Environment]::NewLine)
        $stream = [System.IO.File]::Open($tempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }

        Invoke-DshPowerPolicyAtomicCommit -TempPath $tempPath -TargetPath $Path -CommitFailureInjector $CommitFailureInjector

        $committed = Read-DshPowerPolicyState -Path $Path
        if ($null -eq $committed -or
            $committed.State -ne ([string]$State.State).ToUpperInvariant() -or
            $committed.ActiveSchemeGuid -ne ([string]$State.ActiveSchemeGuid).ToLowerInvariant() -or
            $committed.PreviousAc -ne [uint32]$State.PreviousAc -or
            $committed.PreviousDc -ne [uint32]$State.PreviousDc) {
            throw 'power policy atomic commit read-back verification failed'
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-DshPowerPolicyCapturedState {
    param([Parameter(Mandatory = $true)][object]$Snapshot)
    [pscustomobject]@{
        State = 'CAPTURED'
        ActiveSchemeGuid = $Snapshot.ActiveSchemeGuid
        PreviousAc = [uint32]$Snapshot.AcValue
        PreviousDc = [uint32]$Snapshot.DcValue
        CapturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        AppliedAtUtc = $null
        RestoredAtUtc = $null
        FailedAtUtc = $null
        Failure = $null
    }
}

function Assert-DshPowerPolicyCheckpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Expected
    )
    $readBack = Read-DshPowerPolicyState -Path $Path
    if ($null -eq $readBack -or
        $readBack.State -ne 'CAPTURED' -or
        $readBack.ActiveSchemeGuid -ne $Expected.ActiveSchemeGuid -or
        $readBack.PreviousAc -ne $Expected.PreviousAc -or
        $readBack.PreviousDc -ne $Expected.PreviousDc -or
        $readBack.CapturedAtUtc -ne $Expected.CapturedAtUtc) {
        throw 'power policy CAPTURED checkpoint read-back verification failed before mutation'
    }
    return $readBack
}

function Write-DshPowerPolicyFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$State,
        [Parameter(Mandatory = $true)][string]$Message,
        [scriptblock]$CommitFailureInjector
    )
    $State.State = 'FAILED'
    $State.FailedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $State.Failure = $Message
    Write-DshPowerPolicyState -Path $Path -State $State -CommitFailureInjector $CommitFailureInjector
}

function Invoke-DshAlwaysOnPowerPolicyApply {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner,
        [scriptblock]$CommitFailureInjector
    )
    $current = Get-DshPowerPolicySnapshot -CommandRunner $CommandRunner
    $existing = Read-DshPowerPolicyState -Path $Path
    $reusable = $existing -and $existing.ActiveSchemeGuid -eq $current.ActiveSchemeGuid -and $existing.State -ne 'RESTORED'
    $state = if ($reusable) { $existing } else { New-DshPowerPolicyCapturedState -Snapshot $current }
    $needsMutation = $current.AcValue -ne 0 -or $current.DcValue -ne 0

    if (-not $needsMutation) {
        $verified = Get-DshPowerPolicySnapshot -Scheme $current.ActiveSchemeGuid -CommandRunner $CommandRunner
        if ($verified.AcValue -ne 0 -or $verified.DcValue -ne 0) { throw 'LIDACTION=0 verification failed' }
        $state.State = 'APPLIED'
        $state.AppliedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        $state.Failure = $null
        $state.FailedAtUtc = $null
        Write-DshPowerPolicyState -Path $Path -State $state -CommitFailureInjector $CommitFailureInjector
        $null = Read-DshPowerPolicyState -Path $Path
        return [pscustomobject]@{ Mode = 'Apply'; Verified = $true; IdempotentNoWrite = $true; StatePath = $Path; Snapshot = $verified }
    }

    # The durable CAPTURED checkpoint must exist and read back before the first
    # setac/setdc/setactive mutation. Keep the original values on retries.
    $state.State = 'CAPTURED'
    $state.AppliedAtUtc = $null
    $state.RestoredAtUtc = $null
    $state.FailedAtUtc = $null
    $state.Failure = $null
    Write-DshPowerPolicyState -Path $Path -State $state -CommitFailureInjector $CommitFailureInjector
    $null = Assert-DshPowerPolicyCheckpoint -Path $Path -Expected $state

    try {
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $current.ActiveSchemeGuid, $script:DshSubButtonsSubgroupGuid, $script:DshLidActionSettingGuid, '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $current.ActiveSchemeGuid, $script:DshSubButtonsSubgroupGuid, $script:DshLidActionSettingGuid, '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $current.ActiveSchemeGuid) -CommandRunner $CommandRunner
        $verified = Get-DshPowerPolicySnapshot -Scheme $current.ActiveSchemeGuid -CommandRunner $CommandRunner
        if ($verified.AcValue -ne 0 -or $verified.DcValue -ne 0) { throw 'LIDACTION=0 verification failed' }
    } catch {
        $failureMessage = $_.Exception.Message
        try { Write-DshPowerPolicyFailure -Path $Path -State $state -Message $failureMessage -CommitFailureInjector $CommitFailureInjector } catch { }
        throw
    }

    $state.State = 'APPLIED'
    $state.AppliedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $state.FailedAtUtc = $null
    $state.Failure = $null
    Write-DshPowerPolicyState -Path $Path -State $state -CommitFailureInjector $CommitFailureInjector
    $null = Read-DshPowerPolicyState -Path $Path
    [pscustomobject]@{ Mode = 'Apply'; Verified = $true; IdempotentNoWrite = $false; StatePath = $Path; Snapshot = $verified }
}

function Invoke-DshAlwaysOnPowerPolicyRestore {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner,
        [scriptblock]$CommitFailureInjector
    )
    $state = Read-DshPowerPolicyState -Path $Path
    if ($null -eq $state) { throw 'power policy restore state not found' }
    $scheme = $state.ActiveSchemeGuid
    # Restore arguments are decimal strings. Hex is reserved for query parsing
    # and diagnostics because powercfg accepts the setting index as a number.
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $scheme, $script:DshSubButtonsSubgroupGuid, $script:DshLidActionSettingGuid, ([string][uint32]$state.PreviousAc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $scheme, $script:DshSubButtonsSubgroupGuid, $script:DshLidActionSettingGuid, ([string][uint32]$state.PreviousDc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $scheme) -CommandRunner $CommandRunner
    $verified = Get-DshPowerPolicySnapshot -Scheme $scheme -CommandRunner $CommandRunner
    if ($verified.AcValue -ne $state.PreviousAc -or $verified.DcValue -ne $state.PreviousDc -or $verified.ActiveSchemeGuid -ne $scheme) {
        throw 'power policy restore verification failed'
    }
    $state.State = 'RESTORED'
    $state.RestoredAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $state.Failure = $null
    $state.FailedAtUtc = $null
    Write-DshPowerPolicyState -Path $Path -State $state -CommitFailureInjector $CommitFailureInjector
    $null = Read-DshPowerPolicyState -Path $Path
    [pscustomobject]@{ Mode = 'Restore'; Verified = $true; StatePath = $Path; Snapshot = $verified }
}

if ($Library) { return }
if (($Apply -and $Restore) -or (-not $Apply -and -not $Restore)) {
    throw 'specify exactly one of -Apply or -Restore'
}
if ($Apply) {
    Invoke-DshAlwaysOnPowerPolicyApply -Path $StatePath | ConvertTo-Json -Depth 8
} else {
    Invoke-DshAlwaysOnPowerPolicyRestore -Path $StatePath | ConvertTo-Json -Depth 8
}
