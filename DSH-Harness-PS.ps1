# DSH-Harness-PS.ps1 - "native-feel" DSH client built at runtime with WPF + WebView2.
#
# Why this exists: the compiled "DSH Harness.exe" is unsigned, so Windows Smart App
# Control (SAC) blocks it. This script builds the SAME kind of window (dark, isolated
# WebView2 profile, auto-starts the dsh web server) at runtime under the Microsoft-
# signed powershell.exe, so SAC has nothing unsigned to block.
#
# Features:
#   * remembers window size/position/maximized state across runs
#   * tray icon: close button minimizes to tray (toggleable); right-click to exit
#   * retry button + Ctrl+R when the server or page fails to load
#   * status shown in the window title (在线/离线/加载中)
#   * progress bar while auto-starting the dsh server (up to 90s)
#   * auto-reconnect: if the server drops mid-session, reloads when it returns
#   * client-run.log auto-rotates at 512 KB
#   * window appears fast: WebView2 is loaded lazily after the window shows
#   * quota viewer (left panel): DeepSeek account balance for the current model
#
# Usage (double-click "DSH Harness PS.cmd", or):
#   powershell -NoProfile -STA -File .\DSH-Harness-PS.ps1
# Diagnostics:
#   powershell -NoProfile -STA -File .\DSH-Harness-PS.ps1 -Probe
#     -> writes probe-result.json / probe-step.log next to this script, then exits.
param(
    [int]$Port = 3080,      # which port the DSH web server listens on
    [switch]$Probe
)
$ErrorActionPreference = 'Stop'

# --- re-spawn without a console (CREATE_NO_WINDOW) ---
# The launcher starts us with a console (terminal tab). We immediately re-launch
# ourselves with CREATE_NO_WINDOW - the child has NO console window at all, so no
# terminal tab ever appears for it - then this (console) instance exits and its
# tab closes by itself. The child hosts the WPF window console-less.
if (-not $env:DSH_NO_CONSOLE) {
    try {
        $childArgs = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '" -Port ' + $Port
        if ($Probe) { $childArgs += ' -Probe' }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = $childArgs
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = (Split-Path -Parent $MyInvocation.MyCommand.Path)
        $psi.EnvironmentVariables['DSH_NO_CONSOLE'] = '1'
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        exit 0
    } catch { }
    # if the respawn failed for any reason, continue with the console (rare fallback)
}

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$url    = "http://127.0.0.1:$Port/"
$title  = 'DeepSeek Harness'

# P0 (2026-08-18): deep-clean self-heal module - reclaims zombie/half-dead DSH
# listeners on our port before we spawn a fresh server (fixes "服务拉不起来").
. (Join-Path $root 'dsh-clean-reclaim.ps1')
# P2 (2026-08-18): Windows Credential Manager storage (system vault) with
# automatic migration from the legacy DP1 fields.
. (Join-Path $root 'dsh-credential-manager.ps1')

# ---------- persisted config (window layout + tray + quota) ----------
$dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
try { New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null } catch { }
$configPath = Join-Path $dataRoot 'client-config.json'
$config = @{}
if (Test-Path $configPath) {
    try { $config = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $config = @{} }
}
$script:trayOnClose = $true
try { if ($config.trayOnClose -ne $null) { $script:trayOnClose = [bool]$config.trayOnClose } } catch { }
$script:reallyExit = $false
$script:balloonShown = $false
$script:tray = $null

# ---------- quota state (DeepSeek balance viewer) ----------
# Keys are stored DPAPI-encrypted (prefix "DP1:") at rest; legacy plaintext is
# read transparently and re-encrypted on the next save.
function Protect-Key([string]$plain) {
    if ([string]::IsNullOrEmpty($plain)) { return '' }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
        $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        return 'DP1:' + [Convert]::ToBase64String($enc)
    } catch { return $plain }
}
function Unprotect-Key([string]$stored) {
    if ([string]::IsNullOrEmpty($stored)) { return '' }
    if (-not $stored.StartsWith('DP1:')) { return $stored }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $enc = [Convert]::FromBase64String($stored.Substring(4))
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch { return $stored }
}
# P2 (2026-08-18): Credential-Manager-first key access with one-way migration.
# Reads prefer the system vault; when only a legacy DP1/plaintext value exists it
# is mirrored into the vault and returned. Writes always keep the legacy config
# field too (backward compatible). Controlled by config.useCredentialManager
# (default true).
function Read-BestCredential([string]$Target, [string]$Fallback) {
    if ($config.useCredentialManager -eq $false) { return $Fallback }
    $cm = Get-DshCredCM -Target $Target
    if ($cm -ne '') { return $cm }
    if ($Fallback -ne '') {
        try {
            Set-DshCredCM -Target $Target -Value $Fallback
            $cm = Get-DshCredCM -Target $Target
            if ($cm -ne '') { TraceLog ('credential migrated to Credential Manager: ' + $Target); return $cm }
        } catch { TraceLog ('credential CM migrate error: ' + $_.Exception.Message) }
        return $Fallback
    }
    return ''
}
function Save-CredentialBest([string]$Target, [string]$Value) {
    # returns the legacy DP1 string for the config file; mirrors plaintext into
    # the Credential Manager when enabled.
    if ($Value -and $config.useCredentialManager -ne $false) {
        try { Set-DshCredCM -Target $Target -Value $Value } catch { TraceLog ('credential CM write error: ' + $_.Exception.Message) }
    }
    return Protect-Key $Value
}
function Normalize-QuotaModels {
    # Self-heal data corrupted by the old string-concatenation bug: an element
    # containing several glued model names is split into its known names; the
    # result is deduped and coerced to a real array.
    $known = @('deepseek-v4-flash-free','deepseek-v4-flash','deepseek-v4-pro',
               'mimo-v2.5-pro-ultraspeed','mimo-v2.5-pro','mimo-v2.5','mimo-v2-flash')
    $out = @()
    foreach ($item in @($script:quotaModels)) {
        $s = [string]$item
        if ([string]::IsNullOrWhiteSpace($s)) { continue }
        $found = @()
        foreach ($k in $known) {
            $idx = 0
            while (($idx = $s.IndexOf($k, $idx)) -ge 0) { if ($found -notcontains $k) { $found += $k }; $idx += $k.Length }
        }
        $glued = ($found.Count -ge 2) -and ($s.Length -gt (($found | ForEach-Object { $_.Length } | Measure-Object -Sum).Sum))
        foreach ($f in @(if ($glued) { $found } else { @($s) })) {
            if ($out -notcontains $f) { $out += $f }
        }
    }
    $script:quotaModels = $out
}
function Add-QuotaModel([string]$model) {
    if ([string]::IsNullOrWhiteSpace($model)) { return }
    $script:quotaModels = @($script:quotaModels)
    if ($script:quotaModels -notcontains $model) { $script:quotaModels += $model; Save-QuotaConfig }
}
$script:quotaKey     = Read-BestCredential -Target 'DSHHarness/quota' -Fallback (Unprotect-Key ([string]$config.quotaApiKey))
$script:quotaBaseline = if ($config.quotaBaseline)   { [double]$config.quotaBaseline }   else { $null }
$script:quotaModels  = @($config.quotaModels | Where-Object { $_ -is [string] -and $_.Trim() -ne '' })
Normalize-QuotaModels
$script:quotaState   = @{ expanded = $false; balance = $null; error = ''; fetching = $false }
$script:currentModel = ''
$settingsPath = Join-Path $env:USERPROFILE '.dsh\settings.yaml'
$script:mimoKey  = Read-BestCredential -Target 'DSHHarness/mimo' -Fallback (Unprotect-Key ([string]$config.mimoApiKey))
$script:mimoModels = @('mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.5-pro-ultraspeed')
$script:mimoCookie = if ($config.mimoCookie) { [string]$config.mimoCookie } else { '' }
$script:mimoState  = @{ balance = $null; error = '' }
# MiMo session auto-renewal (hidden off-screen WebView2 keeps the console session fresh)
$script:mimoRenew   = @{ stage = 0; at = $null; task = $null }
$script:mimoRenewWin = $null
$script:mimoRenewWv  = $null
$script:mimoLoginWin = $null
$script:mimoLoginWv  = $null
$script:mimoLoginNav = $null
$script:mimoAutoDone = $false

function Fetch-Balance {
    # synchronous DeepSeek balance fetch (no runspace -> no cross-thread/WPF crash risk)
    try {
        $req = [System.Net.HttpWebRequest]::Create('https://api.deepseek.com/user/balance')
        $req.Proxy = $null
        $req.Method = 'GET'
        $req.Headers.Add('Authorization', 'Bearer ' + $script:quotaKey)
        $req.Timeout = 8000
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $json = $reader.ReadToEnd()
        $reader.Close(); $resp.Close()
        $data = $json | ConvertFrom-Json
        $bi = @($data.balance_infos) | Select-Object -First 1
        return @{ ok = $true; isAvailable = [bool]$data.is_available; currency = [string]$bi.currency;
                  remaining = [double]$bi.total_balance; granted = [double]$bi.granted_balance;
                  toppedUp = [double]$bi.topped_up_balance }
    } catch {
        return @{ ok = $false; error = [string]$_.Exception.Message }
    }
}

function Start-QuotaFetch {
    # synchronous fetch + UI update (called from the quota timer and the refresh button)
    try {
        if ($script:quotaKey -eq '') { return }
        $script:quotaState.fetching = $true
        Update-QuotaUI
        $res = Fetch-Balance
        $script:quotaState.fetching = $false
        if ($res -and $res.ok) {
            $script:quotaState.balance = $res
            $script:quotaState.error = ''
        } elseif ($res) {
            $script:quotaState.error = $res.error
        } else {
            $script:quotaState.error = '无返回数据'
        }
        Update-QuotaUI
    } catch { TraceLog ('quota fetch error: ' + $_.Exception.Message) }
}

function Read-CurrentModel {
    try {
        if (Test-Path $settingsPath) {
            $txt = Get-Content $settingsPath -Raw
            $m = [regex]::Match($txt, '(?ms)agent-default-model:.*?^\s+model:\s*(\S+)')
            if ($m.Success) { return $m.Groups[1].Value }
        }
    } catch {}
    return $null
}

function Read-DefaultProvider {
    # which provider the user is currently using (settings.yaml agent-default-model.provider)
    try {
        if (Test-Path $settingsPath) {
            $txt = Get-Content $settingsPath -Raw
            $m = [regex]::Match($txt, '(?ms)agent-default-model:.*?^\s+provider:\s*(\S+)')
            if ($m.Success) { return $m.Groups[1].Value }
        }
    } catch {}
    return ''
}

function Get-ModelDisplayName([string]$id) {
    # map raw model ids to display names (fallback: keep the raw id)
    if ([string]::IsNullOrWhiteSpace($id)) { return '' }
    $map = @{
        'deepseek-v4-flash'               = 'DeepSeek-V4-Flash'
        'deepseek-v4-flash-free'          = 'DeepSeek-V4-Flash-Free'
        'deepseek-v4-pro'                 = 'DeepSeek-V4-Pro'
        'mimo-v2.5'                       = 'MiMo-V2.5'
        'mimo-v2.5-pro'                   = 'MiMo-V2.5-Pro'
        'mimo-v2.5-pro-ultraspeed'        = 'MiMo-V2.5-Pro-Ultraspeed'
        'mimo-v2-flash'                   = 'MiMo-V2-Flash'
    }
    if ($map.ContainsKey($id.Trim().ToLowerInvariant())) { return $map[$id.Trim().ToLowerInvariant()] }
    return $id
}

# ---------- log with auto-rotation (512 KB cap) ----------
function TraceLog([string]$msg) {
    try {
        $logPath = Join-Path $root 'client-run.log'
        if (Test-Path $logPath) {
            $fi = Get-Item $logPath
            if ($fi.Length -gt 512KB) {
                Move-Item -Path $logPath -Destination (Join-Path $root 'client-run.old.log') -Force -ErrorAction SilentlyContinue
            }
        }
        Add-Content -Path $logPath -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $msg) -Encoding UTF8
    } catch {}
}

