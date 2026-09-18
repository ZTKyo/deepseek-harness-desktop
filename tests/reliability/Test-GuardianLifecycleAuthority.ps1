# GLA1-GLA8: R1.3 lifecycle authority convergence.
#
# This suite is source/library-only. It never invokes powercfg, starts or stops
# a process, touches Task Scheduler, opens port 3080, or writes production state.
$ErrorActionPreference = 'Stop'

$watchdog = Join-Path $PSScriptRoot '..\..\dsh-guardian-watchdog.ps1'
$helper = Join-Path $PSScriptRoot '..\..\Set-DshAlwaysOnPowerPolicy.ps1'
$guardian = Join-Path $PSScriptRoot '..\..\dsh-guardian.ps1'
. $watchdog -Library
. $helper -Library

$pass = 0
$fail = 0
function Assert-GuardianLifecycle([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name :: $Detail"
    }
}

$watchdogSource = Get-Content -LiteralPath $watchdog -Raw
$guardianSource = Get-Content -LiteralPath $guardian -Raw
$helperSource = Get-Content -LiteralPath $helper -Raw
$normalInfo = New-DshGuardianProcessStartInfo -GuardianScript 'C:\isolated\dsh-guardian.ps1' -PortNumber 3080 -NoKeepAwakeFlag $false
$takeoverInfo = New-DshGuardianProcessStartInfo -GuardianScript 'C:\isolated\dsh-guardian.ps1' -PortNumber 3080 -NoKeepAwakeFlag $false
$normalArgs = @(Get-DshGuardianRuntimeArguments -GuardianScript 'C:\isolated\dsh-guardian.ps1' -PortNumber 3080 -NoKeepAwakeFlag $false)
$takeoverArgs = @(Get-DshGuardianRuntimeArguments -GuardianScript 'C:\isolated\dsh-guardian.ps1' -PortNumber 3080 -NoKeepAwakeFlag $false)

# GLA1: normal absent-path runtime args always suppress lid mutation.
Assert-GuardianLifecycle 'GLA1 normal spawn contains -NoLidGuard' `
    ($normalInfo.Arguments -match '(?i)(^|\s)-NoLidGuard(\s|$)') $normalInfo.Arguments

# GLA2: stale-live replacement uses the same canonical runtime contract.
Assert-GuardianLifecycle 'GLA2 takeover spawn contains -NoLidGuard' `
    ($takeoverInfo.Arguments -match '(?i)(^|\s)-NoLidGuard(\s|$)') $takeoverInfo.Arguments

# GLA3: normal and takeover use one argument builder and equal privilege args.
$sameArgs = (($normalArgs -join '|') -eq ($takeoverArgs -join '|'))
$builderWired = ($watchdogSource -match '(?s)function Start-DshGuardianCanonicalProcess.*?New-DshGuardianProcessStartInfo') -and
    ($watchdogSource -match '\$psi = New-DshGuardianProcessStartInfo -GuardianScript \$GuardianPath') -and
    ($watchdogSource -match '\$StartProcess = \{.*?Start-DshGuardianCanonicalProcess')
Assert-GuardianLifecycle 'GLA3 one canonical runtime argument contract' ($sameArgs -and $builderWired) "same=$sameArgs wired=$builderWired"

# GLA4: the Guardian's powercfg writes remain behind -NoLidGuard.
$lidGuardGated = ($guardianSource -match 'if \(-not \$NoLidGuard\)') -and
    ($guardianSource -match 'powercfg /setacvalueindex') -and
    ($guardianSource -match 'powercfg /setdcvalueindex')
Assert-GuardianLifecycle 'GLA4 -NoLidGuard gates powercfg mutation' $lidGuardGated 'lid guard gate or powercfg writes missing'

$testRoot = Join-Path $env:TEMP ('dsh-guardian-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$statePath = Join-Path $testRoot 'lid-policy.json'
$fake = [ordered]@{ Scheme = '11111111-2222-3333-4444-555555555555'; Ac = [uint32]3; Dc = [uint32]1; Calls = @() }
$runner = {
    param([object[]]$Arguments)
    $args = @($Arguments)
    $fake.Calls += ,([pscustomobject]@{ Arguments = $args })
    switch ([string]$args[0]) {
        '/getactivescheme' { return ("Power Scheme GUID: {0}  (Test)" -f $fake.Scheme) }
        '/q' {
            return @(
                ("Current AC Power Setting Index: {0}" -f (ConvertTo-DshPowerHex $fake.Ac)),
                ("Current DC Power Setting Index: {0}" -f (ConvertTo-DshPowerHex $fake.Dc))
            )
        }
        '/setacvalueindex' { $fake.Ac = ConvertTo-DshPowerValue ([string]$args[4]); return 'OK' }
        '/setdcvalueindex' { $fake.Dc = ConvertTo-DshPowerValue ([string]$args[4]); return 'OK' }
        '/setactive' { $fake.Scheme = [string]$args[1]; return 'OK' }
        default { throw "unexpected powercfg command: $($args -join ' ')" }
    }
}
try {
    # GLA5: Apply changes once and is idempotent on the second invocation.
    $firstApply = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner
    $firstWriteCount = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex','/setdcvalueindex','/setactive') }).Count
    $fake.Calls = @()
    $secondApply = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner
    $secondWriteCount = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex','/setdcvalueindex','/setactive') }).Count
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-GuardianLifecycle 'GLA5 Apply is idempotent' `
        ($firstApply.Verified -and $secondApply.Verified -and $secondApply.IdempotentNoWrite -and $firstWriteCount -eq 3 -and $secondWriteCount -eq 0 -and [uint32]$state.previousAc -eq 3 -and [uint32]$state.previousDc -eq 1) `
        "firstWrites=$firstWriteCount secondWrites=$secondWriteCount"

    # GLA6: Restore returns the captured AC/DC values and active scheme.
    $restoreResult = Invoke-DshAlwaysOnPowerPolicyRestore -Path $statePath -CommandRunner $runner
    Assert-GuardianLifecycle 'GLA6 Restore returns captured policy' `
        ($restoreResult.Verified -and $fake.Ac -eq 3 -and $fake.Dc -eq 1 -and $fake.Scheme -eq '11111111-2222-3333-4444-555555555555') `
        "ac=$($fake.Ac) dc=$($fake.Dc) scheme=$($fake.Scheme)"
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# GLA7: the one-shot helper contains no lifecycle authority or resident loop.
$forbidden = @('Stop-Process', 'Start-Process', 'Start-Sleep', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'schtasks', 'dsh-guardian', 'dsh-guardian-watchdog')
$helperLifecycleFree = -not @($forbidden | Where-Object { $helperSource -match [regex]::Escape($_) }).Count
Assert-GuardianLifecycle 'GLA7 power helper has no lifecycle authority' $helperLifecycleFree 'forbidden lifecycle token found'

# GLA8: absent-path cold-start decision is independent of Task Scheduler.
$absent = Resolve-DshGuardianPresence -Heartbeat $null -Processes @() -Now (Get-Date).ToUniversalTime() -MaxAgeSeconds 90
$noTaskDependency = ($watchdogSource -notmatch '(?i)Get-ScheduledTask|Register-ScheduledTask|schtasks')
Assert-GuardianLifecycle 'GLA8 cold start does not depend on legacy task' ($absent.State -eq 'absent' -and $absent.ShouldStart -and $noTaskDependency) $absent.Reason

Write-Host "GLA: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
