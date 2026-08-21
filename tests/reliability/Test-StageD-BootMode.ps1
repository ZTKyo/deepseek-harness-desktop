# Test-StageD-BootMode.ps1 - Boot Mode abstraction tests (isolated; uses DSH_BOOT_MODE_PATH override).
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# isolate the boot-mode state file
$tmp = Join-Path $env:TEMP ("dsh-bm-" + [guid]::NewGuid().ToString('N') + '\boot-mode.json')
$env:DSH_BOOT_MODE_PATH = $tmp

Write-Host '== D1: no state file -> normal (RC8 Golden compatible) =='
. (Join-Path $root 'dsh-boot-mode.ps1')
$m = Get-DshBootMode
Assert ($m.mode -eq 'normal') 'D1 default mode normal' "mode=$($m.mode)"
Assert (Test-DshBootModeNormal) 'D1 Test-DshBootModeNormal true'

Write-Host '== D2: Set safe/experimental/normal round-trip =='
Set-DshBootMode -Mode 'safe' -Reason 'test-entry' -TransactionId 'tx-1' -FailureClass 'verify_failed' | Out-Null
$m2 = Get-DshBootMode
Assert ($m2.mode -eq 'safe') 'D2 safe persisted' "mode=$($m2.mode)"
Assert ($m2.reason -eq 'test-entry') 'D2 reason persisted'
Assert ($m2.transactionId -eq 'tx-1') 'D2 transactionId persisted'
Assert ($m2.failureClass -eq 'verify_failed') 'D2 failureClass persisted'
Set-DshBootMode -Mode 'experimental' -Reason 'chaos-lab' | Out-Null
Assert ((Get-DshBootMode).mode -eq 'experimental') 'D3 experimental persisted'
Set-DshBootMode -Mode 'normal' -Reason 'manual' | Out-Null
Assert ((Get-DshBootMode).mode -eq 'normal') 'D4 normal persisted'

Write-Host '== D5: Reset removes state file -> normal =='
Reset-DshBootMode | Out-Null
Assert (-not (Test-Path $tmp)) 'D5 state file removed'
Assert ((Get-DshBootMode).mode -eq 'normal') 'D5 after reset normal'

Write-Host '== D6: corrupt state file -> safe default to normal =='
Set-Content -Path $tmp -Value '{ not valid json' -Encoding UTF8
Assert ((Get-DshBootMode).mode -eq 'normal') 'D6 corrupt file falls back to normal'

Remove-Item $env:DSH_BOOT_MODE_PATH -Force -ErrorAction SilentlyContinue
Remove-Item (Split-Path $tmp) -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:DSH_BOOT_MODE_PATH -ErrorAction SilentlyContinue

Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Stage D Boot Mode)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
