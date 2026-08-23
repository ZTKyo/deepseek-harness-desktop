# dsh-clean-reclaim.ps1 - deep-clean self-heal: reclaim zombie / half-dead DSH listeners.
#
# P0 optimization (2026-08-18): the classic "服务拉不起来" symptom is a DSH node
# process that still holds the loopback listen socket but whose app is dead or
# wedged (never reaches API readiness). Starting a fresh instance just hits
# EADDRINUSE and "impressively" fails. This module identifies exactly that
# situation (verified process identity + failed readiness) and surgically stops
# ONLY the proven-DSH listener, waits for the port to free, and reports what it
# did. It never touches a healthy service and never touches a non-DSH listener
# (identity_mismatch / foreign listener is left alone and reported).
#
# Depends on dsh-process-identity.ps1 (verified DSH identity + stop-with-wait)
# and dsh-readiness.ps1 (layered API/websocket readiness).
# Dot-source this file (it self-loads its deps when missing).

$script:CleanReclaimRoot = $PSScriptRoot
if (-not (Get-Command Get-DshLoopbackOwner -ErrorAction SilentlyContinue)) {
    $p = Join-Path $script:CleanReclaimRoot 'dsh-process-identity.ps1'
    if (Test-Path $p) { . $p }
}
if (-not (Get-Command Test-DshReadiness -ErrorAction SilentlyContinue)) {
    $p = Join-Path $script:CleanReclaimRoot 'dsh-readiness.ps1'
    if (Test-Path $p) { . $p }
}

function Get-DshReclaimState([int]$Port = 3080) {
    # One snapshot of "ready / owner / zombie" for the port.
    #   Ready   - 'api_ready' | 'client_ready' | other readiness State (api_unready, process_*, ws_unready, ...)
    #   Owner   - Get-DshLoopbackOwner.State ('ok'|'none'|'ambiguous'|'identity_mismatch')
    #   OwnerPid, NonLoopback, Zombie
    $ready = Test-DshReadiness -Port $Port
    $owner = Get-DshLoopbackOwner -Port $Port
    $isReady = ($ready.State -in @('api_ready', 'client_ready'))
    # A "zombie" = verified-DSH process owns the port but never reached API
    # readiness. Identity is verified by the process-identity module (command
    # line OR runtime ledger) - we never kill on a guess. readiness 'api_unready' /
    # 'rpc_error' / 'rpc_not_ok' mean the API itself is not answering; a mere
    # 'ws_unready' is NOT a zombie (the API is fine). process_* states mean there
    # is no loopback listener at all -> not a zombie either.
    $zombie = (-not $isReady) -and ($owner.State -eq 'ok') -and ($ready.State -in @('api_unready', 'rpc_error', 'rpc_not_ok'))
    return [pscustomobject]@{
        Ready        = [string]$ready.State
        Owner        = [string]$owner.State
        OwnerPid     = if ($owner.Pid) { [int]$owner.Pid } else { $null }
        NonLoopback  = [int]$owner.NonLoopbackCount
        IsReady      = [bool]$isReady
        Zombie       = [bool]$zombie
    }
}

function Invoke-DshCleanReclaim(
    [int]$Port = 3080,
    [int]$ProbeSec = 8,
    [switch]$Force
) {
    # Try to reclaim a zombie DSH listener on $Port. Returns a result object.
    #
    # Behavior:
    #   1. Snapshot the port state.
    #   2. If already ready -> action 'none', reason 'ready'.
    #   3. Otherwise wait up to $ProbeSec for it to come ready (a fresh process
    #      often needs a few seconds to expose its API).
    #   4. If still not ready AND the owner is a verified DSH process -> stop it
    #      and wait for the loopback to free (Stop-DshLoopbackOwner) -> 'stopped'.
    #   5. Foreign/unverifiable listeners are left strictly alone.
    $state = Get-DshReclaimState -Port $Port
    if ($state.IsReady) { return [pscustomobject]@{ Action = 'none'; Reason = 'ready'; Port = $Port; State = $state } }

    $probed = $state
    for ($i = 0; $i -lt $ProbeSec; $i++) {
        Start-Sleep -Seconds 1
        $probed = Get-DshReclaimState -Port $Port
        if ($probed.IsReady) { return [pscustomobject]@{ Action = 'none'; Reason = 'ready_after_wait'; Port = $Port; State = $probed } }
        # once the owner stops being a zombie candidate, stop waiting
        if (-not $probed.Zombie -and $probed.Owner -ne 'ok') { break }
    }

    if ($probed.Zombie -and $probed.Owner -eq 'ok' -and $probed.OwnerPid) {
        if (-not $Force) {
            return [pscustomobject]@{ Action = 'pending'; Reason = 'zombie_detected_requires_force'; Port = $Port; Pid = $probed.OwnerPid; State = $probed }
        }
        $stop = Stop-DshLoopbackOwner -Port $Port -ExpectedPid $probed.OwnerPid
        if ($stop.State -eq 'stopped') {
            return [pscustomobject]@{ Action = 'stopped'; Reason = 'zombie_reclaimed'; Port = $Port; Pid = $probed.OwnerPid; Stop = $stop; State = $probed }
        }
        return [pscustomobject]@{ Action = 'stop_failed'; Reason = [string]$stop.State; Port = $Port; Pid = $probed.OwnerPid; Stop = $stop; State = $probed }
    }

    if ($probed.Owner -eq 'identity_mismatch' -or $probed.Owner -eq 'ambiguous') {
        return [pscustomobject]@{ Action = 'none'; Reason = 'foreign_or_ambiguous_listener'; Port = $Port; State = $probed }
    }
    return [pscustomobject]@{ Action = 'none'; Reason = 'no_zombie_owner'; Port = $Port; State = $probed }
}

function Get-DshCleanReclaimHelp {
    [CmdletBinding()]
    param()
    return @"
dsh-clean-reclaim.ps1 - deep-clean self-heal for DSH listeners.

  Get-DshReclaimState -Port 3080          # snapshot: ready/owner/zombie
  Invoke-DshCleanReclaim -Port 3080 -Force   # stop a proven zombie listener (reclaims the port)
  Invoke-DshCleanReclaim -Port 3080          # dry-run: reports 'pending' without stopping

Safety: only a process the identity module provably identifies as the DSH
server for the requested port is ever stopped; foreign listeners are left alone.
"@
}
