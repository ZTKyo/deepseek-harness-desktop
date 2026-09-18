# POST-P3 Guardian stale-live fencing tests.
#
# These tests dot-source the production watchdog in library mode.  All stop/start
# operations are dependency-injected fake actions against in-memory process and
# heartbeat fixtures; port 3080, the live Guardian, Task Scheduler, and the
# production state directory are never touched.

$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot '..\..\dsh-guardian-watchdog.ps1'
. $watchdog -Library

$pass = 0
$fail = 0
function Assert-GuardianFencing([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name $Detail"
    }
}

function New-TestHeartbeat {
    param(
        [int]$GuardianPid,
        [DateTime]$StartedAt,
        [DateTime]$UpdatedAt,
        [string]$Generation = 'old-generation',
        [int]$Sequence = 1,
        [string]$Phase = 'checking'
    )
    [pscustomobject]@{
        pid = $GuardianPid
        port = 3080
        startedAt = $StartedAt.ToUniversalTime().ToString('o')
        updatedAt = $UpdatedAt.ToUniversalTime().ToString('o')
        generation = $Generation
        sequence = $Sequence
        phase = $Phase
        phaseEnteredAt = $UpdatedAt.ToUniversalTime().ToString('o')
        exitCode = 0
        AgeSeconds = (([DateTime]::UtcNow) - $UpdatedAt.ToUniversalTime()).TotalSeconds
    }
}

function New-TestGuardianProcess {
    param(
        [int]$GuardianPid,
        [DateTime]$StartTime,
        [string]$CommandLine = ''
    )
    [pscustomobject]@{
        ProcessId = $GuardianPid
        ProcessName = 'powershell.exe'
        CommandLine = $CommandLine
        StartTime = $StartTime.ToUniversalTime()
    }
}

function New-TestEligibleState {
    $state = New-DshGuardianFenceState
    $state.Phase = 'TAKEOVER_ELIGIBLE'
    return $state
}

