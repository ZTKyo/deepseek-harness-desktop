# GLA1-GLA19: R1.3.2 lifecycle authority and crash-safe checkpoint closure.
#
# This suite is source/library-only. It never invokes powercfg, starts or stops
# a process, touches Task Scheduler, opens port 3080, or writes production state.
$ErrorActionPreference = 'Stop'

$watchdog = Join-Path $PSScriptRoot '..\..\dsh-guardian-watchdog.ps1'
$helper = Join-Path $PSScriptRoot '..\..\Set-DshAlwaysOnPowerPolicy.ps1'
$guardian = Join-Path $PSScriptRoot '..\..\dsh-guardian.ps1'
$legacyCmd = Join-Path $PSScriptRoot '..\..\DSH Guardian Autostart.cmd'
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
$legacyCmdSource = Get-Content -LiteralPath $legacyCmd -Raw
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

# GLA4: runtime lid writes are retired even when -NoLidGuard is omitted.
$lidWritesRetired = ($guardianSource -match '\[switch\]\$NoLidGuard') -and
    ($guardianSource -match 'runtime lid mutation retired') -and
    ($guardianSource -notmatch '(?i)powercfg\s+/(?:setacvalueindex|setdcvalueindex|setactive)') -and
    ($guardianSource -notmatch '\$lidChanged|\$lidOld')
