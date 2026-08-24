# dsh-guardian.ps1 - DSH server guardian: keep-awake + crash recovery + stuck detection.
#
# Protects the unattended DSH agent from:
#   1. Machine sleep freezing an in-flight turn (keep-awake + optional lid-close guard).
#   2. The server dying for any reason (agent self-kill, crash, OOM) -> auto restart.
#   3. A turn hanging forever with no progress (stale session-write detection -> restart).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1            # run in foreground
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -Install   # install logon task + start
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -Uninstall # remove task
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\dsh-guardian.ps1 -OneShot   # single check (diagnostics)
# Options:
#   -Port <n>              which port to guard (default 3080)
#   -IntervalSeconds <n>   check interval (default 30)
#   -StuckRestartMinutes <n> restart server when the newest session file is stale this long
#                           (0 = disable; default 240: recovery safety net only, so an idle
#                           but alive session is never killed mid-thought)
#   -NoKeepAwake           do not prevent idle sleep
#   -NoLidGuard            do not change lid-close power behavior (default: set to "do nothing"
#                           while guardian runs, restore on exit; only for the active power scheme)
#   -Install / -Uninstall  manage the logon scheduled task
#   -OneShot               run a single check cycle and exit
#
# Log: %LOCALAPPDATA%\DSHHarness\logs\guardian.log (auto-rotates at 1 MB)
param(
    [int]$Port = 3080,
    [int]$IntervalSeconds = 30,
    [int]$StuckRestartMinutes = 240,
    [switch]$NoKeepAwake,
    [switch]$NoLidGuard,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$OneShot
)
$ErrorActionPreference = 'Continue'
# ---- environment sanitization (2026-08-15 hardening) ----
# Strip host-app injected vars (WorkBuddy/genie safe-delete, Claude/CodeBuddy
# shims, NODE_OPTIONS require-hooks, BASH_ENV/PYTHONPATH shims, oversized
# product config) so the dsh server / guardian always boot clean. Injections
# previously blocked credential writes, caused writer-lock stalls, and the
# oversized ACC_PRODUCT_CONFIG_V3 (479KB) broke process spawning (env block
# > 64KB).
foreach ($v in (Get-ChildItem Env: | Where-Object {
    $_.Name -like 'CODEBUDDY_*' -or $_.Name -like 'WORKBUDDY_*' -or $_.Name -like 'CLAUDE_*' -or
    $_.Name -like 'CLIENT_INFO_*' -or $_.Name -like 'SERVER__*' -or $_.Name -like 'HERMES_*' -or
    $_.Name -like 'GALILEO_*' -or $_.Name -like 'EFC_*' -or
    $_.Name -eq 'ACC_PRODUCT_CONFIG_V3' -or $_.Name -eq 'NODE_OPTIONS' -or $_.Name -eq 'BASH_ENV' -or
    $_.Name -eq 'PYTHONPATH' -or $_.Name -eq 'GENIE_TRASH_DIR' -or $_.Name -eq 'ELECTRON_RUN_AS_NODE' -or
    $_.Name -eq 'HMCloud' -or $_.Name -eq 'DISABLE_AUTOUPDATER' -or $_.Name -eq 'DOTNET_SYSTEM_CONSOLE_USEUTF8ENCODING' -or
    $_.Name -eq 'ORIGINAL_XDG_CURRENT_DESKTOP'
})) { Remove-Item "Env:$($v.Name)" -ErrorAction SilentlyContinue }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-readiness.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')
$dataRoot = Join-Path $env:LOCALAPPDATA 'DSHHarness'
$logDir = Join-Path $dataRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'guardian.log'
$stateDir = Join-Path $dataRoot 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$heartbeatPath = Join-Path $stateDir 'guardian-heartbeat.json'
$script:GuardianStartedAt = (Get-Date).ToUniversalTime().ToString('o')
$script:GuardianExitCode = 0
$url = "http://127.0.0.1:$Port/"

function TraceG([string]$msg) {
    try {
        if (Test-Path $logPath) { $fi = Get-Item $logPath; if ($fi.Length -gt 1MB) { Move-Item $logPath (Join-Path $logDir 'guardian.old.log') -Force -ErrorAction SilentlyContinue } }
        Add-Content -Path $logPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
    } catch {}
}