trap {
    try { TraceLog ('TRAP: ' + $_.Exception.ToString()) } catch { }
    try { Write-Host ("DSH Harness error: " + $_.Exception.Message) } catch { }
    exit 1
}

TraceLog ("start: probe=" + [bool]$Probe + " pid=" + $PID)

$script:st = @{
    phase          = 'connect'   # connect -> init -> initializing -> done
    serverStarted  = $false
    serverStartedAt = $null
    serverDeadline = $null
    initDeadline   = $null
    wvReady        = $false
    wvLoaded       = $false
    envTask        = $null       # background CoreWebView2Environment creation task
}
$script:wv = $null
$script:reconn = @{ offline = $false; fails = 0 }

function StepLog([string]$msg) {
    if (-not $Probe) { return }
    try { Add-Content -Path (Join-Path $root 'probe-step.log') -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $msg) -Encoding UTF8 } catch {}
}

function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Find-Dsh {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) {
        $dir = Split-Path $cmd.Source
        foreach ($cand in @("$dir\dsh.cmd", "$dir\dsh.exe", $cmd.Source)) {
            if ($cand -and (Test-Path $cand)) { return $cand }
        }
    }
    foreach ($r2 in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'))) {
        if (Test-Path $r2) {
            foreach ($d in (Get-ChildItem $r2 -Directory -ErrorAction SilentlyContinue)) {
                $cand = Join-Path $d.FullName 'node_modules\.bin\dsh.cmd'
                if (Test-Path $cand) { return $cand }
            }
        }
    }
    return 'dsh'
}

function Start-DshServer {
    try {
        # P0-2 (2026-08-18): before spawning, reclaim a zombie/half-dead DSH
        # listener that might still hold the loopback port (otherwise the fresh
        # process dies on EADDRINUSE -> "让服务拉不起来的根源"). Dry-run first;
        # if a proven zombie is reported, stop it, then fall through to spawn.
        try {
            $reclaim = Invoke-DshCleanReclaim -Port $Port -ProbeSec 0
            if ($reclaim.Action -eq 'stopped') {
                TraceLog ('clean-reclaim: stopped zombie pid=' + $reclaim.Pid + ' reason=' + $reclaim.Reason)
            } else {
                TraceLog ('clean-reclaim: ' + $reclaim.Action + ' (' + $reclaim.Reason + ' ready=' + $reclaim.State.Ready + ')')
            }
            if ($reclaim.Action -eq 'pending') {
                $reclaim2 = Invoke-DshCleanReclaim -Port $Port -ProbeSec 0 -Force
                TraceLog ('clean-reclaim: forced ' + $reclaim2.Action + ' (' + $reclaim2.Reason + ')')
            }
        } catch { TraceLog ('clean-reclaim error: ' + $_.Exception.Message) }
        $dsh = Find-Dsh
        New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
        $log = Join-Path $dataRoot ("logs\dsh-server-" + $Port + ".log")
        New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = '/S /C ""' + $dsh + '" web --port ' + $Port + ' > "' + $log + '" 2>&1"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $env:USERPROFILE
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        return $true
    } catch { return $false }
}

function Get-DataDir {
    $base = Join-Path $env:LOCALAPPDATA 'DSHHarness'
    try {
        New-Item -ItemType Directory -Force -Path $base | Out-Null
        $probe = Join-Path $base '.wprobe'
        Set-Content -Path $probe -Value 'x' -ErrorAction Stop
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        return (Join-Path $base 'WebView2PS')
    } catch {
        $alt = Join-Path $root 'data\ps'
        New-Item -ItemType Directory -Force -Path $alt | Out-Null
        return $alt
    }
}

function Save-QuotaConfig {
    # alias of the single config writer (geometry + tray + quota fields).
    Save-Geometry
}

function Save-Geometry {
    # single config writer: window layout + tray preference + quota fields.
    try {
        $cfg = @{}
        if (Test-Path $configPath) { try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $cfg = @{} } }
        $rb = $win.RestoreBounds
        $out = @{
            width       = if ($rb.Width -gt 0)  { [int]$rb.Width }  else { if ($cfg.width) { [int]$cfg.width } else { 1500 } }
            height      = if ($rb.Height -gt 0) { [int]$rb.Height } else { if ($cfg.height) { [int]$cfg.height } else { 950 } }
            left        = if ($rb.Width -gt 0)  { [int]$rb.Left }   else { if ($null -ne $cfg.left) { [int]$cfg.left } else { $null } }
            top         = if ($rb.Height -gt 0) { [int]$rb.Top }    else { if ($null -ne $cfg.top) { [int]$cfg.top } else { $null } }
            maximized   = ($win.WindowState -eq 'Maximized')
            trayOnClose = [bool]$script:trayOnClose
            quotaApiKey = Save-CredentialBest -Target 'DSHHarness/quota' -Value ([string]$script:quotaKey)
            quotaBaseline = $script:quotaBaseline
            quotaModels = @($script:quotaModels)
            mimoApiKey = Save-CredentialBest -Target 'DSHHarness/mimo' -Value ([string]$script:mimoKey)
            mimoCookie = [string]$script:mimoCookie
        }
        $out | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
    } catch {}
}

function Update-QuotaUI {
    # push quota data to the injected web widget.
    # v4: provider cards only (no model names). Collapsed = the provider in use;
    # expanded = all providers. Same API shares one balance.
    try {
        if (-not $script:wv -or -not $script:st.wvReady -or -not $script:wv.CoreWebView2) { return }
        # ---- build the three provider cards ----
        $goCard = @{ id = 'go'; name = 'Open Code Go'; kind = 'subscription'; error = [string]$script:goState.error }
        if ($script:goState.usage) { $goCard.windows = $script:goState.usage; $goCard.error = '' }
        $dsCard = @{ id = 'deepseek'; name = 'DeepSeek'; kind = 'balance'; needKey = ($script:quotaKey -eq ''); error = [string]$script:quotaState.error }
        if ($script:quotaState.balance -and $script:quotaState.balance.ok) {
            $dsCard.remaining = [double]$script:quotaState.balance.remaining
            $dsCard.currency = [string]$script:quotaState.balance.currency
            $dsCard.error = ''
        }
        $mimoCard = @{ id = 'mimo'; name = '小米 MiMo'; kind = 'balance'; connected = ($script:mimoCookie -ne ''); error = [string]$script:mimoState.error }
        if ($script:mimoState.balance -and $script:mimoState.balance.ok) {
            $mimoCard.remaining = [double]$script:mimoState.balance.balance
            $mimoCard.currency = [string]$script:mimoState.balance.currency
            $mimoCard.error = ''
        }
        # ---- which provider is in use (settings default) ----
        $cur = ''
        switch -Regex ((Read-DefaultProvider).Trim().ToLowerInvariant()) {
            'opencode'  { $cur = 'go' }
            'deepseek'  { $cur = 'deepseek' }
            'xiaomi'    { $cur = 'mimo' }
        }
        $data = @{
            ok = $true
            current = $cur
            providers = @($dsCard, $mimoCard, $goCard)
        }
        $script:wv.CoreWebView2.PostWebMessageAsString(($data | ConvertTo-Json -Compress -Depth 8))
    } catch { TraceLog ('quota update error: ' + $_.Exception.Message) }
}

