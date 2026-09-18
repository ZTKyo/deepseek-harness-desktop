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
$script:DshLidActionSettingGuid = '5ca83367-6e45-459f-a27b-476b1d01c936'

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

function Get-DshLidActionValuesFromQuery {
    param([Parameter(Mandatory = $true)][string[]]$Lines)

    $targetGuid = $script:DshLidActionSettingGuid
    $blocks = New-Object System.Collections.Generic.List[object]
    $current = $null
    foreach ($rawLine in @($Lines)) {
        $line = [string]$rawLine
        $settingMatch = [regex]::Match($line, '(?i)^\s*Power\s+Setting\s+GUID\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
        if ($settingMatch.Success) {
            if ($null -ne $current -and $current.IsTarget) {
                $blocks.Add([pscustomobject]$current)
            }
            $guid = $settingMatch.Groups[1].Value.ToLowerInvariant()
            $current = [ordered]@{
                Guid = $guid
                IsTarget = ($guid -eq $targetGuid)
                AcValues = @()
                DcValues = @()
            }
            continue
        }
        if ($null -eq $current -or -not $current.IsTarget) { continue }
        $acMatch = [regex]::Match($line, '(?i)(?:Current\s+AC\s+Power\s+Setting\s+Index|当前交流电源设置索引|交流电源设置索引)\s*:\s*(0x[0-9a-f]+|\d+)')
        if ($acMatch.Success) { $current.AcValues += ,(ConvertTo-DshPowerValue $acMatch.Groups[1].Value) }
        $dcMatch = [regex]::Match($line, '(?i)(?:Current\s+DC\s+Power\s+Setting\s+Index|当前直流电源设置索引|直流电源设置索引)\s*:\s*(0x[0-9a-f]+|\d+)')
        if ($dcMatch.Success) { $current.DcValues += ,(ConvertTo-DshPowerValue $dcMatch.Groups[1].Value) }
    }
    if ($null -ne $current -and $current.IsTarget) {
        $blocks.Add([pscustomobject]$current)
    }

    if ($blocks.Count -ne 1) {
        throw ("LIDACTION setting GUID {0} must have exactly one query block; found {1}" -f $targetGuid, $blocks.Count)
    }
    $block = $blocks[0]
    if (@($block.AcValues).Count -ne 1 -or @($block.DcValues).Count -ne 1) {
        throw ("LIDACTION setting GUID {0} must have exactly one AC and one DC current index; AC={1} DC={2}" -f $targetGuid, @($block.AcValues).Count, @($block.DcValues).Count)
    }
    [pscustomobject]@{
        AcValue = [uint32]$block.AcValues[0]
        DcValue = [uint32]$block.DcValues[0]
        AcHex = ConvertTo-DshPowerHex $block.AcValues[0]
        DcHex = ConvertTo-DshPowerHex $block.DcValues[0]
    }
}

function Get-DshPowerPolicySnapshot {
    param(
        [string]$Scheme = 'SCHEME_CURRENT',
        [scriptblock]$CommandRunner
    )
    $activeResult = Invoke-DshPowerCfgCommand -Arguments @('/getactivescheme') -CommandRunner $CommandRunner
    $activeText = (@($activeResult.Stdout) -join [Environment]::NewLine)
    $activeMatch = [regex]::Match($activeText, '(?i)Power\s+Scheme\s+GUID\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
    if (-not $activeMatch.Success) { throw 'active power scheme GUID not found' }

    $queryResult = Invoke-DshPowerCfgCommand -Arguments @('/q', $Scheme, 'SUB_BUTTONS') -CommandRunner $CommandRunner
    $values = Get-DshLidActionValuesFromQuery -Lines @($queryResult.Stdout)
    [pscustomobject]@{
        ActiveSchemeGuid = $activeMatch.Groups[1].Value.ToLowerInvariant()
        AcValue = [uint32]$values.AcValue
        DcValue = [uint32]$values.DcValue
        AcHex = $values.AcHex
        DcHex = $values.DcHex
    }
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

function Write-DshPowerPolicyState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$State
    )
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [ordered]@{
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
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
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
        [Parameter(Mandatory = $true)][string]$Message
    )
    $State.State = 'FAILED'
    $State.FailedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $State.Failure = $Message
    Write-DshPowerPolicyState -Path $Path -State $State
}

function Invoke-DshAlwaysOnPowerPolicyApply {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner
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
        Write-DshPowerPolicyState -Path $Path -State $state
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
    Write-DshPowerPolicyState -Path $Path -State $state
    $null = Assert-DshPowerPolicyCheckpoint -Path $Path -Expected $state

    try {
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $current.ActiveSchemeGuid, 'SUB_BUTTONS', 'LIDACTION', '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $current.ActiveSchemeGuid, 'SUB_BUTTONS', 'LIDACTION', '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $current.ActiveSchemeGuid) -CommandRunner $CommandRunner
        $verified = Get-DshPowerPolicySnapshot -Scheme $current.ActiveSchemeGuid -CommandRunner $CommandRunner
        if ($verified.AcValue -ne 0 -or $verified.DcValue -ne 0) { throw 'LIDACTION=0 verification failed' }
    } catch {
        $failureMessage = $_.Exception.Message
        try { Write-DshPowerPolicyFailure -Path $Path -State $state -Message $failureMessage } catch { }
        throw
    }

    $state.State = 'APPLIED'
    $state.AppliedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $state.FailedAtUtc = $null
    $state.Failure = $null
    Write-DshPowerPolicyState -Path $Path -State $state
    $null = Read-DshPowerPolicyState -Path $Path
    [pscustomobject]@{ Mode = 'Apply'; Verified = $true; IdempotentNoWrite = $false; StatePath = $Path; Snapshot = $verified }
}

function Invoke-DshAlwaysOnPowerPolicyRestore {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner
    )
    $state = Read-DshPowerPolicyState -Path $Path
    if ($null -eq $state) { throw 'power policy restore state not found' }
    $scheme = $state.ActiveSchemeGuid
    # Restore arguments are decimal strings. Hex is reserved for query parsing
    # and diagnostics because powercfg accepts the setting index as a number.
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $scheme, 'SUB_BUTTONS', 'LIDACTION', ([string][uint32]$state.PreviousAc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $scheme, 'SUB_BUTTONS', 'LIDACTION', ([string][uint32]$state.PreviousDc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $scheme) -CommandRunner $CommandRunner
    $verified = Get-DshPowerPolicySnapshot -Scheme $scheme -CommandRunner $CommandRunner
    if ($verified.AcValue -ne $state.PreviousAc -or $verified.DcValue -ne $state.PreviousDc -or $verified.ActiveSchemeGuid -ne $scheme) {
        throw 'power policy restore verification failed'
    }
    $state.State = 'RESTORED'
    $state.RestoredAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $state.Failure = $null
    $state.FailedAtUtc = $null
    Write-DshPowerPolicyState -Path $Path -State $state
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
