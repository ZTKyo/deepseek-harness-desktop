# deploy-router-fix.ps1
# OpenRouter Exact Model Preservation 鈥?transactional deploy of the two router
# plugins from repo CANONICAL source to the runtime profile.
#
# Canonical source (repo, source of truth):
#   docs/execution-economy/plugins/openrouter-router-core.mjs
#   docs/execution-economy/plugins/openrouter-router.mjs
# Runtime destination (deployed copy):
#   $env:USERPROFILE/.dsh/profiles/web/  (no hardcoded user path)
#
# PERSISTENT ROLLBACK (fixed):
#   Every deploy snapshots the PRE-deploy runtime state into a persistent
#   state root with a manifest. A later, INDEPENDENT PowerShell process running
#   -Rollback reads the manifest, locates that snapshot, and restores the exact
#   pre-deploy state (including ABSENT files -> deletion). It never snapshots
#   "current" on a rollback invocation.
#
# Transactional multi-file deploy:
#   The two router files are one transaction unit. Stage -> validate -> replace
#   -> verify. If ANY step fails, BOTH files are restored to pre-deploy state
#   (no partial deployment).
#
# Replace semantics: same-directory temp file + Move-Item (transactional
# replace, NOT claimed as OS-level atomic rename).
#
# Usage:
#   powershell -File deploy-router-fix.ps1                 # deploy (persistent rollback point)
#   powershell -File deploy-router-fix.ps1 -Rollback       # restore last committed pre-deploy state
#   # Test isolation (CI / drills):
#   powershell -File deploy-router-fix.ps1 -RuntimeRoot <tmp\runtime> -StateRoot <tmp\state>
#   powershell -File deploy-router-fix.ps1 -Rollback -RuntimeRoot <tmp\runtime> -StateRoot <tmp\state>

param(
    [switch]$Rollback,
    [string]$RuntimeRoot = $null,   # test isolation: override runtime destination
    [string]$StateRoot = $null,     # test isolation: override persistent state root
    [string]$CanonRoot = $null      # test isolation: override canonical source (failure injection)
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($CanonRoot) {
    $canonDir = $CanonRoot
} else {
    $canonDir = Join-Path $root 'docs\execution-economy\plugins'
}

$managedFiles = @('openrouter-router-core.mjs', 'openrouter-router.mjs')

# --- path resolution (portable, no hardcoded user) ---
if ($RuntimeRoot) {
    $runtimeDir = $RuntimeRoot
} else {
    $profileHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $runtimeDir = Join-Path $profileHome '.dsh\profiles\web'
}
if ($StateRoot) {
    $stateDir = $StateRoot
} else {
    $profileHome2 = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $stateDir = Join-Path $profileHome2 '.dsh\transactions\router-fix'
}
$currentManifest = Join-Path $stateDir 'current.json'
$snapshotsDir = Join-Path $stateDir 'snapshots'

Write-Host "canonical: $canonDir"
Write-Host "runtime:   $runtimeDir"
Write-Host "state:     $stateDir"

# --- helpers ---
function Get-Sha256([string]$Path) {
    if (Test-Path $Path) { return (Get-FileHash $Path -Algorithm SHA256).Hash }
    return 'ABSENT'
}


function Get-ShortHash([string]$h) {
    if ([string]::IsNullOrEmpty($h) -or $h.Length -le 16) { return $h }
    return $h.Substring(0, 16)
}

function Test-ManagedFileSafe([string]$name) {
    return $managedFiles -contains $name
}

function Write-Manifest($m) {
    ($m | ConvertTo-Json -Depth 6) | Out-File $currentManifest -Encoding utf8
}

function Read-Manifest {
    if (-not (Test-Path $currentManifest)) { return $null }
    try { return (Get-Content $currentManifest -Raw | ConvertFrom-Json) } catch { return $null }
}

# --- validate canonical ---
foreach ($f in $managedFiles) {
    if (-not (Test-Path (Join-Path $canonDir $f))) { Write-Host "FAIL: canonical $f missing"; exit 1 }
}

# ================= ROLLBACK =================
if ($Rollback) {
    Write-Host "=== ROLLBACK (persistent) ==="
    $m = Read-Manifest
    if (-not $m) { Write-Host "ROLLBACK REFUSED: no committed manifest (state: $stateDir)"; exit 2 }
    if ($m.status -ne 'committed') { Write-Host "ROLLBACK REFUSED: last transaction status is '$($m.status)', not committed"; exit 2 }
    $txnDir = Join-Path $snapshotsDir $m.transaction_id
    if (-not (Test-Path $txnDir)) { Write-Host "ROLLBACK REFUSED: snapshot dir missing: $txnDir"; exit 2 }

    $allOk = $true
    foreach ($entry in @($m.files)) {
        $name = $entry.name
        if (-not (Test-ManagedFileSafe $name)) { Write-Host "ROLLBACK REFUSED: unmanaged filename '$name' in manifest"; exit 2 }
        $dest = Join-Path $runtimeDir $name
        $snap = Join-Path $txnDir $name
        if ($entry.existed) {
            if (-not (Test-Path $snap)) { Write-Host "ROLLBACK FAIL: snapshot file missing: $snap"; $allOk = $false; continue }
            Copy-Item $snap $dest -Force
            $h = Get-Sha256 $dest
            Write-Host "restored $name hash=$($(Get-ShortHash $h))... (expect $($(Get-ShortHash $entry.sha256))...) match=$($h -eq $entry.sha256)"
            if ($h -ne $entry.sha256) { $allOk = $false }
        } else {
            # pre-deploy was ABSENT -> delete the deployed file
            if (Test-Path $dest) { Remove-Item $dest -Force }
            $h = Get-Sha256 $dest
            Write-Host "removed $name (was ABSENT pre-deploy) now=$h"
            if ($h -ne 'ABSENT') { $allOk = $false }
        }
    }
    if ($allOk) {
        $m.status = 'rolled_back'
        Write-Manifest $m
        Write-Host "ROLLBACK_VERIFIED = PASS"
        exit 0
    } else {
        $m.status = 'rollback_failed'
        Write-Manifest $m
        Write-Host "ROLLBACK_VERIFIED = FAIL"
        exit 3
    }
}

# ================= DEPLOY =================
Write-Host "=== DEPLOY (transactional) ==="

# 1. SNAPSHOT pre-deploy state (persistent)
$transactionId = 'router-fix-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$txnDir = Join-Path $snapshotsDir $transactionId
New-Item -ItemType Directory -Force -Path $txnDir | Out-Null
$files = @()
foreach ($f in $managedFiles) {
    $src = Join-Path $runtimeDir $f
    $existed = Test-Path $src
    $hash = Get-Sha256 $src
    if ($existed) { Copy-Item $src (Join-Path $txnDir $f) -Force }
    $files += @{ name = $f; existed = $existed; sha256 = $hash; snapshot = (Join-Path $txnDir $f) }
    Write-Host "snapshot $f existed=$existed hash=$($(Get-ShortHash $hash))..."
}

$manifest = @{
    transaction_id = $transactionId
    created_at = (Get-Date -Format 'o')
    status = 'staged'
    canonical_dir = $canonDir
    runtime_dir = $runtimeDir
    files = $files
}

# 2. STAGE + VALIDATE (both files, before touching runtime)
$stageDir = Join-Path $txnDir 'stage'
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
foreach ($f in $managedFiles) {
    $canon = Join-Path $canonDir $f
    & node --check $canon 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "DEPLOY FAILED (syntax in $f)"; $manifest.status = 'failed'
        # rollback: nothing replaced yet, but restore snapshot anyway for consistency
        foreach ($e in $files) { if ($e.existed) { Copy-Item (Join-Path $txnDir $e.name) (Join-Path $runtimeDir $e.name) -Force } }
        Write-Manifest $manifest
        Write-Host "DEPLOY FAILED | ROLLBACK PASS (nothing was replaced)"; exit 4
    }
    Copy-Item $canon (Join-Path $stageDir $f) -Force
    Write-Host "stage OK: $f (syntax + copy)"
}

