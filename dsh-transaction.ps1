# dsh-transaction.ps1 - Transaction 2.0: unified change transaction core (Reliability v1, Stage C)
#
# State machine:
#   PREPARE -> CHECKPOINT -> APPLY -> BOOT -> VERIFY -> STABILIZE -> COMMIT
#   VERIFY FAIL -> ROLLBACK -> RESTART -> VERIFY_RECOVERY
#   VERIFY_RECOVERY FAIL -> ESCALATE_TO_SAFE_MODE
#
# finalState: COMMITTED | ROLLED_BACK | SAFE_MODE | FAILED
#
# A transaction is COMMITTED only when COMMIT_READY (full health) passes after APPLY.
# api_ready alone is NOT a commit signal (BOOT_READY != COMMIT_READY).
#
# Backward compatible: New-DshTransactionCheckpoint / Restore-DshTransactionCheckpoint /
# Test-DshTransactionHealth keep their signatures for existing callers.

$script:DshTxRoot = if ($env:DSH_TX_ROOT) {
    $env:DSH_TX_ROOT
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\tx-checkpoints'
}
$script:DshTxJournal = if ($env:DSH_TX_ROOT) {
    Join-Path (Split-Path -Parent $env:DSH_TX_ROOT) 'tx-journal.json'
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state\tx-journal.json'
}

# ensure dependency modules are available (idempotent dot-source)
if (-not (Get-Command Get-DshGenerationId -ErrorAction SilentlyContinue)) {
    try { . (Join-Path $PSScriptRoot 'dsh-generation.ps1') } catch {}
}
if (-not (Get-Command Get-DshLoopbackOwner -ErrorAction SilentlyContinue)) {
    try { . (Join-Path $PSScriptRoot 'dsh-process-identity.ps1') } catch {}
}

function New-DshTransactionId([string]$Label) {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $rand = [guid]::NewGuid().ToString('N').Substring(0, 6)
    return ("{0}-{1}-{2}" -f $Label, $ts, $rand)
}

function Get-DshTxJournal {
    if (-not (Test-Path $script:DshTxJournal)) { return @{ transactions = @() } }
    try { return (Get-Content $script:DshTxJournal -Raw | ConvertFrom-Json) } catch { return @{ transactions = @() } }
}

function Write-DshTxJournal($Journal) {
    $dir = Split-Path -Parent $script:DshTxJournal
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = "$($script:DshTxJournal).tmp-$PID"
    $Journal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
    try { Move-Item -LiteralPath $tmp -Destination $script:DshTxJournal -Force -ErrorAction Stop }
    catch {
        Remove-Item -LiteralPath $script:DshTxJournal -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $tmp -Destination $script:DshTxJournal -Force
    }
}

function Add-DshTxRecord($Record) {
    $j = Get-DshTxJournal
    if ($null -eq $j.transactions) { $j.transactions = @() }
    $j.transactions += $Record
    if (@($j.transactions).Count -gt 200) { $j.transactions = @($j.transactions)[-200..-1] }
    Write-DshTxJournal $j
}

function Get-DshTxCheckpointDir([string]$TransactionId) {
    return Join-Path $script:DshTxRoot $TransactionId
}

# ---------- legacy API (kept) ----------