function Write-GuardianHeartbeat([string]$Phase) {
    # The heartbeat is deliberately local, atomic, and metadata-only.  The
    # watchdog uses it to distinguish a live guardian from a stale process;
    # it never contains prompts, credentials, or session content.
    try {
        $payload = [ordered]@{
            pid = $PID
            port = $Port
            startedAt = $script:GuardianStartedAt
            updatedAt = (Get-Date).ToUniversalTime().ToString('o')
            phase = $Phase
            exitCode = $script:GuardianExitCode
        }
        $tmp = "$heartbeatPath.tmp-$PID"
        $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $heartbeatPath -Force -ErrorAction Stop
    } catch {
        TraceG ('heartbeat write error: ' + $_.Exception.Message)
    }
}

# ---------- keep-awake (kernel32 SetThreadExecutionState) ----------
$awake = $false
if (-not $NoKeepAwake) {
    try {
        Add-Type -Namespace DSHGuard -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@ -ErrorAction Stop
        # Decimal literals: PS 5.1 parses 0x80000000+ as negative Int32, which fails
        # [uint32] conversion. ES_CONTINUOUS=2147483648, ES_SYSTEM_REQUIRED=1.
        $script:ES_CONTINUOUS = [uint32]2147483648
        $script:ES_SYSTEM = [uint32]1
        $script:ES_AWAYMODE = [uint32]64
        $r = [DSHGuard.Native]::SetThreadExecutionState($script:ES_CONTINUOUS -bor $script:ES_SYSTEM -bor $script:ES_AWAYMODE)
        $awake = ($r -ne 0)
        TraceG ("keep-awake: " + $(if ($awake) { 'ON (ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED, blocks Modern Standby idle sleep)' } else { 'FAILED err=' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }))
    } catch { TraceG ('keep-awake init error: ' + $_.Exception.Message) }
}

# independent keep-awake timer: asserts even while the main loop is busy
# restarting the server or sleeping in backoff (2026-08-15 hardening).
$script:awakeTimer = $null
if ($awake) {
    try {
        $script:awakeTimer = New-Object System.Timers.Timer
        $script:awakeTimer.Interval = 60000
        $script:awakeTimer.AutoReset = $true
        $handler = {
            try { $null = [DSHGuard.Native]::SetThreadExecutionState($script:ES_CONTINUOUS -bor $script:ES_SYSTEM -bor $script:ES_AWAYMODE) } catch {}
        }
        $script:awakeTimer.add_Elapsed($handler)
        $script:awakeTimer.Start()
        TraceG 'keep-awake: independent 60s timer armed'
    } catch { TraceG ('keep-awake timer error: ' + $_.Exception.Message) }
}

# ---------- lid-close guard (active power scheme only; restored on exit) ----------
$lidChanged = $false; $lidOld = $null
if (-not $NoLidGuard) {
    try {
        # Best effort: parse the SUB_BUTTONS group output and take the first
        # AC/DC index pair (LIDACTION is the first setting in the subgroup).
        # Setting-GUID-anchored parsing proved unreliable across localizations.
        $q = @(powercfg /q SCHEME_CURRENT SUB_BUTTONS 2>$null)
        $ac = $null; $dc = $null
        foreach ($line in $q) {
            if ($null -eq $ac -and $line -match '交流|AC' -and $line -match '0x[0-9a-fA-F]+') { $ac = $matches[0] }
            elseif ($null -eq $dc -and $line -match '直流|DC' -and $line -match '0x[0-9a-fA-F]+') { $dc = $matches[0] }
        }
        if ($null -ne $ac -and $null -ne $dc) {
            if ($ac -ne '0x00000000' -or $dc -ne '0x00000000') {
                powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
                powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
                powercfg /setactive SCHEME_CURRENT | Out-Null
                $lidChanged = $true; $lidOld = @($ac, $dc)
                TraceG ("lid-guard: lid close set to 'do nothing' (was AC=$ac DC=$dc); restored on exit")
            } else {
                TraceG 'lid-guard: lid close already "do nothing" - no change needed'
            }
        } else {
            TraceG 'lid-guard: could not locate lid setting in powercfg output - skipped'
        }
    } catch { TraceG ('lid-guard error: ' + $_.Exception.Message) }
}

