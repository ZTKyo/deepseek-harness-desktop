# dsh-boot-mode.ps1 - Boot Mode abstraction (Reliability v1, Stage D)
#
# Modes: NORMAL | SAFE | EXPERIMENTAL
#   NORMAL      = default; behavior identical to RC8 Golden when no state file exists
#   SAFE        = True Safe Mode composition (Stage E): minimal isolated profile
#   EXPERIMENTAL= isolated experimental profile (Reliability Lab Level 2)
#
# State file: %LOCALAPPDATA%\DSHHarness\state\boot-mode.json
#   { mode, reason, enteredAt, transactionId, checkpoint, failureClass }
#
# Normal must stay fully compatible: if the state file is missing or mode=normal,
# boot behaves exactly like RC8 Golden.

$script:DshBootModePath = if ($env:DSH_BOOT_MODE_PATH) {
    $env:DSH_BOOT_MODE_PATH
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state\boot-mode.json'
}

function Get-DshBootMode {
    if (-not (Test-Path -LiteralPath $script:DshBootModePath)) {
        return [pscustomobject]@{ mode = 'normal'; reason = 'no-state-file'; enteredAt = $null; transactionId = $null; checkpoint = $null; failureClass = $null }
    }
    try {
        $v = Get-Content -LiteralPath $script:DshBootModePath -Raw | ConvertFrom-Json
        if ($null -eq $v.mode) { return [pscustomobject]@{ mode = 'normal'; reason = 'corrupt-no-mode'; enteredAt = $null; transactionId = $null; checkpoint = $null; failureClass = $null } }
        return $v
    } catch {
        return [pscustomobject]@{ mode = 'normal'; reason = 'corrupt-unreadable'; enteredAt = $null; transactionId = $null; checkpoint = $null; failureClass = $null }
    }
}

function Set-DshBootMode {
    param(
        [ValidateSet('normal','safe','experimental')][string]$Mode,
        [string]$Reason = 'manual',
        [string]$TransactionId = $null,
        [string]$Checkpoint = $null,
        [string]$FailureClass = $null
    )
    $dir = Split-Path -Parent $script:DshBootModePath
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $state = [pscustomobject]@{
        mode = $Mode
        reason = $Reason
        enteredAt = (Get-Date -Format 'o')
        transactionId = $TransactionId
        checkpoint = $Checkpoint
        failureClass = $FailureClass
    }
    $tmp = "$($script:DshBootModePath).tmp-$PID"
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
    try { Move-Item -LiteralPath $tmp -Destination $script:DshBootModePath -Force -ErrorAction Stop }
    catch {
        Remove-Item -LiteralPath $script:DshBootModePath -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $tmp -Destination $script:DshBootModePath -Force
    }
    return $state
}

function Reset-DshBootMode {
    Remove-Item -LiteralPath $script:DshBootModePath -Force -ErrorAction SilentlyContinue
    return (Get-DshBootMode)
}

function Test-DshBootModeNormal {
    $m = Get-DshBootMode
    return ($m.mode -eq 'normal')
}
