# deploy-p26-r1.ps1
# P2.6 R1 Failure Taxonomy V1 batch deploy - transactional deploy of the
# classifier chain plugins from repo CANONICAL source to the runtime profile.
#
# Canonical source (repo, source of truth):
#   plugins/failure-classifier-core.mjs   (Taxonomy V1 + R1 stream-network fix)
#   plugins/failure-classifier.mjs        (observation plugin, NEW file)
#   plugins/execution-continuity-core.mjs (taxonomy delegation + budgets)
#   plugins/model-registry.mjs            (required by new EC core)
# Runtime destination:
#   $env:USERPROFILE/.dsh/profiles/web/
#
# Same transactional design as deploy-router-fix.ps1:
#   persistent pre-deploy snapshot + manifest -> stage/validate (node --check)
#   -> replace (same-dir temp + Move-Item) -> verify hash -> commit.
#   Any failure restores the EXACT pre-deploy state (ABSENT files -> delete).
#
# Usage:
#   powershell -File deploy-p26-r1.ps1                 # deploy
#   powershell -File deploy-p26-r1.ps1 -Rollback       # restore pre-deploy state
param(
    [switch]$Rollback,
    [string]$RuntimeRoot = $null,
    [string]$StateRoot = $null,
    [string]$CanonRoot = $null
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($CanonRoot) { $canonDir = $CanonRoot } else { $canonDir = Join-Path $root 'plugins' }

$managedFiles = @(
    'failure-classifier-core.mjs',
    'failure-classifier.mjs',
    'execution-continuity-core.mjs',
    'execution-continuity.mjs',
    'model-registry.mjs',
    'openrouter-router.mjs'
)

$profileHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
if ($RuntimeRoot) { $runtimeDir = $RuntimeRoot } else { $runtimeDir = Join-Path $profileHome '.dsh\profiles\web' }
if ($StateRoot) { $stateDir = $StateRoot } else { $stateDir = Join-Path $profileHome '.dsh\transactions\p26-r1' }
$currentManifest = Join-Path $stateDir 'current.json'
$snapshotsDir = Join-Path $stateDir 'snapshots'

Write-Host "canonical: $canonDir"
Write-Host "runtime:   $runtimeDir"
Write-Host "state:     $stateDir"

function Get-Sha256([string]$Path) {
    if (Test-Path $Path) { return (Get-FileHash $Path -Algorithm SHA256).Hash }
    return 'ABSENT'
}
function Get-ShortHash([string]$h) {
    if ([string]::IsNullOrEmpty($h) -or $h.Length -le 16) { return $h }
    return $h.Substring(0, 16)
}
function Test-ManagedFileSafe([string]$name) { return $managedFiles -contains $name }
function Write-Manifest($m) { ($m | ConvertTo-Json -Depth 6) | Out-File $currentManifest -Encoding utf8 }
function Read-Manifest {
    if (-not (Test-Path $currentManifest)) { return $null }
    try { return (Get-Content $currentManifest -Raw | ConvertFrom-Json) } catch { return $null }
}

foreach ($f in $managedFiles) {
    if (-not (Test-Path (Join-Path $canonDir $f))) { Write-Host "FAIL: canonical $f missing"; exit 1 }
}

if ($Rollback) {
    Write-Host "=== ROLLBACK (persistent) ==="
    $m = Read-Manifest
    if (-not $m) { Write-Host "ROLLBACK REFUSED: no committed manifest"; exit 2 }
    if ($m.status -ne 'committed') { Write-Host "ROLLBACK REFUSED: last transaction status is '$($m.status)'"; exit 2 }
    $txnDir = Join-Path $snapshotsDir $m.transaction_id
    if (-not (Test-Path $txnDir)) { Write-Host "ROLLBACK REFUSED: snapshot dir missing"; exit 2 }
    $allOk = $true
    foreach ($entry in @($m.files)) {
        $name = $entry.name
        if (-not (Test-ManagedFileSafe $name)) { Write-Host "ROLLBACK REFUSED: unmanaged '$name'"; exit 2 }
        $dest = Join-Path $runtimeDir $name
        $snap = Join-Path $txnDir $name
        if ($entry.existed) {
            if (-not (Test-Path $snap)) { Write-Host "ROLLBACK FAIL: snapshot missing: $snap"; $allOk = $false; continue }
            Copy-Item $snap $dest -Force
            $h = Get-Sha256 $dest
            Write-Host "restored $name hash=$(Get-ShortHash $h) expect=$(Get-ShortHash $entry.sha256) match=$($h -eq $entry.sha256)"
            if ($h -ne $entry.sha256) { $allOk = $false }
        } else {
            if (Test-Path $dest) { Remove-Item $dest -Force }
            $h = Get-Sha256 $dest
            Write-Host "removed $name (was ABSENT pre-deploy) now=$h"
            if ($h -ne 'ABSENT') { $allOk = $false }
        }
    }
    if ($allOk) { $m.status = 'rolled_back'; Write-Manifest $m; Write-Host "ROLLBACK_VERIFIED = PASS"; exit 0 }
    else { $m.status = 'rollback_failed'; Write-Manifest $m; Write-Host "ROLLBACK_VERIFIED = FAIL"; exit 3 }
}

Write-Host "=== DEPLOY (transactional) ==="

# 1. SNAPSHOT pre-deploy state
$transactionId = 'p26-r1-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$txnDir = Join-Path $snapshotsDir $transactionId
New-Item -ItemType Directory -Force -Path $txnDir | Out-Null
$files = @()
foreach ($f in $managedFiles) {
    $src = Join-Path $runtimeDir $f
    $existed = Test-Path $src
    $hash = Get-Sha256 $src
    if ($existed) { Copy-Item $src (Join-Path $txnDir $f) -Force }
    $files += @{ name = $f; existed = $existed; sha256 = $hash; snapshot = (Join-Path $txnDir $f) }
    Write-Host "snapshot $f existed=$existed hash=$(Get-ShortHash $hash)"
}
$manifest = @{
    transaction_id = $transactionId
    created_at = (Get-Date -Format 'o')
    status = 'staged'
    canonical_dir = $canonDir
    runtime_dir = $runtimeDir
    files = $files
}

# 2. STAGE + VALIDATE (node --check each canonical file before touching runtime)
$stageDir = Join-Path $txnDir 'stage'
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
foreach ($f in $managedFiles) {
    $canon = Join-Path $canonDir $f
    & node --check $canon 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "DEPLOY FAILED (syntax in $f)"; $manifest.status = 'failed'; Write-Manifest $manifest
        exit 4
    }
    Copy-Item $canon (Join-Path $stageDir $f) -Force
    Write-Host "stage OK: $f (syntax + copy)"
}