# ---------- Xiaomi MiMo balance (cookie-authed console API) ----------
function Fetch-MiMoBalance {
    # GET https://platform.xiaomimimo.com/api/v1/balance (+ tokenPlan detail/usage) using the
    # browser session cookie (api-platform_serviceToken + userId) captured from the login window.
    try {
        if ($script:mimoCookie -eq '') { return @{ ok = $false; error = '未连接小米账号' } }
        $base = 'https://platform.xiaomimimo.com/api/v1'
        function Get-MimoJson([string]$path) {
            $req = [System.Net.HttpWebRequest]::Create($base + $path)
            $req.Proxy = $null
            $req.Method = 'GET'
            $req.Accept = 'application/json, text/plain, */*'
            $req.Referer = 'https://platform.xiaomimimo.com/#/console/balance'
            $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            $req.Headers.Add('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
            $req.Headers.Add('Cookie', $script:mimoCookie)
            $req.Headers.Add('Origin', 'https://platform.xiaomimimo.com')
            $req.Headers.Add('x-timeZone', 'UTC+08:00')
            $req.Timeout = 10000
            $resp = $req.GetResponse()
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $json = $reader.ReadToEnd()
            $reader.Close(); $resp.Close()
            return ($json | ConvertFrom-Json)
        }
        $bal = Get-MimoJson '/balance'
        if (-not $bal -or $bal.code -ne 0) {
            $expired = ($bal.code -eq 401 -or $bal.code -eq 403)
            $msg = [string]$bal.message
            TraceLog ('mimo api /balance failed: code=' + [int]$bal.code + ' msg=' + $msg)
            return @{ ok = $false; error = $msg; loginExpired = $expired }
        }
        $plan = $null
        try {
            $det = Get-MimoJson '/tokenPlan/detail'
            $use = Get-MimoJson '/tokenPlan/usage'
            if ($det -and $det.code -eq 0 -and $det.data -and $use -and $use.code -eq 0 -and $use.data.monthUsage -and @($use.data.monthUsage.items).Count -gt 0) {
                $item = @($use.data.monthUsage.items) | Select-Object -First 1
                $plan = @{ code = [string]$det.data.planCode; periodEnd = [string]$det.data.currentPeriodEnd;
                           expired = [bool]$det.data.expired; used = [int]$item.used; limit = [int]$item.limit;
                           pct = [double]$item.percent }
            }
        } catch { $plan = $null }
        return @{ ok = $true; balance = [double]$bal.data.balance; currency = [string]$bal.data.currency;
                  cash = [double]$bal.data.cashBalance; gift = [double]$bal.data.giftBalance; plan = $plan }
    } catch {
        $resp2 = $_.Exception.Response
        $code = if ($resp2) { [int]$resp2.StatusCode } else { 0 }
        TraceLog ('mimo api exception: http=' + $code + ' ' + $_.Exception.Message)
        if ($code -eq 401 -or $code -eq 403) {
            return @{ ok = $false; error = '登录已过期，请重新连接'; loginExpired = $true }
        }
        return @{ ok = $false; error = [string]$_.Exception.Message }
    }
}

# ---------- Open Code Go subscription usage (套餐订阅 -> 进度条) ----------
$script:goState = @{ usage = $null; error = '' }
function Read-OpenCodeKey {
    # reads OPENCODE_API_KEY from ~/.dsh/.credentials.yaml (same key used by the opencode providers)
    try {
        $p = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
        if (Test-Path $p) {
            foreach ($line in (Get-Content $p)) {
                if ($line -match '^\s*OPENCODE_API_KEY\s*:\s*(\S+)') { return $matches[1].Trim() }
            }
        }
    } catch {}
    return ''
}
function Fetch-OpenCodeGo {
    # GET https://opencode.ai/zen/go/v1/usage
    # -> { usage: { rolling: {status,percent,resetsAt}, weekly: {...}, monthly: {...} } }
    try {
        $key = Read-OpenCodeKey
        if ($key -eq '') { return @{ ok = $false; error = '未找到 OPENCODE_API_KEY' } }
        $req = [System.Net.HttpWebRequest]::Create('https://opencode.ai/zen/go/v1/usage')
        $req.Proxy = $null
        $req.Method = 'GET'
        $req.Headers.Add('Authorization', 'Bearer ' + $key)
        $req.Accept = 'application/json'
        $req.Timeout = 10000
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $json = $reader.ReadToEnd()
        $reader.Close(); $resp.Close()
        $d = ($json | ConvertFrom-Json).usage
        if (-not $d) { return @{ ok = $false; error = '响应无 usage 字段' } }
        $win = @{}
        foreach ($k in @('rolling', 'weekly', 'monthly')) {
            if ($d.$k) {
                $win[$k] = @{ status = [string]$d.$k.status; percent = [double]$d.$k.percent; resetsAt = [string]$d.$k.resetsAt }
            }
        }
        return @{ ok = $true; windows = $win }
    } catch {
        $resp2 = $_.Exception.Response
        $code = if ($resp2) { [int]$resp2.StatusCode } else { 0 }
        return @{ ok = $false; error = 'HTTP ' + $code + ' ' + $_.Exception.Message }
    }
}
function Start-GoFetch {
    try {
        $res = Fetch-OpenCodeGo
        if ($res -and $res.ok) {
            $script:goState.usage = $res.windows
            $script:goState.error = ''
            $pct = @($res.windows.GetEnumerator() | ForEach-Object { $_.Key + '=' + [Math]::Round([double]$_.Value.percent * 100) + '%' })
            TraceLog ('opencode go usage ok: ' + ($pct -join ' '))
        } else {
            $script:goState.error = [string]$res.error
            TraceLog ('opencode go usage failed: ' + $res.error)
        }
        Update-QuotaUI
    } catch { TraceLog ('go fetch error: ' + $_.Exception.Message) }
}

function Start-MiMoFetch {
    try {
        if ($script:mimoCookie -eq '') { return }
        $res = Fetch-MiMoBalance
        if ($res -and $res.ok) {
            $script:mimoState.balance = $res
            $script:mimoState.error = ''
            TraceLog ('mimo balance ok: ' + $res.currency + ' ' + ('{0:F2}' -f $res.balance))
        } elseif ($res) {
            $script:mimoState.error = $res.error
            if ($res.loginExpired) {
                $script:mimoState.balance = $null
                TraceLog ('mimo balance failed: ' + $res.error)
                Open-MiMoLogin
            } else {
                TraceLog ('mimo balance failed: ' + $res.error)
            }
        }
        Update-QuotaUI
    } catch { TraceLog ('mimo fetch error: ' + $_.Exception.Message) }
}

# ---------- MiMo session auto-renewal ----------
# 2026-08-14 fix: cookie capture now queries MULTIPLE xiaomi origins and matches
# names by pattern (the platform may set the session token on account.xiaomi.com
# or under a different cookie name than api-platform_serviceToken), and logs the
# names found so future failures are diagnosable.
$script:mimoOrigins = @('https://platform.xiaomimimo.com', 'https://account.xiaomi.com', 'https://xiaomi.com', 'https://www.xiaomi.com')
function Merge-MiMoCookieParts([object[]]$cookieLists) {
    # returns @{ parts = @(...); names = @(...) } from already-awaited cookie collections
    $parts = @(); $names = @()
    foreach ($list in @($cookieLists)) {
        foreach ($c in @($list)) {
            if ($names -notcontains $c.Name) { $names += $c.Name }
            if ($c.Name -match 'serviceToken|service_token|service-token|userId|user_id|^sid$') {
                if ($parts.Name -notcontains $c.Name) { $parts += $c }
            }
        }
    }
    return @{ parts = $parts; names = $names }
}
function New-MiMoRenewalWindow {
    # hidden off-screen WebView2 sharing the client profile: it re-visits the MiMo console,
    # whose SSO session auto-logs-in, and the fresh cookies are read back -> the ~1-day
    # serviceToken TTL never bites and no manual re-login is needed while the SSO session lives.
    try {
        $script:mimoRenewWin = New-Object System.Windows.Window
        $script:mimoRenewWin.Width = 240; $script:mimoRenewWin.Height = 140
        $script:mimoRenewWin.ShowInTaskbar = $false
        $script:mimoRenewWin.WindowStyle = 'None'
        $script:mimoRenewWin.Left = -2000; $script:mimoRenewWin.Top = -2000
        $rg = New-Object System.Windows.Controls.Grid
        $script:mimoRenewWin.Content = $rg
        $script:mimoRenewWv = New-Object Microsoft.Web.WebView2.Wpf.WebView2
        [void]$rg.Children.Add($script:mimoRenewWv)
        $renv = $null
        try { $renv = $script:st.envTask.GetAwaiter().GetResult() } catch {}
        $script:mimoRenewWv.Add_NavigationCompleted({
            param($sender, $nav)
            if ($nav.IsSuccess) {
                $script:mimoRenew.stage = 2
                $script:mimoRenew.at = Get-Date
                TraceLog ('mimo renewal nav ok')
            } else {
                $script:mimoRenew.stage = 0
                TraceLog ('mimo renewal nav failed: ' + $nav.HttpStatusCode)
            }
        })
        $script:mimoRenewWin.Add_Loaded({
            try {
                if ($renv) { $null = $script:mimoRenewWv.EnsureCoreWebView2Async($renv) }
                else { $null = $script:mimoRenewWv.EnsureCoreWebView2Async($null) }
            } catch { TraceLog ('mimo renewal init error: ' + $_.Exception.Message) }
        })
        $script:mimoRenewWv.Add_CoreWebView2InitializationCompleted({
            param($sender, $e)
            if ($e.IsSuccess) { TraceLog ('mimo renewal webview ready') }
            else {
                $msg = ''
                try { $msg = [string]$e.InitException.Message } catch {}
                TraceLog ('mimo renewal webview init FAILED: ' + $msg)
            }
        })
        TraceLog 'mimo renewal window built'
    } catch { TraceLog ('mimo renewal window error: ' + $_.Exception.Message) }
}

function Start-MiMoRenewal {
    # navigate the hidden renewal WebView2 to the console to refresh the session cookies
    # (also used at startup to auto-reconnect when the SSO session is still alive)
    try {
        if (-not $script:mimoRenewWv) { New-MiMoRenewalWindow }
        if (-not $script:mimoRenewWv) { return }
        if ($script:mimoRenew.stage -eq 0) {
            $script:mimoRenew.stage = 1
            try {
                $script:mimoRenewWin.Show()
                if ($script:mimoRenewWv.CoreWebView2) {
                    $script:mimoRenewWv.CoreWebView2.Navigate('https://platform.xiaomimimo.com/#/console/balance')
                    TraceLog 'mimo renewal: navigating'
                } else {
                    # CoreWebView2 not initialized yet: park in stage 4; the 2s
                    # renewal driver (Update-MiMoRenewal) retries when it is ready.
                    # (A one-shot closure timer here misbehaves under PS 5.1: the
                    # function-local timer variable resolves null inside the event
                    # closure, so Stop() throws and the timer never stops.)
                    $script:mimoRenew.stage = 4
                    TraceLog 'mimo renewal: waiting for CoreWebView2 init'
                }
            } catch { $script:mimoRenew.stage = 0; TraceLog ('mimo renewal nav error: ' + $_.Exception.Message) }
        }
    } catch { TraceLog ('mimo renewal error: ' + $_.Exception.Message) }
}

function Update-MiMoRenewal {
    # driven by a 2s timer; all state script-scoped (no closure pitfalls)
    try {
        if (-not $script:mimoRenewWv) { return }
        if ($script:mimoRenew.stage -eq 4) {
            # parked until CoreWebView2 finishes initializing, then navigate;
            # self-heal: rebuild the window after ~60s of failed init
            try {
                $script:mimoRenewWaitCount = [int]$script:mimoRenewWaitCount + 1
                if ($script:mimoRenewWv.CoreWebView2) {
                    $script:mimoRenewWaitCount = 0
                    $script:mimoRenew.stage = 0
                    Start-MiMoRenewal
                } elseif ($script:mimoRenewWaitCount -ge 30) {
                    $script:mimoRenewWaitCount = 0
                    $script:mimoRenew.stage = 0
                    TraceLog 'mimo renewal: init timed out, rebuilding window'
                    try { $script:mimoRenewWin.Close() } catch {}
                    $script:mimoRenewWin = $null
                    $script:mimoRenewWv = $null
                    Start-MiMoRenewal
                }
            } catch { TraceLog ('mimo renewal init-wait error: ' + $_.Exception.Message) }
            return
        }
        if ($script:mimoRenew.stage -eq 2) {
            if (((Get-Date) - $script:mimoRenew.at).TotalSeconds -ge 3) {
                $script:mimoRenew.stage = 3
                try {
                    $script:mimoRenew.tasks = @()
                    foreach ($o in $script:mimoOrigins) {
                        try { $script:mimoRenew.tasks += ,$script:mimoRenewWv.CoreWebView2.CookieManager.GetCookiesAsync($o) } catch {}
                    }
                } catch { $script:mimoRenew.stage = 0; TraceLog ('mimo renewal cookie error: ' + $_.Exception.Message) }
            }
        } elseif ($script:mimoRenew.stage -eq 3) {
            $done = $true
            foreach ($t in @($script:mimoRenew.tasks)) { if (-not $t.IsCompleted) { $done = $false; break } }
            if ($done) {
                $script:mimoRenew.stage = 0
                try {
                    $lists = @()
                    foreach ($t in @($script:mimoRenew.tasks)) { try { $lists += ,@($t.Result) } catch {} }
                    $merged = Merge-MiMoCookieParts $lists
                    TraceLog ('mimo renewal cookies: ' + (($merged.names | Select-Object -Unique) -join ', '))
                    if ($merged.parts.Count -ge 1) {
                        $script:mimoCookie = ((@($merged.parts | ForEach-Object { $_.Name + '=' + $_.Value })) -join '; ')
                        Save-Geometry
                        TraceLog 'mimo renewal OK (cookie refreshed)'
                        Start-MiMoFetch
                    } else {
                        # SSO session expired -> mark for manual reconnect (no auto-popup:
                        # a modal login window must not appear while unattended)
                        TraceLog 'mimo renewal: session expired, needs login'
                        $script:mimoState.error = '登录已过期，请在额度卡片点击「连接小米余额」重新登录'
                        $script:mimoState.balance = $null
                        Update-QuotaUI
                    }
                } catch { TraceLog ('mimo renewal result error: ' + $_.Exception.Message) }
            }
        }
    } catch { TraceLog ('mimo renewal tick error: ' + $_.Exception.Message) }
}

# capture session cookies from the login WebView2 (multi-origin + pattern match + localStorage probe).
# IMPORTANT: only SCRIPT-scoped variables may be touched inside the timer closures — under PS 5.1,
# closures over FUNCTION-local variables resolve null inside .NET event handlers (observed 2026-08-14).
$script:mimoCapBusy = $false
$script:mimoCapWv2 = $null
$script:mimoCapLbl = $null
function Capture-MiMoLoginCookies($wv2, $lbl) {
    try {
        if ($script:mimoCapBusy) { return }
        $script:mimoCapBusy = $true
        $script:mimoCapWv2 = $wv2
        $script:mimoCapLbl = $lbl
        if (-not $script:mimoCapWv2 -or -not $script:mimoCapWv2.CoreWebView2) { $script:mimoCapBusy = $false; return }
        $script:loginCookieTasks = @()
        foreach ($o in $script:mimoOrigins) {
            try { $script:loginCookieTasks += ,$script:mimoCapWv2.CoreWebView2.CookieManager.GetCookiesAsync($o) } catch {}
        }
        $script:loginLsTask = $null
        try { $script:loginLsTask = $script:mimoCapWv2.CoreWebView2.ExecuteScriptAsync("JSON.stringify(Object.keys(localStorage).filter(function(k){return /token|sid|service|user/i.test(k)}))") } catch {}
        try { $script:mimoCapLbl.Text = '正在读取登录状态…' } catch {}
        $script:mimoCapPoll = New-Object System.Windows.Threading.DispatcherTimer
        $script:mimoCapPoll.Interval = [TimeSpan]::FromMilliseconds(300)
        $script:mimoCapPoll.Add_Tick({
            try {
                foreach ($t in @($script:loginCookieTasks)) { if (-not $t.IsCompleted) { return } }
                $script:mimoCapPoll.Stop()
                $script:mimoCapBusy = $false
                $lists = @()
                foreach ($t in @($script:loginCookieTasks)) { try { $lists += ,@($t.Result) } catch {} }
                $merged = Merge-MiMoCookieParts $lists
                $lsKeys = @()
                if ($script:loginLsTask -and $script:loginLsTask.IsCompleted) {
                    try { $lsKeys = @($script:loginLsTask.Result | ConvertFrom-Json) } catch {}
                }
                TraceLog ('mimo capture: cookies=[' + (($merged.names | Select-Object -Unique) -join ',') + '] ls=[' + ($lsKeys -join ',') + ']')
                if ($merged.parts.Count -ge 1) {
                    $script:mimoCookie = ((@($merged.parts | ForEach-Object { $_.Name + '=' + $_.Value })) -join '; ')
                    Save-Geometry
                    try { $script:mimoCapLbl.Text = '已保存，正在验证余额…' } catch {}
                    $res = Fetch-MiMoBalance
                    if ($res -and $res.ok) {
                        $script:mimoState.balance = $res
                        $script:mimoState.error = ''
                        try { $script:mimoCapLbl.Text = '连接成功！余额 ' + $res.currency + ' ' + ('{0:F2}' -f $res.balance) } catch {}
                        TraceLog 'mimo connected OK'
                        Start-Sleep -Milliseconds 600
                        try { $script:mimoLoginWin.Close() } catch {}
                    } else {
                        try { $script:mimoCapLbl.Text = '余额验证失败：' + ($res.error) } catch {}
                        TraceLog ('mimo balance verify failed: ' + $res.error)
                    }
                } else {
                    try { $script:mimoCapLbl.Text = '未检测到登录状态（无 serviceToken/userId 的 Cookie 或 localStorage），请先在页面内登录小米账号' } catch {}
                }
            } catch {
                $script:mimoCapPoll.Stop()
                $script:mimoCapBusy = $false
                try { $script:mimoCapLbl.Text = '错误：' + $_.Exception.Message } catch {}
                TraceLog ('mimo capture error: ' + $_.Exception.Message)
            }
        })
        $script:mimoCapPoll.Start()
    } catch { $script:mimoCapBusy = $false; TraceLog ('mimo capture init error: ' + $_.Exception.Message) }
}

function Open-MiMoLogin {
    # embedded WebView2 login window: log in at platform.xiaomimimo.com, then read the
    # session cookies via CoreWebView2.CookieManager and start polling the balance API.
    try {
        if (-not $script:st.wvReady) { return }
        # single login window at a time (auto-reconnect may also request one)
        if ($script:mimoLoginWin -and $script:mimoLoginWin.IsVisible) { TraceLog 'mimo login: window already open, skipped'; return }
        $script:mimoShotDone = $false
        $script:mimoPoll = $null
        $script:mimoCapTask = $null
        $script:mimoAutoCapFired = $false
        $script:mimoCapBusy = $false
        $loginWin = New-Object System.Windows.Window
        $loginWin.Title = '连接小米 MiMo 余额'
        $loginWin.Width = 460; $loginWin.Height = 700
        $loginWin.WindowStartupLocation = 'CenterScreen'
        $loginWin.Topmost = $true
        try { $loginWin.Owner = $win } catch {}
        $loginWin.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromRgb(13, 17, 28))

        $g = New-Object System.Windows.Controls.Grid
        $rowHint = New-Object System.Windows.Controls.RowDefinition; $rowHint.Height = 'Auto'
        $rowWv   = New-Object System.Windows.Controls.RowDefinition; $rowWv.Height = '*'
        $rowLbl  = New-Object System.Windows.Controls.RowDefinition; $rowLbl.Height = 'Auto'
        $rowBtn  = New-Object System.Windows.Controls.RowDefinition; $rowBtn.Height = 'Auto'
        [void]$g.RowDefinitions.Add($rowHint); [void]$g.RowDefinitions.Add($rowWv)
        [void]$g.RowDefinitions.Add($rowLbl);  [void]$g.RowDefinitions.Add($rowBtn)

        $hint = New-Object System.Windows.Controls.TextBlock
        $hint.Text = '请用小米账号登录 platform.xiaomimimo.com，登录成功后点击下方「完成，获取余额」。会话 Cookie 约 1 天有效，过期后需重新连接。'
        $hint.Foreground = [System.Windows.Media.Brushes]::White
        $hint.FontSize = 12
        $hint.TextWrapping = 'Wrap'
        $hint.Margin = '12,10,12,6'
        [System.Windows.Controls.Grid]::SetRow($hint, 0)
        [void]$g.Children.Add($hint)

        $wv2 = New-Object Microsoft.Web.WebView2.Wpf.WebView2
        [System.Windows.Controls.Grid]::SetRow($wv2, 1)
        [void]$g.Children.Add($wv2)
        $script:mimoLoginWin = $loginWin
        $script:mimoLoginWv = $wv2
        $script:mimoLoginWv2 = $wv2   # script-scope aliases for timer closures (PS 5.1 safe)
        $script:mimoLoginLbl = $null

        $lbl = New-Object System.Windows.Controls.TextBlock
        $lbl.Text = ''
        $lbl.Foreground = [System.Windows.Media.Brushes]::White
        $lbl.FontSize = 12
        $lbl.TextWrapping = 'Wrap'
        $lbl.Margin = '12,6,12,4'
        [System.Windows.Controls.Grid]::SetRow($lbl, 2)
        [void]$g.Children.Add($lbl)
        $script:mimoLoginLbl = $lbl   # script-scope alias (PS 5.1 closure safety)

        $btnRow = New-Object System.Windows.Controls.StackPanel
        $btnRow.Orientation = 'Horizontal'
        $btnRow.HorizontalAlignment = 'Center'
        $btnRow.Margin = '0,4,0,10'
        $btnDone = New-Object System.Windows.Controls.Button
        $btnDone.Content = '完成，获取余额'
        $btnDone.Width = 150; $btnDone.Height = 32
        $btnCancel = New-Object System.Windows.Controls.Button
        $btnCancel.Content = '取消'
        $btnCancel.Width = 90; $btnCancel.Height = 32
        $btnCancel.Margin = '10,0,0,0'
        [void]$btnRow.Children.Add($btnDone)
        [void]$btnRow.Children.Add($btnCancel)
        [System.Windows.Controls.Grid]::SetRow($btnRow, 3)
        [void]$g.Children.Add($btnRow)

        $loginWin.Content = $g

        # init WebView2 AFTER the window is shown (Loaded): the WPF WebView2 control
        # cannot initialize while its window is still unshown (IsSuccess=false -> blank page)
        $env2 = $null
        try { $env2 = $script:st.envTask.GetAwaiter().GetResult() } catch {}
        $wv2.Add_CoreWebView2InitializationCompleted({
            param($sender, $e2)
            if ($e2.IsSuccess) {
                TraceLog 'mimo login webview ready'
                try { $sender.CoreWebView2.Navigate('https://platform.xiaomimimo.com/#/console/balance') } catch {}
            } else {
                $errMsg = ''
                try { $errMsg = [string]$e2.InitException.Message } catch {}
                TraceLog ('mimo login webview init FAILED: ' + $errMsg)
                try { $lbl.Text = '页面组件初始化失败：' + $errMsg } catch {}
            }
        })
        $wv2.Add_NavigationCompleted({
            param($sender, $nav)
            $script:mimoLoginNav = $sender
            TraceLog ('mimo login nav: ok=' + $nav.IsSuccess + ' status=' + $nav.HttpStatusCode + ' url=' + $sender.CoreWebView2.Source)
            if ($nav.IsSuccess -and -not $script:mimoShotDone) {
                # capture what the page actually rendered (single-shot diagnostics)
                $script:mimoShotDone = $true
                try {
                    $script:mimoShot = Join-Path $root 'mimo-login-shot.png'
                    $script:mimoStream = [System.IO.File]::Create($script:mimoShot)
                    $script:mimoCapTask = $sender.CoreWebView2.CapturePreviewAsync([Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat]::Png, $script:mimoStream)
                    $script:mimoPoll = New-Object System.Windows.Threading.DispatcherTimer
                    $script:mimoPoll.Interval = [TimeSpan]::FromMilliseconds(500)
                    $script:mimoPoll.Add_Tick({
                        try {
                            if ($script:mimoCapTask -and $script:mimoCapTask.IsCompleted) {
                                $script:mimoPoll.Stop()
                                try { $script:mimoStream.Close() } catch {}
                                TraceLog 'mimo login shot saved'
                            }
                        } catch { TraceLog ('mimo poll error: ' + $_.Exception.Message) }
                    })
                    $script:mimoPoll.Start()
                } catch { TraceLog ('mimo shot error: ' + $_.Exception.Message) }
            }
            # 2026-08-14: auto-capture once the console page actually loaded (SSO
            # auto-login lands here) - no manual "完成" click needed for a live session.
            if ($nav.IsSuccess -and $sender.CoreWebView2.Source -match 'console/balance' -and -not $script:mimoAutoCapFired -and $script:mimoCookie -eq '') {
                $script:mimoAutoCapFired = $true
                $script:mimoAutoCapTimer = New-Object System.Windows.Threading.DispatcherTimer
                $script:mimoAutoCapTimer.Interval = [TimeSpan]::FromSeconds(3)
                $script:mimoAutoCapTimer.Add_Tick({
                    $script:mimoAutoCapTimer.Stop()
                    TraceLog 'mimo login: auto-capturing cookies'
                    Capture-MiMoLoginCookies $script:mimoLoginWv2 $script:mimoLoginLbl
                })
                $script:mimoAutoCapTimer.Start()
            }
            if ($env:DSH_MIMO_AUTOTEST -eq '1' -and $nav.IsSuccess) {
                $closer = New-Object System.Windows.Threading.DispatcherTimer
                $closer.Interval = [TimeSpan]::FromSeconds(10)
                $closer.Add_Tick({ $closer.Stop(); try { $script:mimoLoginWin.Close() } catch {}; TraceLog 'autotest: login window auto-closed' })
                $closer.Start()
                # auto-complete the login once the console loaded (session auto-login)
                if ($nav.IsSuccess -and $sender.CoreWebView2.Source -match 'console/balance' -and -not $script:mimoAutoDone) {
                    $script:mimoAutoDone = $true
                    $auto = New-Object System.Windows.Threading.DispatcherTimer
                    $auto.Interval = [TimeSpan]::FromSeconds(5)
                    $auto.Add_Tick({
                        $auto.Stop()
                        try {
                            $ct = $script:mimoLoginNav.CoreWebView2.CookieManager.GetCookiesAsync('https://platform.xiaomimimo.com')
                            $poll = New-Object System.Windows.Threading.DispatcherTimer
                            $poll.Interval = [TimeSpan]::FromMilliseconds(300)
                            $poll.Add_Tick({
                                try {
                                    if (-not $ct.IsCompleted) { return }
                                    $poll.Stop()
                                    $cookies = $ct.Result
                                    $parts = @()
                                    foreach ($c in $cookies) {
                                        if ($c.Name -eq 'api-platform_serviceToken' -or $c.Name -eq 'userId') { $parts += ($c.Name + '=' + $c.Value) }
                                    }
                                    if ($parts.Count -ge 2) {
                                        $script:mimoCookie = ($parts -join '; ')
                                        Save-Geometry
                                        TraceLog 'autotest: mimo cookie saved'
                                        Start-MiMoFetch
                                        try { $script:mimoLoginWin.Close() } catch {}
                                    } else {
                                        TraceLog 'autotest: no serviceToken cookie found'
                                    }
                                } catch { TraceLog ('autotest poll error: ' + $_.Exception.Message); $poll.Stop() }
                            })
                            $poll.Start()
                        } catch { TraceLog ('autotest cookie error: ' + $_.Exception.Message) }
                    })
                    $auto.Start()
                }
            }
        })
        $loginWin.Add_Loaded({
            try {
                if ($env2) { $null = $wv2.EnsureCoreWebView2Async($env2) }
                else { $null = $wv2.EnsureCoreWebView2Async($null) }
            } catch { $lbl.Text = 'WebView2 初始化失败：' + $_.Exception.Message }
        })

        $btnCancel.Add_Click({ $loginWin.Close() })
        $btnDone.Add_Click({
            Capture-MiMoLoginCookies $wv2 $lbl
        })
        TraceLog 'mimo login window opened'
        $loginWin.ShowDialog() | Out-Null
    } catch { TraceLog ('mimo login error: ' + $_.Exception.Message) }
}

