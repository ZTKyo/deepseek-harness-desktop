# RH2 G1-G7: deterministic watchdog identity tests.
# Dot-sources the watchdog in library mode; it never starts a process.

$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot '..\..\dsh-guardian-watchdog.ps1'
. $watchdog -Library

$pass = 0
$fail = 0
function Assert-Rh2Watchdog([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name $Detail"
    }
}

$now = ([DateTime]::Parse('2026-09-05T00:00:00Z')).ToUniversalTime()
$started = ([DateTime]::Parse('2026-09-04T23:59:00Z')).ToUniversalTime()
$freshHeartbeat = [pscustomobject]@{
    pid = 4321
    updatedAt = $now.AddSeconds(-5).ToString('o')
    startedAt = $started.ToString('o')
    AgeSeconds = 5
}
$staleHeartbeat = [pscustomobject]@{
    pid = 4321
    updatedAt = $now.AddSeconds(-120).ToString('o')
    startedAt = $started.ToString('o')
    AgeSeconds = 120
}
$liveWithCommandLine = [pscustomobject]@{
    ProcessId = 4321
    ProcessName = 'powershell'
    CommandLine = 'powershell.exe -File C:\Harness\dsh-guardian.ps1 -Port 3080'
    StartTime = $started
}
$liveBlankCommandLine = [pscustomobject]@{
    ProcessId = 4321
    ProcessName = 'powershell'
    CommandLine = ''
    StartTime = $started
}

# G1: the old strong command-line signal plus fresh heartbeat is present.
$g1 = Resolve-DshGuardianPresence -Heartbeat $freshHeartbeat -Processes @($liveWithCommandLine) -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G1 populated CommandLine + fresh heartbeat -> no spawn' ($g1.State -eq 'present' -and -not $g1.ShouldStart -and $g1.Pid -eq 4321) ($g1 | Out-String)

# G2: blank CIM CommandLine is accepted when the authoritative heartbeat PID
# and live process/start identity match.
$g2 = Resolve-DshGuardianPresence -Heartbeat $freshHeartbeat -Processes @($liveBlankCommandLine) -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G2 blank CommandLine + fresh matching PID -> no spawn' ($g2.State -eq 'present' -and $g2.Proven -and -not $g2.ShouldStart -and $g2.Source -eq 'heartbeat-pid') ($g2 | Out-String)

# G3: stale heartbeat + proven live PID is alert/no-start; a PID reuse/start
# mismatch is also fail-safe no-start.
$g3 = Resolve-DshGuardianPresence -Heartbeat $staleHeartbeat -Processes @($liveBlankCommandLine) -Now $now -MaxAgeSeconds 90
$mismatched = $liveBlankCommandLine.PSObject.Copy()
$mismatched.StartTime = $started.AddHours(-2)
$g3Ambiguous = Resolve-DshGuardianPresence -Heartbeat $staleHeartbeat -Processes @($mismatched) -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G3 stale heartbeat + proven live PID -> no duplicate start' ($g3.State -eq 'stale_live' -and $g3.Proven -and -not $g3.ShouldStart) ($g3 | Out-String)
Assert-Rh2Watchdog 'G3 ambiguous PID reuse -> no-kill/no-start' ($g3Ambiguous.State -eq 'ambiguous' -and -not $g3Ambiguous.ShouldStart) ($g3Ambiguous | Out-String)

# G4: only no proven guardian and no fresh heartbeat is start-eligible.
$g4 = Resolve-DshGuardianPresence -Heartbeat $null -Processes @() -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G4 no live Guardian + no fresh heartbeat -> start allowed' ($g4.State -eq 'absent' -and $g4.ShouldStart) ($g4 | Out-String)

# G5: a spawn result without a heartbeat is explicitly unverified.
$g5 = Confirm-DshGuardianSpawn -ExpectedPid 9876 -Heartbeat $null -Processes @() -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G5 Process.Start without heartbeat -> not healthy' ($g5.State -eq 'unverified' -and -not $g5.Verified) ($g5 | Out-String)
$g5ok = Confirm-DshGuardianSpawn -ExpectedPid 4321 -Heartbeat $freshHeartbeat -Processes @($liveBlankCommandLine) -Now $now -MaxAgeSeconds 90
Assert-Rh2Watchdog 'G5 fresh heartbeat/PID pair -> spawn verification' ($g5ok.State -eq 'verified' -and $g5ok.Verified) ($g5ok | Out-String)

# G6: 60 valid watchdog observations cause zero start decisions.
$startCount = 0
for ($i = 0; $i -lt 60; $i++) {
    $observation = Resolve-DshGuardianPresence -Heartbeat $freshHeartbeat -Processes @($liveBlankCommandLine) -Now $now -MaxAgeSeconds 90
    if ($observation.ShouldStart) { $startCount++ }
}
Assert-Rh2Watchdog 'G6 60 valid cycles -> start count 0' ($startCount -eq 0) "startCount=$startCount"

# G7: the Guardian mutex remains a safety backstop, while watchdog presence
# detection is now the normal duplicate-prevention decision.
$watchdogSource = Get-Content -LiteralPath $watchdog -Raw
$guardianSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\dsh-guardian.ps1') -Raw
$invokeBody = $watchdogSource.Substring($watchdogSource.IndexOf('function Invoke-WatchdogCheck'))
Assert-Rh2Watchdog 'G7 Guardian SingleInstance mutex remains' ($guardianSource -match 'DSHGuardian\.SingleInstance')
Assert-Rh2Watchdog 'G7 watchdog resolves presence before Process.Start' ($invokeBody -match 'Resolve-DshGuardianPresence' -and $invokeBody -match '\$presence\.ShouldStart' -and $invokeBody.IndexOf('Resolve-DshGuardianPresence') -lt $invokeBody.IndexOf('[System.Diagnostics.Process]::Start'))
Assert-Rh2Watchdog 'G7 no normal healthy claim from Process.Start alone' ($watchdogSource -notmatch 'guardian started pid=' -and $watchdogSource -match 'guardian spawn unverified')

Write-Host "RH2 WATCHDOG: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
Write-Host 'RH2 WATCHDOG TEST PASSED'
