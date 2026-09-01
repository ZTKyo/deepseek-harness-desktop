# rh1-tests.ps1 - RH1 Reliability Hotfix test harness (G0..G14).
#
# Goals under test (from the RH1 acceptance criteria):
#   Part F  dsh-health.ps1 single source of truth (liveness != readiness).
#   Part C  hard_unhealthy_candidate / recovery_eligible state machine (R1..R4).
#   Part A  single start authority (start-dsh-server.ps1) + append-only log, NO
#           truncating `> dsh-server-<port>.log` path anywhere.
#   Part B  guardian Restart-Server still gated by restart budget (cooldown).
#
# Design:
#   * G1..G3 use a THROWAWAY loopback HTTP server (tests\dsh-disposable-server.ps1)
#     on a random high port. It NEVER touches port 3080 or the real dsh server.
#   * G5..G8 exercise the PURE triage function Invoke-DshHealthTriage with a
#     deterministic fake snapshot + controlled clock (no I/O, no real server).
#   * G9..G14 are static source asserts (append-only, single authority, BOM,
#     parse-valid, no truncating redirect).
#
# Exit code: 0 = all green; 1 = any failure.

$ErrorActionPreference = 'Continue'
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
$root = Split-Path -Parent $PSScriptRoot

# ---- assert harness ----
$script:pass = 0; $script:fail = 0; $script:failed = @()
function Assert([string]$name, [bool]$cond, [string]$detail = '') {
    if ($cond) { $script:pass++; Write-Host ("PASS  {0}  {1}" -f $name, $detail) -ForegroundColor Green }
    else { $script:fail++; $script:failed += $name; Write-Host ("FAIL  {0}  {1}" -f $name, $detail) -ForegroundColor Red }
}

# ---- G0: dot-source the health module (single source of truth) ----
$loadErr = $null
try { . (Join-Path $root 'dsh-health.ps1'); $loadOk = $true } catch { $loadErr = $_.Exception.Message; $loadOk = $false }
Assert 'G0 dot-source dsh-health.ps1' ($loadOk) ($(if ($loadErr) { $loadErr } else { 'loaded ok' }))

# ---- fixed high test port for the disposable server (never 3080; 331xx per RH1 spec) ----
$tport = 33183
$modeFile = Join-Path $env:TEMP ("dsh-disposable-{0}.mode" -f $tport)
$serverScript = Join-Path $PSScriptRoot 'dsh-disposable-server.ps1'

