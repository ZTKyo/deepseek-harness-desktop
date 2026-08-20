# dsh-plugin-transaction.ps1 - Safe plugin install/update/remove with checkpoint+verify+rollback

param(
    [Parameter(Mandatory=$true)][string]$Action,  # install | update | remove | list
    [string]$Plugin = "",
    [int]$Port = 3080
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'dsh-transaction.ps1')
. (Join-Path $root 'dsh-readiness.ps1')

function Invoke-PluginTransaction {
    param([string]$Action, [string]$Plugin, [int]$Port=3080)
    # 1. PREPARE: validate plugin name
    if($Action -in @('install','update','remove') -and [string]::IsNullOrWhiteSpace($Plugin)){
        return @{ Ok=$false; Error='plugin name required' }
    }
    # 2. CHECKPOINT
    $cp = New-DshTransactionCheckpoint -Label "plugin-$Action-$Plugin"
    Write-Host "Checkpoint: $($cp.dir)"

    # 3. APPLY: run pnpm via dsh plugin (forward to profile dir)
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    if(-not $dshCmd){ $dshCmd='dsh' }
    $pArgs = switch($Action){
        'install' { @('plugin','--profile','web','add',$Plugin) }
        'remove'  { @('plugin','--profile','web','remove',$Plugin) }
        'update'  { @('plugin','--profile','web','update',$Plugin) }
        default   { @() }
    }
    if($pArgs.Count -eq 0){ return @{ Ok=$false; Error='unknown action' } }
    Write-Host "Running: dsh $($pArgs -join ' ')"
    $proc = Start-Process -FilePath $dshCmd -ArgumentList $pArgs -Wait -PassThru -NoNewWindow
    if($proc.ExitCode -ne 0){
        Write-Host "Plugin command failed ($($proc.ExitCode)), rolling back"
        Restore-DshTransactionCheckpoint -CheckpointDir $cp.dir | Out-Null
        return @{ Ok=$false; Error="plugin command exit $($proc.ExitCode)"; RolledBack=$true }
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
    $r = Invoke-PluginTransaction -Action $Action -Plugin $Plugin -Port $Port
    $r | ConvertTo-Json -Depth 3
    if(-not $r.Ok){ exit 1 }
}
