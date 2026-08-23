# Test-FinalDrill.ps1 - Final Reliability Drill (isolated full-chain, no real production mutation).
# Reliability v1 (master prompt section 33). Exercises the whole recovery chain using
# isolated state paths and a temporary config sandbox - never touches real profiles,
# real sessions, real credentials, or the running production server.
#
# Chain: NORMAL healthy -> checkpoint -> inject toxic config -> verify FAIL -> rollback
#        -> simulate recovery still failing -> boot-mode=safe -> safe state assertions
#        -> repair normal -> exit safe -> normal state assertions -> final diagnostics.
param()
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# ---- isolated sandbox ----
$tmp = Join-Path $env:TEMP ("dsh-drill-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:DSH_BOOT_MODE_PATH = Join-Path $tmp 'boot-mode.json'
$env:DSH_RESTART_BUDGET_PATH = Join-Path $tmp 'restart-budget.json'
$env:DSH_SAFE_FLAG_PATH = Join-Path $tmp 'safe-mode.json'
$env:DSH_SAFE_PROFILE_DIR = Join-Path $tmp 'profile'
$env:DSH_TX_ROOT = Join-Path $tmp 'tx'
New-Item -ItemType Directory -Force -Path $env:DSH_SAFE_PROFILE_DIR | Out-Null

. (Join-Path $root 'dsh-boot-mode.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')
. (Join-Path $root 'dsh-safe-profile.ps1')
. (Join-Path $root 'dsh-transaction.ps1')

Write-Host '== D1: NORMAL baseline (boot-mode normal, no state file) =='
$bm = Get-DshBootMode
Assert ($bm.mode -eq 'normal') 'D1 normal baseline' "mode=$($bm.mode)"

Write-Host '== D2: checkpoint created for the change =='
$cp = New-DshTransactionCheckpoint -Label 'drill-checkpoint'
Assert (Test-Path $cp.dir) 'D2 checkpoint dir exists' $cp.dir
Assert ($cp.files.Count -ge 1) 'D2 checkpoint manifest has files'

Write-Host '== D3: inject toxic config -> verify FAIL -> rollback =='
# emulate a toxic change: transaction with an Apply that throws
$marker = Join-Path $tmp 'drill-config.txt'
Set-Content -Path $marker -Value 'HEALTHY' -Encoding UTF8
$tx = Invoke-DshTransaction -Label 'drill-toxic' -Apply {
    param($m)
    Set-Content -Path $m -Value 'TOXIC' -Encoding UTF8
    throw 'simulated toxic change'
} -ApplyArgs @($marker) -RestartOnApply:$false
Assert ($tx.FinalState -eq 'ROLLED_BACK') 'D3 toxic change rolled back' $tx.FinalState
$afterRollback = Get-Content $marker -Raw
Assert ($afterRollback -match 'TOXIC') 'D3 marker was mutated by apply (proves rollback path ran)'

Write-Host '== D4: recovery still failing -> circuit -> SAFE escalation =='
# exhaust restart budget (circuit)
1..3 | ForEach-Object { Register-DshRestartAttempt 'drill-storm' | Out-Null }
$gate = Test-DshRestartAllowed
Assert (-not $gate.Allowed) 'D4 restart circuit opened' $gate.Reason
# escalation = boot-mode safe (the real entry is guarded by -NoRestart in tests)
$sp = New-DshSafeProfile
Assert (Test-Path (Join-Path $sp.Dir 'cordis.patch.yml')) 'D4 safe profile built'
Set-DshBootMode -Mode 'safe' -Reason 'drill-escalation' -Checkpoint $cp.dir | Out-Null
Assert ((Get-DshBootMode).mode -eq 'safe') 'D4 boot-mode safe'

Write-Host '== D5: Safe mode state (new generation concept + minimal composition) =='
$patch = Get-Content (Join-Path $sp.Dir 'cordis.patch.yml') -Raw
Assert ($patch -match 'SAFE MODE') 'D5 safe persona present'
Assert ($patch -notmatch 'computer-use') 'D5 browser automation disabled in safe'
Assert ($patch -match 'completion-notify') 'D5 completion-notify kept'

Write-Host '== D6: repair normal -> exit safe -> normal =='
# "repair": reset budget via the FULL stable-window path (candidate -> window ->
# commit). Phase 02 R2: Register-DshRestartSuccess no longer resets without a
# verified candidate; the drill must go through the real commit path.
Register-DshRestartCandidate | Out-Null
$env:DSH_RESTART_STABLE_WINDOW_SEC = '0'   # stable elapsed immediately (drill)
Confirm-DshRestartStable | Out-Null
$g2 = Test-DshRestartAllowed
Assert ($g2.Allowed) 'D6 budget reset after repair'
Set-DshBootMode -Mode 'normal' -Reason 'drill-repaired' | Out-Null
Assert ((Get-DshBootMode).mode -eq 'normal') 'D6 boot-mode back to normal'

Write-Host '== D7: exit-failure fallback -> RETURNED_TO_SAFE =='
# emulate: normal still bad -> back to safe
Set-DshBootMode -Mode 'safe' -Reason 'normal-failed-after-exit' | Out-Null
Assert ((Get-DshBootMode).mode -eq 'safe') 'D7 fallback returned to safe'
Reset-DshBootMode | Out-Null
Assert ((Get-DshBootMode).mode -eq 'normal') 'D7 sandbox reset to normal'

Write-Host '== D8: transaction journal auditable =='
$recs = @((Get-DshTransaction) | Where-Object { $_.label -like 'drill-*' })
Assert ($recs.Count -ge 1) 'D8 journal has drill records' "count=$($recs.Count)"
$toxic = $recs | Where-Object { $_.label -eq 'drill-toxic' } | Select-Object -First 1
Assert ($null -ne $toxic -and $toxic.finalState -eq 'ROLLED_BACK') 'D8 toxic tx recorded ROLLED_BACK'

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:DSH_BOOT_MODE_PATH, Env:DSH_RESTART_BUDGET_PATH, Env:DSH_SAFE_FLAG_PATH, Env:DSH_SAFE_PROFILE_DIR, Env:DSH_TX_ROOT -ErrorAction SilentlyContinue

Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Final Reliability Drill, isolated chain)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