Assert-GuardianLifecycle 'GLA4 Guardian runtime lid writes are retired' $lidWritesRetired 'Guardian still has a runtime powercfg write or restore path'

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
            return (& $ok @(('Power Scheme GUID: {0}  (Test)' -f $fake.Scheme)))
        }
        '/qh' {
            if ($fake.QueryMode -eq 'missing') {
                return (& $ok @(
                    'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Unrelated A)',
                    '  Current AC Power Setting Index: 0x00000002',
                    '  Current DC Power Setting Index: 0x00000002'
                ))
            }
            if ($fake.QueryMode -eq 'malformed') {
                return (& $ok @(
                    ('Power Setting GUID: {0}  (Lid close action)' -f $targetGuid),
                    '  Current AC Power Setting Index: 0x00000003',
                    '  Current AC Power Setting Index: 0x00000003',
                    '  Current DC Power Setting Index: 0x00000001'
                ))
            }
            return (& $ok @(
                'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Unrelated A)',
                '  Current AC Power Setting Index: 0x00000002',
                '  Current DC Power Setting Index: 0x00000002',
                ('Power Setting GUID: {0}  (Lid close action)' -f $targetGuid),
                ('  Current AC Power Setting Index: {0}' -f (ConvertTo-DshPowerHex $fake.Ac)),
                ('  Current DC Power Setting Index: {0}' -f (ConvertTo-DshPowerHex $fake.Dc)),
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

    # GLA6: Restore returns the captured AC/DC values and active scheme.
    $restoreResult = Invoke-DshAlwaysOnPowerPolicyRestore -Path $statePath -CommandRunner $runner
    Assert-GuardianLifecycle 'GLA6 Restore returns captured policy' `
        ($restoreResult.Verified -and $fake.Ac -eq 3 -and $fake.Dc -eq 1 -and $fake.Scheme -eq '11111111-2222-3333-4444-555555555555') `
        "ac=$($fake.Ac) dc=$($fake.Dc) scheme=$($fake.Scheme)"

    # GLA7: the one-shot helper contains no lifecycle authority or resident loop.
    $forbidden = @('Stop-Process', 'Start-Process', 'Start-Sleep', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'schtasks', 'dsh-guardian', 'dsh-guardian-watchdog')
    $helperLifecycleFree = -not @($forbidden | Where-Object { $helperSource -match [regex]::Escape($_) }).Count
    Assert-GuardianLifecycle 'GLA7 power helper has no lifecycle authority' $helperLifecycleFree 'forbidden lifecycle token found'

    # GLA8: absent-path cold-start decision is independent of Task Scheduler.
    $absent = Resolve-DshGuardianPresence -Heartbeat $null -Processes @() -Now (Get-Date).ToUniversalTime() -MaxAgeSeconds 90
    $noTaskDependency = ($watchdogSource -notmatch '(?i)Get-ScheduledTask|Register-ScheduledTask|schtasks')
    Assert-GuardianLifecycle 'GLA8 cold start does not depend on legacy task' ($absent.State -eq 'absent' -and $absent.ShouldStart -and $noTaskDependency) $absent.Reason

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

    # GLA12: Restore setting indexes are decimal strings, not query hex.
    $fake.QueryMode = 'normal'
    $fake.Calls = @()
    $decimalRestore = Invoke-DshAlwaysOnPowerPolicyRestore -Path $statePath -CommandRunner $runner
    $restoreWrites = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex') })
    $restoreAcArg = [string]$restoreWrites[0].Arguments[4]
    $restoreDcArg = [string]$restoreWrites[1].Arguments[4]
    Assert-GuardianLifecycle 'GLA12 Restore uses decimal setting indexes' `
        ($decimalRestore.Verified -and $restoreAcArg -eq '3' -and $restoreDcArg -eq '1' -and $restoreAcArg -notmatch '^0x' -and $restoreDcArg -notmatch '^0x') `
        "acArg=$restoreAcArg dcArg=$restoreDcArg"

    # GLA13/GLA14: native exit failure after AC mutation is checked and the
    # original rollback values remain authoritative.
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
    Assert-GuardianLifecycle 'GLA13 native powercfg exit code is checked' `
        ($partialThrown -and $partialError -match '(?i)powercfg command.*exit code 17') $partialError
    Assert-GuardianLifecycle 'GLA14 partial apply preserves rollback truth' `
        ($partialState.State -eq 'FAILED' -and [uint32]$partialState.PreviousAc -eq 3 -and [uint32]$partialState.PreviousDc -eq 1 -and $partialJson.state -ne 'APPLIED' -and $partialApplyCount -eq 1 -and $partialDcCount -eq 1) `
        "state=$($partialState.State) previous=$($partialState.PreviousAc)/$($partialState.PreviousDc)"
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# GLA15: -Install is a fail-closed retired authority and cannot create/start.
$installMatch = [regex]::Match($guardianSource, '(?s)if \(\$Install\) \{(?<body>.*?)\n\}')
$installBlock = if ($installMatch.Success) { $installMatch.Groups['body'].Value } else { '' }
$installRetired = $installBlock -match 'Direct Guardian autostart retired' -and
    $installBlock -match 'exit 2' -and
    $installBlock -notmatch 'CreateShortcut|Process::Start|Set-Content'
Assert-GuardianLifecycle 'GLA15 direct Guardian install cannot create or start' $installRetired 'install branch still owns autostart'

# GLA16: -Uninstall retains legacy-link cleanup but has no start authority.
$uninstallMatch = [regex]::Match($guardianSource, '(?s)if \(\$Uninstall\) \{(?<body>.*?)\n\}')
$uninstallBlock = if ($uninstallMatch.Success) { $uninstallMatch.Groups['body'].Value } else { '' }
$uninstallCleanup = $uninstallBlock -match 'Remove-Item' -and
    $uninstallBlock -match 'Legacy cleanup only' -and
    $uninstallBlock -notmatch 'Process::Start|CreateShortcut|Start-Process'
Assert-GuardianLifecycle 'GLA16 uninstall only cleans legacy link' $uninstallCleanup 'uninstall cleanup/start topology changed'

# GLA17: the real legacy CMD is a non-launching retired stub, and only the
# retired -Install path + retired CMD + canonical watchdog start form authority.
$legacyCmdRetired = $legacyCmdSource -match '(?i)Direct Guardian autostart retired' -and
    $legacyCmdSource -match '(?im)^\s*exit\s+/b\s+[1-9]\d*\s*$' -and
    $legacyCmdSource -notmatch '(?im)^\s*(?:powershell|pwsh|start)\b' -and
    $legacyCmdSource -notmatch '(?i)dsh-guardian\.ps1'
$watchdogAuthority = $watchdogSource -match 'function Start-DshGuardianCanonicalProcess' -and
    $watchdogSource -match 'New-DshGuardianProcessStartInfo' -and
    $watchdogSource -match '(?i)-NoLidGuard'
$authorityTriple = $installRetired -and $legacyCmdRetired -and $watchdogAuthority
Assert-GuardianLifecycle 'GLA17 legacy CMD retired and Watchdog-only authority' $authorityTriple `
    "install=$installRetired legacyCmd=$legacyCmdRetired watchdog=$watchdogAuthority"

$atomicRoot = Join-Path $env:TEMP ('dsh-guardian-atomic-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $atomicRoot | Out-Null
try {
    # GLA18: a failure after temp flush but before final replacement leaves the
    # previous valid CAPTURED JSON intact and readable.
    $atomicPath = Join-Path $atomicRoot 'atomic-state.json'
    $capturedState = [pscustomobject]@{
        State = 'CAPTURED'
        ActiveSchemeGuid = '11111111-2222-3333-4444-555555555555'
        PreviousAc = [uint32]3
        PreviousDc = [uint32]1
        CapturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        AppliedAtUtc = $null
        RestoredAtUtc = $null
        FailedAtUtc = $null
        Failure = $null
    }
    Write-DshPowerPolicyState -Path $atomicPath -State $capturedState
    $nextState = [pscustomobject]@{
        State = 'APPLIED'
        ActiveSchemeGuid = $capturedState.ActiveSchemeGuid
        PreviousAc = [uint32]3
        PreviousDc = [uint32]1
        CapturedAtUtc = $capturedState.CapturedAtUtc
        AppliedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        RestoredAtUtc = $null
        FailedAtUtc = $null
        Failure = $null
    }
    $replacementFailed = $false
    $replacementError = ''
    $failFinalReplacement = {
        param([string]$TempPath, [string]$TargetPath)
        throw 'simulated final replacement failure'
    }
    try { Write-DshPowerPolicyState -Path $atomicPath -State $nextState -CommitFailureInjector $failFinalReplacement } catch {
        $replacementFailed = $true
        $replacementError = $_.Exception.Message
    }
    $oldRaw = Get-Content -LiteralPath $atomicPath -Raw
    $oldState = Read-DshPowerPolicyState -Path $atomicPath
    $oldJsonValid = $false
    try { $null = $oldRaw | ConvertFrom-Json; $oldJsonValid = $true } catch { }
    Assert-GuardianLifecycle 'GLA18 atomic commit failure preserves CAPTURED checkpoint' `
        ($replacementFailed -and $replacementError -match 'final replacement failure' -and $oldJsonValid -and $oldState.State -eq 'CAPTURED' -and $oldState.PreviousAc -eq 3 -and $oldState.PreviousDc -eq 1 -and -not [string]::IsNullOrWhiteSpace($oldRaw)) `
        "failed=$replacementFailed state=$($oldState.State) error=$replacementError"

    # GLA19: if FAILED metadata cannot commit after AC succeeds/DC fails, the
    # original CAPTURED checkpoint remains the recoverable truth.
    $failedWritePath = Join-Path $atomicRoot 'failed-write-state.json'
    $fake.Ac = [uint32]3
    $fake.Dc = [uint32]1
    $fake.Scheme = '11111111-2222-3333-4444-555555555555'
    $fake.QueryMode = 'normal'
    $fake.FailCommand = '/setdcvalueindex'
    $failedStatusCommitFailed = {
        param([string]$TempPath, [string]$TargetPath)
        $candidate = Get-Content -LiteralPath $TempPath -Raw | ConvertFrom-Json
        if ([string]$candidate.state -eq 'FAILED') { throw 'simulated FAILED status commit failure' }
    }
    $failedWriteOperation = $false
    try {
        $null = Invoke-DshAlwaysOnPowerPolicyApply -Path $failedWritePath -CommandRunner $runner -CommitFailureInjector $failedStatusCommitFailed
    } catch { $failedWriteOperation = $true }
    $recoveredState = Read-DshPowerPolicyState -Path $failedWritePath
    $recoveredRaw = Get-Content -LiteralPath $failedWritePath -Raw
    $recoveredJsonValid = $false
    try { $null = $recoveredRaw | ConvertFrom-Json; $recoveredJsonValid = $true } catch { }
    Assert-GuardianLifecycle 'GLA19 FAILED write cannot destroy CAPTURED checkpoint' `
        ($failedWriteOperation -and $recoveredJsonValid -and $recoveredState.State -eq 'CAPTURED' -and $recoveredState.PreviousAc -eq 3 -and $recoveredState.PreviousDc -eq 1 -and $fake.Ac -eq 0 -and $fake.Dc -eq 1) `
        "operation=$failedWriteOperation state=$($recoveredState.State) previous=$($recoveredState.PreviousAc)/$($recoveredState.PreviousDc)"
} finally {
    Remove-Item -LiteralPath $atomicRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "GLA: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
