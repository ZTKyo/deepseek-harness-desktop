# PPC1-PPC10: locale-independent, hidden-setting power policy compatibility.
# PPC11 adds the fail-closed pre-migration/post-stop exact-state contract.
#
# This suite is source/library-only. Every powercfg interaction is dependency
# injected; it never reads or writes the real Windows power policy.
$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot '..\..\Set-DshAlwaysOnPowerPolicy.ps1'
$guardian = Join-Path $PSScriptRoot '..\..\dsh-guardian.ps1'
$watchdog = Join-Path $PSScriptRoot '..\..\dsh-guardian-watchdog.ps1'
. $helper -Library

$subButtonsGuid = '4f971e89-eebd-4455-a8de-9e59040e7347'
$lidActionGuid = '5ca83367-6e45-459f-a27b-476b1d01c936'
$schemeGuid = '381b4222-f694-41f0-9685-ff5bb260df2e'
$pass = 0
$fail = 0

function Assert-PowerPolicyCompatibility([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name :: $Detail"
    }
}

# PPC1/PPC2: labels and friendly names are not part of active-scheme identity.
$englishGuid = Get-DshActiveSchemeGuidFromOutput -Lines @("Power Scheme GUID: $schemeGuid  (Balanced)")
Assert-PowerPolicyCompatibility 'PPC1 English active-scheme output' ($englishGuid -eq $schemeGuid) $englishGuid

$chineseGuid = Get-DshActiveSchemeGuidFromOutput -Lines @("电源方案 GUID: $schemeGuid (平衡)")
Assert-PowerPolicyCompatibility 'PPC2 Chinese active-scheme output' ($chineseGuid -eq $schemeGuid) $chineseGuid

# PPC3: zero or multiple GUIDs are both ambiguous and fail closed.
$zeroRejected = $false
$multipleRejected = $false
try { $null = Get-DshActiveSchemeGuidFromOutput -Lines @('active scheme unavailable') } catch { $zeroRejected = $_.Exception.Message -match 'exactly one GUID; found 0' }
try { $null = Get-DshActiveSchemeGuidFromOutput -Lines @("GUID: $schemeGuid", 'GUID: 11111111-2222-3333-4444-555555555555') } catch { $multipleRejected = $_.Exception.Message -match 'exactly one GUID; found 2' }
Assert-PowerPolicyCompatibility 'PPC3 zero or multiple active GUIDs fail closed' ($zeroRejected -and $multipleRejected) "zero=$zeroRejected multiple=$multipleRejected"

$fake = [ordered]@{
    Scheme = $schemeGuid
    Ac = [uint32]3
    Dc = [uint32]1
    Locale = 'en'
    QueryMode = 'normal'
    Calls = @()
}
$runner = {
    param([object[]]$Arguments)
    $args = @($Arguments)
    $fake.Calls += ,([pscustomobject]@{ Arguments = $args })
    switch ([string]$args[0]) {
        '/getactivescheme' {
            $line = if ($fake.Locale -eq 'zh') {
                "电源方案 GUID: $($fake.Scheme) (平衡)"
            } else {
                "Power Scheme GUID: $($fake.Scheme)  (Balanced)"
            }
            return [pscustomobject]@{ ExitCode = 0; Stdout = @($line); Stderr = @() }
        }
        '/qh' {
            if ($fake.QueryMode -eq 'missing') {
                return [pscustomobject]@{
                    ExitCode = 0
                    Stdout = @(
                        "Power Scheme GUID: $($fake.Scheme)  (Balanced)",
                        "Subgroup GUID: $subButtonsGuid  (Power buttons and lid)",
                        'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Power button action)',
                        '  Current AC Power Setting Index: 0x00000002',
                        '  Current DC Power Setting Index: 0x00000002'
                    )
                    Stderr = @()
                }
            }
            if ($fake.Locale -eq 'zh') {
                return [pscustomobject]@{
                    ExitCode = 0
                    Stdout = @(
                        "电源方案 GUID: $($fake.Scheme) (平衡)",
                        "子组 GUID: $subButtonsGuid (电源按钮和盖子)",
                        '电源设置 GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee (电源按钮操作)',
                        '  当前交流电源设置索引: 0x00000002',
                        '  当前直流电源设置索引: 0x00000002',
                        "电源设置 GUID: $lidActionGuid (合上盖子操作)",
                        ('  当前交流电源设置索引: {0}' -f (ConvertTo-DshPowerHex $fake.Ac)),
                        ('  当前直流电源设置索引: {0}' -f (ConvertTo-DshPowerHex $fake.Dc))
                    )
                    Stderr = @()
                }
            }
            return [pscustomobject]@{
                ExitCode = 0
                Stdout = @(
                    '',
                    "Power Scheme GUID: $($fake.Scheme)  (Balanced)",
                    "Subgroup GUID: $subButtonsGuid  (Power buttons and lid)",
                    'Power Setting GUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee  (Power button action)',
                    '  Current AC Power Setting Index: 0x00000002',
                    '  Current DC Power Setting Index: 0x00000002',
                    "Power Setting GUID: $lidActionGuid  (Lid close action)",
                    ('  Current AC Power Setting Index: {0}' -f (ConvertTo-DshPowerHex $fake.Ac)),
                    ('  Current DC Power Setting Index: {0}' -f (ConvertTo-DshPowerHex $fake.Dc)),
                    'Power Setting GUID: bbbbbbbb-cccc-dddd-eeee-ffffffffffff  (Sleep button action)',
                    '  Current AC Power Setting Index: 0x00000004',
                    '  Current DC Power Setting Index: 0x00000004'
                )
                Stderr = @()
            }
        }
        '/setacvalueindex' {
            $fake.Ac = ConvertTo-DshPowerValue ([string]$args[4])
            return [pscustomobject]@{ ExitCode = 0; Stdout = @('OK'); Stderr = @() }
        }
        '/setdcvalueindex' {
            $fake.Dc = ConvertTo-DshPowerValue ([string]$args[4])
            return [pscustomobject]@{ ExitCode = 0; Stdout = @('OK'); Stderr = @() }
        }
        '/setactive' {
            $fake.Scheme = [string]$args[1]
            return [pscustomobject]@{ ExitCode = 0; Stdout = @('OK'); Stderr = @() }
        }
        default { throw "unexpected powercfg command: $($args -join ' ')" }
    }
}

