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
    param([int]$Port = 3080, [string]$Reason = 'health-pass', [int]$StableWindowSec = 10, [switch]$SkipLightProbe, [switch]$Force, [object[]]$Src = $null)
    if (-not $Force) {
        $gate = Test-VerifiedLastGoodGate -Port $Port -StableWindowSec $StableWindowSec -SkipLightProbe:$SkipLightProbe
        if (-not $gate.Ready) {
            return @{ Saved = $false; Reason = 'commit_readiness_failed'; Gate = $gate }
        }
    }
    # Phase 02 R5 (B3): -Src allows tests to inject fake config sources (isolated
    # staging); production callers omit it and get the live profile files.
    # NOTE: use $srcList — PowerShell variables are case-insensitive, so $src
    # would clobber the $Src parameter.
    if (-not $Src) {
        $srcList = @(
            @{ Path = "$env:USERPROFILE\.dsh\settings.yaml"; Name = 'settings.yaml' },
            @{ Path = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"; Name = 'cordis.patch.yml' },
            @{ Path = "$env:USERPROFILE\.dsh\profiles\web\cordis.yml"; Name = 'cordis.yml' }
        )
    } else {
        $srcList = @()
        foreach ($s in $Src) { $srcList += @{ Path = $s.Path; Name = $s.Name } }
    }
    $dst = Get-VerifiedLastGoodDir
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $dshVer = ''
    try { $dshVer = ((& dsh --version 2>$null) -join '').Trim() } catch { $dshVer = '' }
    # Phase 02 R4 (Step 8): build the complete set in a STAGING dir first, with a
    # {path, sha256} manifest. Only after every file is staged do we atomically
    # switch the current pointer. A torn copy can never be mistaken for LastGood.
    $staging = Join-Path $dst ".staging-$PID"
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $manifest = @()
    $any = $false
    foreach ($f in $srcList) {
        if (Test-Path $f.Path) {
            $h = (Get-FileHash $f.Path -Algorithm SHA256).Hash
            Copy-Item $f.Path (Join-Path $staging $f.Name) -Force
            $manifest += @{ path = $f.Name; sha256 = $h }
            $any = $true
        }
    }
    if (-not $any) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue; return @{ Saved = $false; Reason = 'no_src_files' } }
    $meta = @{
        timestamp = (Get-Date -Format 'o')
        reason = $Reason
        port = $Port
        dshVersion = $dshVer
        gate = if ($gate) { $gate.Stage } else { 'forced' }
        manifest = $manifest
    }
    ($meta | ConvertTo-Json -Depth 5 -Compress) | Out-File (Join-Path $staging 'meta.json') -Encoding utf8
    # ATOMIC SWITCH: rename staging -> current (same volume, Move-Item is atomic-ish).
    # Remove stale current dir only after staging is fully written and meta validated.
    # Phase 02 R5 (B3): TRUE atomic switch — a versioned set dir + a small
    # current POINTER file replaced via Move-Item -Force (same volume, atomic
    # rename). There is NO delete-then-move gap: the pointer only ever names a
    # fully-written versioned set.
    $version = (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $versioned = Join-Path $dst ("v-" + $version)
    Move-Item $staging $versioned
    # pointer file: content = version dir NAME (not full path) for portability
    $ptrTmp = Join-Path $dst 'current.tmp'
    $versionName = Split-Path $versioned -Leaf
    Set-Content -LiteralPath $ptrTmp -Value $versionName -Encoding UTF8 -NoNewline
    Move-Item -LiteralPath $ptrTmp -Destination (Join-Path $dst 'current') -Force
    $current = $versioned
    # legacy paths for backward-compat readers that look in verified-lastgood root
    foreach ($f in $srcList) {
        $s = Join-Path $current $f.Name
        if (Test-Path $s) { Copy-Item $s (Join-Path $dst $f.Name) -Force }
    }
    (Get-Content (Join-Path $current 'meta.json') -Raw) | Out-File (Join-Path $dst 'meta.json') -Encoding utf8
    # cleanup old versioned sets (keep only the pointed set + immediate previous)
    Get-ChildItem $dst -Directory -Filter 'v-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    # sync the restore mirror (guardian-lastgood) - the ONLY legal writer
    $gDir = Get-GuardianLastGoodDir
    New-Item -ItemType Directory -Force -Path $gDir | Out-Null
    foreach ($f in $srcList) {
        $s = Join-Path $current $f.Name
        if (Test-Path $s) { Copy-Item $s (Join-Path $gDir $f.Name) -Force }
    }
    (Get-Content (Join-Path $current 'meta.json') -Raw) | Out-File (Join-Path $gDir 'meta.json') -Encoding utf8
    return @{ Saved = $true; Reason = $Reason; Dir = $current; Gate = if ($gate) { $gate.Stage } else { 'forced' } }
}

