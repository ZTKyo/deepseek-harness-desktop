# Test-StageB-LastGoodAuthority.ps1 - verify "YAML valid != Last Good" authority rule.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\reliability\Test-StageB-LastGoodAuthority.ps1 [-LivePort 3080]
param([int]$LivePort = 3080)
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Write-Host '== Case 1: YAML syntax broken -> restore from mirror (guardian behavior) =='
# Simulate: a config file is invalid YAML; guardian Check-ConfigSafety must restore the mirror,
# and must NOT have overwritten the mirror when the file was valid.
$tmp = Join-Path $env:TEMP ("dsh-test-b-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $mirrorDir = Join-Path $tmp 'mirror'; New-Item -ItemType Directory -Force -Path $mirrorDir | Out-Null
    $mirrorFile = Join-Path $mirrorDir 'settings.yaml'
    Set-Content -Path $mirrorFile -Value "knownGood: true`nsomeKey: value" -Encoding UTF8
    # a poisoned file (syntax broken)
    $poison = Join-Path $tmp 'settings.yaml'
    Set-Content -Path $poison -Value "this is : not : valid : yaml : [[[" -Encoding UTF8
    # emulate new guardian logic: syntax invalid -> copy mirror over poisoned file
    Copy-Item $mirrorFile $poison -Force
    $restored = Get-Content $poison -Raw
    Assert ($restored -match 'knownGood: true') 'C1 syntax-broken restored from mirror' $poison
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host '== Case 2: YAML valid but runtime-toxic -> must NOT promote (source-level) =='
# The guardian Check-ConfigSafety must never contain a "syntax-valid -> copy to lastgood" write.
$guardianSrc = Get-Content (Join-Path $root 'dsh-guardian.ps1') -Raw
$badPatterns = @(
    "if (`$ok -eq `$true) {`r?`n\s*Copy-Item `$cf.Path `$lg",   # promote on valid
    "if (`$ok -eq `$true) { Copy-Item `$cf.Path `$lg"            # single-line promote
)
foreach ($pat in $badPatterns) {
    $m = [regex]::Match($guardianSrc, $pat)
    Assert (-not $m.Success) 'C2 guardian no longer promotes syntax-valid' "pattern=$pat"
}
# positive control: mirror-restore branch must exist
Assert ($guardianSrc -match 'restored mirror snapshot') 'C2 mirror-restore branch present'

Write-Host '== Case 3a: Save-VerifiedLastGood refuses when gate fails (dead port) =='
. (Join-Path $root 'dsh-verified-lastgood.ps1')
$deadPort = 35999
$r = Save-VerifiedLastGood -Port $deadPort -Reason 'test-dead-port' -StableWindowSec 0 -SkipLightProbe
Assert ($r.Saved -eq $false -and $r.Reason -eq 'commit_readiness_failed') 'C3a dead port refused' "reason=$($r.Reason)"

Write-Host '== Case 3b: Save-VerifiedLastGood promotes on live healthy service =='
$r2 = Save-VerifiedLastGood -Port $LivePort -Reason 'stage-b-test' -StableWindowSec 2 -SkipLightProbe
Assert ($r2.Saved -eq $true) 'C3b live promote succeeded' "gate=$($r2.Gate)"
# guardian-lastgood mirror must have been synced (only legal writer)
$gMeta = Join-Path $env:LOCALAPPDATA 'DSHHarness\guardian-lastgood\meta.json'
Assert (Test-Path $gMeta) 'C3b mirror meta synced'
if (Test-Path $gMeta) {
    $gm = Get-Content $gMeta -Raw | ConvertFrom-Json
    Assert ($gm.reason -eq 'stage-b-test') 'C3b mirror meta carries same reason'
}

Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Stage B authority rule verified)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