# ---------- helpers ----------
function Test-Server {
    try {
        $script:LastReadiness = Test-DshReadiness -Port $Port
        return ($script:LastReadiness.State -in @('api_ready','client_ready'))
    } catch { $script:LastReadiness = $null; return $false }
}
function Get-PortIdentity {
    return (Get-DshLoopbackOwner -Port $Port)
}
function Get-PortPid {
    $owner = Get-PortIdentity
    if ($owner.State -eq 'ok') { return $owner.Pid }
    return $null
}
function Start-DshServer {
    $starter = Join-Path $root 'start-dsh-server.ps1'
    $spawnLock = Enter-DshRestartLock
    if (-not $spawnLock) {
        TraceG 'start skipped: another start/restart transaction owns the lock'
        return $false
    }
    try {
    if (Test-Path $starter) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -Port ' + $Port + ' -LockAlreadyHeld'
        # UseShellExecute: child gets its own handles instead of inheriting this
        # process's stdout pipe (otherwise the long-lived server keeps the pipe
        # open and any caller piping our output never sees EOF).
        $psi.UseShellExecute = $true
        $psi.WindowStyle = 'Hidden'
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        return $true
    }
    return $false
    } finally {
        Exit-DshRestartLock $spawnLock
    }
}

# ---------- hardening helpers (2026-08-15) ----------
function Clear-StaleLocks {
    try {
        $locks = @(
            (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml.lock'),
            (Join-Path $env:USERPROFILE '.dsh\settings.yaml.lock')
        )
        foreach ($lk in $locks) {
            if (Test-Path $lk) {
                $owner = ((Get-Content $lk -Raw) -replace '\s', '')
                $alive = $false
                if ($owner -match '^\d+$') { $alive = [bool](Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue) }
                if (-not $alive) {
                    Remove-Item $lk -Force -ErrorAction SilentlyContinue
                    TraceG ("stale lock removed: " + $lk)
                }
            }
        }
    } catch {}
}
function Send-TelegramAlert([string]$msg) {
    $al = Join-Path $root 'telegram-alert.ps1'
    if (-not (Test-Path $al)) { return }
    try {
        $escaped = $msg.Replace('"', '\"')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $al + '" "' + $escaped + '"'
        $psi.UseShellExecute = $true
        $psi.WindowStyle = 'Hidden'
        [System.Diagnostics.Process]::Start($psi) | Out-Null
    } catch { TraceG ('telegram alert error: ' + $_.Exception.Message) }
}
function Test-ActiveGoal {
    # Return active/inactive/unknown. API-unreachable must not be treated as inactive.
    $gr = Join-Path $root 'goal-recovery.mjs'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -or -not (Test-Path $gr)) { return 'unknown' }
    try {
        & $node $gr --check --port $Port 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return 'active' }
        if ($LASTEXITCODE -eq 1) { return 'inactive' }
        return 'unknown'
    } catch { return 'unknown' }
}
function Invoke-GoalRecovery {
    # Phase 02 R1 (BLOCKING-2): Guardian is Process Authority only. It does NOT
    # autonomously decide which goal to resume (goal-recovery.mjs --resume scans
    # and decides, which duplicated EC's task-recovery authority). After a restart
    # the Guardian only emits the "server ready" fact; Execution Continuity's own
    # recoverableScan/scheduleRecoveryLoop (running inside the web profile) decides
    # whether/which task resumes. This function is kept as a no-op hook so any
    # legacy callers do not break; the read-only active-goal projection for
    # stuck-safety lives in Test-ActiveGoal (--check) which stays.
    try {
        TraceG 'goal-recovery: deferred to EC task-recovery authority (guardian = process authority only)'
    } catch { TraceG ('goal-recovery error: ' + $_.Exception.Message) }
}
function Restore-LastGoodConfig {
    # Phase 02 R6 (R5-B3): restore ONLY from an exact verified set. Missing
    # meta.json / manifest / required file OR any hash mismatch => REFUSE
    # (fail-closed). The legacy no-manifest copy fallback is REMOVED — a mirror
    # without a manifest is not verifiable, so we never restore from it.
    $metaPath = Join-Path $lastGoodDir 'meta.json'
    if (-not (Test-Path $metaPath)) {
        TraceG 'CONFIG SAFETY: guardian-lastgood has no meta.json; restore REFUSED (no legacy copy fallback)'
        return
    }
    try {
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
    } catch {
        TraceG 'CONFIG SAFETY: guardian-lastgood meta.json unreadable; restore REFUSED (fail-closed)'
        return
    }
    $manifest = $meta.manifest
    if (-not $manifest -or @($manifest).Count -eq 0) {
        TraceG 'CONFIG SAFETY: guardian-lastgood manifest empty/missing; restore REFUSED (fail-closed)'
        return
    }
    # Phase 02 R7 (R6-5): the mirror is a DERIVED CACHE — it must carry the
    # canonical set-id matching the canonical current pointer. If the mirror is
    # missing canonicalSetId (pre-R7) OR it does not equal the canonical pointer
    # (stale mirror after a crash between pointer switch and mirror sync), the
    # mirror is NOT the canonical authority — REFUSE instead of restoring a
    # possibly-stale "internally consistent" set.
    $canonicalId = $meta.canonicalSetId
    if (-not $canonicalId) {
        TraceG 'CONFIG SAFETY: guardian-lastgood missing canonicalSetId (pre-R7 mirror); restore REFUSED (must re-sync from canonical)'
        return
    }
    $canonicalPtr = $null
    try {
        # Phase 02 R7 adversarial fix: use the SAME injection-aware root as the
        # canonical writer (Get-VerifiedLastGoodDir honors DSH_STATE_ROOT) — a
        # hard-coded LOCALAPPDATA path would read the REAL canonical while the
        # mirror here lives under an injected root, causing an impossible
        # equality check (restore always refused in isolated/guardian test mode).
        . (Join-Path $PSScriptRoot 'dsh-verified-lastgood.ps1') 2>$null
        $vlgRoot = Get-VerifiedLastGoodDir
        $ptrFile = Join-Path $vlgRoot 'current'
        if (Test-Path $ptrFile) { $canonicalPtr = (Get-Content $ptrFile -Raw).Trim() }
    } catch { $canonicalPtr = $null }
    if (-not $canonicalPtr) {
        TraceG 'CONFIG SAFETY: canonical verified-lastgood pointer missing; restore REFUSED (fail-closed)'
        return
    }
    if ($canonicalId -ne $canonicalPtr) {
        TraceG ("CONFIG SAFETY: mirror canonicalSetId=" + $canonicalId + " != canonical pointer=" + $canonicalPtr + "; mirror is stale; restore REFUSED")
        return
    }
    # required-set cardinality (same contract as Save-VerifiedLastGood)
    $required = if ($meta.required) { @($meta.required) } else { @('settings.yaml', 'cordis.patch.yml', 'cordis.yml') }
    $manifestNames = @($manifest | ForEach-Object { $_.path })
    $verified = $true
    foreach ($rn in $required) {
        if ($rn -notin $manifestNames) { $verified = $false; TraceG ("CONFIG SAFETY: required file " + $rn + " missing from manifest; restore REFUSED"); break }
    }
    if ($verified) {
        foreach ($entry in $manifest) {
            $src = Join-Path $lastGoodDir $entry.path
            if (-not (Test-Path $src)) { $verified = $false; break }
            $h = (Get-FileHash $src -Algorithm SHA256).Hash
            if ($h -ne $entry.sha256) { $verified = $false; TraceG ("CONFIG SAFETY: " + $entry.path + " hash mismatch; refusing restore"); break }
        }
    }
    if (-not $verified) {
        TraceG 'CONFIG SAFETY: guardian-lastgood set torn/hash-mismatch; restore REFUSED (fail-closed)'
        return
    }
    foreach ($cf in $configFiles) {
        $lg = Join-Path $lastGoodDir $cf.Name
        if (Test-Path $lg) {
            Copy-Item $lg $cf.Path -Force
            TraceG ("CONFIG SAFETY: " + $cf.Name + " smoke-rollback to last-good after repeated boot failures")
        }
    }
}

