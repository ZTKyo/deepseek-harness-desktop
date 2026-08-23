# dsh-process-identity.ps1 - fail-closed DSH listener/process identity helpers.
#
# This file is dot-sourced by the DSH guardian and restart/start scripts.
# It intentionally returns only safe process metadata and a command-line hash;
# it never returns command-line text, environment values, or credentials.

function Get-DshTextSha256([string]$Text) {
    if ($null -eq $Text) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Test-DshRuntimeLedgerIdentity(
    [object]$Snapshot,
    [int]$Port = 3080,
    [string]$RuntimePath = $null,
    [string]$EntryPath = $null
) {
    # A task/session boundary can legitimately hide CommandLine from an
    # external observer.  Never treat that absence as DSH by itself: accept
    # this fallback only when the launcher-owned runtime ledger, listener PID,
    # process parent, current-user owner, entry-path hash, and launch-time
    # window all agree.  Any missing or malformed datum fails closed.
    if (-not $Snapshot -or $Snapshot.CommandLinePresent -or -not $Snapshot.IdentityChecks.IsNode -or -not $Snapshot.OwnerCurrentUser -or -not $Snapshot.CreationDate -or $Snapshot.ParentProcessId -le 0) {
        return [pscustomobject]@{ Accepted = $false; Reason = 'snapshot_precondition'; Checks = $null }
    }
    if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
        $RuntimePath = Join-Path $env:LOCALAPPDATA ("DSHHarness\\logs\\dsh-runtime-{0}.json" -f $Port)
    }
    if ([string]::IsNullOrWhiteSpace($EntryPath)) {
        $EntryPath = Join-Path $env:APPDATA 'npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
    }
    if (-not (Test-Path -LiteralPath $RuntimePath -PathType Leaf) -or -not (Test-Path -LiteralPath $EntryPath -PathType Leaf)) {
        return [pscustomobject]@{ Accepted = $false; Reason = 'required_file_missing'; Checks = $null }
    }

    try {
        $runtimeFile = Get-Item -LiteralPath $RuntimePath -ErrorAction Stop
        $runtime = Get-Content -LiteralPath $RuntimePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        # Canonicalise before hashing.  The launcher receives a normalised
        # Windows path, while callers may spell separators differently.
        $resolvedEntryPath = (Resolve-Path -LiteralPath $EntryPath -ErrorAction Stop).Path
        $entryPathHash = Get-DshTextSha256 $resolvedEntryPath
        $startDeltaSeconds = [math]::Abs(($runtimeFile.LastWriteTime - ([datetime]$Snapshot.CreationDate)).TotalSeconds)
        $checks = [pscustomobject]@{
            RuntimeRunning = ([string]$runtime.state -eq 'running')
            PortMatches = ([string]$runtime.port -eq [string]$Port)
            ChildPidMatches = ([int]$runtime.childPid -eq [int]$Snapshot.Pid)
            LauncherParentMatches = ([int]$runtime.launcherPid -eq [int]$Snapshot.ParentProcessId)
            EntryPathHashMatches = ([string]$runtime.entryHash -eq $entryPathHash)
            LaunchWindowMatches = ($startDeltaSeconds -le 30)
        }
        $accepted = $checks.RuntimeRunning -and $checks.PortMatches -and $checks.ChildPidMatches -and $checks.LauncherParentMatches -and $checks.EntryPathHashMatches -and $checks.LaunchWindowMatches
        $reason = if ($accepted) { 'runtime_ledger_verified' } else { 'runtime_ledger_mismatch' }
        return [pscustomobject]@{ Accepted = [bool]$accepted; Reason = $reason; Checks = $checks }
    } catch {
        return [pscustomobject]@{ Accepted = $false; Reason = 'runtime_ledger_error'; Checks = $null }
    }
}

function Get-DshProcessSnapshot([int]$ProcessId) {
    if ($ProcessId -le 0) { return $null }
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ProcessId) -ErrorAction SilentlyContinue
    if (-not $p) { return $null }

    $cmd = [string]$p.CommandLine
    $name = [string]$p.Name
    $normalized = $cmd.Replace('/', '\')
    $portPattern = '(?i)(^|\s)--port(?:=|\s+)' + [regex]::Escape([string]$script:DshIdentityPort) + '(\s|$)'
    $isNode = $name -match '^(?i:node)(\.exe)?$'
    $hasEntry = $normalized -match '(?i)@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js'
    $hasWeb = $normalized -match '(?i)(^|\s)web(\s|$)'
    $hasPort = $false
    if ($script:DshIdentityPort -gt 0) { $hasPort = $normalized -match $portPattern }
    $hasCreation = $null -ne $p.CreationDate
    $ownerCurrentUser = $false
    try {
        $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        $ownerCurrentUser = ($owner.ReturnValue -eq 0 -and $owner.User -eq $env:USERNAME -and $owner.Domain -eq $env:COMPUTERNAME)
    } catch {}

    $directIdentity = ($isNode -and $hasEntry -and $hasWeb -and $hasPort -and $hasCreation)

    $snapshot = [pscustomobject]@{
        Pid                 = [int]$p.ProcessId
        Name                = $name
        ParentProcessId     = if ($p.ParentProcessId) { [int]$p.ParentProcessId } else { $null }
        CreationDate        = $p.CreationDate
        ExecutablePath      = [string]$p.ExecutablePath
        CommandLinePresent  = [bool]$cmd
        CommandLineHash     = Get-DshTextSha256 $cmd
        OwnerCurrentUser    = [bool]$ownerCurrentUser
        IsDsh               = $false
        IdentitySource      = 'none'
        IdentityChecks      = [pscustomobject]@{
            IsNode = $isNode
            HasDshEntry = $hasEntry
            HasWeb = $hasWeb
            HasPort = $hasPort
            HasCreationDate = $hasCreation
        }
        RuntimeLedger       = $null
    }

    if ($directIdentity) {
        $snapshot.IsDsh = $true
        $snapshot.IdentitySource = 'command_line'
    } elseif (-not $snapshot.CommandLinePresent) {
        $runtimeLedger = Test-DshRuntimeLedgerIdentity -Snapshot $snapshot -Port $script:DshIdentityPort
        $snapshot.RuntimeLedger = $runtimeLedger
        if ($runtimeLedger.Accepted) {
            $snapshot.IsDsh = $true
            $snapshot.IdentitySource = 'runtime_ledger'
        }
    }

    return $snapshot
}

