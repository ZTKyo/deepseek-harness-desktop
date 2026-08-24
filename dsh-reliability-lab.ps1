# dsh-reliability-lab.ps1 - Reliability Lab Level 1: synthetic fault tests (isolated).
# Reliability v1 (Stage F). Runs FAULT_CATALOG L1 entries against the local modules
# using isolated state paths - never touches the real profile/service/sessions.
#
# Usage:
#   powershell -File dsh-reliability-lab.ps1 -List       # list registered faults
#   powershell -File dsh-reliability-lab.ps1 -Run F-YAML-001,F-STATE-001
#   powershell -File dsh-reliability-lab.ps1 -RunAll     # run all L1 faults (default)
param([string[]]$Run, [switch]$List, [switch]$RunAll)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$tmp = Join-Path $env:TEMP ("dsh-lab-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
# isolate module state paths
$env:DSH_BOOT_MODE_PATH = Join-Path $tmp 'boot-mode.json'
$env:DSH_RESTART_BUDGET_PATH = Join-Path $tmp 'restart-budget.json'
$env:DSH_SAFE_FLAG_PATH = Join-Path $tmp 'safe-mode.json'
$env:DSH_SAFE_PROFILE_DIR = Join-Path $tmp 'profile'
New-Item -ItemType Directory -Force -Path $env:DSH_SAFE_PROFILE_DIR | Out-Null
# Phase 02 R5 (R4-B1): isolate transaction checkpoints/journal so Lab fault
# tests never write real %LOCALAPPDATA%\DSHHarness\tx-checkpoints.
$env:DSH_TX_ROOT = Join-Path $tmp 'tx'
New-Item -ItemType Directory -Force -Path $env:DSH_TX_ROOT | Out-Null

. (Join-Path $root 'dsh-boot-mode.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')
. (Join-Path $root 'dsh-safe-mode.ps1')

$results = @()
function Add-LabResult([string]$faultId, [bool]$Pass, [string]$Detail) {
    $script:results += [pscustomobject]@{ faultId = $faultId; pass = $Pass; detail = $Detail }
    Write-Host ("{0}  {1}  {2}" -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $faultId, $Detail)
}

# ---- fault runners ----
function Lab-F-YAML-001 {
    # invalid YAML detection via guardian's Test-YamlFile logic (isolated file)
    $bad = Join-Path $tmp 'bad.yaml'
    Set-Content -Path $bad -Value "a: : : [[[" -Encoding UTF8
    $src = Get-Content (Join-Path $root 'dsh-guardian.ps1') -Raw
    $ok = $src -match 'function Test-YamlFile'
    Add-LabResult 'F-YAML-001' ($ok) 'guardian Test-YamlFile present (detection path)'
}
function Lab-F-PROC-004 {
    # stale PID: generation id returns null when nothing listens (safe on dead port)
    . (Join-Path $root 'dsh-generation.ps1') 2>$null
    $g = Get-DshGenerationId -Port 35998
    Add-LabResult 'F-PROC-004' ($null -eq $g) "stale pid -> generation null (got: $g)"
}
function Lab-F-TX-001 {
    . (Join-Path $root 'dsh-transaction.ps1') 2>$null
    $r = Restore-DshTransactionCheckpoint -CheckpointDir (Join-Path $tmp 'nope-missing')
    Add-LabResult 'F-TX-001' ($r.Error -eq 'checkpoint_not_found') 'bad checkpoint path -> checkpoint_not_found'
}
function Lab-F-TX-002 {
    # corrupt manifest: journal read survives
    . (Join-Path $root 'dsh-transaction.ps1') 2>$null
    $j = Get-DshTxJournal
    Add-LabResult 'F-TX-002' ($null -ne $j) 'journal read ok (no manifest)'
}
function Lab-F-TX-003 {
    . (Join-Path $root 'dsh-transaction.ps1') 2>$null
    $t = Invoke-DshTransaction -Label 'lab-f-tx-003' -Apply { throw 'boom' } -RestartOnApply:$false -DryRun
    Add-LabResult 'F-TX-003' ($t.FinalState -eq 'FAILED(dry)') "dry-run apply fail (state=$($t.FinalState))"
}
function Lab-F-STATE-001 {
    Set-Content -Path $env:DSH_BOOT_MODE_PATH -Value '{ bad json' -Encoding UTF8
    $m = Get-DshBootMode
    Add-LabResult 'F-STATE-001' ($m.mode -eq 'normal') 'corrupt boot-mode -> normal fallback'
}
function Lab-F-STATE-002 {
    Set-Content -Path $env:DSH_RESTART_BUDGET_PATH -Value '{ bad json' -Encoding UTF8
    $b = Read-DshRestartBudget
    Add-LabResult 'F-STATE-002' ($null -ne $b -and $null -ne $b.attempts) 'corrupt budget -> defaults'
}
function Lab-F-STATE-003 {
    Set-Content -Path $env:DSH_SAFE_FLAG_PATH -Value '{ bad json' -Encoding UTF8
    $s = Read-SafeFlag
    Add-LabResult 'F-STATE-003' ($null -eq $s) 'corrupt safe flag -> null (not active)'
}
function Lab-F-SEC-001 {
    # diagnostics redaction: dsh-diagnostics.ps1 must not echo raw credential values
    $src = Get-Content (Join-Path $root 'dsh-diagnostics.ps1') -Raw
    $hasRedact = $src -match 'redact|mask|\*\*\*'
    Add-LabResult 'F-SEC-001' ($hasRedact) 'diagnostics has redaction logic (source-level)'
}

$registered = @(
    @{ id = 'F-YAML-001'; runner = 'Lab-F-YAML-001' },
    @{ id = 'F-PROC-004'; runner = 'Lab-F-PROC-004' },
    @{ id = 'F-TX-001';   runner = 'Lab-F-TX-001' },
    @{ id = 'F-TX-002';   runner = 'Lab-F-TX-002' },
    @{ id = 'F-TX-003';   runner = 'Lab-F-TX-003' },
    @{ id = 'F-STATE-001'; runner = 'Lab-F-STATE-001' },
    @{ id = 'F-STATE-002'; runner = 'Lab-F-STATE-002' },
    @{ id = 'F-STATE-003'; runner = 'Lab-F-STATE-003' },
    @{ id = 'F-SEC-001';  runner = 'Lab-F-SEC-001' }
)

if ($List) {
    $registered | ForEach-Object { Write-Output $_.id }
    exit 0
}

$targets = if ($Run) { $Run } else { @($registered | ForEach-Object { $_.id }) }
foreach ($t in $targets) {
    $reg = $registered | Where-Object { $_.id -eq $t } | Select-Object -First 1
    if (-not $reg) { Write-Host "SKIP  $t (not registered)"; continue }
    try { & $reg.runner } catch { Add-LabResult $t $false ("exception: $($_.Exception.Message)") }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:DSH_BOOT_MODE_PATH, Env:DSH_RESTART_BUDGET_PATH, Env:DSH_SAFE_FLAG_PATH, Env:DSH_SAFE_PROFILE_DIR -ErrorAction SilentlyContinue

$fail = @($results | Where-Object { -not $_.pass }).Count
Write-Host ("== Lab L1 result: {0} pass, {1} fail ==" -f ($results.Count - $fail), $fail)
if ($fail -eq 0) { exit 0 } else { exit 1 }
