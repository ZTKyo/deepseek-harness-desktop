# dsh-healthcheck.ps1 - one-shot health check for the DeepSeek Harness client.
#
# Read-only diagnostics: never modifies any file. Prints PASS/WARN/FAIL rows and
# a summary. API keys are redacted (never printed).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-healthcheck.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-healthcheck.ps1 -Port 3080
param(
    [int]$Port = 3080
)
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pass = 0; $warn = 0; $fail = 0
function Report([string]$name, [string]$status, [string]$detail) {
    $p = "$($name.PadRight(26)) $status"
    if ($detail) { $p += "  $detail" }
    Write-Host $p
    switch ($status) {
        'PASS' { $script:pass++ }
        'WARN' { $script:warn++ }
        default { $script:fail++ }
    }
}

Write-Host "== DeepSeek Harness 体检 ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) =="

# 1. dsh CLI
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
if ($dshCmd -and $dshCmd.Source) {
    $ver = & $dshCmd.Source --version 2>$null
    Report 'dsh CLI' 'PASS' "global: $($dshCmd.Source) ($ver)"
} else {
    $found = $null
    foreach ($r2 in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'))) {
        if (-not (Test-Path $r2)) { continue }
        foreach ($d in (Get-ChildItem $r2 -Directory -ErrorAction SilentlyContinue)) {
            $cand = Join-Path $d.FullName 'node_modules\.bin\dsh.cmd'
            if (Test-Path $cand) { $found = $cand; break }
        }
        if ($found) { break }
    }
    if ($found) { Report 'dsh CLI' 'WARN' "仅 npx 缓存兜底: $found（建议 npm i -g @deepseek-ai/dsh）" }
    else { Report 'dsh CLI' 'FAIL' '未找到 dsh 命令' }
}

# 2. pnpm (dsh plugin 依赖)
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pnpm) { Report 'pnpm' 'PASS' "global: $($pnpm.Source)" }
else { Report 'pnpm' 'WARN' '未安装（dsh plugin 不可用）；npm i -g pnpm' }

# 3. 服务
$url = "http://127.0.0.1:$Port/"
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
        $proc = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
        Report 'DSH 服务' 'PASS' "HTTP 200 @ $url (PID $proc)"
    } else { Report 'DSH 服务' 'WARN' "HTTP $($r.StatusCode)" }
} catch { Report 'DSH 服务' 'WARN' '未运行（客户端会自动拉起）' }

# 4. 配置目录
if (Test-Path "$env:USERPROFILE\.dsh\settings.yaml") { Report 'settings.yaml' 'PASS' '存在' }
else { Report 'settings.yaml' 'FAIL' '缺失' }
if (Test-Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml") { Report 'cordis.patch.yml' 'PASS' '存在' }
else { Report 'cordis.patch.yml' 'FAIL' '缺失' }

# 5. client-config.json（密钥加密状态，不打印密钥本身）
$cfgPath = Join-Path $env:LOCALAPPDATA 'DSHHarness\client-config.json'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $q = [string]$cfg.quotaApiKey; $m = [string]$cfg.mimoApiKey
        $enc = ($q.StartsWith('DP1:')) -and ($m.StartsWith('DP1:'))
        Report 'client-config' ($(if ($enc) { 'PASS' } else { 'WARN' })) $(if ($enc) { 'API Key 已 DPAPI 加密' } else { '存在明文 Key（建议重开客户端以加密）' })
        $qm = @($cfg.quotaModels | Where-Object { $_ -is [string] })
        if ($qm.Count -gt 0) { Report 'quotaModels' 'PASS' "$($qm.Count) 个模型" }
    } catch { Report 'client-config' 'FAIL' "解析失败: $($_.Exception.Message)" }
} else { Report 'client-config' 'WARN' '不存在（尚未运行过客户端）' }

# 6. 技能
$skills = Get-ChildItem (Join-Path $env:USERPROFILE '.agents\skills') -Directory -ErrorAction SilentlyContinue
if ($skills) { Report '技能目录' 'PASS' "$($skills.Count) 个技能" }
else { Report '技能目录' 'WARN' '~/.agents/skills 为空' }

# 7. 客户端文件
$need = @('DSH Harness PS.cmd', 'DSH-Harness-PS.ps1', 'DSH Harness.cmd', 'start-dsh-server.ps1', 'DeepSeek Whale.ico')
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $root $_)) })
if ($missing.Count -eq 0) { Report '客户端文件' 'PASS' '启动器齐全' }
else { Report '客户端文件' 'FAIL' "缺失: $($missing -join ', ')" }

# 8. 守护进程（dsh-guardian：防睡眠 + 服务自愈）
$guard = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '-File .*dsh-guardian\.ps1' -and $_.ProcessId -ne $PID }
$guardLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH Guardian Autostart.lnk'
if ($guard -and (Test-Path $guardLnk)) { Report '守护进程' 'PASS' "运行中 (PID $($guard.ProcessId -join ',')) + 自启项就绪" }
elseif ($guard) { Report '守护进程' 'WARN' "运行中但缺自启项（重跑 dsh-guardian.ps1 -Install）" }
elseif (Test-Path $guardLnk) { Report '守护进程' 'WARN' '未运行（手动启动：dsh-guardian.ps1）' }
else { Report '守护进程' 'WARN' '未安装（dsh-guardian.ps1 -Install）' }

# 9. 磁盘
try {
    $d = Get-PSDrive C -ErrorAction Stop
    $freeGB = [math]::Round($d.Free / 1GB, 1)
    if ($freeGB -gt 10) { Report 'C: 磁盘' 'PASS' "剩余 $freeGB GB" }
    else { Report 'C: 磁盘' 'WARN' "剩余 $freeGB GB" }
} catch { Report 'C: 磁盘' 'WARN' '无法读取' }

Write-Host ''
Write-Host "== 结果: PASS=$pass WARN=$warn FAIL=$fail =="
if ($fail -gt 0) { exit 1 } elseif ($warn -gt 0) { exit 2 } else { exit 0 }