# widget injection script (runs inside the web page; native look via app CSS vars)
# 2026-08-14 v4: provider cards only; collapsed = provider in use, expanded = all providers;
# unified typography; source: quota-widget.js
$script:quotaInjectJS = @'
(function(){
  if (window.__dshQuotaInjected) return;
  window.__dshQuotaInjected = true;
  function findSidebar(){
    var all = document.querySelectorAll('*');
    for (var i=0;i<all.length;i++){
      try {
        if (getComputedStyle(all[i]).getPropertyValue('--dsh-sidebar-inline-padding')) return all[i];
      } catch(e){}
    }
    return null;
  }
  var sb = findSidebar();
  if(!sb) return;
  var foot = null;
  for (var k=0;k<sb.children.length;k++){
    var c = sb.children[k];
    var cls = (c.className||'').toString() + ' ' + (c.textContent||'');
    if (cls.indexOf('foot')>=0 || cls.indexOf('设置')>=0 || cls.indexOf('settings')>=0){ foot = c; break; }
  }
  if(!foot) foot = sb.children[sb.children.length-1];

  var w = document.createElement('div');
  w.id = 'dsh-quota-widget';
  w.style.cssText = 'padding:6px var(--dsh-sidebar-inline-padding,12px);font-family:inherit;';
  var card = document.createElement('div');
  card.style.cssText = 'border-radius:10px;padding:10px 12px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.13);transition:background .2s;';
  card.onmouseenter = function(){ card.style.background='rgba(148,163,184,.12)'; };
  card.onmouseleave = function(){ card.style.background='rgba(148,163,184,.08)'; };
  w.appendChild(card);

  // unified typography: every provider name and every amount share one style
  var NAME_STYLE = 'font-size:12px;font-weight:600;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var BAL_STYLE = 'font-size:16px;font-weight:700;letter-spacing:.2px;margin-top:1px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  hdr.innerHTML = '<span style="font-size:11px;font-weight:600;letter-spacing:.4px;opacity:.85">额度</span>'+
                  '<span id="dshq-toggle" title="展开/收起全部提供商" style="font-size:10px;opacity:.55;cursor:pointer;user-select:none">▾</span>';
  card.appendChild(hdr);

  var host = document.createElement('div');
  host.id = 'dshq-providers';
  host.style.cssText = 'margin-top:6px;';
  card.appendChild(host);

  // setup (deepseek card visible but no key configured)
  var setup = document.createElement('div');
  setup.id = 'dshq-setup';
  setup.style.cssText = 'display:none;margin-top:8px;';
  setup.innerHTML = '<input id="dshq-key" type="password" placeholder="DeepSeek API Key" style="width:100%;box-sizing:border-box;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid rgba(148,163,184,.3);background:rgba(148,163,184,.08);color:inherit;outline:none;"/>'+
                    '<button id="dshq-save" style="margin-top:6px;width:100%;font-size:11px;padding:5px 0;border-radius:6px;border:1px solid rgba(148,163,184,.35);background:rgba(148,163,184,.12);color:inherit;cursor:pointer">保存</button>';
  card.appendChild(setup);

  var mimoBtn = document.createElement('button');
  mimoBtn.id='dshq-mimo-btn';
  mimoBtn.textContent='连接小米余额';
  mimoBtn.style.cssText='display:none;margin-top:6px;width:100%;font-size:11px;padding:5px 0;border-radius:6px;border:1px solid rgba(251,146,60,.45);background:rgba(251,146,60,.12);color:inherit;cursor:pointer;';
  mimoBtn.onclick=function(){ if(window.chrome && window.chrome.webview) window.chrome.webview.postMessage('__DSH_MIMO_CONNECT__'); };
  card.appendChild(mimoBtn);

  sb.insertBefore(w, foot);

  var expanded = false;
  var lastData = null;
  document.getElementById('dshq-toggle').onclick=function(){
    expanded = !expanded;
    document.getElementById('dshq-toggle').textContent = expanded ? '▴' : '▾';
    if (lastData) render(lastData);
  };
  document.getElementById('dshq-save').onclick=function(){
    var v=document.getElementById('dshq-key').value.trim();
    if(v && window.chrome && window.chrome.webview) window.chrome.webview.postMessage(v);
  };
  function fmtMoney(sym, v){
    return (sym==='USD'?'$':'¥') + Number(v).toFixed(2);
  }
  function subCardContent(p){
    var wrap=document.createElement('div');
    wrap.style.cssText='margin-top:4px;';
    var barWrap=document.createElement('div');
    barWrap.style.cssText='height:6px;border-radius:3px;background:rgba(148,163,184,.16);overflow:hidden;';
    var bar=document.createElement('div');
    bar.style.cssText='height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#f472b6);transition:width .5s ease;';
    barWrap.appendChild(bar);
    wrap.appendChild(barWrap);
    var info=document.createElement('div');
    info.style.cssText='margin-top:5px;font-size:11px;opacity:.85;line-height:1.6;white-space:pre;';
    wrap.appendChild(info);
    var ww=p.windows;
    if (ww) {
      var month=ww.monthly||ww.weekly||ww.rolling;
      if (month && typeof month.percent==='number') {
        var pct=Math.max(0,Math.min(100,Math.round(month.percent*100)));
        bar.style.width=pct+'%';
        var txt='本月已用 '+pct+'%';
        if (month.resetsAt) {
          var rd=new Date(month.resetsAt);
          if(!isNaN(rd.getTime())){
            var mm=('0'+(rd.getMonth()+1)).slice(-2), dd=('0'+rd.getDate()).slice(-2);
            txt+=' · 重置 '+mm+'-'+dd;
          }
        }
        if (ww.rolling && typeof ww.rolling.percent==='number') txt+='\n滚动 '+Math.round(ww.rolling.percent*100)+'%';
        if (ww.weekly && typeof ww.weekly.percent==='number') txt+=' · 周 '+Math.round(ww.weekly.percent*100)+'%';
        info.textContent=txt;
      }
    } else if (p.error) {
      info.textContent=p.error;
    }
    return wrap;
  }
  function balCardContent(p){
    var val=document.createElement('div');
    val.style.cssText=BAL_STYLE;
    if (p.connected===false) val.textContent='未连接';
    else if (p.needKey) val.textContent='未设置 API Key';
    else if (typeof p.remaining==='number') val.textContent='剩余 '+fmtMoney(p.currency,p.remaining);
    else val.textContent=(p.error||'额度获取失败');
    return val;
  }
  function render(d){
    lastData=d;
    var hostEl=document.getElementById('dshq-providers');
    hostEl.innerHTML='';
    var list=(d.providers)||[];
    var visible=[];
    if (expanded) {
      visible=list;
    } else {
      for (var i=0;i<list.length;i++){
        if (list[i].id===d.current) visible.push(list[i]);
      }
      if (visible.length===0) visible=list; // unknown/empty current -> show all
    }
    for (var j=0;j<visible.length;j++){
      var p=visible[j];
      var box=document.createElement('div');
      box.style.cssText='padding:6px 0;'+(j>0?'border-top:1px solid rgba(148,163,184,.1);':'');
      var name=document.createElement('div');
      name.style.cssText=NAME_STYLE;
      name.textContent=p.name||'?';
      box.appendChild(name);
      box.appendChild(p.kind==='subscription'?subCardContent(p):balCardContent(p));
      hostEl.appendChild(box);
    }
    // mimo connect button: only when a mimo card is visible and disconnected
    var hasMimoVis=false, mimoDisc=false;
    for (var m=0;m<visible.length;m++){
      if (visible[m].id==='mimo'){ hasMimoVis=true; if(!visible[m].connected) mimoDisc=true; }
    }
    var mb=document.getElementById('dshq-mimo-btn');
    if(mb) mb.style.display=(hasMimoVis&&mimoDisc)?'block':'none';
    // deepseek key setup: only when a deepseek card is visible and needs a key
    var dsNeed=false;
    for (var n=0;n<visible.length;n++){
      if (visible[n].id==='deepseek' && visible[n].needKey) dsNeed=true;
    }
    var setupEl=document.getElementById('dshq-setup');
    if(setupEl) setupEl.style.display=dsNeed?'block':'none';
    if(!window.__dshMimoVerified){ window.__dshMimoVerified=true; try{ window.chrome.webview.postMessage('__DSH_Q_MIMO_OK__'); }catch(e){} }
  }
  window.__dshQuotaUpdate=render;
  if(window.chrome && window.chrome.webview){
    window.chrome.webview.addEventListener('message',function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} });
  }
})();
'@


