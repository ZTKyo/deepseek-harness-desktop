# RH2 R1.3: listener classification and Guardian loopback bind-conflict tests.
#
# The deterministic cases use a local Get-NetTCPConnection fixture and the real
# dsh-process-identity.ps1/dsh-health.ps1 functions.  The optional socket
# contract uses only an ephemeral high port and a safe local interface; it
# never uses production port 3080, starts DSH, or changes Tailscale state.

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$workDir = Join-Path $env:TEMP ('rh2-r13-bind-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$env:DSH_HEALTH_STATE_PATH = Join-Path $workDir 'state\health.json'
New-Item -ItemType Directory -Force -Path (Split-Path $env:DSH_HEALTH_STATE_PATH) | Out-Null

. (Join-Path $root 'dsh-process-identity.ps1')

$script:testPort = 39137
$script:listenerRows = @()
$script:processSnapshot = $null
$script:killAttempts = 0
$script:restarts = New-Object System.Collections.ArrayList
$script:alerts = New-Object System.Collections.ArrayList
$script:logs = New-Object System.Collections.ArrayList
$script:goalRecovers = 0

# This function shadows only the cmdlet for deterministic cases.  The socket
# contract removes it before it asks the real Windows cmdlet for live rows.
function Get-NetTCPConnection {
    [CmdletBinding()]
    param(
        [int]$LocalPort,
        [string]$State
    )
    return @($script:listenerRows)
}

# The fixture listener is intentionally not a DSH process.  This proves that
# identity mismatch stays fail-closed without inspecting or killing a process.
function Get-DshProcessSnapshot([int]$ProcessId) {
    return $script:processSnapshot
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $script:killAttempts++
}

. (Join-Path $root 'dsh-health.ps1')

$script:pass = 0
$script:fail = 0
function Assert-Rh2R13([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) {
        $script:pass++
        Write-Host "PASS $Name"
    } else {
        $script:fail++
        Write-Host "FAIL $Name $Detail"
    }
}

function New-ListenerRow([string]$Address, [int]$OwnerPid = 6000) {
    [pscustomobject]@{
        LocalAddress  = $Address
        LocalPort     = $script:testPort
        OwningProcess = $OwnerPid
        State         = 'Listen'
    }
}

function New-GuardProbe([object]$Owner, [int]$Port = 39137) {
    [pscustomobject]@{
        port                         = $Port
        ownerState                   = [string]$Owner.State
        ownerPid                     = $Owner.Pid
        ownerCreation                = $null
        ownerCmdHash                 = $null
        nonLoopbackCount             = [int]$Owner.NonLoopbackCount
        nonLoopbackAddresses         = @($Owner.NonLoopbackAddresses)
        specificNonLoopbackAddresses = @($Owner.SpecificNonLoopbackAddresses)
        specificNonLoopbackCount     = [int]$Owner.SpecificNonLoopbackCount
        wildcardAddresses            = @($Owner.WildcardAddresses)
        wildcardListenerCount        = [int]$Owner.WildcardListenerCount
        loopbackBindConflict         = [bool]$Owner.LoopbackBindConflict
        loopbackBindConflictReason   = $Owner.LoopbackBindConflictReason
        errorClass                   = if ($Owner.State -eq 'none') { 'owner_absent' } else { 'owner_unsafe' }
        basicState                   = 'refused'
        basicHttpStatus              = $null
        apiState                     = 'timeout'
        wsState                      = ''
        apiReady                     = $false
        wsReady                      = $false
        partialReady                 = $false
        readiness                    = 'unready'
        ready                        = $false
        failureSignal                = 'owner'
        probeDurationMs              = 1
    }
}

$Exec_Restart = {
    param($Reason)
    [void]$script:restarts.Add($Reason)
    return $true
}
$Exec_Alert = { param($Message) [void]$script:alerts.Add($Message) }
$Exec_Log = { param($Message) [void]$script:logs.Add($Message) }
$Exec_Recover = { $script:goalRecovers++ }
$Exec_Confirm = { param($Port) return (New-GuardProbe -Owner ([pscustomobject]@{ State = 'ok'; Pid = 4242; NonLoopbackCount = 0; NonLoopbackAddresses = @(); SpecificNonLoopbackAddresses = @(); SpecificNonLoopbackCount = 0; WildcardAddresses = @(); WildcardListenerCount = 0; LoopbackBindConflict = $false; LoopbackBindConflictReason = $null }) -Port ([int]$Port)) }

function Invoke-GuardianCase {
    param(
        [string]$Name,
        [object[]]$Rows,
        [string]$ExpectedOwnerState,
        [int]$ExpectedNonLoopbackCount,
        [string[]]$ExpectedNonLoopbackAddresses = @(),
        [int]$ExpectedSpecificCount,
        [int]$ExpectedWildcardCount,
        [bool]$ExpectedConflict,
        [int]$ExpectedRestarts,
        [int]$ExpectedAlerts
    )

    $script:listenerRows = if ($null -eq $Rows) { @() } else { @($Rows) }
    $script:processSnapshot = $null
    $script:killAttempts = 0
    $owner = Get-DshLoopbackOwner -Port $script:testPort
    Assert-Rh2R13 "$Name identity state" ($owner.State -eq $ExpectedOwnerState) "state=$($owner.State)"
    Assert-Rh2R13 "$Name NonLoopbackCount" ([int]$owner.NonLoopbackCount -eq $ExpectedNonLoopbackCount) "count=$($owner.NonLoopbackCount)"
    $actualAddresses = @($owner.NonLoopbackAddresses)
    $missingAddresses = @($ExpectedNonLoopbackAddresses | Where-Object { $actualAddresses -notcontains $_ })
    Assert-Rh2R13 "$Name non-loopback addresses" ($actualAddresses.Count -eq @($ExpectedNonLoopbackAddresses).Count -and $missingAddresses.Count -eq 0) "actual=$($actualAddresses -join ',') expected=$($ExpectedNonLoopbackAddresses -join ',')"
    Assert-Rh2R13 "$Name specific non-loopback count" ([int]$owner.SpecificNonLoopbackCount -eq $ExpectedSpecificCount) "count=$($owner.SpecificNonLoopbackCount)"
    Assert-Rh2R13 "$Name wildcard listener count" ([int]$owner.WildcardListenerCount -eq $ExpectedWildcardCount) "count=$($owner.WildcardListenerCount)"
    Assert-Rh2R13 "$Name LoopbackBindConflict" ([bool]$owner.LoopbackBindConflict -eq $ExpectedConflict) "conflict=$($owner.LoopbackBindConflict) reason=$($owner.LoopbackBindConflictReason)"
    $expectedReason = if ($ExpectedConflict) { 'wildcard_listener' } else { $null }
    Assert-Rh2R13 "$Name LoopbackBindConflictReason" ($owner.LoopbackBindConflictReason -eq $expectedReason) "reason=$($owner.LoopbackBindConflictReason)"

    $script:restarts.Clear()
    $script:alerts.Clear()
    $script:logs.Clear()
    $script:goalRecovers = 0
    # Suppress the unrelated periodic successful-recovery notification so the
    # alert assertion is specifically about bind-conflict handling.
    $guardState = @{ lastRecoverAlertAt = (Get-Date) }
    $guard = Invoke-DshHealthGuard -Port $script:testPort -Probe (New-GuardProbe -Owner $owner -Port $script:testPort) -CurrentState (New-DshHealthStateObject -Port $script:testPort) -State $guardState -BudgetState $null -MaintenanceLocked $false -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
    $expectedAction = if ($ExpectedOwnerState -eq 'none') { 'server_absent' } else { 'owner_unsafe' }
    Assert-Rh2R13 "$Name guard action" ($guard.HealthAction -eq $expectedAction) "action=$($guard.HealthAction)"
    Assert-Rh2R13 "$Name restart count" ($script:restarts.Count -eq $ExpectedRestarts) "restarts=$($script:restarts.Count)"
    Assert-Rh2R13 "$Name alert count" ($script:alerts.Count -eq $ExpectedAlerts) "alerts=$($script:alerts.Count)"
    Assert-Rh2R13 "$Name no process kill" ($script:killAttempts -eq 0) "kills=$script:killAttempts"
}

try {
    Write-Host '=== RH2 R1.3 loopback bind-conflict closure ==='

    # G/NL1: specific non-loopback IPv4 does not block loopback recovery.
    Invoke-GuardianCase -Name 'G/NL1 specific IPv4' -Rows @(
        (New-ListenerRow '100.64.10.2')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 1 -ExpectedNonLoopbackAddresses @('100.64.10.2') -ExpectedSpecificCount 1 -ExpectedWildcardCount 0 -ExpectedConflict $false -ExpectedRestarts 1 -ExpectedAlerts 0

    # G/NL2: specific non-loopback IPv6 does not block loopback recovery.
    Invoke-GuardianCase -Name 'G/NL2 specific IPv6' -Rows @(
        (New-ListenerRow 'fd7a:115c:a1e0::9133')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 1 -ExpectedNonLoopbackAddresses @('fd7a:115c:a1e0::9133') -ExpectedSpecificCount 1 -ExpectedWildcardCount 0 -ExpectedConflict $false -ExpectedRestarts 1 -ExpectedAlerts 0

    # G/NL3: the observed Tailscale dual-listener shape remains restartable.
    Invoke-GuardianCase -Name 'G/NL3 Tailscale dual specific listeners' -Rows @(
        (New-ListenerRow '100.64.10.2'),
        (New-ListenerRow 'fd7a:115c:a1e0::9133')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 2 -ExpectedNonLoopbackAddresses @('100.64.10.2', 'fd7a:115c:a1e0::9133') -ExpectedSpecificCount 2 -ExpectedWildcardCount 0 -ExpectedConflict $false -ExpectedRestarts 1 -ExpectedAlerts 0

    # G/NL4/G/NL5: wildcard IPv4/IPv6 still fail closed.
    Invoke-GuardianCase -Name 'G/NL4 wildcard IPv4' -Rows @(
        (New-ListenerRow '0.0.0.0')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 1 -ExpectedNonLoopbackAddresses @('0.0.0.0') -ExpectedSpecificCount 0 -ExpectedWildcardCount 1 -ExpectedConflict $true -ExpectedRestarts 0 -ExpectedAlerts 1
    Invoke-GuardianCase -Name 'G/NL5 wildcard IPv6' -Rows @(
        (New-ListenerRow '::')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 1 -ExpectedNonLoopbackAddresses @('::') -ExpectedSpecificCount 0 -ExpectedWildcardCount 1 -ExpectedConflict $true -ExpectedRestarts 0 -ExpectedAlerts 1

    # A wildcard mixed with a specific listener still blocks the loopback
    # bind; the harmless specific listener must not weaken this gate.
    Invoke-GuardianCase -Name 'wildcard plus specific remains blocked' -Rows @(
        (New-ListenerRow '100.64.10.2'),
        (New-ListenerRow '0.0.0.0')
    ) -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 2 -ExpectedNonLoopbackAddresses @('100.64.10.2', '0.0.0.0') -ExpectedSpecificCount 1 -ExpectedWildcardCount 1 -ExpectedConflict $true -ExpectedRestarts 0 -ExpectedAlerts 1

    # G/NL6: loopback owner identity mismatch remains fail closed; the
    # non-loopback process is never a stop target.
    Invoke-GuardianCase -Name 'G/NL6 loopback identity mismatch' -Rows @(
        (New-ListenerRow '127.0.0.1' 4242)
    ) -ExpectedOwnerState 'identity_mismatch' -ExpectedNonLoopbackCount 0 -ExpectedNonLoopbackAddresses @() -ExpectedSpecificCount 0 -ExpectedWildcardCount 0 -ExpectedConflict $false -ExpectedRestarts 0 -ExpectedAlerts 1

    # G/NL7: no listener keeps the original budgeted restart path.
    Invoke-GuardianCase -Name 'G/NL7 no listener' -Rows @() -ExpectedOwnerState 'none' -ExpectedNonLoopbackCount 0 -ExpectedNonLoopbackAddresses @() -ExpectedSpecificCount 0 -ExpectedWildcardCount 0 -ExpectedConflict $false -ExpectedRestarts 1 -ExpectedAlerts 0

    $script:listenerRows = @(New-ListenerRow '100.64.10.2')
    $script:killAttempts = 0
    $stopResult = Stop-DshLoopbackOwner -Port $script:testPort
    Assert-Rh2R13 'non-loopback process is never a stop target' ($stopResult.State -eq 'not_stopped' -and $stopResult.Reason -eq 'none' -and $script:killAttempts -eq 0) "state=$($stopResult.State) reason=$($stopResult.Reason) kills=$script:killAttempts"

    # Verify the full health probe carries the identity classification through
    # without adding a second listener scan in dsh-health.ps1.
    function Test-DshBasicHttp([int]$Port = 39137, [int]$TimeoutSec = 2) {
        [pscustomobject]@{ State = 'refused'; Uri = "http://127.0.0.1:$Port/"; StatusCode = $null; DurationMs = 1; Error = 'synthetic' }
    }
    function Test-DshApiReady([int]$Port = 39137) {
        [pscustomobject]@{ State = 'api_unready'; Port = $Port; Owner = $null; HostDescribe = $null; SessionList = $null; Error = 'synthetic' }
    }
    $script:listenerRows = @(New-ListenerRow '100.64.10.2')
    $healthSpecific = Get-DshHealthProbe -Port $script:testPort
    Assert-Rh2R13 'health probe passes specific classification' ($healthSpecific.nonLoopbackCount -eq 1 -and $healthSpecific.specificNonLoopbackCount -eq 1 -and -not $healthSpecific.loopbackBindConflict) "nonLoopback=$($healthSpecific.nonLoopbackCount) specific=$($healthSpecific.specificNonLoopbackCount) conflict=$($healthSpecific.loopbackBindConflict)"
    $script:listenerRows = @(New-ListenerRow '0.0.0.0')
    $healthWildcard = Get-DshHealthProbe -Port $script:testPort
    Assert-Rh2R13 'health probe passes wildcard conflict' ($healthWildcard.wildcardListenerCount -eq 1 -and $healthWildcard.loopbackBindConflict -and $healthWildcard.loopbackBindConflictReason -eq 'wildcard_listener') "wildcards=$($healthWildcard.wildcardListenerCount) conflict=$($healthWildcard.loopbackBindConflict) reason=$($healthWildcard.loopbackBindConflictReason)"
    $healthSource = Get-Content -LiteralPath (Join-Path $root 'dsh-health.ps1') -Raw
    Assert-Rh2R13 'health has no second port scan' ($healthSource -notmatch 'Get-NetTCPConnection')

    # A stale/legacy probe carrying a non-loopback count but no classification
    # must retain the old fail-closed behavior rather than fail open.
    $legacyProbe = New-GuardProbe -Owner ([pscustomobject]@{
        State = 'none'; Pid = $null; NonLoopbackCount = 1
        NonLoopbackAddresses = @('192.0.2.10'); SpecificNonLoopbackAddresses = @('192.0.2.10'); SpecificNonLoopbackCount = 1
        WildcardAddresses = @(); WildcardListenerCount = 0; LoopbackBindConflict = $null; LoopbackBindConflictReason = $null
    }) -Port $script:testPort
    [void]$legacyProbe.PSObject.Properties.Remove('loopbackBindConflict')
    [void]$legacyProbe.PSObject.Properties.Remove('loopbackBindConflictReason')
    $script:restarts.Clear(); $script:alerts.Clear(); $script:logs.Clear()
    $legacyGuard = Invoke-DshHealthGuard -Port $script:testPort -Probe $legacyProbe -CurrentState (New-DshHealthStateObject -Port $script:testPort) -State @{ lastRecoverAlertAt = (Get-Date) } -BudgetState $null -MaintenanceLocked $false -RestartExecutor $Exec_Restart -AlertSender $Exec_Alert -GoalRecover $Exec_Recover -Log $Exec_Log -ConfirmProbe $Exec_Confirm
    Assert-Rh2R13 'legacy unclassified non-loopback remains fail closed' ($script:restarts.Count -eq 0 -and $script:alerts.Count -eq 1 -and @($script:logs | Where-Object { $_ -match 'listener_classification_missing' }).Count -eq 1) "restarts=$($script:restarts.Count) alerts=$($script:alerts.Count)"

    # Optional live socket contract: use an eligible local interface and a
    # port assigned by Winsock. Tailscale CGNAT/ULA and link-local addresses are
    # excluded so this test never binds a Tailscale address.
    Remove-Item -LiteralPath Function:\Get-NetTCPConnection -ErrorAction SilentlyContinue
    Import-Module NetTCPIP -Force -ErrorAction SilentlyContinue
    $netCmd = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -eq 'NetTCPIP' -and $_.Name -eq 'Get-NetTCPConnection' } |
        Select-Object -First 1
    $safeAddress = $null
    if ($netCmd) {
        $safeAddress = @(
            Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.AddressState -in @('Preferred', $null) } |
                ForEach-Object {
                    try {
                        $ip = [System.Net.IPAddress]::Parse([string]$_.IPAddress)
                        $b = $ip.GetAddressBytes()
                        $tailscale = ($b.Length -eq 4 -and $b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127)
                        if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                            -not $ip.Equals([System.Net.IPAddress]::Loopback) -and
                            -not ($b[0] -eq 169 -and $b[1] -eq 254) -and
                            -not $tailscale) {
                            [string]$_.IPAddress
                        }
                    } catch {}
                } | Select-Object -First 1
        ) | Select-Object -First 1
    }

    if (-not $safeAddress) {
        Write-Host 'SKIP SOCKET_CONTRACT: no safe non-loopback IPv4 interface (Tailscale/link-local excluded)'
    } else {
        $specificSocket = $null
        $loopbackSocket = $null
        try {
            $specificSocket = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($safeAddress), 0)
            $specificSocket.Start()
            $socketPort = ([System.Net.IPEndPoint]$specificSocket.LocalEndpoint).Port
            $loopbackSocket = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $socketPort)
            $loopbackSocket.Start()
            Start-Sleep -Milliseconds 100
            $script:processSnapshot = $null
            $socketOwner = Get-DshLoopbackOwner -Port $socketPort
            Assert-Rh2R13 'isolated socket specific address coexists with loopback' ($socketOwner.NonLoopbackCount -ge 1 -and $socketOwner.WildcardListenerCount -eq 0 -and -not $socketOwner.LoopbackBindConflict -and $socketOwner.NonLoopbackAddresses -contains $safeAddress) "address=$safeAddress port=$socketPort nonLoopback=$($socketOwner.NonLoopbackCount) wildcards=$($socketOwner.WildcardListenerCount) state=$($socketOwner.State)"
        } catch {
            $script:fail++
            Write-Host ("FAIL isolated socket contract: " + $_.Exception.Message)
        } finally {
            if ($loopbackSocket) { try { $loopbackSocket.Stop() } catch {} }
            if ($specificSocket) { try { $specificSocket.Stop() } catch {} }
        }
    }

    # Wildcard is independently testable even when the host has no safe
    # non-loopback interface.  This is an ephemeral local socket only and is
    # never the production 3080 listener.
    if ($netCmd) {
        $wildcardSocket = $null
        try {
            $wildcardSocket = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, 0)
            $wildcardSocket.Start()
            $wildcardPort = ([System.Net.IPEndPoint]$wildcardSocket.LocalEndpoint).Port
            Start-Sleep -Milliseconds 100
            $script:processSnapshot = $null
            $wildcardOwner = Get-DshLoopbackOwner -Port $wildcardPort
            Assert-Rh2R13 'isolated wildcard socket is a loopback bind conflict' ($wildcardOwner.WildcardListenerCount -ge 1 -and $wildcardOwner.LoopbackBindConflict -and $wildcardOwner.NonLoopbackAddresses -contains '0.0.0.0') "port=$wildcardPort wildcards=$($wildcardOwner.WildcardListenerCount) conflict=$($wildcardOwner.LoopbackBindConflict) addresses=$($wildcardOwner.NonLoopbackAddresses -join ',')"
        } catch {
            $script:fail++
            Write-Host ("FAIL isolated wildcard socket contract: " + $_.Exception.Message)
        } finally {
            if ($wildcardSocket) { try { $wildcardSocket.Stop() } catch {} }
        }
    }
} catch {
    $script:fail++
    Write-Host ("FAIL fatal exception: " + $_.Exception.Message)
}

Write-Host ("RH2 R1.3 BIND-CONFLICT: PASS={0} FAIL={1}" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
Write-Host 'RH2 R1.3 BIND-CONFLICT TEST PASSED'
exit 0
