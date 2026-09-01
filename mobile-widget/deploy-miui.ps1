# DSH Watchdog Widget - MIUI 部署 + 特殊权限修复（一键）
# 用法: pwsh -File mobile-widget\deploy-miui.ps1 [-Serial 设备序列] [-Pin=false]
#
# 背景（根因 2026-09 实机验证）：
#   MIUI launcher 的 hasAddShortcutPermission 不检查 manifest 的 INSTALL_SHORTCUT 权限，
#   而是检查 AppOps 的 MIUI 自定义 op 10017（OP_INSTALL_SHORTCUT = "主屏幕快捷方式"）。
#   op 10017 默认 = ignore，导致即使 INSTALL_SHORTCUT granted=true 仍报 "has no permission"。
#   修复: adb shell cmd appops set <pkg> 10017 allow
#   验证: dumpsys appwidget 显示 host=com.miui.home + provider=WatchdogWidgetProvider
#         + 真实 RemoteViews 绑定实例（widget 真正出现在 MIUI 桌面）。
param(
    [string]$Serial = '',
    [switch]$Pin = $true       # 默认部署后自动点「添加到桌面」触发 pin
)
$ErrorActionPreference = 'Stop'

# --- adb 定位 ---
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }

$pkg = 'com.dsh.watchdog.widget'
$apk = Join-Path $PSScriptRoot 'dsh-watchdog-widget.apk'
if (-not (Test-Path $apk)) { throw "APK not found: $apk (先运行 build.ps1)" }

function Invoke-Adb([string]$args) {
    if ($Serial) { & $adb -s $Serial $args.Split(' ') }
    else { & $adb $args.Split(' ') }
}

Write-Host "== 1/4 安装 APK =="
Invoke-Adb "install -r $apk"

Write-Host "== 2/4 授予 manifest 权限（INSTALL_SHORTCUT / POST_NOTIFICATIONS 等） =="
foreach ($p in @(
    'com.android.launcher.permission.INSTALL_SHORTCUT',
    'com.android.launcher.permission.INSTALL_SHORTCUT'  # 冗余无害
)) {
    Invoke-Adb "shell pm grant $pkg $p" 2>&1 | Out-Null
}
# MIUI 权限是运行时授予，走一次 appops 兜底
Invoke-Adb "shell appops set $pkg INSTALL_SHORTCUT allow" 2>&1 | Out-Null

Write-Host "== 3/4 修复 MIUI「主屏幕快捷方式」特殊权限 (AppOps 10017) =="
Invoke-Adb "shell cmd appops set $pkg 10017 allow"
$chk = Invoke-Adb "shell appops get $pkg"
Write-Host "--- 当前 op 10017 状态 ---"
$chk | Select-String -Pattern '10017' | ForEach-Object { $_.Line.Trim() }

Write-Host "== 4/4 唤起应用 =="
Invoke-Adb "shell am force-stop $pkg"
Invoke-Adb "shell monkey -p $pkg -c android.intent.category.LAUNCHER 1" | Select-String 'Events injected'

if ($Pin) {
    Start-Sleep -Seconds 4
    Write-Host "== 可选：自动点「添加到桌面」按钮 =="
    # 等待并点击 btnPinWidget（bounds 中心约 600,1200，随分辨率变化）
    Invoke-Adb "shell uiautomator dump /sdcard/ui_pin.xml" | Out-Null
    $xml = Invoke-Adb "shell cat /sdcard/ui_pin.xml"
    $m = [regex]::Match($xml, 'resource-id="com\.dsh\.watchdog\.widget:id/btnPinWidget"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if ($m.Success) {
        $cx = ([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2
        $cy = ([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2
        Write-Host "点击 btnPinWidget at ($cx,$cy)"
        Invoke-Adb "shell input tap $cx $cy"
        Start-Sleep -Seconds 5
    } else {
        Write-Host "未找到 btnPinWidget（界面可能已变），跳过自动点击；请手动点「添加到桌面」"
    }
}
Write-Host "DONE - widget 已部署，MIUI 主屏幕快捷方式权限已修复。"
