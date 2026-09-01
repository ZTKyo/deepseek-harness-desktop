# rh1-real-append-only.ps1 — R2 append-only restart evidence.
# Proves the CANONICAL start-dsh-server.ps1 restarts APPEND to the per-port dsh
# server log rather than truncating it. Runs with REAL env (real config + real
# dsh entry + node v22) on a THROWAWAY port 33651 (NOT 3080), and kills + cleans
# up after. Sentinel written between two canonical boots; verification:
#   * boot#1 writes a runner-start marker  (markerCount >= 1)
#   * sentinel (written after boot#1) is preserved after boot#2  -> NOT truncated
#   * boot#2 appends a 2nd runner-start marker (markerCount >= 2) -> appended
#   * file length grew past the sentinel (afterLen > sentinelOffset)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root
$port = 33651
$sds = Join-Path $root 'start-dsh-server.ps1'
$logReal = Join-Path $env:LOCALAPPDATA ("DSHHarness\logs\dsh-server-{0}.log" -f $port)
$stateFile = Join-Path $env:LOCALAPPDATA ("DSHHarness\state\dsh-health-{0}.json" -f $port)
$epoch = [guid]::NewGuid().ToString('N').Substring(0,8)
$passes = 0; $failures = 0
function Assert([bool]$c,[string]$m){ if($c){$script:passes++;Write-Host ("  PASS: "+$m)}else{$script:failures++;Write-Host ("  **FAIL**: "+$m)} }
function Stop-CanonicalServer {
    foreach ($lc in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { Stop-Process -Id ([int]$lc.OwningProcess) -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}
function Wait-LogMarker([int]$ExpectedMin) {
    for ($i=0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 1000; if (Test-Path $logReal) { $c = (Get-Content $logReal -Raw); $n = ([regex]::Matches($c,'dsh server runner start')).Count; if ($n -ge $ExpectedMin) { return $n } } }
    $c = if (Test-Path $logReal) { Get-Content $logReal -Raw } else { '' }
    return ([regex]::Matches($c,'dsh server runner start')).Count
}

Write-Host ("=== RH1 R2 APPEND-ONLY restart evidence (real env, port {0}) ===" -f $port)
# start clean
New-Item -ItemType Directory -Force -Path (Split-Path $logReal) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $stateFile) | Out-Null
if (Test-Path $logReal) { Remove-Item -LiteralPath $logReal -Force -ErrorAction SilentlyContinue }
if (Test-Path $stateFile) { Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue }

try {
    # ---- boot #1: canonical authority, real env ----
    $argLine = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1} -LockAlreadyHeld' -f $sds,$port)
    $null = Start-Process -FilePath 'powershell' -ArgumentList $argLine `
        -RedirectStandardOutput (Join-Path $env:TEMP ("rh1-ao-{0}-b1.out" -f $epoch)) `
        -RedirectStandardError  (Join-Path $env:TEMP ("rh1-ao-{0}-b1.err" -f $epoch)) -PassThru -WindowStyle Hidden
    $marker1 = Wait-LogMarker 1
    Assert ($marker1 -ge 1) ("boot#1 wrote runner-start marker (marker={0})" -f $marker1)
    Stop-CanonicalServer

    # ---- sentinel written AFTER boot#1, into the SAME log the restart appends to ----
    $sentinelTag = 'BEFORE_RESTART_SENTINEL_' + $epoch
    Add-Content -Path $logReal -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$sentinelTag) -Encoding UTF8
    $sentinelOffset = (Get-Item $logReal).Length

    # ---- boot #2 = the restart ----
    $null = Start-Process -FilePath 'powershell' -ArgumentList $argLine `
        -RedirectStandardOutput (Join-Path $env:TEMP ("rh1-ao-{0}-b2.out" -f $epoch)) `
        -RedirectStandardError  (Join-Path $env:TEMP ("rh1-ao-{0}-b2.err" -f $epoch)) -PassThru -WindowStyle Hidden
    # wait for a fresh dsh boot banner to appear AFTER the sentinel (append, not truncate)
    $bannerRe = 'dsh web: http://127\.0\.0\.1:' + $port
    $sentinelIdx = -1; $bannerMax = -1
    for ($i=0; $i -lt 45; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-Path $logReal) {
            $log2 = Get-Content $logReal -Raw
            $sentinelIdx = $log2.IndexOf($sentinelTag)
            $bm = ([regex]::Matches($log2, 'dsh web: http://127\.0\.0\.1:' + $port).Index)
            if ($bm.Count -gt 0) { $bannerMax = ($bm | Measure-Object -Maximum).Maximum } else { $bannerMax = -1 }
            if ($sentinelIdx -ge 0 -and $bannerMax -gt $sentinelIdx) { break }
        }
    }
    $log2 = Get-Content $logReal -Raw
    $afterLen = (Get-Item $logReal).Length
    Assert (($sentinelIdx -ge 0))                  ("sentinel preserved in log after restart (sentinelIdx={0})" -f $sentinelIdx)
    Assert (($bannerMax -gt $sentinelIdx))         ("boot#2 appended a fresh dsh boot banner AFTER the sentinel (sentinelIdx={0} bannerIdx={1})" -f $sentinelIdx, $bannerMax)
    Assert (($afterLen -gt $sentinelOffset))       ("log grew past sentinel (pre={0} after={1})" -f $sentinelOffset,$afterLen)
    Stop-CanonicalServer
} catch {
    Write-Host ("FATAL: "+$_.Exception.Message)
    $script:failures++
    Write-Host ("  **FAIL**: fatal exception raised (see FATAL above)")
} finally {
    Stop-CanonicalServer
    @((Join-Path $env:TEMP ("rh1-ao-{0}-b1.out" -f $epoch)),(Join-Path $env:TEMP ("rh1-ao-{0}-b1.err" -f $epoch)),(Join-Path $env:TEMP ("rh1-ao-{0}-b2.out" -f $epoch)),(Join-Path $env:TEMP ("rh1-ao-{0}-b2.err" -f $epoch))) | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
    if ($failures -eq 0) { Remove-Item -LiteralPath $logReal -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue }
    else { Write-Host ("EVIDENCE_LOG (kept for inspection): {0}" -f $logReal) }
}
Write-Host ("RESULT: PASS={0} FAIL={1}" -f $passes,$failures)
# FAIL-CLOSED: exit non-zero if any assertion or fatal recorded a failure.
if ($failures -gt 0) { exit 1 } else { exit 0 }
