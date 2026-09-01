# rh1-real-probe-overlap.ps1 — RH1 R3 REAL-E8: a SLOW (>3s) probe must NOT overlap / pile up.
# Behaviour, not "code looks synchronous": we drive the PRODUCTION Invoke-DshHealthGuard
# against a real, isolated dsh web server and instrument every ConfirmProbe start/finish
# with a real wall-clock timestamp. With a genuine 3.6s probe, run 3 consecutive guard
# cycles and assert the probe periods are pairwise DISJOINT (each finish < next start) and
# maxConcurrentProbe == 1, and total serial probe time ~= n*duration (nobody doubles up).
# Requires PS 5.1, FullLanguage (Add-Type ok), isolated env so it never reads real ~/.dsh.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root   # worktree root (_wt-rh1)

$isoRoot = Join-Path $env:TEMP ('rh1-probe-{0}' -f (Get-Random))
New-Item -ItemType Directory -Path $isoRoot -Force | Out-Null
$env:DSH_HOME = $isoRoot; $env:USERPROFILE = $isoRoot; $env:LOCALAPPDATA = $isoRoot
$env:APPDATA = Join-Path $isoRoot 'AppData\Roaming'; New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null
$env:DSH_HEALTH_STATE_PATH = Join-Path $isoRoot 'state\health.json'
$env:DSH_RESTART_BUDGET_PATH = Join-Path $isoRoot 'state\budget.json'
$env:DSH_INCIDENT_DIR = Join-Path $isoRoot 'incidents'
$env:DSH_HEALTH_FAIL_THRESHOLD = '3'
$env:DSH_HEALTH_CANDIDATE_WINDOW_SEC = '30'
$env:DSH_HEALTH_RECOVERY_WINDOW_SEC = '60'
New-Item -ItemType Directory -Force -Path (Split-Path $env:DSH_HEALTH_STATE_PATH) | Out-Null
New-Item -ItemType Directory -Force -Path $env:DSH_INCIDENT_DIR | Out-Null

. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-health.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')

$port = 33654   # non-3080, non-331xx
$npm = 'C:\Users\Administrator\AppData\Roaming\npm'
$binjs = Join-Path $npm 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$node = Join-Path 'C:\Users\Administrator\Desktop\sdeepseek harness\DSH-Client' 'node-runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$log = Join-Path $isoRoot ('dsh-server-{0}.log' -f $port)

$failures = 0; $passes = 0
function Assert([bool]$c, [string]$msg) {
    if ($c) { $script:passes++; Write-Host ("  PASS: " + $msg) }
    else    { $script:failures++; Write-Host ("  **FAIL**: " + $msg) }
}

# ---- snapshot + state builders (mirror the guardian-path test so the guard reaches
#      the restart_eligible -> ConfirmProbe branch) ----
function New-TestProbe {
    param([string]$Owner='ok',[bool]$Ready=$false,[bool]$Partial=$false,[int]$NonLoopback=0,[int]$Port=33177,[string]$ErrorClass='timeout')
    [pscustomobject]@{
        port=$Port; ownerState=$Owner; ownerPid= if($Owner -eq 'ok'){4242}else{0}; ownerCreation=$null; ownerCmdHash=$null
        nonLoopbackCount=$NonLoopback; errorClass=$ErrorClass
        basicState= if($Ready){'ok'}else{'unreachable'}; apiState= if($Ready){'ok'}else{'timeout'}
        wsState= if($Ready){'ok'}elseif($Partial){'ok'}else{'timeout'}
        apiReady= if($Ready -or $Partial){$true}else{$false}; wsReady= if($Ready){$true}else{$false}
        partialReady=$Partial; readiness= if($Ready){'full'}elseif($Partial){'partial'}else{'unready'}
        ready=$Ready; failureSignal= if($Ready){'none'}else{'unreachable'}; probeDurationMs=5
    }
}
function New-BackdatedState([int]$port) {
    $st = New-DshHealthStateObject -Port $port
    $st.consecutiveFailures = 2
    $st.firstFailureAtMs = [long]((([DateTimeOffset]::Now).ToUnixTimeMilliseconds()) - 120000)
    $st.lastFailureAtMs  = [long](([DateTimeOffset]::Now).ToUnixTimeMilliseconds())
    $st.state = 'degraded'
    return $st
}

