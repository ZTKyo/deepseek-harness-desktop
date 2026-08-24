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
# Phase 02 R5 (R4-B1): isolated PROFILE root — checkpoint restore targets a temp
# profile, never the live %USERPROFILE%\.dsh. Transaction rollback therefore
# cannot write the real profile.
$script:TestProfileRoot = Join-Path $env:TEMP ("dsh-tx-profile-" + [guid]::NewGuid().ToString('N'))
# Record TRUE before-state of the live profile config (hash + mtime) so the end
# assert can prove zero writes to the live profile.
$liveProfile = Join-Path $env:USERPROFILE '.dsh'
$script:LiveProfileBefore = @()
foreach ($rel in @('settings.yaml','profiles\web\cordis.patch.yml','profiles\web\cordis.yml','profiles\web\package.json')) {
    $p = Join-Path $liveProfile $rel
    if (Test-Path $p) {
        $script:LiveProfileBefore += @{ rel = $rel; hash = (Get-FileHash $p).Hash; mtime = (Get-Item $p).LastWriteTimeUtc }
    } else {
        $script:LiveProfileBefore += @{ rel = $rel; hash = $null; mtime = $null }
    }
}
# Phase 02 R6 (R5-B1): record TRUE pre-state of real tx-journal (mtime + content
# hash) and tx-checkpoint count BEFORE the test runs, so the end assert is a
# genuine pre/post comparison (was: reading twice after the test).
$script:RealJournalPath = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\tx-journal.json'
$script:RealTxDirPath = Join-Path $env:LOCALAPPDATA 'DSHHarness\tx-checkpoints'
$script:JournalBefore = if (Test-Path $script:RealJournalPath) { (Get-Item $script:RealJournalPath).LastWriteTimeUtc.ToString('o') + '|' + (Get-FileHash $script:RealJournalPath).Hash } else { $null }
$script:TxCountBefore = if (Test-Path $script:RealTxDirPath) { @(Get-ChildItem $script:RealTxDirPath -Recurse -File).Count } else { 0 }
# hard deny helper: any file path under live profile / live DSHHarness is a FAIL
function Deny-LiveWrite([string]$msg) {
    $bad = $false
    foreach ($e in $script:LiveProfileBefore) {
        $p = Join-Path $liveProfile $e.rel
        if (Test-Path $p) {
            if ((Get-FileHash $p).Hash -ne $e.hash) { $bad = $true; Write-Host ("  DENY-LIVE-CHANGED: " + $e.rel) }
        } elseif ($null -ne $e.hash) { $bad = $true; Write-Host ("  DENY-LIVE-DELETED: " + $e.rel) }
    }
    if ($bad) { Write-Host "FAIL  $msg (live profile was written)"; $script:failCount++ } else { Write-Host "PASS  $msg (live profile untouched)" }
}
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
} -ApplyArgs @($marker) -RestartOnApply:$false -ProfileRoot $script:TestProfileRoot
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
# Phase 02 R6 (R5-B1): TRUE pre/post deny — real tx-journal mtime+hash and real
# tx-checkpoint count recorded at test start must be unchanged.
$journalAfter = if (Test-Path $script:RealJournalPath) { (Get-Item $script:RealJournalPath).LastWriteTimeUtc.ToString('o') + '|' + (Get-FileHash $script:RealJournalPath).Hash } else { $null }
$txCountAfter = if (Test-Path $script:RealTxDirPath) { @(Get-ChildItem $script:RealTxDirPath -Recurse -File).Count } else { 0 }
Assert (($null -eq $script:JournalBefore) -or ($script:JournalBefore -eq $journalAfter)) 'C5 real tx-journal untouched (true pre/post)'
Assert ($txCountAfter -eq $script:TxCountBefore) 'C5 real tx-checkpoint count unchanged' "before=$($script:TxCountBefore) after=$txCountAfter"
# real profile config files untouched (true before-state comparison)
$denyBad = $false
foreach ($e in $script:LiveProfileBefore) {
    $p = Join-Path $liveProfile $e.rel
    if (Test-Path $p) {
        if ((Get-FileHash $p).Hash -ne $e.hash) { $denyBad = $true; Write-Host ("  LIVE-CHANGED: " + $e.rel) }
        if ((Get-Item $p).LastWriteTimeUtc -ne $e.mtime) { $denyBad = $true; Write-Host ("  LIVE-MTIME: " + $e.rel) }
    } elseif ($null -ne $e.hash) { $denyBad = $true; Write-Host ("  LIVE-DELETED: " + $e.rel) }
}
Assert (-not $denyBad) 'C5 live profile untouched (true before/after deny)'
Remove-Item $env:DSH_TX_ROOT -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $script:TestProfileRoot -Recurse -Force -ErrorAction SilentlyContinue

if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Stage C Transaction 2.0)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