# 3. REPLACE (transactional; restore on any failure)
$replaced = @()
try {
    foreach ($f in $managedFiles) {
        $dest = Join-Path $runtimeDir $f
        $stageFile = Join-Path $stageDir $f
        $tmp = Join-Path $runtimeDir ("$f.new-" + $transactionId)
        Copy-Item $stageFile $tmp -Force -ErrorAction Stop
        if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction Stop }
        Move-Item $tmp $dest -Force -ErrorAction Stop
        $replaced += $f
        Write-Host "replaced $f"
    }
} catch {
    $script:allOk = $true
    Write-Host "DEPLOY FAILED during replace: $($_.Exception.Message)"
    foreach ($e in $files) {
        $dest = Join-Path $runtimeDir $e.name
        if ($e.existed) {
            if (Test-Path (Join-Path $txnDir $e.name)) { Copy-Item (Join-Path $txnDir $e.name) $dest -Force -ErrorAction Stop }
            $h = Get-Sha256 $dest
            Write-Host "  rollback $($e.name) hash=$(Get-ShortHash $h) expect=$(Get-ShortHash $e.sha256) match=$($h -eq $e.sha256)"
            if ($h -ne $e.sha256) { $script:allOk = $false }
        } else {
            if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction Stop }
            $h = Get-Sha256 $dest
            Write-Host "  rollback $($e.name) (was ABSENT) now=$h"
            if ($h -ne 'ABSENT') { $script:allOk = $false }
        }
        Get-ChildItem $runtimeDir -Filter "*.new-$transactionId" -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Host "  cleaned temp residue: $($_.Name)"
        }
    }
    $manifest.status = 'failed_rolled_back'
    Write-Manifest $manifest
    Write-Host "DEPLOY FAILED | ROLLBACK $(if ($script:allOk) {'PASS'} else {'FAILED'})"
    exit 5
}

# 4. VERIFY (runtime hash == canonical hash)
$verifyOk = $true
foreach ($f in $managedFiles) {
    $rh = Get-Sha256 (Join-Path $runtimeDir $f)
    $ch = Get-Sha256 (Join-Path $canonDir $f)
    Write-Host "verify $f runtime=$(Get-ShortHash $rh) canonical=$(Get-ShortHash $ch) match=$($rh -eq $ch)"
    if ($rh -ne $ch) { $verifyOk = $false }
}
if (-not $verifyOk) {
    foreach ($e in $files) {
        $dest = Join-Path $runtimeDir $e.name
        if ($e.existed) { Copy-Item (Join-Path $txnDir $e.name) $dest -Force -ErrorAction Stop }
        else { if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction Stop } }
    }
    $manifest.status = 'failed_rolled_back'
    Write-Manifest $manifest
    Write-Host "DEPLOY FAILED (hash mismatch) | ROLLBACK PASS"; exit 6
}

# 5. COMMIT
$manifest.status = 'committed'
Write-Manifest $manifest
Write-Host ""
Write-Host "DEPLOY_VERIFIED = PASS (runtime == canonical)"
Write-Host "Rollback point persisted: $txnDir (manifest: $currentManifest)"
Write-Host "Use: powershell -File deploy-p26-r1.ps1 -Rollback  (from a new process)"
exit 0