# PPC4: hidden LIDACTION can be selected by GUID when it is not the first item.
$fake.Locale = 'en'
$fake.QueryMode = 'normal'
$fake.Ac = [uint32]3
$fake.Dc = [uint32]1
$fake.Calls = @()
$hiddenSnapshot = Get-DshPowerPolicySnapshot -CommandRunner $runner
$hiddenQuery = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/qh' })
$hiddenArgs = if ($hiddenQuery.Count -eq 1) { @($hiddenQuery[0].Arguments) } else { @() }
Assert-PowerPolicyCompatibility 'PPC4 hidden LIDACTION is selected by exact GUID' `
    ($hiddenSnapshot.AcValue -eq 3 -and $hiddenSnapshot.DcValue -eq 1 -and $hiddenSnapshot.SettingGuid -eq $lidActionGuid -and
        $hiddenArgs.Count -eq 3 -and $hiddenArgs[1] -eq $schemeGuid -and $hiddenArgs[2] -eq $subButtonsGuid) `
    "ac=$($hiddenSnapshot.AcValue) dc=$($hiddenSnapshot.DcValue) args=$($hiddenArgs -join '|')"

# PPC5: localized setting labels parse the exact hidden block and values.
$fake.Locale = 'zh'
$fake.Ac = [uint32]1
$fake.Dc = [uint32]1
$chineseSnapshot = Get-DshPowerPolicySnapshot -CommandRunner $runner
Assert-PowerPolicyCompatibility 'PPC5 Chinese hidden-setting output reads 1/1' `
    ($chineseSnapshot.AcValue -eq 1 -and $chineseSnapshot.DcValue -eq 1 -and $chineseSnapshot.SettingGuid -eq $lidActionGuid) `
    "ac=$($chineseSnapshot.AcValue) dc=$($chineseSnapshot.DcValue)"

# PPC6: visible-only /q-shaped output cannot masquerade as LIDACTION success.
$fake.Locale = 'en'
$fake.QueryMode = 'missing'
$missingRejected = $false
try { $null = Get-DshPowerPolicySnapshot -CommandRunner $runner } catch { $missingRejected = $_.Exception.Message -match 'exactly one query block; found 0' }
Assert-PowerPolicyCompatibility 'PPC6 visible-only output fails closed' $missingRejected 'missing LIDACTION was accepted'

