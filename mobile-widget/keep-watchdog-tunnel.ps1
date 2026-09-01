# keep-watchdog-tunnel.ps1 — 保活 DSH Watchdog 手机 widget 的公网隧道
# 目标：确保存在一条公网 HTTPS -> 本机 adapter 8091 的隧道（trycloudflare 快速隧道），
#       供手机端 widget 脱离 USB 经公网读取 /watchdog/status（Authorization: Bearer token）。
# 结构：幂等保活循环；隧道进程死了则重启；重启后若 URL 变化则刷新手机端 baseUrl。
# 可回滚：杀掉本脚本进程 + 删除启动文件夹快捷方式；隧道 URL 变化可用手机 config UI 重填。
# 用法：powershell -ExecutionPolicy Bypass -File keep-watchdog-tunnel.ps1

$ErrorActionPreference = 'Stop'
$cf      = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$log     = Join-Path $env:TEMP 'dsh-watchdog-tunnel-keepalive.log'
$adb     = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial  = '61ad2087'
$prefs   = '/data/data/com.dsh.watchdog.widget/shared_prefs/dsh_watchdog_widget.xml'
# token 不入盘，仅在手机端缺失时由脚本注入（可选）。当前手机端已就地保存，跳过。

function Log($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# 探测一个 URL 是否真的可通过公网到达（adapter 8091 根->会 404 但能连通即视为隧道在）
function Test-UrlAlive([string]$url) {
    if ([string]::IsNullOrWhiteSpace($url)) { return $false }
    try {
        $r = Invoke-WebRequest -Uri "$url/healthz" -UseBasicParsing -TimeoutSec 8
        return $true
    } catch { return $false }
}

# 提取 trycloudflare URL：优先用已记录的 URL，其次从 stdout 日志抓取
function Get-TryCfUrl {
    $known = Join-Path $env:TEMP 'dsh-trycf-8091.url'
    if (Test-Path $known) {
        $u = (Get-Content $known -Raw).Trim()
        if ($u -match '^https://[a-z0-9-]+\.trycloudflare\.com') { return $u }
    }
    $outLog = Join-Path $env:TEMP 'dsh-trycf-8091.out.log'
    if (Test-Path $outLog) {
        $txt = Get-Content $outLog -Raw
        if ($txt -match '(https://[a-z0-9-]+\.trycloudflare\.com)') { return $matches[1] }
    }
    return $null
}

# 手机端更新 baseUrl（仅当磁盘值与当前公网 URL 不一致时；用 run-as 覆写）
# 说明：内部临时降级 $ErrorActionPreference，adb push/cp 的正常输出不作为异常；
#       仅当磁盘值已正确或 adb 不可达时才跳过/记录。
function Set-PhoneBaseUrl([string]$url) {
    try {
        # adb 可能未连接（手机未插线），先探测，避免整套调用空转
        $dev = (& $adb -s $serial get-state 2>&1) -join ""
        if ($dev.Trim() -ne 'device') { Log "adb 未连接 ($dev)，跳过手机 baseUrl 更新"; return }
        $cur = (& $adb -s $serial shell "run-as com.dsh.watchdog.widget cat $prefs" 2>&1) -join "`n"
        $tok = ''
        if ($cur -match '<string name="token">([^<]+)</string>') { $tok = $matches[1] }
        if ($cur -match '<string name="baseUrl">([^<]+)</string>' -and $matches[1] -eq $url) {
            Log "手机 baseUrl 已是 $url，跳过"; return
        }
        $xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>" + "`n" + "<map>" + "`n" + "    <string name=`"baseUrl`">$url</string>" + "`n" + "    <string name=`"token`">$tok</string>" + "`n" + "</map>"
        $tmp = Join-Path $env:TEMP 'dsh-widget-prefs.xml'
        [System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UTF8Encoding($false)))
        $prevEA = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
        & $adb -s $serial push $tmp '/data/local/tmp/dsh-widget-prefs.xml' 2>&1 | Out-Null
        & $adb -s $serial shell "run-as com.dsh.watchdog.widget sh -c 'cp /data/local/tmp/dsh-widget-prefs.xml $prefs'" 2>&1 | Out-Null
        & $adb -s $serial shell "run-as com.dsh.watchdog.widget rm -f /data/local/tmp/dsh-widget-prefs.xml" 2>&1 | Out-Null
        & $adb -s $serial shell "am force-stop com.dsh.watchdog.widget" 2>&1 | Out-Null
        & $adb -s $serial shell "am broadcast -n com.dsh.watchdog.widget/.WatchdogWidgetProvider -a com.dsh.watchdog.widget.ACTION_FETCH" 2>&1 | Out-Null
        $ErrorActionPreference = $prevEA
        Log "已更新手机 baseUrl -> $url"
    } catch { Log "更新手机 baseUrl 失败: $($_.Exception.Message)" }
}

Log "=== watchdog-tunnel keepalive started (pid $PID) ==="

while ($true) {
    try {
        $url = Get-TryCfUrl
        $alive = Test-UrlAlive $url
        if ($alive) {
            Set-PhoneBaseUrl $url
        } else {
            Log "隧道不可用 (url=$url)，尝试重启 cloudflared --url 8091"
            Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'tunnel --url' } |
                ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
            Start-Sleep -Seconds 2
            $outLog = Join-Path $env:TEMP 'dsh-trycf-8091.out.log'
            $errLog = Join-Path $env:TEMP 'dsh-trycf-8091.err.log'
            Remove-Item $outLog,$errLog -ErrorAction SilentlyContinue
            try {
                $p = Start-Process -FilePath $cf -ArgumentList 'tunnel','--url','http://127.0.0.1:8091','--no-autoupdate','--protocol','quic' -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
                # 把新 URL 记入 known 文件（trycloudflare 的 URL 从 stderr 打印）
                Start-Sleep -Seconds 15
                $txt = ""
                if (Test-Path $errLog) { $txt = Get-Content $errLog -Raw }
                if ($txt -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
                    [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'dsh-trycf-8091.url'), $matches[1], (New-Object System.Text.UTF8Encoding($false)))
                    Log "新隧道 URL -> $($matches[1])"
                } else {
                    Log "重启后未抓到 URL"
                }
                Log "已重启 cloudflared --url 8091"
            } catch { Log "重启 cloudflared 失败: $($_.Exception.Message)" }
        }
    } catch { Log "keepalive 循环异常: $($_.Exception.Message)" }
    Start-Sleep -Seconds 30
}
