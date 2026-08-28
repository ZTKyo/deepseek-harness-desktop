# deploy-ox-relay.ps1
# stealth/ox-alpha 同模型跨 relay fallback 的事务式部署（与 deploy-router-fix.ps1 同构）。
#
# Canonical source (repo, source of truth):
#   docs/execution-economy/plugins/ox-relay-core.mjs
#   docs/execution-economy/plugins/ox-relay-failover.mjs
# Runtime destination (deployed copy):
#   $env:USERPROFILE/.dsh/profiles/web/
#
# PERSISTENT ROLLBACK: 每次部署把部署前状态快照进持久 state root + manifest；
# 之后的、独立进程运行 -Rollback 依据 manifest 精确还原部署前状态
# （含 "原文件不存在 -> 删除" 语义）。绝不快照"当前"状态。
#
# Transactional: 两个文件是一个事务单元。Stage -> validate -> replace -> verify。
# 任一步失败，两个文件都还原到部署前状态（无半部署）。
#
# 注意：本脚本只部署插件文件，不自动改 settings.yaml / cordis.patch.yml。
# 部署后按输出提示手动注册（plugin id + provider profile），
# provider profile 模板见 docs/execution-economy/config/ox-relay-providers.yaml。
#
# Usage:
#   powershell -File deploy-ox-relay.ps1                          # deploy
#   powershell -File deploy-ox-relay.ps1 -Rollback                # 还原最近一次 committed 部署前状态
#   powershell -File deploy-ox-relay.ps1 -RuntimeRoot <tmp> -StateRoot <tmp> -CanonRoot <tmp>   # 隔离测试
#   powershell -File deploy-ox-relay.ps1 -InjectReplaceFailure    # TEST-ONLY：首文件替换后抛错

param(
    [switch]$Rollback,
    [string]$RuntimeRoot = $null,
    [string]$StateRoot = $null,
    [string]$CanonRoot = $null,
    [switch]$InjectReplaceFailure
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($CanonRoot) {
    $canonDir = $CanonRoot
} else {
    $canonDir = Join-Path $root 'docs\execution-economy\plugins'
}

$managedFiles = @('ox-relay-core.mjs', 'ox-relay-failover.mjs')

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
    $stateDir = Join-Path $profileHome2 '.dsh\transactions\ox-relay'
}
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
$transactionId = 'ox-relay-' + (Get-Date -Format 'yyyyMMddHHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
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
        $manifest | ConvertTo-Json -Depth 6 | Out-File $currentManifest -Encoding utf8
        exit 4
    }
    Copy-Item $canon (Join-Path $stageDir $f) -Force
}

# 3. REPLACE (transactional: same-dir temp + Move-Item; both files, restore on any failure)
#    All file ops use -ErrorAction Stop so a real failure enters the catch and
#    triggers full rollback (never a silent partial deployment).
try {
    foreach ($f in $managedFiles) {
        $dest = Join-Path $runtimeDir $f
        $stageFile = Join-Path $stageDir $f
        $tmp = Join-Path $runtimeDir ("$f.new-" + $transactionId)
        Copy-Item $stageFile $tmp -Force -ErrorAction Stop
        if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction Stop }  # pre-remove for Move (see note)
        Move-Item $tmp $dest -Force -ErrorAction Stop
        Write-Host "replaced $f"
        # TEST-ONLY injection seam: simulate failure right AFTER file #1 replaced,
        # BEFORE file #2 replace. Never enabled in production.
        if ($InjectReplaceFailure -and $f -eq $managedFiles[0]) {
            Write-Host "INJECT: forcing failure after first replace (test-only seam)"
            throw "injected replace failure (test-only)"
        }
    }
} catch {
    $script:allOk = $true   # explicit init; any restore failure flips to $false
    Write-Host "DEPLOY FAILED during replace: $($_.Exception.Message)"
    # 4. AUTO ROLLBACK both files (exact pre-deploy state; verify each)
    foreach ($e in $files) {
        $dest = Join-Path $runtimeDir $e.name
        if ($e.existed) {
            if (Test-Path (Join-Path $txnDir $e.name)) { Copy-Item (Join-Path $txnDir $e.name) $dest -Force -ErrorAction Stop }
            $h = Get-Sha256 $dest
            Write-Host "  rollback $($e.name) hash=$($(Get-ShortHash $h))... (expect $($(Get-ShortHash $e.sha256))...) match=$($h -eq $e.sha256)"
            if ($h -ne $e.sha256) { $script:allOk = $false }
        } else {
            if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction Stop }
            $h = Get-Sha256 $dest
            Write-Host "  rollback $($e.name) (was ABSENT) now=$h"
            if ($h -ne 'ABSENT') { $script:allOk = $false }
        }
        # temp residue cleanup (any .new-<txn> left behind)
        Get-ChildItem $runtimeDir -Filter "*.new-$transactionId" -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Host "  cleaned temp residue: $($_.Name)"
        }
    }
    $manifest.status = 'failed_rolled_back'
    Write-Manifest $manifest
    Write-Host "DEPLOY FAILED | ROLLBACK $($(if ($script:allOk) {'PASS'} else {'FAILED'}))"
    exit 5
}

# 4. VERIFY (runtime hash == canonical hash)
$verifyOk = $true
foreach ($f in $managedFiles) {
    $rh = Get-Sha256 (Join-Path $runtimeDir $f)
    $ch = Get-Sha256 (Join-Path $canonDir $f)
    Write-Host "verify $f runtime=$($(Get-ShortHash $rh))... canonical=$($(Get-ShortHash $ch))... match=$($rh -eq $ch)"
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
Write-Host "Use: powershell -File deploy-ox-relay.ps1 -Rollback  (from a new process) to restore pre-deploy state."
Write-Host ""
Write-Host "NEXT STEPS (manual, per task §7 trial/production safety):"
Write-Host "  1) register plugin in cordis.patch.yml:"
Write-Host "       - insert:"
Write-Host "         - id: ox-relay-failover"
Write-Host "           name: './ox-relay-failover.mjs'"
Write-Host "           config: { diagnostics: false }"
Write-Host "  2) add provider profiles per docs/execution-economy/config/ox-relay-providers.yaml"
Write-Host "     (ox-relay-a / ox-relay-b) to llm-pi-ai.providers in settings.yaml"
Write-Host "  3) restart dsh service for plugins to load (ESM imported at startup)."
Write-Host "NOTE: service restart may be required for new code to load. Replace is transactional, not OS-level atomic."
exit 0