function Get-DshLoopbackOwner([int]$Port = 3080) {
    $script:DshIdentityPort = $Port
    try {
        $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return [pscustomobject]@{ State = 'error'; Port = $Port; Error = $_.Exception.Message; Pid = $null; LocalAddresses = @(); NonLoopbackCount = 0 }
    }

    $loopback = @($connections | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') })
    $nonLoopback = @($connections | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
    $pids = @($loopback | Select-Object -ExpandProperty OwningProcess -Unique)

    if ($pids.Count -eq 0) {
        return [pscustomobject]@{
            State = 'none'; Port = $Port; Pid = $null; LocalAddresses = @(); NonLoopbackCount = $nonLoopback.Count; Snapshot = $null
        }
    }

    if ($pids.Count -ne 1) {
        return [pscustomobject]@{
            State = 'ambiguous'; Port = $Port; Pid = $null
            LocalAddresses = @($loopback | Select-Object -ExpandProperty LocalAddress -Unique)
            CandidatePids = @($pids); NonLoopbackCount = $nonLoopback.Count; Snapshot = $null
        }
    }

    $snapshot = Get-DshProcessSnapshot ([int]$pids[0])
    if (-not $snapshot -or -not $snapshot.IsDsh) {
        return [pscustomobject]@{
            State = 'identity_mismatch'; Port = $Port; Pid = [int]$pids[0]
            LocalAddresses = @($loopback | Select-Object -ExpandProperty LocalAddress -Unique)
            CandidatePids = @($pids); NonLoopbackCount = $nonLoopback.Count; Snapshot = $snapshot
        }
    }

    return [pscustomobject]@{
        State = 'ok'; Port = $Port; Pid = $snapshot.Pid
        LocalAddresses = @($loopback | Select-Object -ExpandProperty LocalAddress -Unique)
        CandidatePids = @($pids); NonLoopbackCount = $nonLoopback.Count; Snapshot = $snapshot
    }
}

function Stop-DshLoopbackOwner([int]$Port = 3080, [int]$ExpectedPid = 0) {
    $before = Get-DshLoopbackOwner -Port $Port
    if ($before.State -ne 'ok') {
        return [pscustomobject]@{ State = 'not_stopped'; Reason = $before.State; Port = $Port; Pid = $before.Pid; Owner = $before }
    }
    if ($ExpectedPid -gt 0 -and $before.Pid -ne $ExpectedPid) {
        return [pscustomobject]@{ State = 'not_stopped'; Reason = 'pid_changed'; Port = $Port; Pid = $before.Pid; Owner = $before }
    }

    try {
        Stop-Process -Id $before.Pid -Force -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ State = 'stop_failed'; Reason = $_.Exception.Message; Port = $Port; Pid = $before.Pid; Owner = $before }
    }

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $after = Get-DshLoopbackOwner -Port $Port
        if ($after.State -eq 'none') {
            return [pscustomobject]@{ State = 'stopped'; Reason = 'loopback_listener_gone'; Port = $Port; Pid = $before.Pid; Owner = $before }
        }
        if ($after.State -ne 'ok' -or $after.Pid -ne $before.Pid) {
            return [pscustomobject]@{ State = 'stop_ambiguous'; Reason = $after.State; Port = $Port; Pid = $before.Pid; Owner = $before; After = $after }
        }
    }
    return [pscustomobject]@{ State = 'stop_timeout'; Reason = 'loopback_listener_still_present'; Port = $Port; Pid = $before.Pid; Owner = $before }
}

function Enter-DshRestartLock([string]$Name = 'Local\DSHHarness.Restart.v1') {
    $mutex = New-Object System.Threading.Mutex($false, $Name)
    try {
        $acquired = $false
        try {
            $acquired = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if ($acquired) { return $mutex }
        $mutex.Dispose()
    } catch {
        try { $mutex.Dispose() } catch {}
    }
    return $null
}

function Exit-DshRestartLock($Mutex) {
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch {}
    try { $Mutex.Dispose() } catch {}
}