function Set-Mode([string]$m) { Set-Content -LiteralPath $modeFile -Value $m -Encoding ascii }
function Start-Disposable {
    if (Test-Path -LiteralPath $modeFile) { Remove-Item -LiteralPath $modeFile -Force -ErrorAction SilentlyContinue }
    Set-Mode 'ready'
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$serverScript`"",'-Port',"$tport",'-ModeFile',"`"$modeFile`"") -WindowStyle Hidden -PassThru
    # wait until it actually answers
    $t = 0
    while ($t -lt 60) {
        $probe = Test-DshBasicHttp -Port $tport -TimeoutSec 1
        if ($probe.State -eq 'matched') { break }
        Start-Sleep -Milliseconds 250; $t++
    }
    return $p
}
function Stop-Disposable($p) {
    if ($p -and $p.Id -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
    Remove-Item -LiteralPath $modeFile -Force -ErrorAction SilentlyContinue
}

$serverProc = $null
try {
    $serverProc = Start-Disposable

    # ---- G1: online 200 => matched (alive) ----
    $b = Test-DshBasicHttp -Port $tport -TimeoutSec 3
    Assert 'G1 online 200 matched' ($b.State -eq 'matched') ("State=$($b.State) HttpStatus=$($b.HttpStatus)")
    Assert 'G1b online is HTTP 200' ($b.HttpStatus -eq 200) ("HttpStatus=$($b.HttpStatus)")

    # ---- G2: unready 503 => STILL matched (alive but not ready; NOT refused/dead) ----
    Set-Mode 'unready'
    Start-Sleep -Milliseconds 400
    $b = Test-DshBasicHttp -Port $tport -TimeoutSec 3
    Assert 'G2 unready 503 matched (alive)' ($b.State -eq 'matched') ("State=$($b.State) HttpStatus=$($b.HttpStatus)")
    Assert 'G2b unready is HTTP 503' ($b.HttpStatus -eq 503) ("HttpStatus=$($b.HttpStatus)")

    # ---- G3: server gone => liveness LOSS (must NOT be 'matched' = falsely online) ----
    # On Windows a just-released loopback port frequently yields 'timeout' (a
    # TCP teardown artifact) rather than a clean RST -> 'refused'. Both are valid
    # liveness-loss states: the module must never report a dead server as online.
    Stop-Disposable $serverProc
    $serverProc = $null   # already stopped
    Start-Sleep -Milliseconds 700
    $b = Test-DshBasicHttp -Port $tport -TimeoutSec 2
    Assert 'G3 offline => liveness loss (not online)' ($b.State -ne 'matched') ("State=$($b.State) HttpStatus=$($b.HttpStatus)")

} finally {
    Stop-Disposable $serverProc
}

# ---- LIVE classification: Get-DshHealthProbe never sets ready=true on a NON-dsh owner (owner safety) ----
# Restart the disposable server, probe it: loopback owner is not a dsh server -> owner_unsafe.
try {
    $serverProc = Start-Disposable
    $hp = Get-DshHealthProbe -Port $tport
    # ownerState for a non-dsh loopback listener should NOT be 'ok' (identity mismatch/ambiguous),
    # and thus the triage must NOT schedule a restart.
    Assert 'G4a non-dsh owner not ready' (-not $hp.ready) ("ownerState=$($hp.ownerState) ready=$($hp.ready) errorClass=$($hp.errorClass)")
    $tri = Invoke-DshHealthTriage -Snapshot $hp -CurrentState (New-DshHealthStateObject -Port $tport) -Now (Get-Date)
    # owner not-ok (mismatch/ambiguous/absent) must NEVER schedule a restart.
    Assert 'G4b non-dsh owner never triggers restart' ($tri.Action -in @('owner_unsafe','server_absent') -and $tri.Action -ne 'restart_eligible') ("Action=$($tri.Action)")
} finally { Stop-Disposable $serverProc }

# ---- PURE state machine (R1..R4), controlled clock, no server ----
$snapOk = [pscustomobject]@{ port = $tport; ready = $true;  ownerState = 'ok'; basicState = 'matched'; apiState = 'api_ready'; wsState = ''; failureSignal = ''; errorClass = ''; probeDurationMs = 5 }
$snapUn = [pscustomobject]@{ port = $tport; ready = $false; ownerState = 'ok'; basicState = 'matched'; apiState = 'api_unready'; wsState = ''; failureSignal = 'api'; errorClass = 'api_unready'; probeDurationMs = 5 }

$now = [datetime]::Now
$s0 = New-DshHealthStateObject -Port $tport

# G5: full success resets to healthy (noop).
$r0 = Invoke-DshHealthTriage -Snapshot $snapOk -CurrentState $s0 -Now $now -FailThreshold 3 -CandidateWindowSec 30 -RecoveryWindowSec 60
Assert 'G5 ready resets healthy (noop, no restart)' ($r0.Action -eq 'noop' -and $r0.State -eq 'healthy') ("Action=$($r0.Action) State=$($r0.State)")

# G6: 1st unready => degrade (below threshold). NOT a restart.
$r1 = Invoke-DshHealthTriage -Snapshot $snapUn -CurrentState $s0 -Now $now -FailThreshold 3 -CandidateWindowSec 30 -RecoveryWindowSec 60
Assert 'G6 R1 degrade (no restart)' ($r1.Action -eq 'degrade' -and $r1.State -eq 'degraded' -and $r1.NextState.consecutiveFailures -eq 1) ("Action=$($r1.Action) State=$($r1.State) fails=$($r1.NextState.consecutiveFailures)")

# G7: 2nd unready +5s => still degrade.
$r2 = Invoke-DshHealthTriage -Snapshot $snapUn -CurrentState $r1.NextState -Now $now.AddSeconds(5) -FailThreshold 3 -CandidateWindowSec 30 -RecoveryWindowSec 60
Assert 'G7 R2 degrade (no restart)' ($r2.Action -eq 'degrade' -and $r2.NextState.consecutiveFailures -eq 2) ("Action=$($r2.Action) fails=$($r2.NextState.consecutiveFailures)")

# G8: 3rd unready + candidate window (>=30s) => hard_candidate.
$r3 = Invoke-DshHealthTriage -Snapshot $snapUn -CurrentState $r2.NextState -Now $now.AddSeconds(31) -FailThreshold 3 -CandidateWindowSec 30 -RecoveryWindowSec 60
Assert 'G8 R3 hard_candidate (candidate only)' ($r3.Action -eq 'hard_candidate' -and $r3.State -eq 'hard_unhealthy_candidate') ("Action=$($r3.Action) State=$($r3.State) fails=$($r3.NextState.consecutiveFailures)")

$r4 = Invoke-DshHealthTriage -Snapshot $snapUn -CurrentState $r3.NextState -Now $now.AddSeconds(61) -FailThreshold 3 -CandidateWindowSec 30 -RecoveryWindowSec 60
Assert 'G8b R4 recovery_eligible (restart gated)' ($r4.Action -eq 'restart_eligible' -and $r4.State -eq 'recovery_eligible') ("Action=$($r4.Action) State=$($r4.State) fails=$($r4.NextState.consecutiveFailures)")

# ---- STATIC asserts ----
function Get-Raw([string]$p) { if (Test-Path -LiteralPath $p) { return (Get-Content -LiteralPath $p -Raw) } else { return '' } }

$ljs = Get-Raw (Join-Path $root 'dsh-launcher.js')
# A3: launcher opens the server log in APPEND mode and writes a START marker; never truncates it.
Assert 'G9 launcher append-only + start marker' (
    ($ljs -match "fs\.openSync\(logFile, 'a'\)") -and ($ljs -match 'dsh server runner start')
) 'dsh-launcher.js must open log with ''a'' and emit a start marker'

# A2: no truncating `> "..."` server-log redirect in the start path scripts.
$noTrunc = $true; $truncDetail = ''
foreach ($f in @('start-dsh-server.ps1','restart-dsh-server-delayed.ps1','DSH-Client.ps1')) {
    $raw = Get-Raw (Join-Path $root $f)
    # `>` (single redirect, i.e. truncate) to a path mentioning dsh-server; `>>` (append) is allowed.
    if ($raw -match '[^>]>\s*"[^"]*dsh-server') { $noTrunc = $false; $truncDetail = $f }
}
Assert 'G10 no truncating server-log redirect' ($noTrunc) ($(if ($noTrunc) { 'none' } else { $truncDetail }))

# A1/A2: single start authority — both launchers route through start-dsh-server.ps1.
$dc = Get-Raw (Join-Path $root 'DSH-Client.ps1')
$rs = Get-Raw (Join-Path $root 'restart-dsh-server-delayed.ps1')
Assert 'G11 single authority (client + restart route to start-dsh-server.ps1)' (
    ($dc -match 'start-dsh-server\.ps1') -and ($rs -match 'start-dsh-server\.ps1' -and $rs -match 'single authority')
) 'client + restart must both use start-dsh-server.ps1'

# D1/E: client reuses the shared health probe (Test-DshBasicHttp) as a single source.
Assert 'G12 client uses shared health probe' ($dc -match 'dsh-health\.ps1' -and $dc -match 'Test-DshBasicHttp') 'client must dot-source dsh-health.ps1 and use Test-DshBasicHttp'

# E: guardian restart still gated by restart budget (cooldown/circuit).
$gd = Get-Raw (Join-Path $root 'dsh-guardian.ps1')
Assert 'G13 guardian restart gated by Test-DshRestartAllowed' ($gd -match 'Test-DshRestartAllowed') 'guardian Restart-Server must consult the restart budget'

# BOM + parse on all modified PS1 files.
function HasBom([string]$p) { $b = [System.IO.File]::ReadAllBytes($p); return ($b.Length -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191) }
function ParseOk([string]$p) { $t = $null; $e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e); $e = @($e); return ($e.Count -eq 0) }
$psFiles = @('dsh-health.ps1','dsh-reconnect.ps1','dsh-guardian.ps1','DSH-Harness-PS.ps1','DSH-Client.ps1','restart-dsh-server-delayed.ps1','start-dsh-server.ps1', (Join-Path 'tests' 'dsh-disposable-server.ps1'), (Join-Path 'tests' 'rh1-tests.ps1'))
$allBom = $true; $bomBad = ''
$allParse = $true; $parseBad = ''
foreach ($f in $psFiles) {
    $p = if ($f -match '\\|/') { Join-Path $root $f } else { Join-Path $root $f }
    if (-not (HasBom $p)) { $allBom = $false; if (-not $bomBad) { $bomBad = $f } }
    if (-not (ParseOk $p)) { $allParse = $false; if (-not $parseBad) { $parseBad = $f } }
}
Assert 'G14a UTF-8 BOM preserved on all PS1' ($allBom) ($(if ($allBom) { 'all BOM' } else { $bomBad }))
Assert 'G14b PS1 parse-valid (no syntax error)' ($allParse) ($(if ($allParse) { 'all parse' } else { $parseBad }))