$testRoot = Join-Path $env:TEMP ('dsh-power-policy-compat-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$statePath = Join-Path $testRoot 'lid-policy.json'
try {
    $fake.QueryMode = 'normal'
    $fake.Ac = [uint32]3
    $fake.Dc = [uint32]1
    $fake.Calls = @()
    $applyResult = Invoke-DshAlwaysOnPowerPolicyApply -Path $statePath -CommandRunner $runner
    $applyWrites = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex') })
    $exactApplyWrites = $applyWrites.Count -eq 2 -and -not @($applyWrites | Where-Object {
            $_.Arguments[1] -ne $schemeGuid -or $_.Arguments[2] -ne $subButtonsGuid -or $_.Arguments[3] -ne $lidActionGuid
        }).Count
    Assert-PowerPolicyCompatibility 'PPC7 Apply uses exact subgroup and setting GUIDs' ($applyResult.Verified -and $exactApplyWrites) "writeCount=$($applyWrites.Count)"

    $applyQh = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/qh' })
    $applyPlainQ = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/q' })
    $allApplyQhExact = $applyQh.Count -ge 2 -and -not @($applyQh | Where-Object {
            $_.Arguments[1] -ne $schemeGuid -or $_.Arguments[2] -ne $subButtonsGuid
        }).Count
    Assert-PowerPolicyCompatibility 'PPC8 Apply verification re-queries with /qh' `
        ($allApplyQhExact -and $applyPlainQ.Count -eq 0) "qh=$($applyQh.Count) q=$($applyPlainQ.Count)"

    $fake.Calls = @()
    $restoreResult = Invoke-DshAlwaysOnPowerPolicyRestore -Path $statePath -CommandRunner $runner
    $restoreQh = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/qh' })
    $restorePlainQ = @($fake.Calls | Where-Object { $_.Arguments[0] -eq '/q' })
    $restoreWrites = @($fake.Calls | Where-Object { $_.Arguments[0] -in @('/setacvalueindex', '/setdcvalueindex') })
    $restoreExact = $restoreWrites.Count -eq 2 -and
        $restoreWrites[0].Arguments[2] -eq $subButtonsGuid -and $restoreWrites[0].Arguments[3] -eq $lidActionGuid -and $restoreWrites[0].Arguments[4] -eq '3' -and
        $restoreWrites[1].Arguments[2] -eq $subButtonsGuid -and $restoreWrites[1].Arguments[3] -eq $lidActionGuid -and $restoreWrites[1].Arguments[4] -eq '1'
    Assert-PowerPolicyCompatibility 'PPC9 Restore verifies with /qh and decimal values' `
        ($restoreResult.Verified -and $restoreExact -and $restoreQh.Count -ge 1 -and $restorePlainQ.Count -eq 0) `
        "qh=$($restoreQh.Count) q=$($restorePlainQ.Count) writes=$($restoreWrites.Count)"
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# PPC10: only the bounded helper owns LIDACTION writes.
$helperSource = Get-Content -LiteralPath $helper -Raw
$guardianSource = Get-Content -LiteralPath $guardian -Raw
$watchdogSource = Get-Content -LiteralPath $watchdog -Raw
$writeTokens = '(?i)/(?:setacvalueindex|setdcvalueindex|setactive)'
$singleAuthority = ($helperSource -match $writeTokens) -and
    ($helperSource -match [regex]::Escape($subButtonsGuid)) -and
    ($helperSource -match [regex]::Escape($lidActionGuid)) -and
    ($guardianSource -notmatch $writeTokens) -and
    ($watchdogSource -notmatch $writeTokens) -and
    ($guardianSource -match 'runtime lid mutation retired')
Assert-PowerPolicyCompatibility 'PPC10 one-shot helper is the sole LIDACTION write authority' $singleAuthority 'Guardian or Watchdog still owns a powercfg write path'

# PPC11: migration must stop before Apply if stopping the old Guardian changed
# the exact scheme/LIDACTION state captured immediately before the stop.
$sameBaselineAccepted = Assert-DshPowerPolicyMigrationBaseline -PreMigrationSnapshot $hiddenSnapshot -PostStopSnapshot $hiddenSnapshot
$changedPostStop = [pscustomobject]@{
    ActiveSchemeGuid = $hiddenSnapshot.ActiveSchemeGuid
    SubgroupGuid = $hiddenSnapshot.SubgroupGuid
    SettingGuid = $hiddenSnapshot.SettingGuid
    AcValue = $hiddenSnapshot.AcValue
    DcValue = [uint32]($hiddenSnapshot.DcValue + 1)
}
$changedBaselineRejected = $false
try { $null = Assert-DshPowerPolicyMigrationBaseline -PreMigrationSnapshot $hiddenSnapshot -PostStopSnapshot $changedPostStop } catch {
    $changedBaselineRejected = $_.Exception.Message -match '^LID_STATE_CHANGED_DURING_MIGRATION:'
}
Assert-PowerPolicyCompatibility 'PPC11 migration baseline is exact and fail-closed' `
    ($sameBaselineAccepted -and $changedBaselineRejected) "same=$sameBaselineAccepted changedRejected=$changedBaselineRejected"

Write-Host "PPC: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