function Inject-QuotaWidget {
    try {
        if (-not $script:wv -or -not $script:st.wvReady -or -not $script:wv.CoreWebView2) { return }
        $null = $script:wv.CoreWebView2.ExecuteScriptAsync($script:quotaInjectJS)
        # async presence check (the page renders after navigation; retried by the timer)
        $null = $script:wv.CoreWebView2.ExecuteScriptAsync("setTimeout(function(){ if (!window.__dshQVerified && document.getElementById('dsh-quota-widget')) { window.__dshQVerified = true; window.chrome.webview.postMessage('__DSH_Q_WIDGET_OK__'); } }, 1200)")
        Update-QuotaUI
    } catch { TraceLog ('quota inject error: ' + $_.Exception.Message) }
}

function Write-ProbeResult($e) {
    try {
        $ok = $false; $code = 0; $err = -1; $docUrl = ''; $docTitle = ''
        if ($e) {
            $ok   = [bool]$e.IsSuccess
            $code = [int]$e.HttpStatusCode
            $err  = [int]$e.WebErrorStatus
        }
        if ($script:st.wvReady -and $script:wv -and $script:wv.CoreWebView2) {
            $docUrl   = $script:wv.CoreWebView2.Source
            $docTitle = $script:wv.CoreWebView2.DocumentTitle
        }
        $json = '{"ok":' + $(if ($ok) { 'true' } else { 'false' }) +
                ',"url":"' + ($docUrl -replace '\\', '\\' -replace '"', '\"') + '"' +
                ',"title":"' + ($docTitle -replace '\\', '\\' -replace '"', '\"') + '"' +
                ',"status":' + $code +
                ',"error":' + $err +
                ',"time":"' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '"}'
        Set-Content -Path (Join-Path $root 'probe-result.json') -Value $json -Encoding UTF8
    } catch {}
}

# ---------- single instance (skip in Probe mode) ----------
$mutex = $null
if (-not $Probe) {
    $mutex = New-Object System.Threading.Mutex($false, 'DSHHarness.PSClient.SingleInstance')
    $acquired = $mutex.WaitOne(0)
    TraceLog ("mutex acquired=" + $acquired)
    if (-not $acquired) { Write-Host 'DSH Harness is already running.'; exit 0 }
}

# ---------- load WPF + WinForms + Drawing (fast, reference loads only) ----------
$loadErr = $null
try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
} catch {
    $loadErr = $_.Exception.Message
}

