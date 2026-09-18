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

function Invoke-DshPowerCfgCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [scriptblock]$CommandRunner
    )
    if ($CommandRunner) {
        return @(& $CommandRunner $Arguments)
    }
    return @(& powercfg @Arguments 2>&1)
}

function ConvertTo-DshPowerValue {
    param([Parameter(Mandatory = $true)][string]$Value)
    $digits = $Value.Trim() -replace '^0x', ''
    return [uint32]::Parse($digits, [System.Globalization.NumberStyles]::AllowHexSpecifier, [System.Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-DshPowerHex {
    param([Parameter(Mandatory = $true)][uint32]$Value)
    return ('0x{0:x8}' -f $Value)
}

function Get-DshPowerPolicySnapshot {
    param(
        [string]$Scheme = 'SCHEME_CURRENT',
        [scriptblock]$CommandRunner
    )
    $activeOutput = @(Invoke-DshPowerCfgCommand -Arguments @('/getactivescheme') -CommandRunner $CommandRunner)
    $activeText = $activeOutput -join [Environment]::NewLine
    $activeMatch = [regex]::Match($activeText, '(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
    if (-not $activeMatch.Success) { throw 'active power scheme GUID not found' }

    $queryOutput = @(Invoke-DshPowerCfgCommand -Arguments @('/q', $Scheme, 'SUB_BUTTONS') -CommandRunner $CommandRunner)
    $ac = $null
    $dc = $null
    foreach ($line in $queryOutput) {
        $text = [string]$line
        if ($null -eq $ac -and $text -match '(?i)(?:交流|\bAC\b).*?(0x[0-9a-f]+)') { $ac = ConvertTo-DshPowerValue $matches[1] }
        elseif ($null -eq $dc -and $text -match '(?i)(?:直流|\bDC\b).*?(0x[0-9a-f]+)') { $dc = ConvertTo-DshPowerValue $matches[1] }
    }
    if ($null -eq $ac -or $null -eq $dc) { throw 'active scheme lid AC/DC values not found' }
    [pscustomobject]@{
        ActiveSchemeGuid = $activeMatch.Groups[1].Value.ToLowerInvariant()
        AcValue = [uint32]$ac
        DcValue = [uint32]$dc
        AcHex = ConvertTo-DshPowerHex $ac
        DcHex = ConvertTo-DshPowerHex $dc
    }
}

function Read-DshPowerPolicyState {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($name in @('activeSchemeGuid', 'previousAc', 'previousDc', 'capturedAtUtc')) {
        if ($state.PSObject.Properties.Name -notcontains $name) { throw "power policy state missing $name" }
    }
    [pscustomobject]@{
        ActiveSchemeGuid = ([string]$state.activeSchemeGuid).ToLowerInvariant()
        PreviousAc = [uint32]$state.previousAc
        PreviousDc = [uint32]$state.previousDc
        CapturedAtUtc = [string]$state.capturedAtUtc
        AppliedAtUtc = [string]$state.appliedAtUtc
        RestoredAtUtc = [string]$state.restoredAtUtc
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
        schema = 1
        activeSchemeGuid = $State.ActiveSchemeGuid
        previousAc = [uint32]$State.PreviousAc
        previousDc = [uint32]$State.PreviousDc
        capturedAtUtc = $State.CapturedAtUtc
        appliedAtUtc = $State.AppliedAtUtc
        restoredAtUtc = $State.RestoredAtUtc
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-DshAlwaysOnPowerPolicyApply {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner
    )
    $current = Get-DshPowerPolicySnapshot -CommandRunner $CommandRunner
    $existing = Read-DshPowerPolicyState -Path $Path
    $state = if ($existing -and $existing.ActiveSchemeGuid -eq $current.ActiveSchemeGuid) {
        $existing
    } else {
        [pscustomobject]@{
            ActiveSchemeGuid = $current.ActiveSchemeGuid
            PreviousAc = $current.AcValue
            PreviousDc = $current.DcValue
            CapturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            AppliedAtUtc = $null
            RestoredAtUtc = $null
        }
    }

    if ($current.AcValue -ne 0 -or $current.DcValue -ne 0) {
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $current.ActiveSchemeGuid, 'SUB_BUTTONS', 'LIDACTION', '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $current.ActiveSchemeGuid, 'SUB_BUTTONS', 'LIDACTION', '0') -CommandRunner $CommandRunner
        $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $current.ActiveSchemeGuid) -CommandRunner $CommandRunner
    }
    $verified = Get-DshPowerPolicySnapshot -Scheme $current.ActiveSchemeGuid -CommandRunner $CommandRunner
    if ($verified.AcValue -ne 0 -or $verified.DcValue -ne 0) { throw 'LIDACTION=0 verification failed' }
    $state.AppliedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Write-DshPowerPolicyState -Path $Path -State $state
    [pscustomobject]@{ Mode = 'Apply'; Verified = $true; IdempotentNoWrite = ($current.AcValue -eq 0 -and $current.DcValue -eq 0); StatePath = $Path; Snapshot = $verified }
}

function Invoke-DshAlwaysOnPowerPolicyRestore {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [scriptblock]$CommandRunner
    )
    $state = Read-DshPowerPolicyState -Path $Path
    if ($null -eq $state) { throw 'power policy restore state not found' }
    $scheme = $state.ActiveSchemeGuid
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setacvalueindex', $scheme, 'SUB_BUTTONS', 'LIDACTION', (ConvertTo-DshPowerHex $state.PreviousAc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setdcvalueindex', $scheme, 'SUB_BUTTONS', 'LIDACTION', (ConvertTo-DshPowerHex $state.PreviousDc)) -CommandRunner $CommandRunner
    $null = Invoke-DshPowerCfgCommand -Arguments @('/setactive', $scheme) -CommandRunner $CommandRunner
    $verified = Get-DshPowerPolicySnapshot -Scheme $scheme -CommandRunner $CommandRunner
    if ($verified.AcValue -ne $state.PreviousAc -or $verified.DcValue -ne $state.PreviousDc -or $verified.ActiveSchemeGuid -ne $scheme) {
        throw 'power policy restore verification failed'
    }
    $state.RestoredAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Write-DshPowerPolicyState -Path $Path -State $state
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
