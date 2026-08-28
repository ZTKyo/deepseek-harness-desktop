# Test-OxRelayDeployRollback.ps1
# Rollback Seal for the ox-relay deploy — persistent cross-process rollback verification.
# Runs deploy-ox-relay.ps1 with isolated -RuntimeRoot/-StateRoot/-CanonRoot across
# THREE separate PowerShell processes (persistence across processes).
#
# Requires: node, git checkout with docs/execution-economy/plugins/ (canonical).
# No live DSH, no credentials, no ~/.dsh. Portable on Windows.
#
# Exit: 0 = all PASS, 1 = any FAIL.

$ErrorActionPreference = 'Continue'
$failCount = 0
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # repo root
$scriptPath = Join-Path $root 'deploy-ox-relay.ps1'
$realCanon = Join-Path $root 'docs\execution-economy\plugins'

function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host "PASS  $Name  $Detail" }
    else { Write-Host "FAIL  $Name  $Detail"; $script:failCount++ }
}
function Sha([string]$p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { 'ABSENT' } }

# --- isolated test env ---
$tmp = Join-Path $env:TEMP ("oxrb-seal-" + [guid]::NewGuid().ToString('N'))
$rt = Join-Path $tmp 'runtime'; $st = Join-Path $tmp 'state'; $canon = Join-Path $tmp 'canon'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
New-Item -ItemType Directory -Force -Path $st | Out-Null
New-Item -ItemType Directory -Force -Path $canon | Out-Null

Copy-Item (Join-Path $realCanon 'ox-relay-core.mjs') (Join-Path $canon 'ox-relay-core.mjs') -Force
Copy-Item (Join-Path $realCanon 'ox-relay-failover.mjs') (Join-Path $canon 'ox-relay-failover.mjs') -Force
$canonCore = Sha (Join-Path $canon 'ox-relay-core.mjs')
$canonPlugin = Sha (Join-Path $canon 'ox-relay-failover.mjs')

# pre-deploy "OLD" state (distinct marker content)
Set-Content (Join-Path $rt 'ox-relay-core.mjs') "// OLD-CORE-marker`nexport const OLD=1;" -Encoding UTF8
Set-Content (Join-Path $rt 'ox-relay-failover.mjs') "// OLD-PLUGIN-marker`nexport const OLD=1;" -Encoding UTF8
$oldCore = Sha (Join-Path $rt 'ox-relay-core.mjs')
$oldPlugin = Sha (Join-Path $rt 'ox-relay-failover.mjs')

Write-Host '== T1: PROCESS 1 deploy (isolated) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T1 deploy exit 0'
Assert ((Sha (Join-Path $rt 'ox-relay-core.mjs')) -eq $canonCore) 'T1 core == canonical'
Assert ((Sha (Join-Path $rt 'ox-relay-failover.mjs')) -eq $canonPlugin) 'T1 plugin == canonical'
Assert (Test-Path (Join-Path $st 'current.json')) 'T1 persistent manifest exists'

Write-Host '== T2: PROCESS 2 rollback (new process) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Rollback -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T2 rollback exit 0'
Assert ((Sha (Join-Path $rt 'ox-relay-core.mjs')) -eq $oldCore) 'T2 core == exact OLD'
Assert ((Sha (Join-Path $rt 'ox-relay-failover.mjs')) -eq $oldPlugin) 'T2 plugin == exact OLD'

Write-Host '== T3: PROCESS 3 redeploy (new process) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T3 redeploy exit 0'
Assert ((Sha (Join-Path $rt 'ox-relay-core.mjs')) -eq $canonCore) 'T3 core == canonical (redeployed)'
Assert ((Sha (Join-Path $rt 'ox-relay-failover.mjs')) -eq $canonPlugin) 'T3 plugin == canonical (redeployed)'

Write-Host '== T4: TRUE partial-replace failure (A replaced -> inject fail before B) =='
$rt4 = Join-Path $tmp 'runtime4'; $st4 = Join-Path $tmp 'state4'
New-Item -ItemType Directory -Force -Path $rt4 | Out-Null
New-Item -ItemType Directory -Force -Path $st4 | Out-Null
Set-Content (Join-Path $rt4 'ox-relay-core.mjs') "// OLD-CORE-marker`nexport const OLD=1;" -Encoding UTF8
Set-Content (Join-Path $rt4 'ox-relay-failover.mjs') "// OLD-PLUGIN-marker`nexport const OLD=1;" -Encoding UTF8
$o4c = Sha (Join-Path $rt4 'ox-relay-core.mjs'); $o4m = Sha (Join-Path $rt4 'ox-relay-failover.mjs')
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt4 -StateRoot $st4 -CanonRoot $canon -InjectReplaceFailure | Out-Null
Assert ($LASTEXITCODE -ne 0) 'T4 deploy exits non-zero on injected replace failure'
Assert ((Sha (Join-Path $rt4 'ox-relay-core.mjs')) -eq $o4c) 'T4 A hash == OLD A (rolled back)'
Assert ((Sha (Join-Path $rt4 'ox-relay-failover.mjs')) -eq $o4m) 'T4 B hash == OLD B (never replaced)'
$residue = Get-ChildItem $rt4 -Filter '*.new-*' -ErrorAction SilentlyContinue
Assert ($null -eq $residue -or @($residue).Count -eq 0) 'T4 no *.new-* temp residue' $(if($residue){$residue.Name -join ','}else{''})

Write-Host '== T5: absent-file semantics (deploy over absent -> rollback removes) =='
$rt3 = Join-Path $tmp 'runtime3'; $st3 = Join-Path $tmp 'state3'
New-Item -ItemType Directory -Force -Path $rt3 | Out-Null
New-Item -ItemType Directory -Force -Path $st3 | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt3 -StateRoot $st3 -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T5 deploy over absent ok'
Assert (Test-Path (Join-Path $rt3 'ox-relay-core.mjs')) 'T5 core now exists'
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Rollback -RuntimeRoot $rt3 -StateRoot $st3 -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T5 rollback ok'
Assert (-not (Test-Path (Join-Path $rt3 'ox-relay-core.mjs'))) 'T5 core removed (was ABSENT)'
Assert (-not (Test-Path (Join-Path $rt3 'ox-relay-failover.mjs'))) 'T5 plugin removed (was ABSENT)'

# cleanup
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (OxRelay Rollback Seal)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount)"; exit 1 }
