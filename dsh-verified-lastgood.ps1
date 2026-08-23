# dsh-verified-lastgood.ps1 - Health-Verified Last Good for DSH Harness (Reliability v1, Stage B)
#
# Authority rule (v1):
#   YAML Valid  !=  Last Good
#   YAML Valid  only means "allowed to attempt boot"
#   Last Good   is promoted ONLY after full COMMIT_READY verification
#               (process identity + host.describe + session.list + events.mux +
#                events.host + renderer + light probe + stable window)
#
# guardian-lastgood is a RESTORE MIRROR ONLY. It must never be written by
# "YAML syntax is valid" logic. Its only legal writer is Save-VerifiedLastGood.
#
# Phase 02 R4 (Step 0 Test Isolation): a StateRoot env override lets tests pin
# verified/guardian last-good to a temp root instead of the real
# %LOCALAPPDATA%\DSHHarness. Default behaviour is unchanged when unset.

function Get-VerifiedLastGoodDir {
    if ($env:DSH_STATE_ROOT) { return (Join-Path $env:DSH_STATE_ROOT 'verified-lastgood') }
    return Join-Path $env:LOCALAPPDATA 'DSHHarness\verified-lastgood'
}
function Get-GuardianLastGoodDir {
    if ($env:DSH_STATE_ROOT) { return (Join-Path $env:DSH_STATE_ROOT 'guardian-lastgood') }
    return Join-Path $env:LOCALAPPDATA 'DSHHarness\guardian-lastgood'
}

function Test-FullReadiness {
    param([int]$Port = 3080)
    $ps = Join-Path $PSScriptRoot 'dsh-readiness.ps1'
    if (Test-Path $ps) { . $ps }
    try {
        $r = Test-DshReadiness -Port $Port
        return ($r.State -in @('api_ready','client_ready'))
    } catch { return $false }
}

function Test-VerifiedLastGoodGate {
    <#
    .SYNOPSIS
    Full COMMIT_READY gate before promoting Last Good.
    .PARAMETER Port
    .PARAMETER StableWindowSec
    .PARAMETER SkipLightProbe
    Use -SkipLightProbe when a provider is not guaranteed (e.g. boot-time in CI without keys);
    the gate then verifies the full runtime surface but not a real provider round-trip.
    #>
    param([int]$Port = 3080, [int]$StableWindowSec = 10, [switch]$SkipLightProbe)
    $cr = Join-Path $PSScriptRoot 'dsh-commit-readiness.ps1'
    if (Test-Path $cr) { . $cr }
    if (Get-Command Test-CommitReadiness -ErrorAction SilentlyContinue) {
        $gate = Test-CommitReadiness -Port $Port -StableWindowSec $StableWindowSec `
            -LightProbe:(-not $SkipLightProbe)
        return $gate
    }
    # fallback (should not happen): shallow gate
    $ok = Test-FullReadiness -Port $Port
    return [pscustomobject]@{ Ready = $ok; Stage = if ($ok) { 'COMMIT_READY(shallow)' } else { 'NOT_COMMIT_READY' }; Checks = $null; Timestamp = (Get-Date -Format 'o') }
}

function Save-VerifiedLastGood {
    <#
    .SYNOPSIS
    Promote current config to Verified Last Good. ONLY when the full COMMIT_READY gate passes.
    Also syncs guardian-lastgood (the restore mirror). This is the ONLY legal writer of
    guardian-lastgood.
    #>
    param([int]$Port = 3080, [string]$Reason = 'health-pass', [int]$StableWindowSec = 10, [switch]$SkipLightProbe, [switch]$Force)
    if (-not $Force) {
        $gate = Test-VerifiedLastGoodGate -Port $Port -StableWindowSec $StableWindowSec -SkipLightProbe:$SkipLightProbe
        if (-not $gate.Ready) {
            return @{ Saved = $false; Reason = 'commit_readiness_failed'; Gate = $gate }
        }
    }
    $src = @(
        @{ Path = "$env:USERPROFILE\.dsh\settings.yaml"; Name = 'settings.yaml' },
        @{ Path = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"; Name = 'cordis.patch.yml' },
        @{ Path = "$env:USERPROFILE\.dsh\profiles\web\cordis.yml"; Name = 'cordis.yml' }
    )
    $dst = Get-VerifiedLastGoodDir
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $dshVer = ''
    try { $dshVer = ((& dsh --version 2>$null) -join '').Trim() } catch { $dshVer = '' }
    $meta = @{
        timestamp = (Get-Date -Format 'o')
        reason = $Reason
        port = $Port
        dshVersion = $dshVer
        gate = if ($gate) { $gate.Stage } else { 'forced' }
    }
    foreach ($f in $src) { if (Test-Path $f.Path) { Copy-Item $f.Path (Join-Path $dst $f.Name) -Force } }
    ($meta | ConvertTo-Json -Compress) | Out-File (Join-Path $dst 'meta.json') -Encoding utf8
    # sync the restore mirror (guardian-lastgood) - the ONLY legal writer
    $gDir = Get-GuardianLastGoodDir
    New-Item -ItemType Directory -Force -Path $gDir | Out-Null
    foreach ($f in $src) {
        $s = Join-Path $dst $f.Name
        if (Test-Path $s) { Copy-Item $s (Join-Path $gDir $f.Name) -Force }
    }
    (Get-Content (Join-Path $dst 'meta.json') -Raw) | Out-File (Join-Path $gDir 'meta.json') -Encoding utf8
    return @{ Saved = $true; Reason = $Reason; Dir = $dst; Gate = if ($gate) { $gate.Stage } else { 'forced' } }
}

function Restore-VerifiedLastGood {
    $src = Get-VerifiedLastGoodDir
    $restored = @()
    foreach ($f in @('settings.yaml','cordis.patch.yml','cordis.yml')) {
        $s = Join-Path $src $f
        if (-not (Test-Path $s)) { continue }
        $dst = switch ($f) {
            'settings.yaml' { "$env:USERPROFILE\.dsh\settings.yaml" }
            'cordis.patch.yml' { "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" }
            'cordis.yml' { "$env:USERPROFILE\.dsh\profiles\web\cordis.yml" }
        }
        Copy-Item $s $dst -Force
        $restored += $f
    }
    return @{ Restored = $restored; Count = $restored.Count }
}

function Get-VerifiedLastGoodMeta {
    $p = Join-Path (Get-VerifiedLastGoodDir) 'meta.json'
    if (-not (Test-Path $p)) { return $null }
    try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-GuardianLastGoodMeta {
    $p = Join-Path (Get-GuardianLastGoodDir) 'meta.json'
    if (-not (Test-Path $p)) { return $null }
    try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}