# 3. REPLACE (transactional: same-dir temp + Move-Item; both files, restore on any failure)
$replaced = @()
try {
    foreach ($f in $managedFiles) {
        $dest = Join-Path $runtimeDir $f
        $stageFile = Join-Path $stageDir $f
        $tmp = Join-Path $runtimeDir ("$f.new-" + $transactionId)
        Copy-Item $stageFile $tmp -Force
        if (Test-Path $dest) { Remove-Item $dest -Force }  # pre-remove for Move (see note)
        Move-Item $tmp $dest -Force
        $replaced += $f
        Write-Host "replaced $f"
    }
} catch {
    Write-Host "DEPLOY FAILED during replace: $($_.Exception.Message)"
    # 4. AUTO ROLLBACK both files
    foreach ($e in $files) {
        $dest = Join-Path $runtimeDir $e.name
        if ($e.existed) {
            if (Test-Path (Join-Path $txnDir $e.name)) { Copy-Item (Join-Path $txnDir $e.name) $dest -Force }
            $h = Get-Sha256 $dest
            Write-Host "  rollback $($e.name) hash=$($(Get-ShortHash $h))... (expect $($(Get-ShortHash $e.sha256))...) match=$($h -eq $e.sha256)"
            if ($h -ne $e.sha256) { $script:allOk = $false }
        } else {
            if (Test-Path $dest) { Remove-Item $dest -Force }
        }
    }
    $manifest.status = 'failed_rolled_back'
    Write-Manifest $manifest
    Write-Host "DEPLOY FAILED | ROLLBACK $($(if ($script:allOk) {'PASS'} else {'FAILED'}))"
    exit 5
}

# 5. VERIFY (runtime hash == canonical hash, both files)
$verifyOk = $true
foreach ($f in $managedFiles) {
    $rh = Get-Sha256 (Join-Path $runtimeDir $f)
    $ch = Get-Sha256 (Join-Path $canonDir $f)
    Write-Host "verify $f runtime=$($(Get-ShortHash $rh))... canonical=$($(Get-ShortHash $ch))... match=$($rh -eq $ch)"
    if ($rh -ne $ch) { $verifyOk = $false }
}
if (-not $verifyOk) {
    # 6. AUTO ROLLBACK both files
    foreach ($e in $files) {
        $dest = Join-Path $runtimeDir $e.name
        if ($e.existed) { Copy-Item (Join-Path $txnDir $e.name) $dest -Force }
        else { if (Test-Path $dest) { Remove-Item $dest -Force } }
    }
    $manifest.status = 'failed_rolled_back'
    Write-Manifest $manifest
    Write-Host "DEPLOY FAILED (hash mismatch) | ROLLBACK PASS"; exit 6
}

# 7. COMMIT
$manifest.status = 'committed'
Write-Manifest $manifest
Write-Host ""
Write-Host "DEPLOY_VERIFIED = PASS (runtime == canonical)"
Write-Host "Rollback point persisted: $txnDir (manifest: $currentManifest)"
Write-Host "Use: powershell -File deploy-router-fix.ps1 -Rollback  (from a new process) to restore pre-deploy state."
Write-Host "NOTE: service restart may be required for new code to load (ESM imported at startup). Replace is transactional, not OS-level atomic."
exit 0