if ($loadErr) {
    $msg = "无法加载 WPF 组件：$loadErr`n`n请改用 DSH Harness.cmd（Edge 模式）。"
    StepLog ('load failed: ' + $loadErr)
    if ($Probe) {
        Set-Content -Path (Join-Path $root 'probe-result.json') -Value '{"ok":false,"error":"load failed"}' -Encoding UTF8
        exit 1
    }
    try { [System.Windows.MessageBox]::Show($msg, $title, 'OK', 'Error') | Out-Null } catch { Write-Host $msg }
    exit 1
}

# ---------- build the window ----------
$darkBg = [System.Windows.Media.Color]::FromRgb(13, 17, 28)
$win = New-Object System.Windows.Window
$win.Title = $title
$win.Background = New-Object System.Windows.Media.SolidColorBrush($darkBg)
$win.UseLayoutRounding = $true

# apply saved geometry (validated against the virtual screen)
if (-not $Probe) {
    $winW = 1500; $winH = 950
    $savedLeft = $null; $savedTop = $null; $savedMax = $false
    try {
        if ($config.width)  { $winW = [double]$config.width }
        if ($config.height) { $winH = [double]$config.height }
        $savedLeft = $config.left
        $savedTop  = $config.top
        if ($config.maximized) { $savedMax = [bool]$config.maximized }
    } catch {}
    $vsW = [System.Windows.SystemParameters]::VirtualScreenWidth
    $vsH = [System.Windows.SystemParameters]::VirtualScreenHeight
    $posOk = $false
    if ($savedLeft -ne $null -and $savedTop -ne $null) {
        $l = [double]$savedLeft; $t = [double]$savedTop
        if ($l -ge -20 -and $l -lt ($vsW - 120) -and $t -ge 0 -and $t -lt ($vsH - 60)) { $posOk = $true }
    }
    if ($posOk) {
        $win.WindowStartupLocation = 'Manual'
        $win.Width = $winW; $win.Height = $winH
        $win.Left = $l; $win.Top = $t
        if ($savedMax) { $win.WindowState = 'Maximized' }
    } else {
        $win.WindowStartupLocation = 'CenterScreen'
        $win.Width = $winW; $win.Height = $winH
    }
} else {
    $win.Width = 900; $win.Height = 600
    $win.ShowInTaskbar = $false
    $win.WindowStartupLocation = 'CenterScreen'
}

# Window/taskbar icon: the official whale, loaded from the PNG render.
try {
    $pngPath = Join-Path $root 'whale-512.png'
    if (Test-Path $pngPath) {
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.UriSource = (New-Object System.Uri($pngPath))
        $bmp.DecodePixelWidth = 64
        $bmp.EndInit()
        $bmp.Freeze()
        $win.Icon = $bmp
    }
} catch { }

$grid = New-Object System.Windows.Controls.Grid

$status = New-Object System.Windows.Controls.TextBlock
$status.Text = "正在连接 DSH 服务 (127.0.0.1:$Port) …"
$status.Foreground = [System.Windows.Media.Brushes]::White
$status.FontSize = 16
$status.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
$status.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
[System.Windows.Controls.Grid]::SetZIndex($status, 1)

$progressPanel = New-Object System.Windows.Controls.StackPanel
$progressPanel.Orientation = 'Horizontal'
$progressPanel.HorizontalAlignment = 'Center'
$progressPanel.VerticalAlignment = 'Center'
$progressPanel.Margin = '0,60,0,0'
$pb = New-Object System.Windows.Controls.ProgressBar
$pb.Width = 240; $pb.Height = 10; $pb.Minimum = 0; $pb.Maximum = 90
$pbText = New-Object System.Windows.Controls.TextBlock
$pbText.Foreground = [System.Windows.Media.Brushes]::White
$pbText.FontSize = 13
$pbText.Margin = '10,0,0,0'
$pbText.VerticalAlignment = 'Center'
[void]$progressPanel.Children.Add($pb)
[void]$progressPanel.Children.Add($pbText)
$progressPanel.Visibility = 'Collapsed'
[System.Windows.Controls.Grid]::SetZIndex($progressPanel, 2)

$btnRetry = New-Object System.Windows.Controls.Button
$btnRetry.Content = '重试'
$btnRetry.Width = 90; $btnRetry.Height = 30
$btnRetry.HorizontalAlignment = 'Center'
$btnRetry.VerticalAlignment = 'Center'
$btnRetry.Margin = '0,115,0,0'
$btnRetry.Visibility = 'Collapsed'
[System.Windows.Controls.Grid]::SetZIndex($btnRetry, 3)

[void]$grid.Children.Add($status)
[void]$grid.Children.Add($progressPanel)
[void]$grid.Children.Add($btnRetry)

$win.Content = $grid
TraceLog 'window built'

# ---------- retry button ----------
$btnRetry.Add_Click({
    $btnRetry.Visibility = 'Collapsed'
    $progressPanel.Visibility = 'Collapsed'
    $status.Visibility = 'Visible'
    $status.Text = '正在重试连接…'
    $win.Title = $title + ' — 正在连接…'
    $script:st.phase = 'connect'
    $script:st.serverStarted = $false
    $script:st.serverStartedAt = $null
    $script:st.serverDeadline = $null
    $script:st.initDeadline = $null
    $script:st.envTask = $null
    $script:reconn.offline = $false
    $script:reconn.fails = 0
})

# ---------- Ctrl+R (works when the window itself has focus) ----------
$win.Add_PreviewKeyDown({
    param($s, $k)
    try {
        $mods = $k.KeyboardDevice.Modifiers
        if (($mods -band [System.Windows.Input.ModifierKeys]::Control) -ne 0 -and $k.Key -eq [System.Windows.Input.Key]::R) {
            $k.Handled = $true
            if ($script:st.wvReady -and $script:wv -and $script:wv.CoreWebView2) {
                try { $script:wv.CoreWebView2.Reload() } catch {}
            } else {
                $script:st.phase = 'connect'
                $script:st.serverStarted = $false
            }
        }
    } catch {}
})

# ---------- window close: tray or exit + save geometry ----------
$win.Add_Closing({
    param($s, $e)
    if ($Probe) { return }
    if ($script:trayOnClose -and -not $script:reallyExit) {
        $e.Cancel = $true
        $win.Hide()
        if (-not $script:balloonShown) {
            $script:balloonShown = $true
            try { $script:tray.ShowBalloonTip(1500, 'DeepSeek Harness', '已最小化到系统托盘。右键托盘鲸鱼图标可退出。', [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
        }
        return
    }
    Save-Geometry
    Stop-NotifyBridge
    if ($script:tray) { try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {} }
})

# ---------- tray icon ----------
if (-not $Probe) {
    try {
        $tray = New-Object System.Windows.Forms.NotifyIcon
        $icoPath = Join-Path $root 'DeepSeek Whale.ico'
        if (Test-Path $icoPath) { $tray.Icon = New-Object System.Drawing.Icon($icoPath) }
        $tray.Text = 'DeepSeek Harness'
        $tray.Visible = $true
        $menu = New-Object System.Windows.Forms.ContextMenuStrip
        $mOpen = New-Object System.Windows.Forms.ToolStripMenuItem('打开主窗口')
        $mOpen.Add_Click({ $win.Show(); $win.WindowState = 'Normal'; $win.Activate() })
        $mTray = New-Object System.Windows.Forms.ToolStripMenuItem('关闭按钮最小化到托盘')
        $mTray.CheckOnClick = $true
        $mTray.Checked = $script:trayOnClose
        $mTray.Add_Click({ $script:trayOnClose = $mTray.Checked; Save-Geometry })
        # P1-5 (2026-08-18): browser / clipboard quick actions
        $mOpenBrowser = New-Object System.Windows.Forms.ToolStripMenuItem('在浏览器打开')
        $mOpenBrowser.Add_Click({ try { [System.Diagnostics.Process]::Start($url) | Out-Null } catch { TraceLog ('open browser error: ' + $_.Exception.Message) } })
        $mCopyUrl = New-Object System.Windows.Forms.ToolStripMenuItem('复制本地地址')
        $mCopyUrl.Add_Click({ try { $null = [System.Windows.Forms.Clipboard]::SetText($url) } catch { TraceLog ('clipboard error: ' + $_.Exception.Message) } })
        # P1-4: manual update check (async -> result read back; blocks briefly on the message box)
        $mUpdate = New-Object System.Windows.Forms.ToolStripMenuItem('检查更新…')
        $mUpdate.Add_Click({
            Invoke-DshUpdateCheck
            $avail = $null
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 400
                $o = Join-Path $root 'update-check.json'
                if (Test-Path $o) { try { $avail = Get-Content $o -Raw | ConvertFrom-Json } catch {}; if ($avail) { break } }
            }
            if ($avail -and $avail.remote -and $avail.remote -ne $avail.local) {
                $r = [System.Windows.Forms.MessageBox]::Show($null, ('发现新版本 v' + $avail.remote + '（当前 v' + $avail.local + '）。`n是否现在一键升级？`n（升级不中断当前服务，重启服务后生效）'), 'DeepSeek Harness 更新检查', 'YesNo', 'Information')
                if ($r -eq 'Yes') { Invoke-DshUpgrade -Remote $avail.remote }
            } else {
                $null = [System.Windows.Forms.MessageBox]::Show($null, ('已是最新版本' + $(if ((-not $avail) -or -not $avail.remote) { '，或无法访问版本源' } elseif ((Get-LocalDshVersion) -ne '') { '（v' + (Get-LocalDshVersion) + '）' } else { '' })), 'DeepSeek Harness 更新检查', 'OK', 'Information')
            }
        })
        $mExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
        $mExit.Add_Click({
            $script:reallyExit = $true
            Save-Geometry
            try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
            $win.Close()
        })
        # P2-7 (2026-08-18): one-click mobile remote - (re)starts the VPS reverse
        # SSH tunnel (dsh-vps-tunnel-loop.ps1) and reports Tailscale/VPS addresses.
        $mRemote = New-Object System.Windows.Forms.ToolStripMenuItem('手机远程（隧道状态）')
        $mRemote.Add_Click({
            $tail = ''
            try {
                $ts = 'C:\Program Files\Tailscale\tailscale.exe'
                if (-not (Test-Path $ts)) { $ts = 'C:\Program Files (x86)\Tailscale\tailscale.exe' }
                if (Test-Path $ts) { $tail = ((& $ts ip -4 2>$null | Select-Object -First 1).Trim()) }
            } catch {}
            $tunnelAlive = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '38443:127\.0\.0\.1:3080' }).Count -gt 0
            if (-not $tunnelAlive) {
                try {
                    $psi = New-Object System.Diagnostics.ProcessStartInfo
                    $psi.FileName = 'powershell.exe'
                    $psi.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'dsh-vps-tunnel-loop.ps1') + '"'
                    $psi.UseShellExecute = $false
                    $psi.CreateNoWindow = $true
                    [System.Diagnostics.Process]::Start($psi) | Out-Null
                    Start-Sleep -Seconds 3
                    $tunnelAlive = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '38443:127\.0\.0\.1:3080' }).Count -gt 0
                } catch { TraceLog ('remote tunnel start error: ' + $_.Exception.Message) }
            }
            $body = 'Tailscale: ' + $(if ($tail) { 'http://' + $tail + ':' + $Port } else { '未检测到 Tailscale' }) + "`n" + 'VPS 反向隧道: ' + $(if ($tunnelAlive) { '已运行（按你的 VPS 转发端口访问）' } else { '未运行' })
            try {
                $n = New-Object System.Windows.Forms.NotifyIcon
                $n.Icon = New-Object System.Drawing.Icon((Join-Path $root 'DeepSeek Whale.ico'))
                $n.Visible = $true
                $n.ShowBalloonTip(6000, 'DeepSeek Harness 手机远程', $body, [System.Windows.Forms.ToolTipIcon]::Info)
                $close = New-Object System.Windows.Threading.DispatcherTimer
                $close.Interval = [TimeSpan]::FromSeconds(7)
                $close.Add_Tick({ $close.Stop(); try { $n.Visible = $false; $n.Dispose() } catch {} })
                $close.Start()
            } catch { TraceLog ('remote toast error: ' + $_.Exception.Message) }
            TraceLog ('remote status: tail=' + $tail + ' tunnel=' + $tunnelAlive)
        })
        # P0-1 (2026-08-18): clean exit that also stops the verified DSH server
        # we may have started - avoids leaving a half-dead listener behind.
        $mExitStop = New-Object System.Windows.Forms.ToolStripMenuItem('退出并停止服务')
        $mExitStop.Add_Click({
            $script:reallyExit = $true
            Save-Geometry
            try { $script:tray.Visible = $false; $script:tray.Dispose() } catch {}
            try {
                $owner = Get-DshLoopbackOwner -Port $Port
                if ($owner.State -eq 'ok') {
                    $stop = Stop-DshLoopbackOwner -Port $Port -ExpectedPid $owner.Pid
                    TraceLog ('clean-exit: stopped DSH pid=' + $owner.Pid + ' result=' + $stop.State)
                } else {
                    TraceLog ('clean-exit: owner state=' + $owner.State + ' (nothing to stop)')
                }
            } catch { TraceLog ('clean-exit stop error: ' + $_.Exception.Message) }
            $win.Close()
        })
        [void]$menu.Items.Add($mOpen)
        [void]$menu.Items.Add($mOpenBrowser)
        [void]$menu.Items.Add($mCopyUrl)
        [void]$menu.Items.Add($mRemote)
        [void]$menu.Items.Add($mUpdate)
        [void]$menu.Items.Add($mTray)
        [void]$menu.Items.Add($mExitStop)
        [void]$menu.Items.Add($mExit)
        $tray.ContextMenuStrip = $menu
        $tray.Add_DoubleClick({ $win.Show(); $win.WindowState = 'Normal'; $win.Activate() })
        $script:tray = $tray
    } catch { $script:tray = $null }
}