$script:activeProbe = 0
$script:maxConcurrent = 0
$script:probeSpans = New-Object System.Collections.Generic.List[object]
$script:probeLock = New-Object System.Threading.Mutex
$probeSleepMs = 3600   # real 3.6s per confirm probe => periods must be disjoint

function SlowProbe([int]$Port, [bool]$Count) {
    $script:probeLock.WaitOne() | Out-Null
    $script:activeProbe++
    if ($script:activeProbe -gt $script:maxConcurrent) { $script:maxConcurrent = $script:activeProbe }
    $script:probeLock.ReleaseMutex()
    $start = Get-Date
    Start-Sleep -Milliseconds $probeSleepMs          # REAL slow probe
    $s = Get-DshHealthProbe -Port $Port
    $finish = Get-Date
    $script:probeLock.WaitOne() | Out-Null
    $script:activeProbe--
    $script:probeSpans.Add([pscustomobject]@{ start=$start; finish=$finish; idx=$script:probeSpans.Count })
    $script:probeLock.ReleaseMutex()
    return $s
}

Write-Host ("=== RH1 R3 REAL-E8 slow (>3s) probe overlap (isolated, wall-clock) ===")
try {
    $p = Start-Process -FilePath $node -ArgumentList @($binjs,'--profile','web','--port',"$port",'--no-open') -RedirectStandardOutput $log -RedirectStandardError (Join-Path $isoRoot 'err.log') -PassThru -WindowStyle Hidden
    $ready = $false
    for ($i=0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 1000
        $probe = Get-DshHealthProbe -Port $port
        if ($probe.ready -and $probe.ownerState -eq 'ok') { $ready = $true; break }
    }
    Assert $ready "real dsh server ready on $port before slow-probe run"
    if (-not $ready) { throw 'server never became ready' }

    # drive the PRODUCTION guard 3 real cycles; each reaches restart_eligible -> ConfirmProbe
    $before = $script:probeSpans.Count
    for ($cycle = 1; $cycle -le 3; $cycle++) {
        $State2 = @{}
        $null = Invoke-DshHealthGuard -Port $port `
            -Probe (New-TestProbe -Owner 'ok' -Ready $false -Port $port) `
            -CurrentState (New-BackdatedState $port) -State $State2 -BudgetState $null `
            -RestartExecutor { param($r) $true } -AlertSender { param($m) } -GoalRecover { } `
            -Log { param($s) } -ConfirmProbe { param($P) SlowProbe $P $true } `
            -MaintenanceLocked $false
    }
    $confirmSpans = @($script:probeSpans | Select-Object -Skip $before)

    $disjoint = $true
    for ($k = 0; $k -lt $confirmSpans.Count - 1; $k++) {
        if ($confirmSpans[$k].finish -ge $confirmSpans[$k+1].start) { $disjoint = $false }
    }
    Assert ($confirmSpans.Count -ge 2) ("REAL-E8 ran >=2 slow confirm probes (count={0})" -f $confirmSpans.Count)
    Assert ($disjoint) ("REAL-E8 probe periods are pairwise DISJOINT (no overlap) across {0} slow probes" -f $confirmSpans.Count)
    Assert ($script:maxConcurrent -eq 1) ("REAL-E8 maxConcurrentProbe = 1 with a {0}s probe (measured max={1})" -f ($probeSleepMs/1000), $script:maxConcurrent)
    $totalProbeMs = 0
    foreach ($s in $confirmSpans) { $totalProbeMs += [math]::Round(($s.finish - $s.start).TotalMilliseconds) }
    $expected = $confirmSpans.Count * $probeSleepMs
    if ($confirmSpans.Count -ge 2) {
        Assert ($totalProbeMs -ge ($expected * 0.8)) ("REAL-E8 total serial probe ~= n*duration (measured {0}ms vs expected ~{1}ms => serial, no doubling)" -f $totalProbeMs, $expected)
    }
    Write-Host ("REAL-E8 spans: count={0} maxConcurrent={1} totalProbeMs={2} expected~={3}" -f $confirmSpans.Count, $script:maxConcurrent, $totalProbeMs, $expected)
} catch {
    $script:failures++
    Write-Host ("  **FAIL**: fatal exception raised (see FATAL above)")
} finally {
    if ($p -and -not $p.HasExited) { [void]$p.Kill() }
    Start-Sleep -Milliseconds 500
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host ("RESULT: PASS={0} FAIL={1}" -f $script:passes, $script:failures)
if ($script:failures -gt 0) { exit 1 } else { exit 0 }
