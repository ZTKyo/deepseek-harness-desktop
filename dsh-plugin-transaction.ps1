# dsh-plugin-transaction.ps1 - Safe plugin install/update/remove with checkpoint+verify+rollback

param(
    [Parameter(Mandatory=$true)][string]$Action,  # install | update | remove | list
    [string]$Plugin = "",
    [string]$Profile = "web",
    [int]$Port = 3080
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'dsh-transaction.ps1')
. (Join-Path $root 'dsh-readiness.ps1')

function Invoke-PluginTransaction {
    param([string]$Action, [string]$Plugin, [string]$Profile, [int]$Port=3080)
    # 1. PREPARE: validate plugin name
    if($Action -in @('install','update','remove') -and [string]::IsNullOrWhiteSpace($Plugin)){
        return @{ Ok=$false; Error='plugin name required' }
    }
    # 2. CHECKPOINT
    $cp = New-DshTransactionCheckpoint -Label "plugin-$Action-$Plugin"
    Write-Host "Checkpoint: $($cp.dir)"

    # 3. APPLY: run pnpm via dsh plugin (forward to profile dir)
    # Note: dsh is a PowerShell wrapper (dsh.ps1), so invoke via &, not Start-Process.
    $pArgs = switch($Action){
        'install' { @('plugin','--profile',$Profile,'add',$Plugin) }
        'remove'  { @('plugin','--profile',$Profile,'remove',$Plugin) }
        'update'  { @('plugin','--profile',$Profile,'update',$Plugin) }
        default   { @() }
    }
    if($pArgs.Count -eq 0){ return @{ Ok=$false; Error='unknown action' } }
    Write-Host "Running: dsh $($pArgs -join ' ')"
    $out = & dsh @pArgs 2>&1
    $exitCode = $LASTEXITCODE
    if($out){ $out | ForEach-Object { Write-Host "  $_" } }
    if($exitCode -ne 0){
        Write-Host "Plugin command failed (exit $exitCode), rolling back"
        Restore-DshTransactionCheckpoint -CheckpointDir $cp.dir | Out-Null
        return @{ Ok=$false; Error="plugin command exit $exitCode"; RolledBack=$true }
    }
    # 4. VERIFY: YAML + readiness
    Start-Sleep -Seconds 3
    $health = Test-DshTransactionHealth -Port $Port -TimeoutSec 15
    if(-not $health.Ok){
        Write-Host "Health check failed, rolling back"
        Restore-DshTransactionCheckpoint -CheckpointDir $cp.dir | Out-Null
        return @{ Ok=$false; Error='health failed after plugin change'; RolledBack=$true; Health=$health }
    }
    # 5. COMMIT: save verified lastgood
    $vlg = Join-Path $root 'dsh-verified-lastgood.ps1'
    if(Test-Path $vlg){ . $vlg; Save-VerifiedLastGood -Port $Port -Reason "plugin-$Action-$Plugin" | Out-Null }
    return @{ Ok=$true; Checkpoint=$cp.dir }
}

# CLI entry
if($Action){
    $r = Invoke-PluginTransaction -Action $Action -Plugin $Plugin -Profile $Profile -Port $Port
    $r | ConvertTo-Json -Depth 3
    if(-not $r.Ok){ exit 1 }
}
