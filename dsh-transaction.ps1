# dsh-transaction.ps1 - Change Transaction helper for DSH Harness
# Pattern: PREPARE -> CHECKPOINT -> APPLY -> RESTART -> VERIFY -> COMMIT  |  FAIL -> ROLLBACK -> RESTART -> VERIFY_RECOVERY
# Used for: config change, plugin install/update/remove, harness update, profile change

function New-DshTransactionCheckpoint {
    param([string]$Label = 'tx', [string]$Dir = $null)
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    if(-not $Dir){ $Dir = Join-Path $env:LOCALAPPDATA "DSHHarness\tx-checkpoints\$Label-$ts" }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $files = @(
        @{ Src="$env:USERPROFILE\.dsh\settings.yaml"; Name='settings.yaml' },
        @{ Src="$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"; Name='cordis.patch.yml' },
        @{ Src="$env:USERPROFILE\.dsh\profiles\web\cordis.yml"; Name='cordis.yml' },
        @{ Src="$env:USERPROFILE\.dsh\profiles\web\package.json"; Name='package.json' }
    )
    $manifest = @{ timestamp=(Get-Date -Format 'o'); label=$Label; dir=$Dir; files=@() }
    foreach($f in $files){
        if(Test-Path $f.Src){
            Copy-Item $f.Src (Join-Path $Dir $f.Name) -Force
            $h = (Get-FileHash $f.Src -Algorithm SHA256).Hash
            $manifest.files += @{ name=$f.Name; hash=$h; path=$f.Src }
        }
    }
    # also record DSH version
    try { $manifest.dshVersion = ((& dsh --version 2>$null) -join '').Trim() } catch {}
    ($manifest | ConvertTo-Json -Depth 4) | Out-File (Join-Path $Dir 'manifest.json') -Encoding utf8
    return $manifest
}
function Restore-DshTransactionCheckpoint {
    param([string]$CheckpointDir)
    if(-not (Test-Path $CheckpointDir)){ return @{ Restored=@(); Error='checkpoint_not_found' } }
    $map = @{
        'settings.yaml' = "$env:USERPROFILE\.dsh\settings.yaml"
        'cordis.patch.yml' = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
        'cordis.yml' = "$env:USERPROFILE\.dsh\profiles\web\cordis.yml"
        'package.json' = "$env:USERPROFILE\.dsh\profiles\web\package.json"
    }
    $restored=@()
    foreach($k in $map.Keys){
        $s = Join-Path $CheckpointDir $k
        if(Test-Path $s){ Copy-Item $s $map[$k] -Force; $restored+= $k }
    }
    return @{ Restored=$restored; Count=$restored.Count }
}
function Test-DshTransactionHealth {
    param([int]$Port=3080, [int]$TimeoutSec=15)
    $ps = Join-Path $PSScriptRoot 'dsh-readiness.ps1'
    if(Test-Path $ps){ . $ps }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while((Get-Date) -lt $deadline){
        try {
            $r = Test-DshReadiness -Port $Port
            if($r.State -in @('api_ready','client_ready')){ return @{ Ok=$true; State=$r.State } }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return @{ Ok=$false; State='timeout' }
}