function Invoke-TestTakeover {
    param(
        [hashtable]$World,
        [string]$BudgetPath,
        [bool]$FreshAfterStart = $true,
        [bool]$StopSurvives = $false,
        [bool]$FreshAtCleanup = $false,
        [bool]$ChangeSpawnIdentity = $false
    )
    $World.FreshAfterStart = $FreshAfterStart
    $World.StopSurvives = $StopSurvives
    $World.FreshAtCleanup = $FreshAtCleanup
    $World.ChangeSpawnIdentity = $ChangeSpawnIdentity
    $World.HeartbeatReads = 0
    $World.SpawnIdentityChanged = $false
    $getHeartbeat = {
        $World.HeartbeatReads = [int]$World.HeartbeatReads + 1
        if ($World.ChangeSpawnIdentity -and $World.StartCalls -gt 0 -and -not $World.SpawnIdentityChanged) {
            $World.Processes = @(New-TestGuardianProcess -GuardianPid $World.NewPid -StartTime $World.SpawnStart.AddSeconds(60))
            $World.SpawnIdentityChanged = $true
        }
        if ($World.FreshAtCleanup -and $World.StartCalls -gt 0 -and $World.HeartbeatReads -ge 4) {
            $World.Heartbeat = New-TestHeartbeat -GuardianPid $World.NewPid -StartedAt $World.SpawnStart -UpdatedAt $World.SpawnStart -Generation ('new-generation-cleanup-' + $World.StartCalls) -Sequence 1
        }
        return $World.Heartbeat
    }
    $getProcesses = {
        param($heartbeat)
        return [pscustomobject]@{ ProbeOk = [bool]$World.ProbeOk; Processes = @($World.Processes) }
    }
    $stop = {
        param($targetPid)
        $World.StopCalls = [int]$World.StopCalls + 1
        if ($null -eq $World.StoppedPids) { $World.StoppedPids = @() }
        $World.StoppedPids = @($World.StoppedPids) + $targetPid
        if (-not $World.StopSurvives) { $World.Processes = @() }
    }
    $start = {
        param($path, $port, $noAwake, $noLid)
        $World.StartCalls = [int]$World.StartCalls + 1
        $newPid = [int]$World.NewPid
        $newStart = (Get-Date).ToUniversalTime()
        $World.SpawnStart = $newStart
        $World.Processes = @(New-TestGuardianProcess -GuardianPid $newPid -StartTime $newStart)
        if ($World.FreshAfterStart) {
            $World.Heartbeat = New-TestHeartbeat -GuardianPid $newPid -StartedAt $newStart -UpdatedAt $newStart -Generation ('new-generation-' + $World.StartCalls) -Sequence 1
        }
        return [pscustomobject]@{ Id = $newPid; ProcessId = $newPid; ProcessName = 'powershell.exe'; CommandLine = ''; StartTime = $newStart }
    }
    $result = Invoke-DshGuardianTakeover -Observation $World.Observation -State $World.State `
        -GuardianScript 'C:\isolated\dsh-guardian.ps1' -PortNumber 3080 -StaleSeconds 90 `
        -TakeoverMaxAttempts 2 -TakeoverCooldownSeconds 600 -TakeoverWindowSeconds 900 `
        -TakeoverGoneTimeoutSeconds 0 -TakeoverVerifyTimeoutSeconds 0 -TakeoverPollMilliseconds 0 `
        -BudgetPath $BudgetPath -GetHeartbeat $getHeartbeat -GetProcesses $getProcesses `
        -StopProcess $stop -StartProcess $start
    return $result
}

$testRoot = Join-Path $env:TEMP ('dsh-guardian-stale-live-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
try {
    $now = (Get-Date).ToUniversalTime()
    $oldStart = $now.AddMinutes(-5)
    $fresh = New-TestHeartbeat -GuardianPid 4321 -StartedAt $oldStart -UpdatedAt $now.AddSeconds(-5)
    $staleJustOver = New-TestHeartbeat -GuardianPid 4321 -StartedAt $oldStart -UpdatedAt $now.AddSeconds(-120)
    $staleConfirmed = New-TestHeartbeat -GuardianPid 4321 -StartedAt $oldStart -UpdatedAt $now.AddSeconds(-360)
    $oldProcess = New-TestGuardianProcess -GuardianPid 4321 -StartTime $oldStart

    # GSL1: fresh heartbeat + matching PID/start identity -> healthy/no takeover.
    $o1 = Resolve-DshGuardianFenceObservation -Heartbeat $fresh -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
    $d1 = Update-DshGuardianFenceState -State (New-DshGuardianFenceState) -Observation $o1 -Now $now -StaleSeconds 90
    Assert-GuardianFencing 'GSL1 fresh heartbeat + matching PID -> HEALTHY/no takeover' ($o1.IdentityState -eq 'PROVEN' -and $d1.Phase -eq 'HEALTHY' -and $d1.Action -eq 'NONE') ($d1 | Out-String)

    # GSL2: the first and second observations just over stale remain suspect.
    $o2 = Resolve-DshGuardianFenceObservation -Heartbeat $staleJustOver -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
    $s2 = New-DshGuardianFenceState
    $d2a = Update-DshGuardianFenceState -State $s2 -Observation $o2 -Now $now -StaleSeconds 90
    $d2b = Update-DshGuardianFenceState -State $d2a.State -Observation $o2 -Now $now -StaleSeconds 90
    Assert-GuardianFencing 'GSL2 just-over-stale -> SUSPECT_STALE/no kill-start' ($d2b.Phase -eq 'SUSPECT_STALE' -and $d2b.Action -eq 'NONE') ($d2b | Out-String)

    # GSL3: repeated stale observations cross the longer threshold, then one
    # takeover is executed and a second execution is a no-op.
    $o3 = Resolve-DshGuardianFenceObservation -Heartbeat $staleConfirmed -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
    $s3 = New-DshGuardianFenceState
    $d3a = Update-DshGuardianFenceState -State $s3 -Observation $o3 -Now $now -StaleSeconds 90
    $d3b = Update-DshGuardianFenceState -State $d3a.State -Observation $o3 -Now $now -StaleSeconds 90
    $d3c = Update-DshGuardianFenceState -State $d3b.State -Observation $o3 -Now $now -StaleSeconds 90
    $w3 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o3; State = $d3c.State; ProbeOk = $true; NewPid = 5321; StopCalls = 0; StartCalls = 0 }
    $r3 = Invoke-TestTakeover -World $w3 -BudgetPath (Join-Path $testRoot 'gsl3.json')
    $r3Again = Invoke-TestTakeover -World $w3 -BudgetPath (Join-Path $testRoot 'gsl3.json')
    Assert-GuardianFencing 'GSL3 confirmed stale + same identity -> exactly one verified takeover' ($d3c.Phase -eq 'TAKEOVER_ELIGIBLE' -and $r3.Verified -and $w3.StopCalls -eq 1 -and $w3.StartCalls -eq 1 -and -not $r3Again.Verified -and $w3.StopCalls -eq 1 -and $w3.StartCalls -eq 1) ($r3 | Out-String)

    # GSL4/GSL5: PID reuse and creation-time mismatch are ambiguous, never kill.
    $reused = New-TestGuardianProcess -GuardianPid 4321 -StartTime $oldStart.AddHours(1)
    $o4 = Resolve-DshGuardianFenceObservation -Heartbeat $staleConfirmed -Processes @($reused) -Now $now -MaxAgeSeconds 90
    $mismatchHb = New-TestHeartbeat -GuardianPid 4321 -StartedAt $oldStart.AddMinutes(-2) -UpdatedAt $now.AddSeconds(-360)
    $o5 = Resolve-DshGuardianFenceObservation -Heartbeat $mismatchHb -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
    Assert-GuardianFencing 'GSL4 PID reuse -> AMBIGUOUS_FAIL_CLOSED/no kill' ($o4.IdentityState -eq 'AMBIGUOUS' -and $o4.Reason -eq 'start_time_mismatch') ($o4 | Out-String)
    Assert-GuardianFencing 'GSL5 start-time mismatch -> AMBIGUOUS_FAIL_CLOSED/no kill' ($o5.IdentityState -eq 'AMBIGUOUS' -and $o5.Reason -eq 'start_time_mismatch') ($o5 | Out-String)

    # GSL6: multiple visible Guardian candidates fail closed.
    $multi = @(
        (New-TestGuardianProcess -GuardianPid 4321 -StartTime $oldStart -CommandLine 'powershell.exe -File "C:\isolated\dsh-guardian.ps1" -Port 3080'),
        (New-TestGuardianProcess -GuardianPid 9876 -StartTime $oldStart.AddSeconds(1) -CommandLine 'powershell.exe -File "C:\isolated\dsh-guardian.ps1" -Port 3080')
    )
    $o6 = Resolve-DshGuardianFenceObservation -Heartbeat $staleConfirmed -Processes $multi -Now $now -MaxAgeSeconds 90
    Assert-GuardianFencing 'GSL6 multiple Guardian candidates -> fail closed' ($o6.IdentityState -eq 'AMBIGUOUS' -and $o6.Reason -eq 'multiple_guardian_candidates') ($o6 | Out-String)

    # GSL7: old Guardian disappears naturally before takeover; do not call stop,
    # then allow one canonical start and verify its new heartbeat.
    $w7 = @{ Heartbeat = $staleConfirmed; Processes = @(); Observation = [pscustomobject]@{ IdentityState = 'ABSENT'; Heartbeat = $staleConfirmed; HeartbeatPid = 4321; HeartbeatFresh = $false; AgeSeconds = 360; Process = $null; ProcessStart = $null; Reason = 'old_guardian_disappeared' }; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5327; StopCalls = 0; StartCalls = 0 }
    $r7 = Invoke-TestTakeover -World $w7 -BudgetPath (Join-Path $testRoot 'gsl7.json')
    Assert-GuardianFencing 'GSL7 old Guardian gone naturally -> one canonical start' ($r7.Verified -and $w7.StopCalls -eq 0 -and $w7.StartCalls -eq 1) ($r7 | Out-String)

    # GSL8: old Guardian survives the stop request; no new Guardian is started.
    $o8 = Resolve-DshGuardianFenceObservation -Heartbeat $staleConfirmed -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
    $w8 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5330; StopCalls = 0; StartCalls = 0 }
    $r8 = Invoke-TestTakeover -World $w8 -BudgetPath (Join-Path $testRoot 'gsl8.json') -StopSurvives $true
    Assert-GuardianFencing 'GSL8 old Guardian survives stop -> no second Guardian' (-not $r8.Verified -and $w8.StopCalls -eq 1 -and $w8.StartCalls -eq 0) ($r8 | Out-String)

    # GSL9: Process.Start without a fresh heartbeat is never takeover-verified.
    $w9 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5333; StopCalls = 0; StartCalls = 0 }
    $r9 = Invoke-TestTakeover -World $w9 -BudgetPath (Join-Path $testRoot 'gsl9.json') -FreshAfterStart $false
    Assert-GuardianFencing 'GSL9 unverified Process.Start -> exact child cleanup/gone proven' (-not $r9.Verified -and $w9.StartCalls -eq 1 -and $w9.StopCalls -eq 2 -and @($w9.StoppedPids | Where-Object { $_ -eq 5333 }).Count -eq 1 -and @($w9.Processes | Where-Object { $_.ProcessId -eq 5333 }).Count -eq 0 -and $r9.Cleanup.CleanupState -eq 'PROVEN' -and $r9.UnverifiedChildCleanup -eq 'PROVEN') ($r9 | Out-String)

    # GSL10: a new heartbeat with generation/sequence/phase metadata and matching
    # PID/start identity commits the takeover.
    $w10 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5336; StopCalls = 0; StartCalls = 0 }
    $r10 = Invoke-TestTakeover -World $w10 -BudgetPath (Join-Path $testRoot 'gsl10.json') -FreshAfterStart $true
    Assert-GuardianFencing 'GSL10 fresh new heartbeat + PID/start -> TAKEOVER_VERIFIED' ($r10.Verified -and $r10.Phase -eq 'TAKEOVER_VERIFIED') ($r10 | Out-String)

    # GSL11: 60 healthy cycles never become takeover-eligible.
    $s11 = New-DshGuardianFenceState
    $startCount11 = 0
    for ($i = 0; $i -lt 60; $i++) {
        $o11 = Resolve-DshGuardianFenceObservation -Heartbeat $fresh -Processes @($oldProcess) -Now $now -MaxAgeSeconds 90
        $d11 = Update-DshGuardianFenceState -State $s11 -Observation $o11 -Now $now -StaleSeconds 90
        $s11 = $d11.State
        if ($d11.Action -eq 'TAKEOVER') { $startCount11++ }
    }
    Assert-GuardianFencing 'GSL11 60 healthy watchdog cycles -> zero takeover' ($startCount11 -eq 0 -and $s11.Phase -eq 'HEALTHY') "takeoverCount=$startCount11 phase=$($s11.Phase)"

    # GSL12: takeover callbacks have no Server input and do not mutate the
    # server PID/generation fixture.
    $serverBefore = [pscustomobject]@{ Pid = 17012; Generation = 'boot:17012_1789236493764' }
    $w12 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5339; StopCalls = 0; StartCalls = 0; Server = $serverBefore }
    $r12 = Invoke-TestTakeover -World $w12 -BudgetPath (Join-Path $testRoot 'gsl12.json') -FreshAfterStart $true
    $serverAfter = $w12.Server
    Assert-GuardianFencing 'GSL12 Guardian takeover -> Server PID/generation unchanged' ($r12.Verified -and $serverAfter.Pid -eq $serverBefore.Pid -and $serverAfter.Generation -eq $serverBefore.Generation) ($serverAfter | Out-String)

    # GSL13: repeated failed takeover attempts are bounded by a separate budget
    # and cooldown; no restart storm is allowed.
    $gsl13Budget = Join-Path $testRoot 'gsl13.json'
    $w13 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5342; StopCalls = 0; StartCalls = 0 }
    $r13 = @()
    for ($i = 0; $i -lt 4; $i++) {
        $w13.State = New-TestEligibleState
        $r13 += Invoke-TestTakeover -World $w13 -BudgetPath $gsl13Budget -FreshAfterStart $false
    }
    $b13 = Read-DshGuardianTakeoverBudget -Path $gsl13Budget
    Assert-GuardianFencing 'GSL13 failed takeovers bounded by budget/cooldown' ($w13.StartCalls -le 2 -and $b13.attempts -le 2 -and @($r13 | Where-Object { $_.Reason -match 'cooldown|unverified|failed' }).Count -ge 1) "starts=$($w13.StartCalls) attempts=$($b13.attempts)"

    # A corrupt or incomplete takeover budget is a control-plane uncertainty;
    # it must fail closed instead of silently resetting the storm guard.
    $corruptBudget = Join-Path $testRoot 'corrupt-budget.json'
    Set-Content -LiteralPath $corruptBudget -Value '{"attempts":0,"windowStart":"not-a-date"}' -Encoding UTF8
    $w13b = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5343; StopCalls = 0; StartCalls = 0 }
    $r13b = Invoke-TestTakeover -World $w13b -BudgetPath $corruptBudget
    Assert-GuardianFencing 'GSL13 budget corruption -> fail closed/no kill-start' (-not $r13b.Verified -and $r13b.Reason -eq 'takeover_budget_corrupt' -and $w13b.StopCalls -eq 0 -and $w13b.StartCalls -eq 0) ($r13b | Out-String)

    # GSL14: re-check immediately before the destructive edge; a recovered
    # heartbeat cancels the takeover without issuing a stop request.
    $w14 = @{ Heartbeat = $fresh; Processes = @($oldProcess); Observation = $o3; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5345; StopCalls = 0; StartCalls = 0 }
    $r14 = Invoke-TestTakeover -World $w14 -BudgetPath (Join-Path $testRoot 'gsl14.json')
    Assert-GuardianFencing 'GSL14 heartbeat recovers before stop -> no destructive action' (-not $r14.Verified -and $w14.StopCalls -eq 0 -and $w14.StartCalls -eq 0) ($r14 | Out-String)

    # GSL15: a spawned child with no fresh heartbeat is cleaned only through
    # the exact PID/start identity recorded from the Process.Start result.
    $w15 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5350; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $r15 = Invoke-TestTakeover -World $w15 -BudgetPath (Join-Path $testRoot 'gsl15.json') -FreshAfterStart $false
    Assert-GuardianFencing 'GSL15 unverified child -> exact cleanup and gone proof' (-not $r15.Verified -and $r15.UnverifiedChildCleanup -eq 'PROVEN' -and $r15.Cleanup.CleanupState -eq 'PROVEN' -and @($w15.StoppedPids | Where-Object { $_ -eq 5350 }).Count -eq 1 -and @($w15.Processes | Where-Object { $_.ProcessId -eq 5350 }).Count -eq 0) ($r15 | Out-String)

    # GSL16: the final cleanup-boundary probe sees a valid new heartbeat; the
    # child is preserved and the takeover is committed.
    $w16 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5355; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $r16 = Invoke-TestTakeover -World $w16 -BudgetPath (Join-Path $testRoot 'gsl16.json') -FreshAfterStart $false -FreshAtCleanup $true
    Assert-GuardianFencing 'GSL16 valid heartbeat at cleanup boundary -> cleanup cancelled' ($r16.Verified -and $r16.Cleanup.CleanupState -eq 'CANCELLED_VALID_GUARDIAN' -and $w16.StopCalls -eq 1 -and $w16.StartCalls -eq 1 -and @($w16.StoppedPids | Where-Object { $_ -eq 5355 }).Count -eq 0 -and @($w16.Processes | Where-Object { $_.ProcessId -eq 5355 }).Count -eq 1) ($r16 | Out-String)

    # GSL17: the PID survives but its creation identity changes; do not kill
    # that unknown process and report cleanup as not safe.
    $w17 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5358; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $r17 = Invoke-TestTakeover -World $w17 -BudgetPath (Join-Path $testRoot 'gsl17.json') -FreshAfterStart $false -ChangeSpawnIdentity $true
    Assert-GuardianFencing 'GSL17 changed child identity -> no unknown-process kill/fail closed' (-not $r17.Verified -and $r17.UnverifiedChildCleanup -eq 'NOT_SAFE_TO_CLEAN' -and $r17.Cleanup.Reason -eq 'spawned_pid_present_identity_changed' -and $w17.StopCalls -eq 1 -and $w17.StartCalls -eq 1 -and @($w17.StoppedPids | Where-Object { $_ -eq 5358 }).Count -eq 0 -and @($w17.Processes | Where-Object { $_.ProcessId -eq 5358 }).Count -eq 1) ($r17 | Out-String)

    # GSL18: verified takeovers consume the same window budget; success does
    # not reset attempts, so the third eligible takeover is blocked.
    $gsl18Budget = Join-Path $testRoot 'gsl18.json'
    $w18a = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5361; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $w18b = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5362; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $w18c = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5363; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $r18a = Invoke-TestTakeover -World $w18a -BudgetPath $gsl18Budget
    $r18b = Invoke-TestTakeover -World $w18b -BudgetPath $gsl18Budget
    $r18c = Invoke-TestTakeover -World $w18c -BudgetPath $gsl18Budget
    $b18 = Read-DshGuardianTakeoverBudget -Path $gsl18Budget
    Assert-GuardianFencing 'GSL18 two verified takeovers consume window; third blocked' ($r18a.Verified -and $r18b.Verified -and -not $r18c.Verified -and $r18c.Reason -eq 'takeover_budget_exhausted' -and $w18c.StopCalls -eq 0 -and $w18c.StartCalls -eq 0 -and $b18.attempts -eq 2) "r18c=$($r18c.Reason) attempts=$($b18.attempts)"

    # GSL19: once the same window expires, the budget becomes eligible again.
    $gsl19Budget = Join-Path $testRoot 'gsl19.json'
    $now19 = [DateTimeOffset]::Now
    $seed19 = Get-DshGuardianTakeoverBudgetDefault
    $seed19.windowStart = $now19.AddSeconds(-901).ToString('o')
    $seed19.attempts = 2
    $seed19.lastResult = 'verified'
    Write-DshGuardianTakeoverBudget -Value $seed19 -Path $gsl19Budget | Out-Null
    $allowed19 = Test-DshGuardianTakeoverAllowed -Path $gsl19Budget -MaxAttempts 2 -WindowSeconds 900 -Now $now19
    $registered19 = Register-DshGuardianTakeoverAttempt -Path $gsl19Budget -MaxAttempts 2 -WindowSeconds 900 -OldPid 4321 -Now $now19
    $b19 = Read-DshGuardianTakeoverBudget -Path $gsl19Budget
    Assert-GuardianFencing 'GSL19 expired window -> budget eligible again' ($allowed19.Allowed -and $allowed19.Budget.attempts -eq 0 -and $registered19.Registered -and $b19.attempts -eq 1) "allowed=$($allowed19.Allowed) registered=$($registered19.Registered) attempts=$($b19.attempts)"

    # GSL20: spawned identity uses an exact UTC millisecond value.  Sub-ms
    # observation noise is accepted after normalization, including the DMTF
    # CreationDate representation used by CIM, while a 2-5 second PID reuse
    # is rejected and never stopped.
    $gsl20Start = [DateTimeOffset]::Parse('2026-09-19T00:00:00.1234567Z').UtcDateTime
    $spawn20 = ConvertTo-DshGuardianSpawnIdentity -Process (New-TestGuardianProcess -GuardianPid 5370 -StartTime $gsl20Start) -TakeoverAttemptId 'gsl20'
    $sameMillisecond20 = [pscustomobject]@{
        ProcessId = 5370
        ProcessName = 'powershell.exe'
        CommandLine = ''
        CreationDate = [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($gsl20Start.AddTicks(1000))
    }
    $reuse20 = New-TestGuardianProcess -GuardianPid 5370 -StartTime $gsl20Start.AddSeconds(3)
    $sameIdentity20 = Test-DshGuardianSpawnedProcessIdentity -SpawnIdentity $spawn20 -Process $sameMillisecond20
    $reuseIdentity20 = Test-DshGuardianSpawnedProcessIdentity -SpawnIdentity $spawn20 -Process $reuse20
    $stop20Calls = 0
    $cleanup20 = Invoke-DshGuardianSpawnCleanup -SpawnIdentity $spawn20 -PreviousHeartbeat $staleConfirmed `
        -StaleSeconds 90 -GetHeartbeat { $staleConfirmed } `
        -GetProcesses { param($hb) [pscustomobject]@{ ProbeOk = $true; Processes = @($reuse20) } } `
        -StopProcess { param($targetPid) $script:stop20Calls++ } -GoneTimeoutSeconds 0 -PollMilliseconds 0
    Assert-GuardianFencing 'GSL20 exact normalized identity accepted; 3s PID reuse rejected/not stopped' `
        ($spawn20.ProcessStart.Ticks -eq $gsl20Start.Ticks -and $spawn20.ProcessStartIdentity -eq '2026-09-19T00:00:00.123Z' -and $sameIdentity20.Proven -and -not $reuseIdentity20.Proven -and $cleanup20.CleanupState -eq 'NOT_SAFE_TO_CLEAN' -and $cleanup20.Reason -eq 'spawned_pid_present_identity_changed' -and $script:stop20Calls -eq 0) `
        "same=$($sameIdentity20.Reason) reuse=$($reuseIdentity20.Reason) cleanup=$($cleanup20.Reason) stops=$script:stop20Calls"

    # GSL21: a failed takeover may prove its spawned child gone, but its active
    # cooldown immediately blocks a normal absent-path start.
    $gsl21Budget = Join-Path $testRoot 'gsl21.json'
    $w21 = @{ Heartbeat = $staleConfirmed; Processes = @($oldProcess); Observation = $o8; State = (New-TestEligibleState); ProbeOk = $true; NewPid = 5373; StopCalls = 0; StartCalls = 0; StoppedPids = @() }
    $r21 = Invoke-TestTakeover -World $w21 -BudgetPath $gsl21Budget -FreshAfterStart $false
    $gate21 = Test-DshGuardianStartAllowed -Path $gsl21Budget -MaxAttempts 2 -WindowSeconds 900 -Now ([DateTimeOffset]::Now)
    Assert-GuardianFencing 'GSL21 proven failed cleanup -> active cooldown blocks start gate' `
        (-not $r21.Verified -and $r21.Cleanup.CleanupState -eq 'PROVEN' -and $r21.UnverifiedChildCleanup -eq 'PROVEN' -and -not $gate21.Allowed -and $gate21.Reason -eq 'takeover_cooldown') `
        "takeover=$($r21.Reason) cleanup=$($r21.Cleanup.CleanupState) gate=$($gate21.Reason)"

    # GSL22: the current-window maximum blocks normal absent-path start.
    $gsl22Budget = Join-Path $testRoot 'gsl22.json'
    $seed22 = Get-DshGuardianTakeoverBudgetDefault
    $seed22.windowStart = ([DateTimeOffset]::Now).AddSeconds(-10).ToString('o')
    $seed22.attempts = 2
    Write-DshGuardianTakeoverBudget -Value $seed22 -Path $gsl22Budget | Out-Null
    $gate22 = Test-DshGuardianStartAllowed -Path $gsl22Budget -MaxAttempts 2 -WindowSeconds 900 -Now ([DateTimeOffset]::Now)
    Assert-GuardianFencing 'GSL22 current-window max attempts blocks start gate' (-not $gate22.Allowed -and $gate22.Reason -eq 'takeover_budget_exhausted') "gate=$($gate22.Reason)"

    # GSL23: a missing/default budget permits cold boot and does not create a
    # second state database or materialize a budget file.
    $gsl23Budget = Join-Path $testRoot 'gsl23-missing.json'
    $gate23 = Test-DshGuardianStartAllowed -Path $gsl23Budget -MaxAttempts 2 -WindowSeconds 900 -Now ([DateTimeOffset]::Now)
    Assert-GuardianFencing 'GSL23 missing budget allows cold boot without creating budget' ($gate23.Allowed -and $gate23.Reason -eq 'takeover_allowed' -and -not (Test-Path -LiteralPath $gsl23Budget)) "gate=$($gate23.Reason) exists=$(Test-Path -LiteralPath $gsl23Budget)"

    # GSL24: an expired window is reset in the shared gate's in-memory view and
    # becomes eligible again without introducing another budget store.
    $gsl24Budget = Join-Path $testRoot 'gsl24.json'
    $seed24 = Get-DshGuardianTakeoverBudgetDefault
    $seed24.windowStart = ([DateTimeOffset]::Now).AddSeconds(-901).ToString('o')
    $seed24.attempts = 2
    Write-DshGuardianTakeoverBudget -Value $seed24 -Path $gsl24Budget | Out-Null
    $gate24 = Test-DshGuardianStartAllowed -Path $gsl24Budget -MaxAttempts 2 -WindowSeconds 900 -Now ([DateTimeOffset]::Now)
    Assert-GuardianFencing 'GSL24 expired window allows start again' ($gate24.Allowed -and $gate24.Budget.attempts -eq 0 -and $gate24.Reason -eq 'takeover_allowed') "gate=$($gate24.Reason) attempts=$($gate24.Budget.attempts)"

    # Heartbeat schema contract: one heartbeat authority gains progress metadata;
    # no second Guardian state database is introduced.
    $guardianSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\dsh-guardian.ps1') -Raw
    $watchdogSource = Get-Content -LiteralPath $watchdog -Raw
    Assert-GuardianFencing 'Heartbeat schema carries generation/sequence/phaseEnteredAt' ($guardianSource -match 'GuardianGeneration' -and $guardianSource -match 'GuardianHeartbeatSequence' -and $guardianSource -match 'GuardianPhaseEnteredAt')
    Assert-GuardianFencing 'SingleInstance mutex remains the Guardian backstop' ($guardianSource -match 'DSHGuardian\.SingleInstance' -and $watchdogSource -match 'DSHGuardian\.Watchdog\.SingleInstance')
    Assert-GuardianFencing 'Identity probe covers Windows PowerShell and pwsh' ($watchdogSource -match "Name='powershell\.exe' OR Name='pwsh\.exe'" -and $watchdogSource -match '\^\(\?:powershell\|pwsh\)')
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "GUARDIAN STALE-LIVE FENCING: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
Write-Host 'GUARDIAN STALE-LIVE FENCING TEST PASSED'