# ---------- maintenance lock (2026-08-16): restart script owns the restart ----------
# restart-dsh-server-delayed.ps1 writes this lock before killing the server and
# removes it after the new instance answers. While the lock is fresh (<10 min),
# the guardian must NOT auto-start/restart the server — otherwise two instances
# boot at once and one dies with EADDRINUSE (and the "recovered" alert spams).
# Phase 02 P2-0: the lock payload records the restart-worker PID. If that worker
# process no longer exists (it died with the old server — the R4 root cause), the
# lock is "orphaned": we clear it and let guardian recovery take over. This is the
# equivalent lock-lost takeover mechanism, so a dead worker can never wedge the
# system into "server down + lock present -> no self-heal".
$maintenanceLock = Join-Path $env:USERPROFILE '.dsh\guardian-maintenance.lock'
function Test-MaintenanceLock {
    if (-not (Test-Path $maintenanceLock)) { return $false }
    try {
        $age = (Get-Date) - (Get-Item $maintenanceLock).LastWriteTime
        if ($age.TotalMinutes -gt 10) {
            Remove-Item $maintenanceLock -Force -ErrorAction SilentlyContinue
            return $false
        }
        # Phase 02 P2-0: orphan detection. A fresh lock whose worker PID is gone
        # means the restart worker died before it could finish (old-server stop
        # killed it). Treat the lock as stale and let guardian take over.
        try {
            $payload = Get-Content $maintenanceLock -Raw | ConvertFrom-Json
            if ($payload.pid) {
                $workerAlive = Get-Process -Id ([int]$payload.pid) -ErrorAction SilentlyContinue
                if (-not $workerAlive) {
                    TraceG ("maintenance lock ORPHANED: worker pid=$($payload.pid) no longer alive; clearing for guardian takeover")
                    Remove-Item $maintenanceLock -Force -ErrorAction SilentlyContinue
                    return $false
                }
            }
        } catch {
            # payload not JSON (legacy timestamp-only lock): treat as valid while fresh
        }
        return $true
    } catch { return $false }
}
function Restart-Server([string]$reason) {
    # Phase 02 R7 (R6-1): Guardian is the Process Authority / POLICY entry ONLY.
    # It must NOT hold the restart mutex while waiting on the delegated worker —
    # Enter-DshRestartLock is a NAMED MUTEX (Local\DSHHarness.Restart.v1); a
    # worker spawned as a separate process cannot re-acquire a mutex the parent
    # already holds, so the worker would exit 75 (lock busy) and the Guardian's
    # -Wait would read a false failure. The delegated exact primitive
    # (restart-dsh-server-delayed.ps1) OWNS the mutex + budget attempt + commit.
    try {
    TraceG ("RESTART: " + $reason)
    Check-ConfigSafety            # never boot with a broken config (anti-self-kill)
    $rs = Join-Path $PSScriptRoot 'restart-dsh-server-delayed.ps1'
    if (-not (Test-Path $rs)) {
        TraceG ('  RESTART aborted: restart script missing')
        return $false
    }
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$rs`" -DelaySeconds 0 -Port $Port -RestartAndWait -TimeoutSec 180 -Reason `"$reason`""
    $p = Start-Process powershell -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        TraceG ("  RESTART FAILED: exact terminal not COMMITTED (exit=$($p.ExitCode))")
        return $false
    }
    TraceG '  RESTART COMMITTED (exact attempt: candidate -> stable -> COMMIT_READY; budget reset by Confirm-DshRestartStable)'
    return $true
    } finally {
        Exit-DshRestartLock $restartLock
    }
}