# ---------- P1-3: dsh event -> Windows notification bridge ----------
# A small background node process subscribes to /api/events.mux and raises
# high-value Windows toasts (task done/failed, needs your answer, approvals).
# Controlled by client-config.json `notifyEvents` (default true; false disables).
$script:notifyBridge = $null
function Start-NotifyBridge {
    try {
        if ($config.notifyEvents -eq $false) { TraceLog 'notify bridge disabled by config (notifyEvents=false)'; return }
        if ($script:notifyBridge) { return }
        $node = Join-Path $root 'node-runtime\node.exe'
        if (-not (Test-Path $node)) {
            $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { TraceLog 'notify bridge: no node runtime found'; return }
            $node = $cmd.Source
        }
        $bridge = Join-Path $root 'dsh-event-notify.mjs'
        if (-not (Test-Path $bridge)) { TraceLog 'notify bridge: script missing'; return }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $node
        $psi.Arguments = '"' + $bridge + '" --port ' + $Port
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables['DSH_NOTIFY_DATA'] = $dataRoot
        $script:notifyBridge = [System.Diagnostics.Process]::Start($psi)
        try { Set-Content -Path (Join-Path $dataRoot 'notify-bridge.pid') -Value $script:notifyBridge.Id -Encoding UTF8 } catch {}
        TraceLog ('notify bridge started pid=' + $script:notifyBridge.Id)
        $script:notifyBridge.EnableRaisingEvents = $true
        $script:notifyBridge.Add_Exited({
            try { $script:notifyBridge = $null } catch {}
            TraceLog 'notify bridge exited'
        })
    } catch { TraceLog ('notify bridge start error: ' + $_.Exception.Message) }
}
function Stop-NotifyBridge {
    try {
        if ($script:notifyBridge) { try { $script:notifyBridge.Kill() } catch {}; $script:notifyBridge = $null; TraceLog 'notify bridge stopped' }
        $pidFile = Join-Path $dataRoot 'notify-bridge.pid'
        if (Test-Path $pidFile) {
            try {
                $oldPid = [int]((Get-Content $pidFile -Raw) -replace '\D', '')
                if ($oldPid -gt 0 -and $oldPid -ne $PID) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
            } catch {}
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }
    } catch { TraceLog ('notify bridge stop error: ' + $_.Exception.Message) }
}

