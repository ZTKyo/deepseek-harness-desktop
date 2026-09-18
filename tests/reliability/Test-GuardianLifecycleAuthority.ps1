# GLA1-GLA16: R1.3.1 lifecycle authority convergence.
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
$targetGuid = '5ca83367-6e45-459f-a27b-476b1d01c936'
$fake = [ordered]@{
    Scheme = '11111111-2222-3333-4444-555555555555'
    Ac = [uint32]3
    Dc = [uint32]1
    QueryMode = 'normal'
    FailCommand = $null
    Calls = @()
}
$runner = {
    param([object[]]$Arguments)
    $args = @($Arguments)
    $fake.Calls += ,([pscustomobject]@{ Arguments = $args })
    $ok = {
        param([object[]]$Output)
        [pscustomobject]@{ ExitCode = 0; Stdout = @($Output); Stderr = @() }
    }
    $failed = {
        param([int]$Code, [string]$Message)
        [pscustomobject]@{ ExitCode = $Code; Stdout = @(); Stderr = @($Message) }
    }
    switch ([string]$args[0]) {
        '/getactivescheme' {
            return (& $ok @(("Power Scheme GUID: {0}  (Test)" -f $fake.Scheme)))
        }
        '/q' {
            if ($fake.QueryMode -eq 'missing') {
                return (& $ok @(
                    'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Unrelated A)',
                    '  Current AC Power Setting Index: 0x00000002',
                    '  Current DC Power Setting Index: 0x00000002'
                ))
            }
            if ($fake.QueryMode -eq 'malformed') {
                return (& $ok @(
                    ("Power Setting GUID: {0}  (Lid close action)" -f $targetGuid),
                    '  Current AC Power Setting Index: 0x00000003',
                    '  Current AC Power Setting Index: 0x00000003',
                    '  Current DC Power Setting Index: 0x00000001'
                ))
            }
            return (& $ok @(
                'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Unrelated A)',
                '  Current AC Power Setting Index: 0x00000002',
                '  Current DC Power Setting Index: 0x00000002',
                ("Power Setting GUID: {0}  (Lid close action)" -f $targetGuid),
                ("  Current AC Power Setting Index: {0}" -f (ConvertTo-DshPowerHex $fake.Ac)),
                ("  Current DC Power Setting Index: {0}" -f (ConvertTo-DshPowerHex $fake.Dc)),
                'Power Setting GUID: bbbbbbbb-cccc-dddd-eeee-ffffffffffff  (Unrelated B)',
                '  Current AC Power Setting Index: 0x00000004',
                '  Current DC Power Setting Index: 0x00000004'
            ))
        }
        '/setacvalueindex' {
            if ($fake.FailCommand -eq '/setacvalueindex') { return (& $failed 17 'simulated AC failure') }
            $fake.Ac = ConvertTo-DshPowerValue ([string]$args[4])
            return (& $ok @('OK'))
        }
        '/setdcvalueindex' {
            if ($fake.FailCommand -eq '/setdcvalueindex') { return (& $failed 17 'simulated DC failure') }
            $fake.Dc = ConvertTo-DshPowerValue ([string]$args[4])
            return (& $ok @('OK'))
        }
        '/setactive' {
            if ($fake.FailCommand -eq '/setactive') { return (& $failed 17 'simulated active-scheme failure') }
            $fake.Scheme = [string]$args[1]
            return (& $ok @('OK'))
        }
        default { throw "unexpected powercfg command: $($args -join ' ')" }
    }
}
try {
    # GLA5: Apply changes once and is idempotent on the second invocation.
    $firstApply = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner
    $firstWriteCount = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex', '/setactive') }).Count
    $fake.Calls = @()
    $secondApply = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner
    $secondWriteCount = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex', '/setactive') }).Count
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-GuardianLifecycle 'GLA5 Apply is idempotent' `
        ($firstApply.Verified -and -not $firstApply.IdempotentNoWrite -and $secondApply.Verified -and $secondApply.IdempotentNoWrite -and $firstWriteCount -eq 3 -and $secondWriteCount -eq 0 -and $state.state -eq 'APPLIED' -and [uint32]$state.previousAc -eq 3 -and [uint32]$state.previousDc -eq 1) `
        "firstWrites=$firstWriteCount secondWrites=$secondWriteCount state=$($state.state)"

    # GLA6 and GLA12: Restore returns captured values and passes decimal args.
    $fake.Calls = @()
    $restoreResult = Invoke-DshAlwaysOnPowerPolicyRestore -Path $statePath -CommandRunner $runner
    $restoreWrites = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex') })
    $restoreAcArg = [string]$restoreWrites[0].Arguments[4]
    $restoreDcArg = [string]$restoreWrites[1].Arguments[4]
    Assert-GuardianLifecycle 'GLA6 Restore returns captured policy' `
        ($restoreResult.Verified -and $fake.Ac -eq 3 -and $fake.Dc -eq 1 -and $fake.Scheme -eq '11111111-2222-3333-4444-555555555555') `
        "ac=$($fake.Ac) dc=$($fake.Dc) scheme=$($fake.Scheme)"
    Assert-GuardianLifecycle 'GLA12 Restore uses decimal setting indexes' `
        ($restoreAcArg -eq '3' -and $restoreDcArg -eq '1' -and $restoreAcArg -notmatch '^0x' -and $restoreDcArg -notmatch '^0x') `
        "acArg=$restoreAcArg dcArg=$restoreDcArg"

    # GLA9: the exact LIDACTION block is selected even when it is not first.
    $fake.QueryMode = 'normal'
    $snapshot = Get-DshPowerPolicySnapshot -CommandRunner $runner
    Assert-GuardianLifecycle 'GLA9 exact LIDACTION block is not position-dependent' `
        ($snapshot.AcValue -eq 3 -and $snapshot.DcValue -eq 1 -and $helperSource -match [regex]::Escape($targetGuid)) `
        "ac=$($snapshot.AcValue) dc=$($snapshot.DcValue)"

    # GLA10: a missing exact setting GUID fails closed rather than selecting a neighbor.
    $fake.QueryMode = 'missing'
    $missingRejected = $false
    try { $null = Get-DshPowerPolicySnapshot -CommandRunner $runner } catch { $missingRejected = $_.Exception.Message -match 'exactly one query block' }
    Assert-GuardianLifecycle 'GLA10 missing LIDACTION block fails closed' $missingRejected 'missing exact GUID was accepted'

    # GLA11: duplicate/malformed AC/DC data fails closed.
    $fake.QueryMode = 'malformed'
    $malformedRejected = $false
    try { $null = Get-DshPowerPolicySnapshot -CommandRunner $runner } catch { $malformedRejected = $_.Exception.Message -match 'exactly one AC and one DC' }
    Assert-GuardianLifecycle 'GLA11 malformed LIDACTION block fails closed' $malformedRejected 'malformed exact block was accepted'

    # GLA13: a native nonzero exit after AC mutation preserves rollback truth.
    $fake.QueryMode = 'normal'
    $fake.FailCommand = '/setdcvalueindex'
    $fake.Calls = @()
    $partialThrown = $false
    $partialError = ''
    try { $null = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner } catch {
        $partialThrown = $true
        $partialError = $_.Exception.Message
    }
    $partialState = Read-DshPowerPolicyState -Path $statePath
    $partialJson = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $partialApplyCount = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/setacvalueindex' }).Count
    $partialDcCount = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/setdcvalueindex' }).Count
    Assert-GuardianLifecycle 'GLA13 partial apply preserves CAPTURED rollback truth' `
        ($partialThrown -and $partialState.State -eq 'FAILED' -and [uint32]$partialState.PreviousAc -eq 3 -and [uint32]$partialState.PreviousDc -eq 1 -and $partialJson.state -ne 'APPLIED' -and $partialApplyCount -eq 1 -and $partialDcCount -eq 1) `
        "thrown=$partialThrown state=$($partialState.State) previous=$($partialState.PreviousAc)/$($partialState.PreviousDc)"
    Assert-GuardianLifecycle 'GLA10 native powercfg exit code is checked' `
        ($partialError -match '(?i)powercfg command.*exit code 17') $partialError
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

# GLA14: -Install is a fail-closed retired authority and cannot create/start.
$installMatch = [regex]::Match($guardianSource, '(?s)if \(\$Install\) \{(?<body>.*?)\n\}')
$installBlock = if ($installMatch.Success) { $installMatch.Groups['body'].Value } else { '' }
$installRetired = $installBlock -match 'Direct Guardian autostart retired' -and
    $installBlock -match 'exit 2' -and
    $installBlock -notmatch 'CreateShortcut|Process::Start|Set-Content'
Assert-GuardianLifecycle 'GLA14 direct Guardian install cannot create or start' $installRetired 'install branch still owns autostart'

# GLA15: -Uninstall retains legacy-link cleanup but has no start authority.
$uninstallMatch = [regex]::Match($guardianSource, '(?s)if \(\$Uninstall\) \{(?<body>.*?)\n\}')
$uninstallBlock = if ($uninstallMatch.Success) { $uninstallMatch.Groups['body'].Value } else { '' }
$uninstallCleanup = $uninstallBlock -match 'Remove-Item' -and
    $uninstallBlock -match 'Legacy cleanup only' -and
    $uninstallBlock -notmatch 'Process::Start|CreateShortcut|Start-Process'
Assert-GuardianLifecycle 'GLA15 uninstall only cleans legacy link' $uninstallCleanup 'uninstall cleanup/start topology changed'

# GLA16: Watchdog is the sole canonical Guardian bootstrap.
$watchdogAuthority = $watchdogSource -match 'function Start-DshGuardianCanonicalProcess' -and
    $watchdogSource -match 'New-DshGuardianProcessStartInfo' -and
    $watchdogSource -match '(?i)-NoLidGuard'
$guardianNoSecondBootstrap = $guardianSource -notmatch 'CreateShortcut|Start "" powershell|guardian autostart installed'
Assert-GuardianLifecycle 'GLA16 Watchdog-only Guardian lifecycle topology' ($watchdogAuthority -and $guardianNoSecondBootstrap) "watchdog=$watchdogAuthority guardian=$guardianNoSecondBootstrap"

Write-Host "GLA: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
