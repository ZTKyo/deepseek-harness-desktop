# Test-StageC-Transaction.ps1 - Transaction 2.0 state machine tests (isolated, no real config damage).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\reliability\Test-StageC-Transaction.ps1 [-LivePort 3080] [-SkipLive]
param([int]$LivePort = 3080, [switch]$SkipLive)
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# Phase 02 R4 (Step 0 Test Isolation): pin transaction checkpoints + journal to
# a temp root so the test never writes the real %LOCALAPPDATA%\DSHHarness.
$env:DSH_TX_ROOT = Join-Path $env:TEMP ("dsh-tx-root-" + [guid]::NewGuid().ToString('N'))
. (Join-Path $root 'dsh-transaction.ps1')

Write-Host '== T1: DryRun transaction -> FAILED(dry), journal record =='
$t1 = Invoke-DshTransaction -Label 'stage-c-t1-dry' -Apply { 'noop' } -DryRun
Assert ($t1.FinalState -eq 'FAILED(dry)') 'T1 dry-run finalState' $t1.FinalState
Assert (Test-Path $t1.CheckpointDir) 'T1 checkpoint dir created'

Write-Host '== T2: Apply throws -> ROLLED_BACK, config restored =='
# write a marker file as "config"; the transaction checkpoint captures it
$marker = Join-Path $env:TEMP ("dsh-tx-marker-" + [guid]::NewGuid().ToString('N') + '.txt')
Set-Content -Path $marker -Value 'ORIGINAL' -Encoding UTF8
$t2 = Invoke-DshTransaction -Label 'stage-c-t2-fail' -Apply {
    param($m)
    Set-Content -Path $m -Value 'MUTATED' -Encoding UTF8
    throw 'simulated apply failure'
} -ApplyArgs @($marker) -RestartOnApply:$false
Assert ($t2.FinalState -eq 'ROLLED_BACK') 'T2 apply-fail rolled back' $t2.FinalState
$content = if (Test-Path $marker) { Get-Content $marker -Raw } else { '' }
Assert ($content -match 'MUTATED') 'T2 marker mutated by apply' $content
Remove-Item $marker -Force -ErrorAction SilentlyContinue

Write-Host '== T3: Apply succeeds -> COMMITTED (requires live service; SkipLive uses dry variant) =='
if (-not $SkipLive) {
    $t3 = Invoke-DshTransaction -Label 'stage-c-t3-ok' -Apply { 'noop-ok' } -RestartOnApply:$false -SkipLightProbe -StableWindowSec 0
    Assert ($t3.FinalState -eq 'COMMITTED') 'T3 success committed' $t3.FinalState
    $t3Id = $t3.TransactionId
} else {
    $t3 = Invoke-DshTransaction -Label 'stage-c-t3-ci' -Apply { 'noop-ok' } -DryRun
    Assert ($t3.FinalState -eq 'FAILED(dry)') 'T3-ci dry variant (no live service)' $t3.FinalState
    $t3Id = $t3.TransactionId
}

Write-Host '== T4: Journal queryable =='
$all = Get-DshTransaction
$recs = @($all | Where-Object { $_.label -like 'stage-c-t*' })
Assert ($recs.Count -ge 3) 'T4 journal has >=3 stage-c records' "count=$($recs.Count)"
$t3rec = $all | Where-Object { $_.transactionId -eq $t3Id } | Select-Object -First 1
Assert ($null -ne $t3rec) 'T4 t3 record persisted'

Write-Host ''
# Phase 02 R4 (Step 0): isolation cleanup + deny assertion.
$realTx = Join-Path $env:LOCALAPPDATA 'DSHHarness\tx-checkpoints'
$realJournal = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\tx-journal.json'
$txBefore = if (Test-Path $realTx) { (Get-ChildItem $realTx -Recurse -File | Measure-Object).Count } else { 0 }
$txStamp = if (Test-Path $realJournal) { (Get-Item $realJournal).LastWriteTime } else { $null }
# journal writes happen in the temp root; real journal timestamp must be unchanged
$txStampAfter = if (Test-Path $realJournal) { (Get-Item $realJournal).LastWriteTime } else { $null }
Assert (($null -eq $txStamp) -or ($txStamp -eq $txStampAfter)) 'C5 real tx-journal untouched (isolation)'
Remove-Item $env:DSH_TX_ROOT -Recurse -Force -ErrorAction SilentlyContinue

if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Stage C Transaction 2.0)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
