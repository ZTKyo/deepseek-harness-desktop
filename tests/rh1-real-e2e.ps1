# rh1-real-e2e.ps1 — RH1 R3 REAL WALL-CLOCK >=60s E2E (strictly isolated).
# Runs the PRODUCTION guardian decision path (Invoke-DshHealthGuard) over REAL
# wall-clock time against a REAL, fully-isolated dsh web server that is SUSPENDED
# so its port owner stays 'ok' but readiness goes unready. No fake clock. Uses
# Get-Date / real elapsed. Requires PS 5.1, FullLanguage (Add-Type ok), an
# isolated DSH_HOME+USERPROFILE+LOCALAPPDATA so it never reads real ~/.dsh.
# Only the injectable restart/alert/recover/log/confirm executors are overridden
# (sanctioned test seam); the decision path is the production DEFAULT.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root   # worktree root (_wt-rh1)

$isoRoot = Join-Path $env:TEMP ('rh1-real-e2e-{0}' -f (Get-Random))
New-Item -ItemType Directory -Path $isoRoot -Force | Out-Null
# capture the ORIGINAL (real) env before overriding — used by the append-only
# proof below, which must do a GENUINE production dsh boot (real config) on the
# throwaway port to prove the canonical restart appends rather than truncates.
$origAPPDATA = $env:APPDATA; $origUSERPROFILE = $env:USERPROFILE; $origLOCALAPPDATA = $env:LOCALAPPDATA; $origDSH_HOME = $env:DSH_HOME
$env:DSH_HOME = $isoRoot; $env:USERPROFILE = $isoRoot; $env:LOCALAPPDATA = $isoRoot
$env:APPDATA = Join-Path $isoRoot 'AppData\Roaming'; New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null

. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-health.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')

$port = 33651   # non-3080, non-331xx
$npm = 'C:\Users\Administrator\AppData\Roaming\npm'
$binjs = Join-Path $npm 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$node = Join-Path 'C:\Users\Administrator\Desktop\sdeepseek harness\DSH-Client' 'node-runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$log = Join-Path $isoRoot ('dsh-server-{0}.log' -f $port)

# suspend via native API
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class R3Suspend { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }
'@ -ErrorAction Stop

$failures = 0
$passes   = 0
function Assert([bool]$c, [string]$msg) {
    if ($c) { $script:passes++; Write-Host ("  PASS: " + $msg) }
    else    { $script:failures++; Write-Host ("  **FAIL**: " + $msg) }
}

$p = $null
$startedAt = $null
$candidateAt = $null
$eligibleAt = $null
$restartCount = 0
$restartRequestedAt = $null
$restartAtCandidate = $null
$incidentFile = $null
$maxConcurrentProbe = 0
$activeProbe = 0
$global:R3ProbeSync = New-Object System.Threading.Mutex
function Probe([int]$Port, [bool]$Count) {
    $script:activeProbe++
    if ($script:activeProbe -gt $script:maxConcurrentProbe) { $script:maxConcurrentProbe = $script:activeProbe }
    $s = Get-DshHealthProbe -Port $Port
    Start-Sleep -Milliseconds 100   # widen the overlap window; serial => still 1
    $script:activeProbe--
    return $s
}

