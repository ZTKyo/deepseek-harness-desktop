# dsh-safe-mode.ps1 - Safe Mode entry for DSH Harness
# When boot repeatedly fails, enter Safe Mode: minimal plugins, stable provider, trimmed patches.
# Safe Mode does NOT modify normal profile; it creates/uses a temporary safe composition.

param([switch]$Enter, [switch]$Exit, [switch]$Status)

$flagPath = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\safe-mode.json'
$settingsPath = "$env:USERPROFILE\.dsh\settings.yaml"
$patchPath = "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"

function Get-SafeModeStatus {
    if(Test-Path $flagPath){
        try { return (Get-Content $flagPath -Raw | ConvertFrom-Json) } catch { return @{ active=$true; raw=$true } }
    }
    return @{ active=$false }
}
if($Status){
    $s = Get-SafeModeStatus
    $s | ConvertTo-Json -Depth 3
    exit 0
}
if($Enter){
    $meta = @{ active=$true; enteredAt=(Get-Date -Format 'o'); reason='manual or boot-failure threshold'; dshVersion=((& dsh --version 2>$null) -join '').Trim() }
    # checkpoint current config before entering safe mode
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $cp = Join-Path $env:LOCALAPPDATA "DSHHarness\tx-checkpoints\pre-safe-mode-$ts"
    New-Item -ItemType Directory -Force -Path $cp | Out-Null
    foreach($f in @(@{Src=$settingsPath;Name='settings.yaml'},@{Src=$patchPath;Name='cordis.patch.yml'})){
        if(Test-Path $f.Src){ Copy-Item $f.Src (Join-Path $cp $f.Name) -Force }
    }
    $meta.checkpoint = $cp
    New-Item -ItemType Directory -Force -Path (Split-Path $flagPath) | Out-Null
    ($meta | ConvertTo-Json -Depth 3) | Out-File $flagPath -Encoding utf8
    Write-Host "Safe Mode ENTERED. Checkpoint: $cp"
    Write-Host "To restore: powershell -File dsh-safe-mode.ps1 -Exit"
    exit 0
}
if($Exit){
    if(-not (Test-Path $flagPath)){ Write-Host "Not in safe mode"; exit 0 }
    $meta = Get-Content $flagPath -Raw | ConvertFrom-Json
    if($meta.checkpoint -and (Test-Path $meta.checkpoint)){
        foreach($n in @('settings.yaml','cordis.patch.yml')){
            $s = Join-Path $meta.checkpoint $n
            $d = if($n -eq 'settings.yaml'){ $settingsPath } else { $patchPath }
            if(Test-Path $s){ Copy-Item $s $d -Force; Write-Host "Restored $n" }
        }
    }
    Remove-Item $flagPath -Force -ErrorAction SilentlyContinue
    Write-Host "Safe Mode EXITED. Config restored. Restart DSH to apply."
    exit 0
}
# default: show status
Get-SafeModeStatus | ConvertTo-Json -Depth 3