# ============ R2 (external review, round 2) additions ============
# Blocker 1: client reconnect PURE state machine. No I/O / no server; controlled clock.
$rcLoadErr = $null
try { . (Join-Path $root 'dsh-reconnect.ps1'); $rcLoadOk = $true } catch { $rcLoadErr = $_.Exception.Message; $rcLoadOk = $false }
Assert 'G15 dot-source dsh-reconnect.ps1' ($rcLoadOk) ($(if ($rcLoadErr) { $rcLoadErr } else { 'loaded ok' }))

$t0 = [datetime]::Now
# (a) DEGRADED -> ONLINE: ALWAYS 0 auto reload (reviewer requirement).
$sA = New-DshReconnectState; $sA.mode = 'degraded'
$dA = Invoke-DshReconnectTransition -State $sA -Mode 'online' -LastNavigationSucceeded $false -Now $t0 -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G15 degraded->online always 0 reload' ((-not $dA.Reload) -and $dA.Operation -eq 'no_reload_degraded_to_online') ("op=$($dA.Operation) reload=$($dA.Reload)")

# (b) OFFLINE declared only after >= OfflineHitsThreshold unreachable ticks (observe first).
$sB = New-DshReconnectState
$d1 = Invoke-DshReconnectTransition -State $sB -Mode 'offline' -Now $t0 -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G16 offline observe (< threshold) no declare' ($d1.Operation -eq 'offline_observe' -and $d1.State.mode -eq 'online') ("op=$($d1.Operation) mode=$($d1.State.mode) hits=$($d1.State.offlineHits)")
$d2 = Invoke-DshReconnectTransition -State $d1.State -Mode 'offline' -Now $t0.AddSeconds(3) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G16b offline declared at threshold' ($d2.Operation -eq 'offline_declared' -and $d2.State.mode -eq 'offline') ("op=$($d2.Operation) mode=$($d2.State.mode) ep=$($d2.State.episodeCounter)")