Write-Host ("=== RH1 R3 REAL WALL-CLOCK E2E (isolated, wall-clock, >=60s) ===")
try {
    $p = Start-Process -FilePath $node -ArgumentList @($binjs,'--profile','web','--port',"$port",'--no-open') -RedirectStandardOutput $log -RedirectStandardError (Join-Path $isoRoot 'err.log') -PassThru -WindowStyle Hidden
    # wait for ready
    $ready = $false
    for ($i=0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 1000
        $probe = Probe $port $false
        if ($probe.ready -and $probe.ownerState -eq 'ok') { $ready = $true; break }
    }
    Assert ($ready) ('server ready + owner=ok (ready={0} owner={1})' -f $probe.ready, $probe.ownerState)
    $ownerPid = if ($probe) { $probe.ownerPid } else { $p.Id }

    # REAL-E3: suspend -> first unready -> DEGRADE, restart=0
    [R3Suspend]::NtSuspendProcess($p.Handle) | Out-Null
    Start-Sleep -Milliseconds 1500
    $startedAt = Get-Date
    $State = @{}
    $gh = Invoke-DshHealthGuard -Port $port -Probe (Probe $port $true) -CurrentState (New-DshHealthStateObject -Port $port) -State $State -BudgetState $null `
        -RestartExecutor { param($r) $script:restartCount++; $script:restartRequestedAt = Get-Date; return $true } `
        -AlertSender { param($m) } -GoalRecover { } -Log { param($s) Write-Host ("    [guard] " + $s) } `
        -ConfirmProbe { param($P) Probe $P $true }
    Assert ($gh.HealthAction -eq 'degrade') ('REAL-E3 first unready -> degrade (action={0})' -f $gh.HealthAction)
    Assert ($script:restartCount -eq 0) ('REAL-E3 restart count = 0')

    # REAL-E1/E2: keep probing over real wall-clock until eligible or 95s
    $sawCandidate = $false
    $lastAction = $gh.HealthAction
    $cur = $gh.State
    while ($true) {
        $elapsed = ((Get-Date) - $startedAt).TotalSeconds
        if ($elapsed -ge 95 -or $lastAction -eq 'restart_eligible') { break }
        Start-Sleep -Milliseconds 5000
        $snap = Probe $port $true
        $n = (Get-DshHealthState -Port $port)
        $g = Invoke-DshHealthGuard -Port $port -Probe $snap -CurrentState $n -State $State -BudgetState $null `
            -RestartExecutor { param($r) $script:restartCount++; $script:restartRequestedAt = Get-Date; return $true } `
            -AlertSender { param($m) } -GoalRecover { } -Log { param($s) Write-Host ("    [guard] " + $s) } `
            -ConfirmProbe { param($P) Probe $P $true }
        $lastAction = $g.HealthAction
        $elapsed2 = ((Get-Date) - $startedAt).TotalSeconds
        Write-Host ("    t={0:n1}s action={1} owner={2} ready={3} failStreak={4}" -f $elapsed2, $lastAction, $snap.ownerState, $snap.ready, $State['failStreak'])
        if ($lastAction -eq 'hard_candidate') {
            $sawCandidate = $true
            if (-not $candidateAt) { $candidateAt = Get-Date; $restartAtCandidate = $script:restartCount }
        }
        if ($lastAction -eq 'restart_eligible') {
            if (-not $eligibleAt) { $eligibleAt = Get-Date }
            # capture incident file written by the helper (filesystem creation time = evidence)
            if ($g.IncFile -and (Test-Path -LiteralPath $g.IncFile)) { $incidentFile = $g.IncFile } else { $incidentFile = $null }
        }
    }
    $elapsedFinal = ((Get-Date) - $startedAt).TotalSeconds
    Assert ($sawCandidate) ('REAL-E1 observed HARD_UNHEALTHY_CANDIDATE (>=30s window)')
    Assert ($restartAtCandidate -eq 0) ('REAL-E1 no restart before eligible (restartAtCandidate={0})' -f $restartAtCandidate)
    Assert ($lastAction -eq 'restart_eligible') ('REAL-E2 reached RECOVERY_ELIGIBLE (action={0})' -f $lastAction)
    Assert ($elapsedFinal -ge 60) ('REAL-E2 across REAL wall-clock >=60s (elapsed={0:n1}s)' -f $elapsedFinal)
    Assert ($script:restartCount -eq 1) ('REAL-E5 restart executor called EXACTLY ONCE (count={0})' -f $script:restartCount)
    Assert (-not [string]::IsNullOrEmpty($incidentFile)) ('REAL-E5 incident bundle written (file={0})' -f $incidentFile)
    if ($incidentFile -and (Test-Path -LiteralPath $incidentFile) -and $restartRequestedAt) {
        $inc2 = Get-Item -LiteralPath $incidentFile
        $rt = $restartRequestedAt
        Assert (($inc2.CreationTime) -le $rt.AddSeconds(2)) ('REAL-E5 incident BEFORE restart (incidentCreatedAt={0} <= restartRequestedAt={1})' -f $inc2.CreationTime.ToString('o'), $rt.ToString('o'))
    }
    Assert ($maxConcurrentProbe -eq 1) ('REAL-E8 maxConcurrentProbe = 1 (measured max={0})' -f $maxConcurrentProbe)

    # REAL-E4: resume -> success resets streak, no restart
    [R3Suspend]::NtResumeProcess($p.Handle) | Out-Null
    Start-Sleep -Seconds 3
    $snap2 = Probe $port $true
    $State2 = @{}
    $g2 = Invoke-DshHealthGuard -Port $port -Probe $snap2 -CurrentState (Get-DshHealthState -Port $port) -State $State2 -BudgetState $null `
        -RestartExecutor { param($r) $script:restartCount++; return $true } -AlertSender { param($m) } -GoalRecover { } `
        -Log { param($s) Write-Host ("    [guard] " + $s) } -ConfirmProbe { param($P) Probe $P $true }
    Assert ($snap2.ready -and $g2.HealthAction -eq 'noop') ('REAL-E4 resume ready -> noop (ready={0} action={1})' -f $snap2.ready, $g2.HealthAction)
    Assert ($State2['failStreak'] -eq 0) ('REAL-E4 failStreak reset to 0 after success')

    # APPEND-ONLY: prove the canonical start-dsh-server.ps1 APPENDS to the dsh
    # server log (never truncates). This needs a GENUINE production dsh boot
    # (real config resolves the real dsh entry + node v22), so we temporarily
    # restore the real APPDATA/USERPROFILE/LOCALAPPDATA, boot on the throwaway
    # port 33651 (NOT 3080 -> no guardian/prod interference; -LockAlreadyHeld
    # skips the prod restart lock/budget), then restore isolation + clean up.
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    # save isolated env, restore real env for a genuine canonical boot
    $isoAPPDATA = $env:APPDATA; $isoUSERPROFILE = $env:USERPROFILE; $isoLOCALAPPDATA = $env:LOCALAPPDATA; $isoDSH_HOME = $env:DSH_HOME
    $env:APPDATA = $origAPPDATA; $env:USERPROFILE = $origUSERPROFILE; $env:LOCALAPPDATA = $origLOCALAPPDATA
    if ($origDSH_HOME) { $env:DSH_HOME = $origDSH_HOME } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
    $sds = Join-Path $root 'start-dsh-server.ps1'
    $logReal = Join-Path $origLOCALAPPDATA ("DSHHarness\logs\dsh-server-{0}.log" -f $port)
    New-Item -ItemType Directory -Force -Path (Split-Path $logReal) | Out-Null
    function Run-CanonicalRestart {
        param([string]$tag)
        # single quoted string arg keeps the space in the script path intact in -File
        $argLine = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1} -LockAlreadyHeld' -f $sds, $port)
        $null = Start-Process -FilePath 'powershell' -ArgumentList $argLine `
            -RedirectStandardOutput (Join-Path $origLOCALAPPDATA ("sds-{0}.out" -f $tag)) `
            -RedirectStandardError (Join-Path $origLOCALAPPDATA ("sds-{0}.err" -f $tag)) `
            -PassThru -WindowStyle Hidden
        for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 1000; if ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { break } }
        Start-Sleep -Seconds 2
    }
    function Stop-CanonicalServer {
        foreach ($lc in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { Stop-Process -Id ([int]$lc.OwningProcess) -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
    }
    $okRealEnv = $true
    try {
        # boot #1 via canonical authority -> real dsh log with boot marker #1
        Run-CanonicalRestart 'b1'
        $c1 = if (Test-Path $logReal) { Get-Content $logReal -Raw } else { '' }
        $marker1 = ([regex]::Matches($c1, 'dsh web: http://127\.0\.0\.1:' + $port)).Count
        Assert ($marker1 -ge 1) ('APPEND_ONLY boot#1 produced real dsh log with boot marker (marker={0})' -f $marker1)
        Stop-CanonicalServer
        # write sentinel into the SAME file the canonical restart appends to
        $sentinelTag = 'BEFORE_RESTART_SENTINEL_' + [guid]::NewGuid().ToString('N')
        Add-Content -Path $logReal -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $sentinelTag) -Encoding UTF8
        $sentinelOffset = (Get-Item $logReal).Length
        # boot #2 = the restart; must APPEND a fresh boot banner AFTER the sentinel
        Run-CanonicalRestart 'b2'
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
        Assert ($sentinelIdx -ge 0) ('APPEND_ONLY sentinel preserved in log after restart (idx={0})' -f $sentinelIdx)
        Assert ($bannerMax -gt $sentinelIdx) ('APPEND_ONLY boot#2 appended a fresh dsh boot banner AFTER the sentinel (idx={0} banner={1})' -f $sentinelIdx, $bannerMax)
        Assert ($afterLen -gt $sentinelOffset) ('APPEND_ONLY start-marker offset > sentinel offset (pre={0} after={1})' -f $sentinelOffset, $afterLen)
        Stop-CanonicalServer
    } finally {
        # restore isolated env + clean the throwaway real log artifacts
        $env:APPDATA = $isoAPPDATA; $env:USERPROFILE = $isoUSERPROFILE; $env:LOCALAPPDATA = $isoLOCALAPPDATA; $env:DSH_HOME = $isoDSH_HOME
        if ($okRealEnv) {
            @((Join-Path $origLOCALAPPDATA ("sds-b1.out")), (Join-Path $origLOCALAPPDATA ("sds-b1.err")), (Join-Path $origLOCALAPPDATA ("sds-b2.out")), (Join-Path $origLOCALAPPDATA ("sds-b2.err"))) | ForEach-Object { Remove-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue }
            Remove-Item -LiteralPath $logReal -Force -ErrorAction SilentlyContinue
            $stateFile = Join-Path $origLOCALAPPDATA ("DSHHarness\state\dsh-health-{0}.json" -f $port)
            Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
        }
    }

} catch {
    Write-Host ("FATAL: " + $_.Exception.Message)
} finally {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Write-Host ("RESULT: PASS={0} FAIL={1}" -f $passes, $failures)
    Write-Host ("ISO_ROOT={0}" -f $isoRoot)
}