# ---------- P1-4: upstream dsh update check + one-click upgrade ----------
# Shows a toast when a NEWER upstream dsh exists; upgrading is always
# user-confirmed (never automatic) and never touches the running server.
$script:updateAvail = $null
function Get-LocalDshVersion {
    $cands = @((Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json'))
    if (Test-Path $cands[0]) {
        try { $j = Get-Content $cands[0] -Raw | ConvertFrom-Json; if ($j.version) { return [string]$j.version } } catch {}
    }
    $npx = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    if (Test-Path $npx) {
        foreach ($d in (Get-ChildItem $npx -Directory -ErrorAction SilentlyContinue)) {
            $cand = Join-Path $d.FullName 'node_modules\@deepseek-ai\dsh\package.json'
            if (Test-Path $cand) { try { $j = Get-Content $cand -Raw | ConvertFrom-Json; if ($j.version) { return [string]$j.version } } catch {} }
        }
    }
    return ''
}
function Test-DshVersionNewer([string]$a, [string]$b) {
    # true when b (remote) is newer than a (local); safe on rc/prerelease strings
    try {
        $pa = [version](($a -split '-')[0]); $pb = [version](($b -split '-')[0])
        if ($pb -gt $pa) { return $true }
    } catch {}
    return $false
}
function Invoke-DshUpdateCheck {
    # spawn a background powershell that queries npm and writes update-check.json
    try {
        $out = Join-Path $root 'update-check.json'
        $local = Get-LocalDshVersion
        $code = "`$ErrorActionPreference='Continue'; `$out=`$args[0]; `$l=`$args[1]; `$r=''; try { `$rr = npm view @deepseek-ai/dsh version 2>`$null; if (`$rr) { `$r=(`$rr | Select-Object -Last 1).Trim() } } catch {}; @{local=`$l; remote=`$r; at=(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')} | ConvertTo-Json | Set-Content -Path `$out -Encoding UTF8"
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command ' + '"' + $code + '" "' + $out + '" "' + $local + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $root
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        TraceLog ('update check started (local=' + $local + ')')
    } catch { TraceLog ('update check spawn error: ' + $_.Exception.Message) }
}
function Test-DshUpdateAvail {
    # read the background result; null when not ready / no network / up to date
    $o = Join-Path $root 'update-check.json'
    if (-not (Test-Path $o)) { return $null }
    try {
        $d = Get-Content $o -Raw | ConvertFrom-Json
        if (-not $d.remote -or -not $d.local) { return $null }
        if (Test-DshVersionNewer $d.local $d.remote) { return $d }
    } catch { return $null }
    return $null
}
function Invoke-DshUpgrade([string]$Remote) {
    try {
        $log = Join-Path $env:LOCALAPPDATA 'DSHHarness\logs\update.log'
        New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'npm.cmd'
        $psi.Arguments = 'install -g @deepseek-ai/dsh@' + $Remote
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = $env:USERPROFILE
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $err = $p.StandardError.ReadToEnd()
        $p.WaitForExit(120000)
        Add-Content $log ("{0}  upgrade->{1} exit={2} {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Remote, $p.ExitCode, ($out.Trim() + ' ' + $err.Trim()))
        $null = [System.Windows.Forms.MessageBox]::Show($null, ('升级完成（exit ' + $p.ExitCode + '）。`n当前连接中的服务不受影响，下次重启服务后生效。'), 'DeepSeek Harness 更新', 'OK', 'Information')
    } catch {
        TraceLog ('upgrade error: ' + $_.Exception.Message)
        try { $null = [System.Windows.Forms.MessageBox]::Show($null, ('升级失败：' + $_.Exception.Message), 'DeepSeek Harness 更新', 'OK', 'Error') } catch {}
    }
}

# ---------- quota timers ----------
# follow the current model from ~/.dsh/settings.yaml (every 5s)
$settingsTimer = New-Object System.Windows.Threading.DispatcherTimer
$settingsTimer.Interval = [TimeSpan]::FromSeconds(5)
$settingsTimer.Add_Tick({
    $model = Read-CurrentModel
    if ($model -and $model -ne $script:currentModel) {
        $script:currentModel = $model
        Add-QuotaModel $model
        Update-QuotaUI
    }
})
$settingsTimer.Start()

# balance refresh (every 20s)
$quotaTimer = New-Object System.Windows.Threading.DispatcherTimer
$quotaTimer.Interval = [TimeSpan]::FromSeconds(20)
$quotaTimer.Add_Tick({ if ($script:quotaKey -ne '') { Start-QuotaFetch }; if ($script:mimoCookie -ne '') { Start-MiMoFetch }; Start-GoFetch })
$quotaTimer.Start()
# one-shot initial fetch shortly after launch
$initTimer = New-Object System.Windows.Threading.DispatcherTimer
$initTimer.Interval = [TimeSpan]::FromSeconds(2)
$initTimer.Add_Tick({ $initTimer.Stop(); if ($script:quotaKey -ne '') { Start-QuotaFetch }; if ($script:mimoCookie -ne '') { Start-MiMoFetch }; Start-GoFetch })
$initTimer.Start()
# retry widget injection until the web app has rendered its sidebar
$injectTimer = New-Object System.Windows.Threading.DispatcherTimer
$injectTimer.Interval = [TimeSpan]::FromSeconds(3)
$injectTimer.Add_Tick({ if ($script:st.wvReady) { Inject-QuotaWidget } })
$injectTimer.Start()

# initial model read + quota render
$model0 = Read-CurrentModel
if ($model0) {
    $script:currentModel = $model0
    Add-QuotaModel $model0
}
Update-QuotaUI

# diagnostics hook: auto-open the MiMo login window when DSH_MIMO_AUTOTEST=1
if ($env:DSH_MIMO_AUTOTEST -eq '1') {
    $autoTimer = New-Object System.Windows.Threading.DispatcherTimer
    $autoTimer.Interval = [TimeSpan]::FromSeconds(8)
    $autoTimer.Add_Tick({ $autoTimer.Stop(); TraceLog 'autotest: opening mimo login'; Open-MiMoLogin })
    $autoTimer.Start()
}

# MiMo reconnect policy (2026-08-14): the hidden offscreen renewal window fails to
# initialize WebView2 on this machine (init FAILED, empty exception), so reconnect
# uses the visible login window instead: it auto-logs-in via the saved SSO session,
# the navigation handler auto-captures the cookies ~3s after the console loads, and
# the window closes itself on success. While connected, no periodic popups: the
# session cookie lasts ~1 day and a 401 on the balance API triggers re-login.
$mimoRenewTimer = New-Object System.Windows.Threading.DispatcherTimer
$mimoRenewTimer.Interval = [TimeSpan]::FromMinutes(30)
$mimoRenewTimer.Add_Tick({ if ($script:mimoCookie -eq '') { TraceLog 'mimo: disconnected, attempting reconnect'; Open-MiMoLogin } })
$mimoRenewTimer.Start()
# renewal state-machine driver (cheap when idle)
$mimoRenewTick = New-Object System.Windows.Threading.DispatcherTimer
$mimoRenewTick.Interval = [TimeSpan]::FromSeconds(2)
$mimoRenewTick.Add_Tick({ Update-MiMoRenewal })
$mimoRenewTick.Start()
# startup auto-reconnect: if not connected, open the login window once (SSO usually
# still alive -> auto-capture -> connect -> window closes itself)
$mimoStartDiag = New-Object System.Windows.Threading.DispatcherTimer
$mimoStartDiag.Interval = [TimeSpan]::FromSeconds(15)
$mimoStartDiag.Add_Tick({
    $mimoStartDiag.Stop()
    if ($script:mimoCookie -eq '') { TraceLog 'mimo startup: not connected, trying auto-reconnect'; Open-MiMoLogin }
})
$mimoStartDiag.Start()

# P1-3: once the UI is up (phase done + webview ready), start the notification
# bridge. A retry when the server is rebooting is fine - the bridge reconnects.
$notifyBridgeTimer = New-Object System.Windows.Threading.DispatcherTimer
$notifyBridgeTimer.Interval = [TimeSpan]::FromSeconds(5)
$notifyBridgeTimer.Add_Tick({
    if ($Probe) { return }   # probe mode: skip the bridge (no toast on self-test)
    if ($script:st.phase -eq 'done' -and $script:st.wvReady -and -not $script:notifyBridge) {
        Start-NotifyBridge
    }
})
$notifyBridgeTimer.Start()

# P1-4: silent update check shortly after launch. Checks once; if a newer
# upstream dsh exists, shows a toast pointing at tray -> 检查更新 (one-click).
$updateTimer = New-Object System.Windows.Threading.DispatcherTimer
$updateTimer.Interval = [TimeSpan]::FromSeconds(4)
$updateTimer.Add_Tick({
    if ($Probe) { return }
    $updateTimer.Interval = [TimeSpan]::FromSeconds(12)   # next tick becomes the "read result" pass
    if (-not $script:updateChecked) {
        $script:updateChecked = $true
        if (Test-Path (Join-Path $root 'update-check.json')) { Remove-Item (Join-Path $root 'update-check.json') -Force -ErrorAction SilentlyContinue }
        Invoke-DshUpdateCheck
    } else {
        $updateTimer.Stop()
        $avail = Test-DshUpdateAvail
        if ($null -ne $avail -and $avail.remote) {
            TraceLog ('update available: local=' + $avail.local + ' remote=' + $avail.remote)
            try {
                $n = New-Object System.Windows.Forms.NotifyIcon
                $n.Icon = New-Object System.Drawing.Icon((Join-Path $root 'DeepSeek Whale.ico'))
                $n.Visible = $true
                $n.ShowBalloonTip(6000, 'DSH 有更新', ('发现新版本 v' + $avail.remote + '（当前 v' + $avail.local + '），右键托盘 → 检查更新 → 一键升级。'), [System.Windows.Forms.ToolTipIcon]::Info)
                $close = New-Object System.Windows.Threading.DispatcherTimer
                $close.Interval = [TimeSpan]::FromSeconds(7)
                $close.Add_Tick({ $close.Stop(); try { $n.Visible = $false; $n.Dispose() } catch {} })
                $close.Start()
            } catch { TraceLog ('update toast error: ' + $_.Exception.Message) }
        }
    }
})
$updateTimer.Start()

# ---------- state machine timer ----------
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
    $phase = $script:st.phase

    if ($phase -eq 'connect') {
        # lazy WebView2 setup on the first tick (window already visible -> faster start)
        if (-not $script:st.wvLoaded) {
            $script:st.wvLoaded = $true
            try {
                $env:PATH = $root + ';' + $env:PATH   # so WebView2Loader.dll (native) can be resolved
                [System.Reflection.Assembly]::LoadFrom((Join-Path $root 'Microsoft.Web.WebView2.Core.dll')) | Out-Null
                [System.Reflection.Assembly]::LoadFrom((Join-Path $root 'Microsoft.Web.WebView2.Wpf.dll'))  | Out-Null
                $script:wv = New-Object Microsoft.Web.WebView2.Wpf.WebView2
                $script:wv.DefaultBackgroundColor = [System.Drawing.Color]::FromArgb(255, 13, 17, 28)
                [System.Windows.Controls.Grid]::SetZIndex($script:wv, 0)
                [void]$grid.Children.Add($script:wv)
                $script:wv.Add_CoreWebView2InitializationCompleted({
                    param($sender, $e)
                    StepLog ('InitializationCompleted: success=' + $e.IsSuccess)
                    if ($e.IsSuccess) {
                        $script:st.wvReady = $true
                        $status.Text = '正在加载界面…'
                        try {
                            # Ctrl+R inside the web content
                            $sender.CoreWebView2.Add_AcceleratorKeyPressed({
                                param($w, $a)
                                try {
                                    if ($a.Key -eq 0x52 -and ($a.Modifiers -band 2) -ne 0) {
                                        $a.Handled = $true
                                        try { $w.CoreWebView2.Reload() } catch {}
                                    }
                                } catch {}
                            })
                        } catch {}
                        try {
                            # receive the API key typed into the injected widget
                            $sender.CoreWebView2.Add_WebMessageReceived({
                                param($w, $e)
                                try {
                                    $v = $e.TryGetWebMessageAsString()
                                    if ($v -and $v.StartsWith('__DSH_')) {
                                        if ($v -eq '__DSH_Q_WIDGET_OK__') { TraceLog 'quota widget injected OK' }
                                        if ($v -eq '__DSH_Q_MIMO_OK__') { TraceLog 'quota widget rendered MiMo OK' }
                                        if ($v -eq '__DSH_MIMO_CONNECT__') { TraceLog 'mimo connect requested'; Open-MiMoLogin }

                                        return
                                    }
                                    if ($v -and $v.Length -ge 10) {
                                        $script:quotaKey = $v
                                        Save-QuotaConfig
                                        Start-QuotaFetch
                                    }
                                } catch { TraceLog ('webmsg error: ' + $_.Exception.Message) }
                            })
                        } catch {}
                        $sender.CoreWebView2.Navigate($url)
                    } else {
                        $status.Text = 'WebView2 初始化失败，可点击重试'
                        $btnRetry.Visibility = 'Visible'
                        $win.Title = $title + ' — 连接失败'
                        if ($Probe) { Write-ProbeResult $null; $win.Close() }
                    }
                })
                $script:wv.Add_NavigationCompleted({
                    param($s, $a)
                    StepLog ('NavigationCompleted: ok=' + $a.IsSuccess + ' status=' + $a.HttpStatusCode + ' url=' + $s.Source)
                    if ($a.IsSuccess) {
                        $status.Visibility = [System.Windows.Visibility]::Collapsed
                        $win.Title = $title + ' — 服务在线'
                        $script:reconn.fails = 0
                        $script:reconn.offline = $false
                        Inject-QuotaWidget
                    } else {
                        $status.Text = '页面加载失败，可点击重试或按 Ctrl+R'
                        $status.Visibility = [System.Windows.Visibility]::Visible
                        $btnRetry.Visibility = 'Visible'
                        $win.Title = $title + ' — 连接失败'
                    }
                    if ($script:st.phase -ne 'done') {
                        $script:st.phase = 'done'
                        if ($Probe) { Write-ProbeResult $a; $win.Close() }
                    }
                })
                TraceLog 'webview loaded + created'
            } catch {
                TraceLog ('webview load FAILED: ' + $_.Exception.Message)
                $status.Text = '初始化失败：' + $_.Exception.Message
                $btnRetry.Visibility = 'Visible'
            }
        }
        # kick off WebView2 environment creation in the background (parallel with server check)
        if (-not $script:st.envTask) {
            try {
                $script:st.envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, (Get-DataDir), $null)
            } catch { $script:st.envTask = $null }
        }
        if (Test-Server) {
            $script:st.phase = 'init'
            $progressPanel.Visibility = 'Collapsed'
            StepLog 'server up -> init'
        } else {
            if (-not $script:st.serverStarted) {
                $script:st.serverStarted = $true
                $script:st.serverStartedAt = Get-Date
                $script:st.serverDeadline = $script:st.serverStartedAt.AddSeconds(90)
                $status.Text = 'DSH 服务未运行，正在尝试启动…'
                $progressPanel.Visibility = 'Visible'
                $pb.Value = 0
                $pbText.Text = '0/90 秒'
                $win.Title = $title + ' — 正在启动服务…'
                StepLog 'starting dsh server'
                Start-DshServer | Out-Null
            } elseif ((Get-Date) -gt $script:st.serverDeadline) {
                $script:st.phase = 'init'
                $progressPanel.Visibility = 'Collapsed'
                $status.Text = '无法启动 DSH 服务，仍将尝试打开页面。'
                $btnRetry.Visibility = 'Visible'
                $win.Title = $title + ' — 服务离线'
                StepLog 'server start timed out'
            } else {
                $waited = [int]((Get-Date) - $script:st.serverStartedAt).TotalSeconds
                $pb.Value = [Math]::Min(90, $waited)
                $pbText.Text = "$waited/90 秒"
                $status.Text = "等待服务启动… $waited/90 秒"
                $win.Title = $title + " — 正在启动服务… ($waited/90)"
            }
        }
        return
    }

    if ($phase -eq 'init') {
        $script:st.phase = 'initializing'
        $script:st.initDeadline = (Get-Date).AddSeconds(30)
        $status.Text = '正在初始化界面…'
        $win.Title = $title + ' — 正在加载…'
        StepLog 'init'
        try {
            if ($script:st.wvReady) {
                # already initialized (e.g. after a retry): just navigate again
                StepLog 're-navigating'
                $script:wv.CoreWebView2.Navigate($url)
            } else {
                $env2 = $script:st.envTask.GetAwaiter().GetResult()
                StepLog 'env ready'
                $null = $script:wv.EnsureCoreWebView2Async($env2)
                StepLog 'EnsureCoreWebView2Async fired'
            }
        } catch {
            StepLog ('init EXCEPTION: ' + $_.Exception.Message)
            $status.Text = '初始化失败：' + $_.Exception.Message + "`n可点击重试"
            $btnRetry.Visibility = 'Visible'
            $script:st.phase = 'done'
            if ($Probe) { Write-ProbeResult $null; $win.Close() }
        }
        return
    }

    if ($phase -eq 'initializing' -and $Probe) {
        if ((Get-Date) -gt $script:st.initDeadline) {
            StepLog 'init/navigation timed out'
            $status.Text = '界面初始化超时。'
            $script:st.phase = 'done'
            Write-ProbeResult $null
            $win.Close()
        }
        return
    }
})
$timer.Start()
TraceLog 'timer started'

# ---------- auto-reconnect: if the server drops, reload when it returns ----------
if (-not $Probe) {
    $reconnTimer = New-Object System.Windows.Threading.DispatcherTimer
    $reconnTimer.Interval = [TimeSpan]::FromSeconds(3)
    $reconnTimer.Add_Tick({
        if ($script:st.phase -ne 'done' -or -not $script:st.wvReady -or -not $script:wv) { return }
        try {
            if (Test-Server) {
                if ($script:reconn.offline) {
                    $script:reconn.offline = $false
                    $script:reconn.fails = 0
                    $status.Text = '服务已恢复，正在重新加载…'
                    $status.Visibility = [System.Windows.Visibility]::Visible
                    try { $script:wv.CoreWebView2.Reload() } catch { try { $script:wv.CoreWebView2.Navigate($url) } catch {} }
                    $win.Title = $title + ' — 服务在线'
                } else {
                    $script:reconn.fails = 0
                }
            } else {
                $script:reconn.fails++
                if (-not $script:reconn.offline -and $script:reconn.fails -ge 2) {
                    $script:reconn.offline = $true
                    $status.Text = '服务离线，等待重连…'
                    $status.Visibility = [System.Windows.Visibility]::Visible
                    $win.Title = $title + ' — 服务离线'
                }
            }
        } catch {}
    })
    $reconnTimer.Start()
}

StepLog 'window shown, app.Run'
$app = New-Object System.Windows.Application
# never flash-crash: log any unhandled UI exception and keep running
$app.add_DispatcherUnhandledException({
    param($s, $e)
    TraceLog ('UNHANDLED UI EXCEPTION: ' + $e.Exception.ToString())
    $e.Handled = $true
})
$app.Run($win) | Out-Null

if ($mutex) { $mutex.Dispose() }
TraceLog 'exited cleanly'
StepLog 'exited cleanly'