# (c) OFFLINE -> ONLINE: recovery grace NOT elapsed => no reload (wait for stable window).
$dg = Invoke-DshReconnectTransition -State $d2.State -Mode 'online' -LastNavigationSucceeded $false -Now $t0.AddSeconds(5) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G17 offline->online grace not elapsed, no reload' ($dg.Operation -eq 'recovery_grace' -and (-not $dg.Reload)) ("op=$($dg.Operation) reload=$($dg.Reload)")

# (d) grace elapsed + page NOT self-recovered => auto reload exactly once.
$dr = Invoke-DshReconnectTransition -State $dg.State -Mode 'online' -LastNavigationSucceeded $false -Now $t0.AddSeconds(15) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G18 grace elapsed page not recovered -> auto reload (1x)' ($dr.Reload -and $dr.Operation -eq 'auto_reload' -and $dr.State.reloaded) ("op=$($dr.Operation) reload=$($dr.Reload)")
$dr2 = Invoke-DshReconnectTransition -State $dr.State -Mode 'online' -LastNavigationSucceeded $false -Now $t0.AddSeconds(16) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
Assert 'G18b no second auto reload this episode' ((-not $dr2.Reload) -and $dr2.State.reloaded) ("op=$($dr2.Operation) reload=$($dr2.Reload)")

# (e) page self-recovered => no reload (do not fight a healing page). Grace window
# starts on the FIRST online tick (recoveryStartAt), so we need one online tick to
# open the window, then a second past grace.
$sE = New-DshReconnectState
$e1 = Invoke-DshReconnectTransition -State $sE -Mode 'offline' -Now $t0 -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
$e2 = Invoke-DshReconnectTransition -State $e1.State -Mode 'offline' -Now $t0.AddSeconds(3) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2
$e3 = Invoke-DshReconnectTransition -State $e2.State -Mode 'online' -LastNavigationSucceeded $true -Now $t0.AddSeconds(30) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2   # opens grace window
$e4 = Invoke-DshReconnectTransition -State $e3.State -Mode 'online' -LastNavigationSucceeded $true -Now $t0.AddSeconds(45) -GraceSec 10 -CooldownSec 120 -OfflineHitsThreshold 2   # grace elapsed
Assert 'G19 page self-recovered -> no reload' ((-not $e4.Reload) -and $e4.Operation -eq 'no_reload_page_recovered') ("op=$($e4.Operation) reload=$($e4.Reload)")

