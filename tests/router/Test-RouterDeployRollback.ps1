# Test-RouterDeployRollback.ps1
# Rollback Seal — persistent cross-process rollback verification.
# Runs deploy-router-fix.ps1 with isolated -RuntimeRoot/-StateRoot/-CanonRoot
# across THREE separate PowerShell processes (persistence across processes).
#
# Requires: node, git checkout with docs/execution-economy/plugins/ (canonical).
# No live DSH, no credentials, no ~/.dsh. Portable on Windows.
#
# Exit: 0 = all PASS, 1 = any FAIL.

$ErrorActionPreference = 'Continue'
$failCount = 0
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # repo root
$scriptPath = Join-Path $root 'deploy-router-fix.ps1'
$realCanon = Join-Path $root 'docs\execution-economy\plugins'

function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host "PASS  $Name  $Detail" }
    else { Write-Host "FAIL  $Name  $Detail"; $script:failCount++ }
}
function Sha([string]$p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash } else { 'ABSENT' } }

# --- isolated test env ---
$tmp = Join-Path $env:TEMP ("rb-seal-" + [guid]::NewGuid().ToString('N'))
$rt = Join-Path $tmp 'runtime'; $st = Join-Path $tmp 'state'; $canon = Join-Path $tmp 'canon'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
New-Item -ItemType Directory -Force -Path $st | Out-Null
New-Item -ItemType Directory -Force -Path $canon | Out-Null

# canonical test copies (valid)
Copy-Item (Join-Path $realCanon 'openrouter-router-core.mjs') (Join-Path $canon 'openrouter-router-core.mjs') -Force
Copy-Item (Join-Path $realCanon 'openrouter-router.mjs') (Join-Path $canon 'openrouter-router.mjs') -Force
$canonCore = Sha (Join-Path $canon 'openrouter-router-core.mjs')
$canonRouter = Sha (Join-Path $canon 'openrouter-router.mjs')

# pre-deploy "OLD" state (distinct marker content)
Set-Content (Join-Path $rt 'openrouter-router-core.mjs') "// OLD-CORE-marker`nexport const OLD=1;" -Encoding UTF8
Set-Content (Join-Path $rt 'openrouter-router.mjs') "// OLD-ROUTER-marker`nexport const OLD=1;" -Encoding UTF8
$oldCore = Sha (Join-Path $rt 'openrouter-router-core.mjs')
$oldRouter = Sha (Join-Path $rt 'openrouter-router.mjs')

Write-Host '== T1: PROCESS 1 deploy (isolated) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T1 deploy exit 0'
Assert ((Sha (Join-Path $rt 'openrouter-router-core.mjs')) -eq $canonCore) 'T1 core == canonical'
Assert ((Sha (Join-Path $rt 'openrouter-router.mjs')) -eq $canonRouter) 'T1 router == canonical'
Assert (Test-Path (Join-Path $st 'current.json')) 'T1 persistent manifest exists'

Write-Host '== T2: PROCESS 2 rollback (new process) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Rollback -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T2 rollback exit 0'
Assert ((Sha (Join-Path $rt 'openrouter-router-core.mjs')) -eq $oldCore) 'T2 core == exact OLD'
Assert ((Sha (Join-Path $rt 'openrouter-router.mjs')) -eq $oldRouter) 'T2 router == exact OLD'

Write-Host '== T3: PROCESS 3 redeploy (new process) =='
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt -StateRoot $st -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T3 redeploy exit 0'
Assert ((Sha (Join-Path $rt 'openrouter-router-core.mjs')) -eq $canonCore) 'T3 core == canonical (redeployed)'
Assert ((Sha (Join-Path $rt 'openrouter-router.mjs')) -eq $canonRouter) 'T3 router == canonical (redeployed)'

Write-Host '== T4: stage failure injection (bad second file) =='
$badCanon = Join-Path $tmp 'canon-bad'; New-Item -ItemType Directory -Force -Path $badCanon | Out-Null
Copy-Item (Join-Path $realCanon 'openrouter-router-core.mjs') (Join-Path $badCanon 'openrouter-router-core.mjs') -Force
Set-Content (Join-Path $badCanon 'openrouter-router.mjs') "not valid javascript {{{" -Encoding UTF8
$rt2 = Join-Path $tmp 'runtime2'; $st2 = Join-Path $tmp 'state2'
New-Item -ItemType Directory -Force -Path $rt2 | Out-Null
New-Item -ItemType Directory -Force -Path $st2 | Out-Null
Set-Content (Join-Path $rt2 'openrouter-router-core.mjs') "// OLD" -Encoding UTF8
Set-Content (Join-Path $rt2 'openrouter-router.mjs') "// OLD" -Encoding UTF8
$o2c = Sha (Join-Path $rt2 'openrouter-router-core.mjs'); $o2m = Sha (Join-Path $rt2 'openrouter-router.mjs')
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt2 -StateRoot $st2 -CanonRoot $badCanon | Out-Null
Assert ($LASTEXITCODE -ne 0) 'T4 deploy fails on bad second file'
Assert ((Sha (Join-Path $rt2 'openrouter-router-core.mjs')) -eq $o2c) 'T4 core NOT replaced (both old)'
Assert ((Sha (Join-Path $rt2 'openrouter-router.mjs')) -eq $o2m) 'T4 router NOT replaced (both old)'

Write-Host '== T5: absent-file semantics (deploy over absent -> rollback removes) =='
$rt3 = Join-Path $tmp 'runtime3'; $st3 = Join-Path $tmp 'state3'
New-Item -ItemType Directory -Force -Path $rt3 | Out-Null
New-Item -ItemType Directory -Force -Path $st3 | Out-Null
# no files present (both ABSENT pre-deploy)
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RuntimeRoot $rt3 -StateRoot $st3 -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T5 deploy over absent ok'
Assert (Test-Path (Join-Path $rt3 'openrouter-router-core.mjs')) 'T5 core now exists'
& powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Rollback -RuntimeRoot $rt3 -StateRoot $st3 -CanonRoot $canon | Out-Null
Assert ($LASTEXITCODE -eq 0) 'T5 rollback ok'
Assert (-not (Test-Path (Join-Path $rt3 'openrouter-router-core.mjs'))) 'T5 core removed (was ABSENT)'
Assert (-not (Test-Path (Join-Path $rt3 'openrouter-router.mjs'))) 'T5 router removed (was ABSENT)'

# cleanup
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Rollback Seal)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount)"; exit 1 }
