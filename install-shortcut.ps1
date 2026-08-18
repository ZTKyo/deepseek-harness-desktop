# install-shortcut.ps1 - creates Desktop shortcuts for DSH Harness.
#
# Usage (run from the DSH-Client folder):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1            # [默认] PS 原生感客户端 (SAC 安全, 推荐)
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1 -PS
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1 -EdgeMode  # Edge 应用模式客户端
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1 -Native    # 原生 exe (需关闭 SAC 或已签名)
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1 -All       # 全部三个
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1 -PS -ShortcutName "DSH" -StartMenu
param(
    [switch]$PS,                       # PowerShell 原生感客户端 (SAC 安全, 推荐)
    [switch]$EdgeMode,                 # Edge 应用模式客户端 (SAC 安全)
    [switch]$Native,                   # 原生 exe (需关闭 SAC 或已签名)
    [switch]$All,                      # 全部创建
    [string]$ShortcutName = "DeepSeek Harness",
    [switch]$Desktop  = $true,
    [switch]$StartMenu = $false
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico  = Join-Path $root 'DeepSeek Whale.ico'
$cmdPS = Join-Path $root 'DSH Harness PS.cmd'
$exe  = Join-Path $root 'DSH Harness.exe'
$cmd  = Join-Path $root 'DSH Harness.cmd'

$wantPS      = $All -or $PS -or (-not ($PS -or $EdgeMode -or $Native -or $All))
$wantEdge    = $All -or $EdgeMode
$wantNative  = $All -or $Native

if ($wantPS -and -not (Test-Path $cmdPS)) { throw "not found: $cmdPS" }
if ($wantEdge -and -not (Test-Path $cmd))    { throw "not found: $cmd" }
if ($wantNative -and -not (Test-Path $exe))  { throw "not found: $exe (run build.ps1 first)" }

$ws = New-Object -ComObject WScript.Shell
$dirs = @()
if ($Desktop)   { $dirs += [Environment]::GetFolderPath('Desktop') }
if ($StartMenu) { $dirs += [Environment]::GetFolderPath('Programs') }

foreach ($d in $dirs) {
    if ($wantPS) {
        $lnk = Join-Path $d "$ShortcutName.lnk"
        $sc = $ws.CreateShortcut($lnk)
        # Target the .cmd directly (no powershell+args in the shortcut, so antivirus
        # heuristics like HEUR:Trojan/LNK.Agent.b do not false-positive on it).
        $sc.TargetPath       = $cmdPS
        $sc.Arguments        = ''
        $sc.WorkingDirectory = $root
        $sc.IconLocation     = "$ico,0"
        $sc.Description      = 'DSH Harness client (PowerShell 原生感, 自动拉起 dsh web 服务)'
        $sc.Save()
        Write-Host "created (PS 原生感): $lnk" -ForegroundColor Green
    }
    if ($wantEdge) {
        $lnk = Join-Path $d "$ShortcutName (Edge).lnk"
        $sc = $ws.CreateShortcut($lnk)
        # Target the .cmd directly (no cmd.exe /c with arguments in the shortcut).
        $sc.TargetPath       = $cmd
        $sc.Arguments        = ''
        $sc.WorkingDirectory = $root
        $sc.IconLocation     = "$ico,0"
        $sc.Description      = 'DSH Harness client (Edge 应用模式, 自动拉起 dsh web 服务)'
        $sc.Save()
        Write-Host "created (Edge 模式): $lnk" -ForegroundColor Green
    }
    if ($wantNative) {
        $lnk = Join-Path $d "$ShortcutName (原生).lnk"
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath       = $exe
        $sc.WorkingDirectory = $root
        $sc.IconLocation     = "$exe,0"
        $sc.Description      = 'DSH Harness native client (WebView2; Smart App Control 需关闭或已签名)'
        $sc.Save()
        Write-Host "created (原生 exe): $lnk" -ForegroundColor Green
    }
}
if ($dirs.Count -eq 0) { Write-Host 'no targets requested (use -Desktop and/or -StartMenu)' -ForegroundColor Yellow }
Write-Host "Tip: client data lives in %LOCALAPPDATA%\DSHHarness (WebView2PS for the PS client, EdgeProfile for Edge mode, WebView2 for native)."