function New-DshTransactionCheckpoint {
    param([string]$Label = 'tx', [string]$Dir = $null)
    $transactionId = New-DshTransactionId $Label
    if (-not $Dir) { $Dir = Get-DshTxCheckpointDir $transactionId }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $files = @(
        @{ Src = "$env:USERPROFILE\.dsh\settings.yaml"; Name = 'settings.yaml' },
        @{ Src = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"; Name = 'cordis.patch.yml' },
        @{ Src = "$env:USERPROFILE\.dsh\profiles\web\cordis.yml"; Name = 'cordis.yml' },
        @{ Src = "$env:USERPROFILE\.dsh\profiles\web\package.json"; Name = 'package.json' }
    )
    $manifest = @{
        transactionId = $transactionId
        timestamp = (Get-Date -Format 'o')
        label = $Label
        dir = $Dir
        files = @()
        generationBefore = $null
        dshVersionBefore = $null
    }
    foreach ($f in $files) {
        if (Test-Path $f.Src) {
            Copy-Item $f.Src (Join-Path $Dir $f.Name) -Force
            $h = (Get-FileHash $f.Src -Algorithm SHA256).Hash
            $manifest.files += @{ name = $f.Name; hash = $h; path = $f.Src }
        }
    }
    try {
        . (Join-Path $PSScriptRoot 'dsh-generation.ps1') 2>$null
        if (Get-Command Get-DshGenerationId -ErrorAction SilentlyContinue) {
            $manifest.generationBefore = Get-DshGenerationId
        }
    } catch {}
    try { $manifest.dshVersionBefore = ((& dsh --version 2>$null) -join '').Trim() } catch {}
    ($manifest | ConvertTo-Json -Depth 5) | Out-File (Join-Path $Dir 'manifest.json') -Encoding utf8
    return $manifest
}

function Restore-DshTransactionCheckpoint {
    <#
    .SYNOPSIS
    Restore a transaction checkpoint's config files to their live locations.
    Phase 02 R5 (R4-B1): a ProfileRoot override lets tests restore into an
    isolated temp profile instead of the real %USERPROFILE%\.dsh. Default
    (ProfileRoot = $null) restores to the live profile, preserving old behavior.
    .PARAMETER CheckpointDir
    Directory holding the checkpoint files.
    .PARAMETER ProfileRoot
    If non-null, config targets resolve under this root (e.g. an isolated test
    profile). Avoids test-destructive writes to the live profile.
    #>
    param([string]$CheckpointDir, [string]$ProfileRoot = $null)
    if (-not (Test-Path $CheckpointDir)) { return @{ Restored = @(); Error = 'checkpoint_not_found' } }
    $base = if ($ProfileRoot) { $ProfileRoot } else { (Join-Path $env:USERPROFILE '.dsh') }
    $map = @{
        'settings.yaml' = Join-Path $base 'settings.yaml'
        'cordis.patch.yml' = Join-Path $base 'profiles\web\cordis.patch.yml'
        'cordis.yml' = Join-Path $base 'profiles\web\cordis.yml'
        'package.json' = Join-Path $base 'profiles\web\package.json'
    }
    # Phase 02 R5: hard deny — if a ProfileRoot was requested but the resolved
    # restore target still lands on the live profile, fail closed (never let a
    # test restore into live config).
    $liveBase = Join-Path $env:USERPROFILE '.dsh'
    if ($ProfileRoot) {
        foreach ($t in $map.Values) { if ($t.StartsWith($liveBase, [System.StringComparison]::OrdinalIgnoreCase)) { return @{ Restored = @(); Error = 'profile_deny_live' } } }
    }
    $restored = @()
    foreach ($k in $map.Keys) {
        $s = Join-Path $CheckpointDir $k
        if (Test-Path $s) {
            $dstDir = Split-Path $map[$k]
            New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
            Copy-Item $s $map[$k] -Force; $restored += $k
        }
    }
    return @{ Restored = $restored; Count = $restored.Count }
}

function Test-DshTransactionHealth {
    param([int]$Port = 3080, [int]$TimeoutSec = 15)
    $ps = Join-Path $PSScriptRoot 'dsh-readiness.ps1'
    if (Test-Path $ps) { . $ps }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Test-DshReadiness -Port $Port
            if ($r.State -in @('api_ready','client_ready')) { return @{ Ok = $true; State = $r.State } }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return @{ Ok = $false; State = 'timeout' }
}

# ---------- Transaction 2.0 state machine ----------

function Test-DshTransactionCommitReady {
    param([int]$Port = 3080, [int]$StableWindowSec = 5, [switch]$SkipLightProbe)
    $cr = Join-Path $PSScriptRoot 'dsh-commit-readiness.ps1'
    if (Test-Path $cr) { . $cr }
    if (Get-Command Test-CommitReadiness -ErrorAction SilentlyContinue) {
        return (Test-CommitReadiness -Port $Port -StableWindowSec $StableWindowSec -LightProbe:(-not $SkipLightProbe))
    }
    $h = Test-DshTransactionHealth -Port $Port
    return [pscustomobject]@{ Ready = $h.Ok; Stage = if ($h.Ok) { 'COMMIT_READY(shallow)' } else { 'NOT_COMMIT_READY' }; Checks = $null }
}

function Invoke-DshTransaction {
    <#
    .SYNOPSIS
    Run a change as a full transaction. The caller supplies an APPLY scriptblock.
    The transaction drives the whole state machine and records everything in the journal.
    .PARAMETER Label
    Human-readable transaction label.
    .PARAMETER Apply
    ScriptBlock that performs the actual change (config edit / plugin change / update).
    .PARAMETER ApplyArgs
    Arguments passed to the Apply scriptblock (optional).
    .PARAMETER Port
    DSH server port.
    .PARAMETER RestartOnApply
    If $true (default), the transaction restarts the server between APPLY and VERIFY.
    .PARAMETER SkipLightProbe
    Skip the provider light probe (used when no provider is guaranteed).
    .PARAMETER StableWindowSec
    Stable window before COMMIT.
    .PARAMETER DryRun
    Do not execute Apply; only checkpoint + journal a FAILED(dry) record for testing.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Apply,
        [object[]]$ApplyArgs = @(),
        [int]$Port = 3080,
        [switch]$RestartOnApply = $true,
        [switch]$SkipLightProbe,
        [int]$StableWindowSec = 5,
        [switch]$DryRun,
        # Phase 02 R5 (R4-B1): isolated profile root for checkpoint restore in
        # tests. When set (non-empty), Restore-DshTransactionCheckpoint writes
        # back into this temp profile instead of the live %USERPROFILE%\.dsh.
        [string]$ProfileRoot = $null
    )
    $root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $tx = New-DshTransactionCheckpoint -Label $Label
    $transactionId = $tx.transactionId
    $startedAt = Get-Date -Format 'o'
    $faultClass = 'none'
    $verifyResult = $null
    $rollbackResult = $null
    $finalState = 'FAILED'

    try {
        if ($DryRun) {
            $finalState = 'FAILED'
            Add-DshTxRecord @{
                transactionId = $transactionId; label = $Label; startedAt = $startedAt
                finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
                generationAfter = $null; dshVersionBefore = $tx.dshVersionBefore
                dshVersionAfter = $null; checkpointDir = $tx.dir; files = $tx.files
                hashBefore = $tx.files; hashAfter = $null; faultClass = 'dry-run'
                verifyResult = 'SKIP'; rollbackResult = 'none'; finalState = 'FAILED(dry)'
            }
            return [pscustomobject]@{ TransactionId = $transactionId; FinalState = 'FAILED(dry)'; DryRun = $true; CheckpointDir = $tx.dir }
        }

        # ---- APPLY ----
        $applyResult = $null
        try {
            if ($ApplyArgs.Count -gt 0) { $applyResult = & $Apply @ApplyArgs }
            else { $applyResult = & $Apply }
        } catch {
            $faultClass = 'apply_exception'
            $verifyResult = "APPLY failed: $($_.Exception.Message)"
            $rollbackResult = Restore-DshTransactionCheckpoint -CheckpointDir $tx.dir -ProfileRoot $ProfileRoot
            $finalState = 'ROLLED_BACK'
            Add-DshTxRecord @{
                transactionId = $transactionId; label = $Label; startedAt = $startedAt
                finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
                generationAfter = $null; dshVersionBefore = $tx.dshVersionBefore
                dshVersionAfter = $null; checkpointDir = $tx.dir; files = $tx.files
                hashBefore = $tx.files; hashAfter = $null; faultClass = $faultClass
                verifyResult = $verifyResult; rollbackResult = $rollbackResult; finalState = $finalState
            }
            return [pscustomobject]@{ TransactionId = $transactionId; FinalState = $finalState; FaultClass = $faultClass; Rollback = $rollbackResult }
        }

        # ---- BOOT (restart so the change takes effect) ----
        if ($RestartOnApply) {
            $rs = Join-Path $root 'restart-dsh-server-delayed.ps1'
            if (Test-Path $rs) {
                # Phase 02 R4 (Step 1): run the restart detached, capture the
                # attemptId, then WAIT on the exact attempt's terminal state
                # (COMMITTED | FAILED | TIMED_OUT). The outer wrapper's exit 0
                # is NOT "restart complete" — the worker may still be booting.
                $attemptId = [guid]::NewGuid().ToString('N')
                $rsArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$rs`" -DelaySeconds 0 -Port $Port -AttemptId $attemptId"
                Start-Process powershell -ArgumentList $rsArgs -WindowStyle Hidden | Out-Null
                # Wait for the exact attempt terminal (up to restart terminal timeout).
                $waitArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$rs`" -WaitAttempt $attemptId -TimeoutSec 180 -Port $Port"
                $waitOut = Start-Process powershell -ArgumentList $waitArgs -WindowStyle Hidden -Wait -PassThru
                if ($waitOut.ExitCode -ne 0) {
                    Write-Warning "restart attempt $attemptId did not reach COMMITTED (exit $($waitOut.ExitCode))"
                    $faultClass = 'boot_failed'
                }
            } else {
                $h = Test-DshTransactionHealth -Port $Port
                if (-not $h.Ok) { $faultClass = 'boot_failed' }
            }
        }

        # ---- VERIFY (full COMMIT_READY) ----
        $gate = Test-DshTransactionCommitReady -Port $Port -StableWindowSec $StableWindowSec -SkipLightProbe:$SkipLightProbe
        $verifyResult = $gate.Stage
        if ($gate.Ready) {
            # ---- STABILIZE + COMMIT ----
            . (Join-Path $root 'dsh-verified-lastgood.ps1') 2>$null
            $lg = $null
            if (Get-Command Save-VerifiedLastGood -ErrorAction SilentlyContinue) {
                $lg = Save-VerifiedLastGood -Port $Port -Reason "tx:$Label" -StableWindowSec 0 -SkipLightProbe:$SkipLightProbe
            }
            $finalState = 'COMMITTED'
            $dshVerAfter = ''
            try { $dshVerAfter = ((& dsh --version 2>$null) -join '').Trim() } catch { $dshVerAfter = '' }
            Add-DshTxRecord @{
                transactionId = $transactionId; label = $Label; startedAt = $startedAt
                finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
                generationAfter = (Get-DshGenerationId -Port $Port); dshVersionBefore = $tx.dshVersionBefore
                dshVersionAfter = $dshVerAfter
                checkpointDir = $tx.dir; files = $tx.files
                hashBefore = $tx.files; hashAfter = $tx.files; faultClass = $faultClass
                verifyResult = $verifyResult; rollbackResult = 'none'; finalState = $finalState
                lastGood = $lg
            }
            return [pscustomobject]@{ TransactionId = $transactionId; FinalState = $finalState; Verify = $verifyResult; LastGood = $lg }
        }

        # ---- VERIFY FAIL -> ROLLBACK -> RESTART -> VERIFY_RECOVERY ----
        $faultClass = 'verify_failed'
        $rollbackResult = Restore-DshTransactionCheckpoint -CheckpointDir $tx.dir -ProfileRoot $ProfileRoot
        if ($RestartOnApply) {
            $rs = Join-Path $root 'restart-dsh-server-delayed.ps1'
            if (Test-Path $rs) {
                $rsArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$rs`" -DelaySeconds 0 -Port $Port"
                Start-Process powershell -ArgumentList $rsArgs -WindowStyle Hidden -Wait
            }
        }
        $recovery = Test-DshTransactionHealth -Port $Port
        if ($recovery.Ok) {
            $finalState = 'ROLLED_BACK'
            $dshVerAfter = ''
            try { $dshVerAfter = ((& dsh --version 2>$null) -join '').Trim() } catch { $dshVerAfter = '' }
            Add-DshTxRecord @{
                transactionId = $transactionId; label = $Label; startedAt = $startedAt
                finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
                generationAfter = (Get-DshGenerationId -Port $Port); dshVersionBefore = $tx.dshVersionBefore
                dshVersionAfter = $dshVerAfter
                checkpointDir = $tx.dir; files = $tx.files
                hashBefore = $tx.files; hashAfter = $tx.files; faultClass = $faultClass
                verifyResult = $verifyResult; rollbackResult = $rollbackResult; finalState = $finalState
            }
            return [pscustomobject]@{ TransactionId = $transactionId; FinalState = $finalState; FaultClass = $faultClass; Verify = $verifyResult; Rollback = $rollbackResult }
        }

        # ---- recovery still failing -> ESCALATE_TO_SAFE_MODE ----
        $finalState = 'SAFE_MODE'
        Add-DshTxRecord @{
            transactionId = $transactionId; label = $Label; startedAt = $startedAt
            finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
            generationAfter = $null; dshVersionBefore = $tx.dshVersionBefore
            dshVersionAfter = $null; checkpointDir = $tx.dir; files = $tx.files
            hashBefore = $tx.files; hashAfter = $null; faultClass = $faultClass
            verifyResult = $verifyResult; rollbackResult = $rollbackResult; finalState = $finalState
        }
        return [pscustomobject]@{ TransactionId = $transactionId; FinalState = $finalState; FaultClass = $faultClass; Verify = $verifyResult; Rollback = $rollbackResult }
    } catch {
        $finalState = 'FAILED'
        Add-DshTxRecord @{
            transactionId = $transactionId; label = $Label; startedAt = $startedAt
            finishedAt = (Get-Date -Format 'o'); generationBefore = $tx.generationBefore
            generationAfter = $null; dshVersionBefore = $tx.dshVersionBefore
            dshVersionAfter = $null; checkpointDir = $tx.dir; files = $tx.files
            hashBefore = $tx.files; hashAfter = $null; faultClass = "exception:$($_.Exception.Message)"
            verifyResult = $null; rollbackResult = $null; finalState = $finalState
        }
        return [pscustomobject]@{ TransactionId = $transactionId; FinalState = $finalState; Error = $_.Exception.Message }
    }
}

function Get-DshTransaction([string]$TransactionId = $null) {
    $j = Get-DshTxJournal
    if ($TransactionId) {
        return @($j.transactions) | Where-Object { $_.transactionId -eq $TransactionId } | Select-Object -First 1
    }
    return $j.transactions
}