function Invoke-BudgetedRestart([string]$reason) {
    $gate = Test-DshRestartAllowed
    if (-not $gate.Allowed) {
        TraceG ("restart circuit closed: reason=$($gate.Reason) pauseUntil=$($gate.PauseUntil)")
        return $false
    }
    # Phase 02 R7 (R6-1): the delegated worker registers the attempt ONCE inside
    # (restart-dsh-server-delayed.ps1 L182 Register-DshRestartAttempt). Do NOT
    # register here too — that would double-count hourly attempts for one restart.
    $ok = Restart-Server $reason
    if ($ok) {
        # Phase 02 R6: the exact-attempt path already committed the budget
        # (Confirm-DshRestartStable inside the restart worker). Do NOT call
        # Register-DshRestartSuccess here — without a candidate it records
        # "NOT reset" while the real budget WAS reset by the worker's commit,
        # causing log/budget contradiction.
        TraceG 'restart budget committed via exact attempt (Confirm-DshRestartStable)'
        return $true
    }
    return $false
}

# ---------- config safety: guardian-lastgood is a RESTORE MIRROR ONLY ----------
# Anti-self-kill: if settings.yaml or cordis.patch.yml is edited into an invalid
# state (syntax error), the server would fail to boot on the next restart. The
# guardian restores the mirror snapshot before any start/restart, so a bad edit
# can never brick the service.
#
# Reliability v1 authority rule (2026-08-21):
#   YAML Valid != Last Good. Check-ConfigSafety NEVER writes into guardian-lastgood.
#   Syntax-valid files are left untouched (they are "allowed to attempt boot").
#   The mirror is updated ONLY by Save-VerifiedLastGood (full COMMIT_READY gate).
$configFiles = @(
    @{ Path = Join-Path $env:USERPROFILE '.dsh\settings.yaml'; Name = 'settings.yaml' },
    @{ Path = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'; Name = 'cordis.patch.yml' }
)
$lastGoodDir = Join-Path $dataRoot 'guardian-lastgood'
try { New-Item -ItemType Directory -Force -Path $lastGoodDir | Out-Null } catch {}
function Find-JsYaml {
    foreach ($p in @(
        (Join-Path $env:APPDATA 'npm\node_modules\js-yaml\index.js'),
        (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\js-yaml\index.js'),
        (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') -Directory -Recurse -Filter index.js -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'js-yaml' } | Select-Object -First 1 -ExpandProperty FullName)
    )) { if (Test-Path $p) { return $p } }
    return $null
}
function Test-YamlFile([string]$path) {
    $y = Find-JsYaml
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $y -or -not $node -or -not (Test-Path $path)) { return $null }   # unknown -> don't touch
    try {
        $code = "const fs=require('fs'),y=require(process.argv[1]);try{y.load(fs.readFileSync(process.argv[2],'utf8'));console.log('OK')}catch(e){console.log('ERR')}"
        $out = & $node -e $code $y $path 2>&1 | Out-String
        if ($out -match 'OK') { return $true }
        if ($out -match 'ERR') { return $false }
    } catch {}
    return $null
}
function Check-ConfigSafety {
    # Syntax guard only. Never promotes; never writes guardian-lastgood.
    foreach ($cf in $configFiles) {
        if (-not (Test-Path $cf.Path)) { continue }
        $ok = Test-YamlFile $cf.Path
        $lg = Join-Path $lastGoodDir $cf.Name
        if ($ok -eq $true) {
            # syntax valid -> allowed to attempt boot; do NOT promote (authority rule)
            TraceG ("CONFIG SAFETY: " + $cf.Name + " YAML valid (not promoted; mirror untouched)")
        } elseif ($ok -eq $false) {
            if (Test-Path $lg) {
                Copy-Item $lg $cf.Path -Force
                TraceG ("CONFIG SAFETY: " + $cf.Name + " was INVALID - restored mirror snapshot (guardian-lastgood)")
            } else {
                TraceG ("CONFIG SAFETY: " + $cf.Name + " is INVALID and no mirror snapshot exists")
            }
        }
    }
}

function Get-NewestSessionWrite {
    try {
        $sessions = Join-Path $env:USERPROFILE '.dsh\sessions'
        if (-not (Test-Path $sessions)) { return $null }
        $f = Get-ChildItem $sessions -Recurse -File -Filter 'session.jsonl.zstd' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($f) { return $f.LastWriteTime }
    } catch {}
    return $null
}

# ---------- install / uninstall: Startup-folder autostart (same pattern as DSH Server Autostart) ----------
$lnkName = 'DSH Guardian Autostart'
if ($Install) {
    try {
        $startup = [Environment]::GetFolderPath('Startup')
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path $startup ($lnkName + '.lnk')))
        $cmdPath = Join-Path $root 'DSH Guardian Autostart.cmd'
        if (-not (Test-Path $cmdPath)) {
            Set-Content -Path $cmdPath -Value (@(
                '@echo off',
                'rem DSH Guardian Autostart - runs at sign-in (hidden).',
                'rem Starts dsh-guardian.ps1 (keep-awake + server watchdog) detached.',
                'setlocal',
                'start "" powershell -NoProfile -WindowStyle Hidden -File "%~dp0dsh-guardian.ps1" %*',
                'endlocal'
            ) -join "`r`n") -Encoding ASCII
        }
        $lnk.TargetPath = $cmdPath
        $lnk.WorkingDirectory = $root
        $lnk.WindowStyle = 7
        $lnk.Save()
        TraceG 'guardian autostart installed (Startup folder)'
        Write-Host 'Guardian autostart installed (Startup folder). Starting now...'
        # detached start with own handles (no pipe inheritance)
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"'
        $psi.UseShellExecute = $true
        $psi.WindowStyle = 'Hidden'
        [System.Diagnostics.Process]::Start($psi) | Out-Null
        Write-Host 'Guardian started detached.'
        exit 0
    } catch { Write-Host ('Install failed: ' + $_.Exception.Message); exit 1 }
}
if ($Uninstall) {
    try {
        $startup = [Environment]::GetFolderPath('Startup')
        $lnk = Join-Path $startup ($lnkName + '.lnk')
        if (Test-Path $lnk) { Remove-Item $lnk -Force; TraceG 'guardian autostart removed' }
        else { TraceG 'guardian autostart not found (nothing to remove)' }
    } catch { TraceG ('uninstall error: ' + $_.Exception.Message) }
    exit 0
}

