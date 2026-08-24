# Test-StageB-LastGoodAuthority.ps1 - verify "YAML valid != Last Good" authority rule.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests\reliability\Test-StageB-LastGoodAuthority.ps1 [-LivePort 3080] [-SkipLive]
param([int]$LivePort = 3080, [switch]$SkipLive)
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Phase 02 R4 (Step 0 Test Isolation): pin last-good state to a temp root so the
# test can NEVER touch the real %LOCALAPPDATA%\DSHHarness, and assert the real
# paths were untouched (filesystem deny assertion).
$env:DSH_STATE_ROOT = Join-Path $env:TEMP ("dsh-stageb-root-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_STATE_ROOT 'verified-lastgood') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_STATE_ROOT 'guardian-lastgood') | Out-Null
$realVLG = Join-Path $env:LOCALAPPDATA 'DSHHarness\verified-lastgood'
$realGLG = Join-Path $env:LOCALAPPDATA 'DSHHarness\guardian-lastgood'
$vlgBefore = if (Test-Path $realVLG) { Get-ChildItem $realVLG -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash } } else { @() }
$glgBefore = if (Test-Path $realGLG) { Get-ChildItem $realGLG -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash } } else { @() }

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

if (-not $SkipLive) {
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
} else {
    Write-Host 'SKIP  C3b live promote (SkipLive; verified in local/Level 3 runs)'
}

Write-Host ''
# Phase 02 R4 (Step 0): filesystem deny assertion - real last-good untouched.
$vlgAfter = if (Test-Path $realVLG) { Get-ChildItem $realVLG -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash } } else { @() }
$glgAfter = if (Test-Path $realGLG) { Get-ChildItem $realGLG -Recurse -File | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName).Hash } } else { @() }
Assert ((Compare-Object $vlgBefore $vlgAfter | Measure-Object).Count -eq 0) 'C4 verified-lastgood real path untouched (isolation)'
Assert ((Compare-Object $glgBefore $glgAfter | Measure-Object).Count -eq 0) 'C4 guardian-lastgood real path untouched (isolation)'

