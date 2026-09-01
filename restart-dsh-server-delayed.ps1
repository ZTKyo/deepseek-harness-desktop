# restart-dsh-server-delayed.ps1 - apply cordis.patch.yml by restarting the 3080 server.
# Phase 02 P2-0 (Automatic Restart Ownership & Worker Survival):
#   When invoked from the Harness/Agent tool context, the caller's process tree is
#   a CHILD of the DSH server itself. Stopping the server would therefore kill this
#   worker mid-restart (R4 evidence: restart log truncated after validate, old server
#   exitCode=-1, maintenance lock left behind, guardian paused self-heal, manual
#   Desktop relaunch required).
#   Fix: -Detach (default) spawns the REAL restart work in a WMI-created detached
#   process (parent = WmiPrvSE.exe, NOT the DSH tree). The detached worker owns the
#   whole stop -> start -> verify -> finally-cleanup-lock lifecycle, so it survives
#   the old server shutdown and always releases the maintenance lock.
# Log: %LOCALAPPDATA%\DSHHarness\logs\restart-apply-patch.log
param(
    [int]$DelaySeconds = 2,
    [int]$Port = 3080,
    [switch]$Detach,          # default ON: spawn detached worker via WMI
    [switch]$WorkerMode,      # internal: run the actual restart logic (spawned by Detach)
    [string]$AttemptId = $null,  # Phase 02 R4 (Step 1): terminal ledger identity
    [string]$WaitAttempt = $null, # Phase 02 R4: wait for a specific attempt's terminal state
    [int]$TimeoutSec = 180,
    # Phase 02 R7 (R6-1): caller reason recorded in the attempt ledger (Guardian
    # passes its restart reason; SafeMode/Transaction pass theirs).
    [string]$Reason = $null,
    # P2.5 防回归 dry-run：只做插件挂载预检（Assert-DshPluginModules），不重启。
    # 供部署流水线在重启前调用；与 tools\install-plugin.mjs --check 互补。
    [switch]$PreflightOnly,
    # P2.5 preflight-only 时的配置目录覆盖（默认取真实预设/配置目录）
    [string]$PresetDir = (Join-Path $env:USERPROFILE '.dsh\.agent-presets\autonomous'),
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
    # Phase 02 R5 (R4-B2): one-shot "restart AND wait for exact terminal" — the
    # caller (SafeMode / Transaction / GUI) gets the detailed worker's terminal
    # state, NOT the outer wrapper's exit. Equivalent to calling with -AttemptId
    # then -WaitAttempt, in a single invocation.
    [switch]$RestartAndWait
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:LOCALAPPDATA "DSHHarness\logs\restart-apply-patch.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$lockFile = Join-Path $env:USERPROFILE '.dsh\guardian-maintenance.lock'
# Phase 02 R4 (Step 1): restart attempt terminal ledger (callers wait on this).
$attemptsDir = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\restart-attempts'
New-Item -ItemType Directory -Force -Path $attemptsDir | Out-Null

function Write-Log([string]$msg) {
    Add-Content $log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# ---------- P2.5 防回归预检：重启前解析插件挂载引用 ----------
# 根因（Incident 2026-08-26 17:39-18:37）：agent.cordis.yml 挂载 './context-memory.mjs'
# 是相对**预设目录**解析的；部署时只同步到 profiles\web，导致重启后 mount 解析失败、
# 会话 resume 被阻断（Codex emergency recovery 只补文件，非正式闭环）。
# 本预检在停旧服务**之前**执行：所有 'name: "./*.mjs|*.js"' 引用必须能在其配置所在
# 目录解析到真实文件，且配置 YAML 语法有效（!!js 容忍，与 guardian Test-YamlFile 同口径）。
# 任何缺失 → 中止本次重启（throw → finally 清锁），旧服务保持运行，不产生"装一半就重启"。
function Assert-DshPluginModules {
    param(
        [string]$PresetDir = (Join-Path $env:USERPROFILE '.dsh\.agent-presets\autonomous'),
        [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
    )
    $configs = @(
        @{ Path = (Join-Path $PresetDir 'agent.cordis.yml'); Label = 'preset agent.cordis.yml' },
        @{ Path = (Join-Path $ProfileDir 'cordis.patch.yml'); Label = 'profile cordis.patch.yml' }
    )
    # 指向 js-yaml 包**目录**（require 目录 → package.json main 生效）。
    # 教训：node process.argv 索引 = argv[0] node / argv[1] 脚本自身 / argv[2] 起才是
    # 真实参数——probe 里 js-yaml 取 argv[2]、配置文件取 argv[3]，别再用 argv[1]。
    $jsYamlCandidates = @(
        (Join-Path $env:APPDATA 'npm\node_modules\js-yaml'),
        (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\js-yaml')
    )
    $jsYaml = $jsYamlCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    foreach ($cfg in $configs) {
        $p = $cfg.Path
        if (-not (Test-Path $p)) { Write-Log ("preflight: {0} not present; skipping" -f $cfg.Label); continue }
        $dir = Split-Path $p -Parent
        $text = Get-Content $p -Raw
        # YAML 语法校验（!!js 容忍；语义求值归 cordis）
        if ($jsYaml) {
            $code = 'const fs=require("fs"),y=require(process.argv[2]);try{const s=fs.readFileSync(process.argv[3],"utf8").replace(/!!js(\s+)/g,"str$1");y.load(s);console.log("OK")}catch(e){console.log("ERR: "+e.message)}'
            $probe = Join-Path $env:TEMP ('dsh-yaml-probe-' + [guid]::NewGuid().ToString('N') + '.js')
            Set-Content -Path $probe -Value $code -Encoding UTF8
            $yamlOut = (& node $probe $jsYaml $p 2>$null | Out-String).Trim()
            $nodeExit = $LASTEXITCODE
            Remove-Item $probe -Force -ErrorAction SilentlyContinue
            if ($nodeExit -ne 0 -or $yamlOut -notmatch '^OK') {
                Write-Log ("preflight FAIL: {0} YAML 无效: {1}" -f $cfg.Label, $yamlOut)
                throw ("restart preflight failed: {0} YAML 无效: {1}" -f $cfg.Label, $yamlOut)
            }
        } else {
            Write-Log ("preflight warn: js-yaml not found; YAML 语法检查跳过")
        }
        # 解析相对模块引用（name: './xxx.mjs|.js'）
        $refs = [regex]::Matches($text, "name:\s*['""](\./[^'""]+?\.(?:mjs|js))['""]") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
        $missing = @()
        foreach ($r in $refs) {
            $target = Join-Path $dir $r
            if (-not (Test-Path $target)) { $missing += $r }
        }
        if ($missing.Count -gt 0) {
            Write-Log ("preflight FAIL: {0} 挂载引用缺失文件 → {1}（重启将阻断；先运行 tools\install-plugin.mjs 同步）" -f $cfg.Label, ($missing -join ', '))
            throw ("restart preflight failed: {0} 挂载引用缺失文件 → {1}。请先执行 node tools\install-plugin.mjs --plugin <name> 同步" -f $cfg.Label, ($missing -join ', '))
        }
        Write-Log ("preflight OK: {0} 相对挂载全部可解析 ({1})" -f $cfg.Label, ($refs -join ', '))
    }
}

# P2.5 dry-run：只做插件挂载预检，不重启（供部署流水线在真正重启前调用）
# R2-2: 预检 = YAML 语法 + 挂载引用存在性（Assert-DshPluginModules）+
#       hash 一致性（install-plugin.mjs --check，目标位必须是 repo 当前版本，
#       防止"文件在但内容是旧版"的重启后静默跑旧插件）。
if ($PreflightOnly) {
    try {
        Assert-DshPluginModules -PresetDir $PresetDir -ProfileDir $ProfileDir
        # R2-2: hash 一致校验——交给权威安装器（同一套 sha256 口径，避免第二套校验逻辑）
        $installer = Join-Path $root 'tools\install-plugin.mjs'
        if (Test-Path $installer) {
            Write-Log "preflight: invoking install-plugin --check (hash 一致性)"
            & node $installer --check --preset $PresetDir --profile $ProfileDir 2>&1 | ForEach-Object {
                Write-Log ("install-plugin check: " + $_)
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Log "preflight FAIL: install-plugin --check 未通过（挂载位 hash 与 repo 不一致或缺失）"
                throw "restart preflight failed: install-plugin --check 未通过。请先执行 node tools\install-plugin.mjs --plugin <name> 同步后再重启"
            }
            Write-Log "preflight OK: install-plugin --check PASS（挂载位 hash 与 repo 一致）"
        } else {
            Write-Log ("preflight warn: installer not found at {0}; hash check skipped" -f $installer)
        }
        Write-Log "preflight only: PASS（未执行重启）"
        Write-Output "PREFLIGHT PASS"
        exit 0
    } catch {
        Write-Log ("preflight only: FAIL - {0}" -f $_.Exception.Message)
        Write-Output ("PREFLIGHT FAIL: " + $_.Exception.Message)
        exit 1
    }
}

# ---------- WAIT MODE: block until a specific attempt reaches a terminal state ----------
# Phase 02 R5 (R4-B2): RestartAndWait = detach a restart with a fresh attemptId,
# then fall through to the WaitAttempt loop below for the exact terminal state.

# ledger helpers (defined BEFORE the RestartAndWait branch below uses them:
# Windows PowerShell 5.1 treats a use-before-definition call as a terminating
# error, which broke `-RestartAndWait` when invoked from a 5.1 caller).
function Set-AttemptState([string]$id, [string]$state, [string]$detail = '', [bool]$terminal = $false) {
    if (-not $id) { return }
    $f = Join-Path $attemptsDir ($id + '.json')
    $rec = @{ attemptId = $id; port = $Port; pid = $PID; ts = (Get-Date).ToString('o'); state = $state; terminalState = if ($terminal) { $state } else { $null }; detail = $detail }
    try { $rec | ConvertTo-Json -Compress | Set-Content $f -Encoding UTF8 } catch { Write-Log ("attempt ledger write failed: $($_.Exception.Message)") }
}

$restartAndWaitId = $null
if ($RestartAndWait -and -not $WorkerMode -and -not $WaitAttempt) {
    $restartAndWaitId = [guid]::NewGuid().ToString('N')
    $AttemptId = $restartAndWaitId
    Set-AttemptState $attemptId 'SPAWNED' '' $false
    $shortRoot = try { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { $root }
    $shortSelf = Join-Path $shortRoot 'restart-dsh-server-delayed.ps1'
    $inner = '. "' + $shortSelf + '" -WorkerMode -DelaySeconds ' + $DelaySeconds + ' -Port ' + $Port + ' -AttemptId ' + $AttemptId
    $env:DSH_RESTART_WORKER_MODE = '1'
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'
        $psi.UseShellExecute = $true
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $proc = [System.Diagnostics.Process]::Start($psi)
        if (-not $proc) { Set-AttemptState $AttemptId 'FAILED' 'spawn returned no process' $true; exit 4 }
        Write-Log ("restart-and-wait: worker spawned pid=$($proc.Id) attempt=$AttemptId")
    } catch {
        Set-AttemptState $AttemptId 'FAILED' ("spawn error: " + $_.Exception.Message) $true
        Write-Host ("restart attempt {0} FAILED" -f $AttemptId)
        exit 4
    }
    $WaitAttempt = $AttemptId
    Write-Host $AttemptId   # caller can read the attemptId from stdout
}
# Phase 02 R4 (Step 1): callers (Transaction / Safe Mode / GUI) must NOT treat the
# detached outer wrapper exit 0 as "restart complete". They call
# restart-dsh-server-delayed.ps1 -WaitAttempt <id> -TimeoutSec N and this blocks
# until the ledger shows COMMITTED | FAILED | TIMED_OUT.
if ($WaitAttempt) {
    $ledgerFile = Join-Path $attemptsDir ($WaitAttempt + '.json')
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $ledgerFile) {
            $led = Get-Content $ledgerFile -Raw | ConvertFrom-Json
            if ($led.terminalState) {
                Write-Log ("wait-attempt {0} -> terminal {1}" -f $WaitAttempt, $led.terminalState)
                if ($led.terminalState -eq 'COMMITTED') { exit 0 }
                Write-Host ("restart attempt {0} terminal={1}" -f $WaitAttempt, $led.terminalState)
                exit 2
            }
        }
        Start-Sleep -Seconds 2
    }
    Write-Log ("wait-attempt {0} TIMED_OUT after {1}s" -f $WaitAttempt, $TimeoutSec)
    Write-Host ("restart attempt {0} TIMED_OUT" -f $WaitAttempt)
    exit 3
}

# ---------- DETACH MODE: spawn the worker in an independent process ----------
# The caller (agent tool tree) is a child of the DSH server. If we run the restart
# here, stopping the server kills us before finally{} can release the lock. So we
# re-invoke this script as a NEW process via Start-Process (hidden window). Even if
# the new process is still under the DSH tree, the guardian now detects an orphaned
# maintenance lock (worker PID dead -> clears lock -> takes over restart), so a dead
# worker can NEVER wedge self-heal. This is the equivalent lock-lost takeover.
if (-not $WorkerMode) {
    $useDetach = $Detach -or (-not $env:DSH_RESTART_WORKER_MODE)
    if ($useDetach) {
        Write-Log ("detach: spawning worker for port $Port (delay=$DelaySeconds)")
        # Phase 02 R4 (Step 1): generate attemptId + SPAWNED ledger; caller waits
        # on this attempt's terminal state (COMMITTED | FAILED | TIMED_OUT), NOT
        # on this outer wrapper's exit code.
        if (-not $AttemptId) { $AttemptId = [guid]::NewGuid().ToString('N') }
        Set-AttemptState $AttemptId 'SPAWNED' '' $false
        # Use short path (8.3) to avoid spaces breaking the -Command string
        $shortRoot = try { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { $root }
        $shortSelf = Join-Path $shortRoot 'restart-dsh-server-delayed.ps1'
        # Use -Command with dot-source (NOT -File): WMI/Start-Process created
        # processes cannot load .ps1 via -File in some contexts (verified).
        # Phase 02 R8 (R8-5): forward -Reason to the worker so the attempt ledger
        # records the REAL caller reason (was falling back to 'delayed-restart').
        $inner = '. "' + $shortSelf + '" -WorkerMode -DelaySeconds ' + $DelaySeconds + ' -Port ' + $Port + ' -AttemptId ' + $AttemptId + ' -Reason "' + ($Reason -replace '"', '""') + '"'
        $env:DSH_RESTART_WORKER_MODE = '1'   # nested call must not re-detach
        try {
            # Start-Process hidden window (verified working). Even if the worker dies
            # with the DSH tree, the guardian's orphaned maintenance-lock detection
            # clears the lock and takes over recovery (backstop).
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = 'powershell.exe'
            $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -Command "' + $inner + '"'
            $psi.UseShellExecute = $true
            $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
            $proc = [System.Diagnostics.Process]::Start($psi)
            if ($proc) {
                Write-Log ("detach: worker spawned via Start-Process pid=$($proc.Id) attempt=$AttemptId (guardian orphan takeover as backstop)")
                # Phase 02 R4: write attemptId so a caller can wait on the terminal state.
                Write-Output $AttemptId
                exit 0
            }
            Set-AttemptState $AttemptId 'FAILED' 'spawn returned no process' $true
            Write-Log "detach: Start-Process returned no process"
        } catch {
            Set-AttemptState $AttemptId 'FAILED' ("spawn error: " + $_.Exception.Message) $true
            Write-Log ("detach: Start-Process failed: $($_.Exception.Message)")
        }
        Write-Log "detach: spawn failed; running inline (risk: worker may die with server; guardian orphan takeover is the backstop)"
    }
    # Fallback (no detach / spawn unavailable): run inline. NOTE: if the caller is the
    # agent tool tree this may still die with the server, but the guardian's orphaned
    # maintenance-lock detection will clear the lock and take over recovery.
    if (-not $env:DSH_RESTART_WORKER_MODE) { $env:DSH_RESTART_WORKER_MODE = '1' }
}

# ================= WORKER MODE: real restart logic =================
. (Join-Path $root 'dsh-process-identity.ps1')
. (Join-Path $root 'dsh-readiness.ps1')
. (Join-Path $root 'dsh-generation.ps1')
. (Join-Path $root 'dsh-restart-budget.ps1')

Start-Sleep -Seconds $DelaySeconds
Write-Log ("restart begin (port {0})" -f $Port)
if ($AttemptId) { Set-AttemptState $AttemptId 'STARTED' '' $false }

$restartLock = Enter-DshRestartLock
if (-not $restartLock) {
    Write-Log ("restart skipped: another start/restart transaction owns the lock")
    exit 75
}

# maintenance lock: tell the guardian to stay out of the way while we restart
# (otherwise it auto-starts a second instance -> EADDRINUSE crash + alert spam).
# Phase 02 P2-0: lock payload now records the worker PID so the guardian can
# detect a dead (lost) worker and take over recovery.
$lockPayload = @{ pid = $PID; ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); port = $Port } | ConvertTo-Json -Compress
try { Set-Content -Path $lockFile -Value $lockPayload -Encoding UTF8 } catch { Write-Log "lock write failed: $($_.Exception.Message)" }

try {

# P2.5 防回归：停旧服务前先做插件挂载预检（缺失模块 → 中止，旧服务不动）
Assert-DshPluginModules

$budgetGate = Test-DshRestartAllowed
if (-not $budgetGate.Allowed) { throw "restart budget blocked: $($budgetGate.Reason)" }
$attemptReason = if ($Reason) { $Reason } else { 'delayed-restart' }
Register-DshRestartAttempt $attemptReason | Out-Null

# stop the old DSH server only after loopback ownership is proven
$owner = Get-DshLoopbackOwner -Port $Port
if ($owner.State -eq 'ok') {
    Write-Log ("validated DSH loopback PID {0} creation={1} cmdHash={2}" -f $owner.Pid, $owner.Snapshot.CreationDate, $owner.Snapshot.CommandLineHash)
    $stop = Stop-DshLoopbackOwner -Port $Port -ExpectedPid $owner.Pid
    Write-Log ("stop result: {0} reason={1}" -f $stop.State, $stop.Reason)
    if ($stop.State -ne 'stopped') { throw "DSH loopback owner was not stopped: $($stop.State)" }
} elseif ($owner.State -eq 'none') {
    Write-Log ("no DSH loopback owner; nonLoopbackListeners={0}" -f $owner.NonLoopbackCount)
} else {
    Write-Log ("restart aborted: unsafe owner state={0} pid={1} nonLoopbackListeners={2}" -f $owner.State, $owner.Pid, $owner.NonLoopbackCount)
    throw "Unsafe DSH loopback owner state: $($owner.State)"
}
$free = ((Get-DshLoopbackOwner -Port $Port).State -eq 'none')
Write-Log ("DSH loopback free: {0}" -f $free)
if (-not $free) { throw 'DSH loopback port is still occupied; refusing to start a second instance' }

# start fresh via the standard autostart guard (detached, no window)
$starter = Join-Path $root 'start-dsh-server.ps1'
if (Test-Path $starter) {
    # Do not invoke the starter through `&`: its detached server child can inherit
    # this process's output pipes, leaving the restart transaction hung forever
    # even after the starter itself has exited. A shell-executed hidden child has
    # no redirected handles; wait only for that direct starter process.
    $starterPsi = New-Object System.Diagnostics.ProcessStartInfo
    $starterPsi.FileName = 'powershell.exe'
    $starterPsi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $starter + '" -Port ' + $Port + ' -LockAlreadyHeld'
    $starterPsi.UseShellExecute = $true
    $starterPsi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $starterProc = [System.Diagnostics.Process]::Start($starterPsi)
    if (-not $starterProc) { throw 'Unable to launch start-dsh-server.ps1' }
    $starterProc.WaitForExit()
    $starterCode = $starterProc.ExitCode
    Write-Log ("starter exit code: {0}" -f $starterCode)
    # Phase 02 R2: starter exit code is advisory only. start-dsh-server.ps1
    # returns 2 when client_ready is not reached within its own short window,
    # but the launcher/server it spawned continues booting to client_ready on
    # its own (observed 2026-08-23 23:17: server 20432 reached client_ready
    # moments after starter exited 2). We do NOT fail here; the stable-window
    # readiness + COMMIT_READY check below is the authoritative verification.
    # exit 75 = restart lock held by another transaction (concurrent restart).
    if ($starterCode -eq 75) { throw "start-dsh-server.ps1: another restart transaction owns the lock" }
} else {
    # RH1 Part A2: do NOT fall back to `cmd.exe /C dsh web > log` — that truncates
    # the per-port server log and spawns a second start path. start-dsh-server.ps1
    # is the single start authority (env sanitize + restart lock + append-only log
    # via dsh-launcher.js). If it is missing, fail the restart; the guardian's
    # orphan takeover remains the backstop.
    Write-Log "start-dsh-server.ps1 missing at $starter; refusing truncating/second start path (single authority)"
    throw "start-dsh-server.ps1 missing at $starter (single authority)"
}

# verify actual DSH readiness, not only a root-page HTTP 200.
# Phase 02 R2: wait up to 60s for client_ready (the starter may have exited
# before its own short window saw client_ready; the server keeps booting).
$ready = $null
for ($i = 0; $i -lt 60; $i++) {
    $ready = Test-DshReadiness -Port $Port -RequireWebSockets
    if ($ready.State -eq 'client_ready') { break }
    Start-Sleep -Seconds 1
}
Write-Log ("readiness: {0} error={1} (waited {2}s)" -f $ready.State, $ready.Error, $i)
if ($ready.State -ne 'client_ready') { throw "DSH client readiness failed: $($ready.State)" }

# Phase 02 Reviewer Round 1 (BLOCKING-4): stable-window commit.
# client_ready = candidate stage only (does NOT reset budget). We wait a stable
# window, then re-verify readiness + COMMIT_READY, and only then commit success
# (which resets the budget). A crash inside the window does not clear attempts.
# Phase 02 R5 (R4-B2): the candidate is bound to the NEW server's identity —
# its loopback PID + runtime generation — not the worker PID. Confirm must prove
# the same server+generation.
$newOwner = Get-DshLoopbackOwner -Port $Port
$newServerPid = if ($newOwner -and $newOwner.Pid) { [int]$newOwner.Pid } else { 0 }
# Phase 02 R5 Addendum: generation MUST be a non-empty current-server identity.
# Empty/unknown generation -> fail-closed (do NOT commit with a blank identity).
$newGen = ''
try { if (Get-Command Get-DshGenerationId -ErrorAction SilentlyContinue) { $newGen = [string](Get-DshGenerationId -Port $Port) } } catch { $newGen = '' }
$newGen = ($newGen -replace '\s', '')
Write-Log ("candidate bound to new server pid={0} generation='{1}'" -f $newServerPid, $newGen)
if (-not $newGen -or $newServerPid -le 0) {
    Write-Log ("restart commit ABORTED: candidate identity incomplete (pid={0} gen='{1}') - fail-closed" -f $newServerPid, $newGen)
    if ($AttemptId) { Set-AttemptState $AttemptId 'FAILED' 'candidate identity incomplete (generation missing)' $true }
    throw "candidate identity incomplete: generation must be non-empty"
}
Register-DshRestartCandidate -AttemptId $AttemptId -ProcessId $newServerPid -Generation $newGen | Out-Null
$stableSec = if ($env:DSH_RESTART_STABLE_WINDOW_SEC) { [int]$env:DSH_RESTART_STABLE_WINDOW_SEC } else { 30 }
Write-Log ("stable window: waiting {0}s before commit" -f $stableSec)
Start-Sleep -Seconds $stableSec

# Phase 02 R6 (R5-B2): bounded terminal grace for boot-edge fluctuation — a
# transient api_unready at the stable re-check must NOT immediately FAILED a
# healthy server (observed 13:54: server 22032 reached HTTP200+COMMIT_READY
# shortly after a re-check timeout). Retry the readiness+COMMIT_READY probe a
# bounded number of times; only a PERSISTENT failure becomes FAILED.
$ready2 = Test-DshReadiness -Port $Port -RequireWebSockets
Write-Log ("stable re-check readiness: {0} error={1}" -f $ready2.State, $ready2.Error)
$graceMax = 3
$graceSleep = 10
$graceCount = 0
while ($ready2.State -ne 'client_ready' -and $graceCount -lt $graceMax) {
    $graceCount++
    Write-Log ("boot grace: re-check not ready ({0}), retry {1}/{2} in {3}s" -f $ready2.State, $graceCount, $graceMax, $graceSleep)
    Start-Sleep -Seconds $graceSleep
    $ready2 = Test-DshReadiness -Port $Port -RequireWebSockets
    Write-Log ("boot grace re-check: {0} error={1}" -f $ready2.State, $ready2.Error)
}
if ($ready2.State -ne 'client_ready') { throw "stable re-check failed after grace: $($ready2.State)" }

# COMMIT_READY: full runtime surface (process identity + host.describe + session.list
# + events.mux/host + renderer + stable window + light probe). Budget resets ONLY here.
$crScript = Join-Path $root 'dsh-commit-readiness.ps1'
$commitOk = $false
if (Test-Path $crScript) {
    try {
        . $crScript
        if (Get-Command Test-CommitReadiness -ErrorAction SilentlyContinue) {
            $gate = Test-CommitReadiness -Port $Port -StableWindowSec 2 -LightProbe:$false
            $commitOk = ($gate -and $gate.Ready -eq $true)
            Write-Log ("COMMIT_READY: {0} stage={1}" -f $commitOk, $(if ($gate) { $gate.Stage } else { 'n/a' }))
        }
    } catch {
        Write-Log ("COMMIT_READY error: {0}" -f $_.Exception.Message)
    }
}
if (-not $commitOk) { throw "COMMIT_READY failed after stable window; budget NOT reset" }

$commitRes = Confirm-DshRestartStable -AttemptId $AttemptId -ProcessId $newServerPid -Generation $newGen
if (-not $commitRes.Committed) {
    Write-Log ("restart commit rejected: {0} (budget NOT reset)" -f $commitRes.Reason)
    throw "restart commit rejected: $($commitRes.Reason)"
}
Write-Log "restart committed (stable window + COMMIT_READY; budget reset)"
if ($AttemptId) { Set-AttemptState $AttemptId 'COMMITTED' 'stable window + COMMIT_READY' $true }
} finally {
    # release maintenance lock (guardian resumes auto-recovery)
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-Log ("maintenance lock released")
    Exit-DshRestartLock $restartLock
    # Phase 02 R4 (Step 1): if we reach finally WITHOUT a COMMITTED terminal state
    # and an attemptId exists, the restart failed -> FAILED terminal (caller wakes).
    if ($AttemptId) {
        $ledgerF = Join-Path $attemptsDir ($AttemptId + '.json')
        $cur = if (Test-Path $ledgerF) { Get-Content $ledgerF -Raw | ConvertFrom-Json } else { $null }
        if (-not $cur -or $cur.terminalState -ne 'COMMITTED') {
            $failDetail = $_.Exception.Message
            Set-AttemptState $AttemptId 'FAILED' $failDetail $true
        }
    }
}