# ---------- single instance ----------
$guardMutex = New-Object System.Threading.Mutex($false, 'DSHGuardian.SingleInstance')
if (-not $guardMutex.WaitOne(0)) {
    Write-Host 'DSH Guardian already running.'
    exit 0
}

TraceG ("guardian start: port=$Port interval=${IntervalSeconds}s stuck=$StuckRestartMinutes keepAwake=$(-not $NoKeepAwake) lidGuard=$(-not $NoLidGuard)")
Write-GuardianHeartbeat 'starting'
Check-ConfigSafety   # establish/refresh last-good snapshots immediately

# ---------- main loop ----------
$stuckHits = 0
$lastStuckRestart = $null
$awakeTick = 0
$cfgTick = 0
$failStreak = 0
$pauseUntil = $null
$lockTick = 0
$recovering = $false
$lastRecoverAlertAt = $null
try {
do {
    Write-GuardianHeartbeat 'checking'
    $up = Test-Server

    if (-not $up) {
        if (Test-MaintenanceLock) {
            # restart script is restarting the server itself - stay out of the way
            if ($recovering) { $recovering = $false }
        }
        else {
        $owner = Get-PortIdentity
        if ($owner.State -in @('ok','none')) {
            TraceG ("server not client-ready (ownerState=$($owner.State)) - budgeted controlled restart")
            $failStreak++; $recovering = $true
            if (Invoke-BudgetedRestart ("server not ready ownerState=$($owner.State)")) {
                $failStreak = 0
                Invoke-GoalRecovery
                if (-not $lastRecoverAlertAt -or ((Get-Date) - $lastRecoverAlertAt).TotalMinutes -ge 10) {
                    Send-TelegramAlert 'dsh 服务已恢复（此前未通过 readiness，重启成功）。'
                    $lastRecoverAlertAt = Get-Date
                }
                $recovering = $false
            } else {
                TraceG 'budgeted controlled restart did not complete'
            }
        }
        elseif ($owner.State -in @('identity_mismatch','ambiguous','error')) {
            TraceG ("server down but owner identity is unsafe: state=$($owner.State) pid=$($owner.Pid) nonLoopbackListeners=$($owner.NonLoopbackCount); no kill/start")
            Send-TelegramAlert ("dsh 服务端口 owner 无法安全核验（$($owner.State)），已停止自动杀进程/拉起。")
        }
        }
        $stuckHits = 0
    } else {
        # Stale-mtime is a weak signal, so a restart is issued only when an
        # ACTIVE goal exists (a task that should be progressing but has had
        # no session write for >= threshold minutes) and only after 2
        # consecutive hits plus a cooldown of one threshold period since the
        # last stale restart (a restart does not update session mtime, so
        # without the cooldown this branch would re-trigger every loop).
        # Without an active goal the session is merely old/quiet: telemetry
        # + alert only, no restart.
        if ($StuckRestartMinutes -gt 0 -and -not (Test-MaintenanceLock)) {
            $last = Get-NewestSessionWrite
            if ($last) {
                $ageMin = [int]((Get-Date) - $last).TotalMinutes
                if ($ageMin -ge $StuckRestartMinutes) {
                    $stuckHits++
                    $goalState = Test-ActiveGoal
                    $cooldownOk = (-not $lastStuckRestart) -or ((Get-Date) - $lastStuckRestart).TotalMinutes -ge $StuckRestartMinutes
                    if ($goalState -eq 'active' -and $stuckHits -ge 2 -and $cooldownOk) {
                        $lastStuckRestart = Get-Date
                        TraceG ("RESTART: stale session age=$ageMin min with ACTIVE goal; recovering task")
                        # Phase 02 R7 adversarial fix: stale-session restart MUST go
                        # through the budget gate (Invoke-BudgetedRestart) — a direct
                        # Restart-Server call bypasses Test-DshRestartAllowed and can
                        # restart even when the circuit is open.
                        if (Invoke-BudgetedRestart ("stale session $ageMin min with active goal")) {
                            Invoke-GoalRecovery
                            Send-TelegramAlert ("dsh 检测到活跃 goal 但会话已 $ageMin 分钟无写入，已重启服务并恢复任务。")
                        }
                        $stuckHits = 0
                    } else {
                        $why = if ($goalState -ne 'active') { 'no active goal; telemetry only' }
                               elseif (-not $cooldownOk) { 'active goal; restart in cooldown' }
                               else { 'active goal; waiting for hit threshold' }
                        TraceG ("stale-session telemetry age=$ageMin min threshold=$StuckRestartMinutes hit=$stuckHits goalState=$goalState; $why")
                        if ($stuckHits -ge 2) {
                            Send-TelegramAlert 'dsh 会话文件长期未写入（无活跃 goal 或冷却中），仅记录为停滞候选，未自动重启。'
                            $stuckHits = 0
                        }
                    }
                } else { $stuckHits = 0 }
            }
        }
    }

    # re-assert keep-awake periodically
    if ($awake) {
        $awakeTick++
        if ($awakeTick -ge 2) { $awakeTick = 0; $null = [DSHGuard.Native]::SetThreadExecutionState($script:ES_CONTINUOUS -bor $script:ES_SYSTEM -bor $script:ES_AWAYMODE) }
    }

    # periodic config safety scan (every 10 cycles ~ 5 min)
    $cfgTick++
    if ($cfgTick -ge 10) { $cfgTick = 0; Check-ConfigSafety }

    # periodic stale-lock sweep (every 10 cycles ~ 5 min)
    $lockTick++
    if ($lockTick -ge 10) { $lockTick = 0; Clear-StaleLocks }

    if ($OneShot) { Write-GuardianHeartbeat 'oneshot'; break }
    # dynamic sleep: exponential backoff while boot failures streak
    $sleepSec = if ($failStreak -ge 12) { 300 } elseif ($failStreak -ge 6) { 120 } elseif ($failStreak -ge 3) { 60 } else { $IntervalSeconds }
    Write-GuardianHeartbeat ("sleeping:$sleepSec")
    Start-Sleep -Seconds $sleepSec
} while ($true)
} catch {
    $script:GuardianExitCode = 1
    TraceG ('guardian exception: ' + $_.Exception.Message)
} finally {

# ---------- cleanup ----------
if ($script:awakeTimer) { try { $script:awakeTimer.Stop(); $script:awakeTimer.Dispose() } catch {} }
if ($awake) { try { $null = [DSHGuard.Native]::SetThreadExecutionState($script:ES_CONTINUOUS) } catch {} }
if ($lidChanged) {
    try {
        powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $lidOld[0] | Out-Null
        powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $lidOld[1] | Out-Null
        powercfg /setactive SCHEME_CURRENT | Out-Null
        TraceG 'lid-guard restored'
    } catch { TraceG ('lid restore error: ' + $_.Exception.Message) }
}
Write-GuardianHeartbeat 'exit'
try { $guardMutex.ReleaseMutex() } catch {}
TraceG 'guardian exit'
}
exit $script:GuardianExitCode
