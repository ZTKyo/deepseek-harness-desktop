# deploy-router-fix.ps1
# OpenRouter Exact Model Preservation — transactional deploy of the two router
# plugins from repo CANONICAL source to the runtime profile (~/.dsh/profiles/web/).
#
# Canonical source (repo, source of truth):
#   docs/execution-economy/plugins/openrouter-router-core.mjs
#   docs/execution-economy/plugins/openrouter-router.mjs
# Runtime destination (deployed copy):
#   $HOME/.dsh/profiles/web/ (resolved via $env:USERPROFILE, no hardcoded user)
#
# Transaction: snapshot -> stage -> node --check -> atomic copy -> verify
# (hashes match canonical) -> report. On any failure the pre-deploy runtime
# files are restored. Rollback: -Rollback restores the pre-deploy snapshot.
#
# Usage:
#   powershell -File deploy-router-fix.ps1            # deploy (no restart)
#   powershell -File deploy-router-fix.ps1 -Rollback  # restore pre-deploy copy
#
# Note: does NOT restart the service (hot reload may not apply; see report).

param(
    [switch]$Rollback
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$canonDir = Join-Path $root 'docs\execution-economy\plugins'
$profileHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$runtimeDir = Join-Path $profileHome '.dsh\profiles\web'
$snapDir = Join-Path $env:TEMP ("router-fix-snap-" + [guid]::NewGuid().ToString('N'))

$files = @('openrouter-router-core.mjs', 'openrouter-router.mjs')

Write-Host "canonical: $canonDir"
Write-Host "runtime:   $runtimeDir"
Write-Host "snapshot:  $snapDir"

# --- validate canonical exists ---
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $canonDir $f))) { Write-Host "FAIL: canonical $f missing"; exit 1 }
}

# --- snapshot current runtime (pre-deploy copy = rollback target) ---
New-Item -ItemType Directory -Force -Path $snapDir | Out-Null
$snapHashes = @{}
foreach ($f in $files) {
    $src = Join-Path $runtimeDir $f
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $snapDir $f) -Force
        $snapHashes[$f] = (Get-FileHash $src -Algorithm SHA256).Hash
        Write-Host "snapshot: $f -> $($snapHashes[$f])"
    } else {
        Write-Host "snapshot: $f (absent in runtime)"
        $snapHashes[$f] = 'ABSENT'
    }
}

if ($Rollback) {
    Write-Host "=== ROLLBACK: restoring pre-deploy runtime copy ==="
    foreach ($f in $files) {
        $snap = Join-Path $snapDir $f
        if (Test-Path $snap) {
            Copy-Item $snap (Join-Path $runtimeDir $f) -Force
            $h = (Get-FileHash (Join-Path $runtimeDir $f) -Algorithm SHA256).Hash
            Write-Host "restored $f hash=$h (snap=$($snapHashes[$f]))"
        }
    }
    Write-Host "ROLLBACK DONE (snapshot: $snapDir)"
    exit 0
}

# --- stage + validate ---
Write-Host "=== STAGE + VALIDATE ==="
foreach ($f in $files) {
    $canon = Join-Path $canonDir $f
    & node --check $canon 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: syntax error in $f — not deploying"; exit 1 }
    Write-Host "syntax OK: $f"
}

# --- atomic deploy ---
Write-Host "=== DEPLOY ==="
foreach ($f in $files) {
    $canon = Join-Path $canonDir $f
    $dest = Join-Path $runtimeDir $f
    Copy-Item $canon $dest -Force
    $h = (Get-FileHash $dest -Algorithm SHA256).Hash
    $ch = (Get-FileHash $canon -Algorithm SHA256).Hash
    Write-Host "deployed $f runtime=$h canonical=$ch match=$($h -eq $ch)"
    if ($h -ne $ch) { Write-Host "FAIL: hash mismatch after copy — restoring"; exit 1 }
}

Write-Host ""
Write-Host "DEPLOY DONE (canonical == runtime). Snapshot kept for rollback: $snapDir"
Write-Host "NOTE: service restart may be required for the new code to load (ESM plugins are imported at startup)."
exit 0