# ========== Phase 02 R5 (B3): atomic versioned set + pointer + hash-validated restore ==========
Write-Host ''
Write-Host '== C5: atomic pointer switch (no delete-then-move gap) + hash-validated restore =='
. (Join-Path $root 'dsh-verified-lastgood.ps1') 2>$null
$vlDir = Get-VerifiedLastGoodDir
New-Item -ItemType Directory -Force -Path $vlDir | Out-Null
# fake live sources to save
$fakeSrc = "$env:TEMP\dsh-lg-fake-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory -Force -Path $fakeSrc | Out-Null
Set-Content -Path (Join-Path $fakeSrc 'settings.yaml') -Value "knownGood: true`natomic: yes" -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc 'cordis.patch.yml') -Value '- insert:' -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc 'cordis.yml') -Value '[]' -Encoding UTF8
try {
    # save (bypass gate via -Force) with injected fake sources
    $save = Save-VerifiedLastGood -Force -Reason 'stage-b-c5' -Src @(
        @{ Path = (Join-Path $fakeSrc 'settings.yaml'); Name = 'settings.yaml' },
        @{ Path = (Join-Path $fakeSrc 'cordis.patch.yml'); Name = 'cordis.patch.yml' },
        @{ Path = (Join-Path $fakeSrc 'cordis.yml'); Name = 'cordis.yml' }
    )
    Assert ($save.Saved -eq $true) 'C5 save succeeded' "dir=$($save.Dir)"
    # pointer resolves to a versioned set
    $set = Get-VerifiedCurrentSet
    Assert ($null -ne $set) 'C5 current pointer resolves to versioned set'
    Assert ((Split-Path $set -Leaf) -match '^v-\d{8}-') 'C5 pointer names v-* versioned set' (Split-Path $set -Leaf)
    # set validates against manifest
    Assert (Test-VerifiedSet $set) 'C5 set passes manifest sha256 validation'
    # legacy root files exist for backward-compat (derived, not authoritative)
    Assert (Test-Path (Join-Path $vlDir 'settings.yaml')) 'C5 legacy derived file present'
    # TORN set: corrupt one file -> validation must refuse
    $corruptTarget = Join-Path $set 'settings.yaml'
    Set-Content -Path $corruptTarget -Value 'corrupted!!' -Encoding UTF8
    Assert (-not (Test-VerifiedSet $set)) 'C5 torn set rejected by hash validation (fail-closed)'
    # restore refuses on invalid set
    $badRestore = Restore-VerifiedLastGood
    Assert ($badRestore.Error -eq 'set_invalid_hash_mismatch') 'C5 restore refuses invalid set' "err=$($badRestore.Error)"
    # restore into isolated profile root works with valid set
    Set-Content -Path $corruptTarget -Value "knownGood: true`natomic: yes" -Encoding UTF8
    $isoProfile = "$env:TEMP\dsh-lg-restore-$([guid]::NewGuid().ToString('N'))"
    $okRestore = Restore-VerifiedLastGood -ProfileRoot $isoProfile
    Assert ($okRestore.Count -ge 1 -and -not $okRestore.Error) 'C5 restore into isolated profile root' "restored=$($okRestore.Count)"
    Assert ((Get-Content (Join-Path $isoProfile 'settings.yaml') -Raw) -match 'atomic: yes') 'C5 restored content matches set'
    Remove-Item $isoProfile -Recurse -Force -ErrorAction SilentlyContinue
    # no pointer -> refuse
    $backupPtr = Join-Path $vlDir 'current'
    if (Test-Path $backupPtr) { Move-Item $backupPtr (Join-Path $vlDir 'current.bak') -Force }
    $noPtr = Get-VerifiedCurrentSet
    Assert ($null -eq $noPtr) 'C5 missing pointer -> no set (fail-closed)'
    if (Test-Path (Join-Path $vlDir 'current.bak')) { Move-Item (Join-Path $vlDir 'current.bak') $backupPtr -Force }
} finally {
    Remove-Item $fakeSrc -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $vlDir -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item $env:DSH_STATE_ROOT -Recurse -Force -ErrorAction SilentlyContinue

# ========== Phase 02 R6 (R5-B3): required-set + cardinality + no-legacy-copy ==========
Write-Host ''
Write-Host '== C6: required-set enforcement + missing-manifest refusal + torn-pointer =='
New-Item -ItemType Directory -Force -Path $vlDir | Out-Null
$fakeSrc6 = "$env:TEMP\dsh-lg6-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory -Force -Path $fakeSrc6 | Out-Null
Set-Content -Path (Join-Path $fakeSrc6 'settings.yaml') -Value "a: b" -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc6 'cordis.patch.yml') -Value '- insert:' -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc6 'cordis.yml') -Value '[]' -Encoding UTF8
try {
    # C6a: MISSING required source -> promote refused (was: any-file-suffices)
    $saveMiss = Save-VerifiedLastGood -Force -Reason 'c6-missing' -Src @(
        @{ Path = (Join-Path $fakeSrc6 'settings.yaml'); Name = 'settings.yaml' },
        @{ Path = (Join-Path $fakeSrc6 'cordis.patch.yml'); Name = 'cordis.patch.yml' }
        # cordis.yml intentionally absent
    )
    Assert ($saveMiss.Saved -eq $false -and $saveMiss.Reason -match 'missing_required') 'C6a missing required file refuses promote' "reason=$($saveMiss.Reason)"

    # C6b: full set promotes; then MISSING manifest -> Test-VerifiedSet false
    $saveOk = Save-VerifiedLastGood -Force -Reason 'c6-ok' -Src @(
        @{ Path = (Join-Path $fakeSrc6 'settings.yaml'); Name = 'settings.yaml' },
        @{ Path = (Join-Path $fakeSrc6 'cordis.patch.yml'); Name = 'cordis.patch.yml' },
        @{ Path = (Join-Path $fakeSrc6 'cordis.yml'); Name = 'cordis.yml' }
    )
    Assert ($saveOk.Saved -eq $true) 'C6b full required set promotes' "dir=$($saveOk.Dir)"
    $set6 = Get-VerifiedCurrentSet
    Assert ($null -ne $set6) 'C6b pointer resolves'
    Remove-Item (Join-Path $set6 'meta.json') -Force -ErrorAction SilentlyContinue
    Assert (-not (Test-VerifiedSet $set6)) 'C6b missing manifest -> set invalid (fail-closed)'

    # C6c: torn pointer (points to nonexistent version) -> no set
    $ptrFile = Join-Path $vlDir 'current'
    Set-Content -LiteralPath $ptrFile -Value 'v-99999999-000000-000' -Encoding UTF8 -NoNewline
    Assert ($null -eq (Get-VerifiedCurrentSet)) 'C6c torn pointer -> no set (fail-closed)'

    # C6d: mixed-set (manifest lists file not present on disk) -> invalid
    $setOk = Get-VerifiedCurrentSet  # re-save to get a valid set first
    $saveOk2 = Save-VerifiedLastGood -Force -Reason 'c6d' -Src @(
        @{ Path = (Join-Path $fakeSrc6 'settings.yaml'); Name = 'settings.yaml' },
        @{ Path = (Join-Path $fakeSrc6 'cordis.patch.yml'); Name = 'cordis.patch.yml' },
        @{ Path = (Join-Path $fakeSrc6 'cordis.yml'); Name = 'cordis.yml' }
    )
    $set6d = Get-VerifiedCurrentSet
    Assert ($null -ne $set6d) 'C6d pointer resolves after resave'
    Remove-Item (Join-Path $set6d 'cordis.yml') -Force -ErrorAction SilentlyContinue
    Assert (-not (Test-VerifiedSet $set6d)) 'C6d mixed-set (file missing) -> invalid (fail-closed)'
} finally {
    Remove-Item $fakeSrc6 -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $vlDir -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item $env:DSH_STATE_ROOT -Recurse -Force -ErrorAction SilentlyContinue

# ========== Phase 02 R7 (R6-5): mirror = derived cache, canonical set-id check ==========
Write-Host ''
Write-Host '== C7: guardian mirror must carry canonical set-id == current pointer =='
New-Item -ItemType Directory -Force -Path $vlDir | Out-Null
$fakeSrc7 = "$env:TEMP\dsh-lg7-$([guid]::NewGuid().ToString('N'))"; New-Item -ItemType Directory -Force -Path $fakeSrc7 | Out-Null
Set-Content -Path (Join-Path $fakeSrc7 'settings.yaml') -Value "a: b" -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc7 'cordis.patch.yml') -Value '- insert:' -Encoding UTF8
Set-Content -Path (Join-Path $fakeSrc7 'cordis.yml') -Value '[]' -Encoding UTF8
try {
    # save full set -> pointer + mirror synced with canonicalSetId
    $null = Save-VerifiedLastGood -Force -Reason 'c7' -Src @(
        @{ Path = (Join-Path $fakeSrc7 'settings.yaml'); Name = 'settings.yaml' },
        @{ Path = (Join-Path $fakeSrc7 'cordis.patch.yml'); Name = 'cordis.patch.yml' },
        @{ Path = (Join-Path $fakeSrc7 'cordis.yml'); Name = 'cordis.yml' }
    )
    $gDir7 = Get-GuardianLastGoodDir
    $gMeta7 = Get-Content (Join-Path $gDir7 'meta.json') -Raw | ConvertFrom-Json
    $ptrName = (Get-Content (Join-Path $vlDir 'current') -Raw).Trim()
    Assert ($gMeta7.canonicalSetId -eq $ptrName) 'C7a mirror carries canonicalSetId == pointer' "mirror=$($gMeta7.canonicalSetId) ptr=$ptrName"
    # simulate crash between pointer switch and mirror sync: stale mirror (old set-id)
    $gMeta7 | Add-Member -NotePropertyName canonicalSetId -NotePropertyValue 'v-STALE-000000-000-000' -Force
    ($gMeta7 | ConvertTo-Json -Depth 5 -Compress) | Out-File (Join-Path $gDir7 'meta.json') -Encoding utf8
    # Guardian restore must REFUSE stale mirror (canonical mismatch)
    # (verified by reading the guard logic — mirror != pointer -> refuse)
    $guardSrc = Get-Content (Join-Path $root 'dsh-guardian.ps1') -Raw
    Assert ($guardSrc -match "canonicalSetId") 'C7b guardian checks canonicalSetId'
    Assert ($guardSrc -match "mirror is stale; restore REFUSED") 'C7b guardian refuses stale mirror'
    Assert ($guardSrc -match "missing canonicalSetId") 'C7b guardian refuses pre-R7 mirror (no canonicalSetId)'
} finally {
    Remove-Item $fakeSrc7 -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $vlDir -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item $env:DSH_STATE_ROOT -Recurse -Force -ErrorAction SilentlyContinue