# Phase 02 R5 (B3): resolve the CURRENT pointer -> the exact versioned set it
# names. Returns the set dir (validated to exist) or $null.
function Get-VerifiedCurrentSet {
    $dst = Get-VerifiedLastGoodDir
    $ptr = Join-Path $dst 'current'
    if (-not (Test-Path $ptr)) { return $null }
    try {
        $versionName = (Get-Content $ptr -Raw).Trim()
        if (-not $versionName) { return $null }
        # safety: the pointer must name a v-* dir inside our root (no traversal)
        if ($versionName -notmatch '^v-[\d-]+$') { return $null }
        $set = Join-Path $dst $versionName
        if (-not (Test-Path $set)) { return $null }
        return $set
    } catch { return $null }
}

# Phase 02 R5 (B3): validate a set against its manifest — every manifest entry
# must exist with matching sha256; torn/hash-mismatch -> $false.
function Test-VerifiedSet([string]$SetDir) {
    $metaPath = Join-Path $SetDir 'meta.json'
    if (-not (Test-Path $metaPath)) { return $false }
    try {
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        if (-not $meta.manifest -or @($meta.manifest).Count -eq 0) { return $false }
        foreach ($entry in $meta.manifest) {
            $f = Join-Path $SetDir $entry.path
            if (-not (Test-Path $f)) { return $false }
            $h = (Get-FileHash $f -Algorithm SHA256).Hash
            if ($h -ne $entry.sha256) { return $false }
        }
        return $true
    } catch { return $false }
}

function Restore-VerifiedLastGood {
    <#
    .SYNOPSIS
    Restore the verified LastGood set to live config. Phase 02 R5 (B3): ONLY the
    current pointer's versioned set is authoritative — resolve pointer -> full
    set -> per-file sha256 validation -> restore once. Torn/hash-mismatch/missing
    pointer = refuse (fail-closed). Legacy root files are NOT a restore source.
    #>
    param([string]$ProfileRoot = $null)
    $set = Get-VerifiedCurrentSet
    if (-not $set) { return @{ Restored = @(); Error = 'no_current_pointer' } }
    if (-not (Test-VerifiedSet $set)) { return @{ Restored = @(); Error = 'set_invalid_hash_mismatch' } }
    $base = if ($ProfileRoot) { $ProfileRoot } else { (Join-Path $env:USERPROFILE '.dsh') }
    $map = @{
        'settings.yaml' = Join-Path $base 'settings.yaml'
        'cordis.patch.yml' = Join-Path $base 'profiles\web\cordis.patch.yml'
        'cordis.yml' = Join-Path $base 'profiles\web\cordis.yml'
    }
    $restored = @()
    foreach ($k in $map.Keys) {
        $s = Join-Path $set $k
        if (Test-Path $s) {
            $dstDir = Split-Path $map[$k]
            New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
            Copy-Item $s $map[$k] -Force
            $restored += $k
        }
    }
    return @{ Restored = $restored; Count = $restored.Count; Set = $set }
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