# Blocker 3: incident bundle redaction — a sensitive fixture must NEVER reach an
# incident file (no leak outside the bundle). Use the formats the bundle actually
# produces (JSON values, env-style assignment, Authorization Bearer, PEM block) plus
# the JSON-bundle serializer, which is the real leak surface.
$secretFixture = 'sk-live-1234567890SECRETTOKEN0'
$bearer        = 'Bearer eyJhbGciOiJIUzI1NiJ9.SECRET.JWT'
$pem = [string]::Join("`n", @(
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0redactedsecret1234567890abcdef',
    '-----END ' + 'RSA PRIVATE KEY-----'
))
$red = Invoke-DshRedactText ("token=`"$secretFixture`"`npassword=$secretFixture`n`"authorization`" = `"$bearer`"`n$pem")
$scan = Test-DshIncidentRedaction $red -KnownSensitive @($secretFixture, $pem)
Assert 'G20 incident redaction: sensitive fixture absent' ($scan.Clean) ("Hits=" + ($scan.Hits -join ','))
$bundleObj = [pscustomobject]@{ port = 33183; probe = [pscustomobject]@{ token = $secretFixture; api_key = $secretFixture; note = 'ok' } }
$bundleJson = ConvertTo-DshRedactedJson $bundleObj
$scan2 = Test-DshIncidentRedaction $bundleJson -KnownSensitive @($secretFixture)
Assert 'G20b incident bundle JSON redacted' ($scan2.Clean) ("leak=" + ($scan2.Hits -join ','))

# Blocker 2 / G9: production PS/CMD start paths converge on the single authority
# (start-dsh-server.ps1). src/DSHHarness.cs is the ONE documented OFF_AUTHORITY
# production start (non-default native client, not built by default) — recorded in
# the R2 report §7 so the exception is explicit, not silent.
$conv = $true; $convDetail = ''
# Start-path scripts must route straight to the single authority; restart-path scripts
# must route to restart-dsh-server-delayed.ps1 (which itself converges to authority).
foreach ($f in @('DSH-Harness-PS.ps1','DSH-Client.ps1','dsh-guardian.ps1')) {
    $raw = Get-Raw (Join-Path $root $f)
    if ($raw -notmatch 'start-dsh-server\.ps1') { $conv = $false; if (-not $convDetail) { $convDetail = $f } }
}
foreach ($f in @('dsh-safe-mode.ps1','dsh-transaction.ps1','restart-dsh-server-delayed.ps1')) {
    $raw = Get-Raw (Join-Path $root $f)
    if ($raw -notmatch 'restart-dsh-server-delayed\.ps1') { $conv = $false; if (-not $convDetail) { $convDetail = $f } }
}
Assert 'G21 production PS paths converge on single authority' ($conv) ($(if ($conv) { 'converged' } else { $convDetail + ' lacks route to authority' }))

# ============ HOTFIX: client reconnect dict name collision ============
# The reconnect background probe publishes into a thread-safe dict. Its name MUST NOT
# collide with the local probe-path variable `$probe` (tests\fixtures probe name) nor
# with the `[switch]$Probe` parameter. Canonical name: $script:probeState.
# Regression: if someone renames the dict back to `$script:probe`, the probe self-test
# (-Probe) and the reconnect background probe would share a name with the local
# `$probe = Join-Path $base '.wprobe'` write-path variable, breaking -Probe isolation.
$hp = Get-Raw (Join-Path $root 'DSH-Harness-PS.ps1')
$noProbeDict = $true; $probeDictDetail = ''
if ($hp -match '\$script:probe\s*=\s*\[System\.Collections\.Concurrent\.ConcurrentDictionary') { $noProbeDict = $false; $probeDictDetail = 'reconnect dict named $script:probe' }
if ($hp -notmatch '\$script:probeState\s*=\s*\[System\.Collections\.Concurrent\.ConcurrentDictionary') { $noProbeDict = $false; if (-not $probeDictDetail) { $probeDictDetail = 'reconnect dict missing $script:probeState' } }
# The local write-path variable must still exist (untouched by the rename).
$localProbe = $hp -match '\$probe\s*=\s*Join-Path\s+\$base\s+''\.wprobe'''
Assert 'G22 client reconnect dict uses $script:probeState (no collision with local $probe / [switch]$Probe)' ($noProbeDict -and $localProbe) ($(if ($noProbeDict -and $localProbe) { 'probeState dict + local .wprobe var present' } else { $probeDictDetail + '; localProbe=' + $localProbe }))

# ---- summary ----
Write-Host ""
Write-Host ("==== RH1 harness result: PASS={0} FAIL={1} ====" -f $script:pass, $script:fail) -ForegroundColor Cyan
if ($script:fail -gt 0) {
    Write-Host ("FAILED asserts: " + ($script:failed -join ', ')) -ForegroundColor Red
    exit 1
}
Write-Host 'ALL GREEN' -ForegroundColor Green
exit 0
