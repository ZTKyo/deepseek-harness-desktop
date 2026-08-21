# Test-CommitReadiness.ps1 - verify the COMMIT_READY gate against a live server.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\reliability\Test-CommitReadiness.ps1 [-Port 3080] [-SkipLightProbe]
param([int]$Port = 3080, [switch]$SkipLightProbe)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'dsh-commit-readiness.ps1')
$gate = Test-CommitReadiness -Port $Port -StableWindowSec 2 -LightProbe:(-not $SkipLightProbe)
Write-Host ("Gate: {0} | Stage: {1}" -f $gate.Ready, $gate.Stage)
$gate.Checks.PSObject.Properties | ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.Name, $_.Value) }
if ($gate.Ready) { Write-Host 'RESULT: PASS'; exit 0 } else { Write-Host 'RESULT: FAIL'; exit 1 }
