# dsh-reconnect.ps1 - RH1 Part D client reconnect state machine (PURE, testable).
#
# R2 Blocker 1: the OFFLINE<->ONLINE auto-reload decision was scattered through the
# WPF UI DispatcherTimer and could not be unit-tested. This module extracts the
# whole decision into a deterministic, clock-injected pure transition function.
# The client (DSH-Harness-PS.ps1) calls Invoke-DshReconnectTransition on every
# probe tick; the REAL E2E / CI tests drive the same function directly.
#
# Semantics (R2 correction):
#   * ONLINE     = probe reaches the server (HTTP 200).
#   * DEGRADED   = server alive but not 200 / not fully ready. NO reload ever.
#   * OFFLINE    = probe repeatedly unreachable (>= OfflineHitsThreshold ticks).
#   * DEGRADED -> ONLINE : ALWAYS 0 auto reload.
#   * OFFLINE -> ONLINE  : requires a stable recovery GRACE window (>= GraceSec of
#                          continuous online) BEFORE any auto reload is considered.
#                          Then, only reload if the PAGE has NOT self-recovered,
#                          at most ONCE per episode, and only after a COOLDOWN
#                          (>= CooldownSec) since the last auto reload.
#   * "episode" = a run of consecutive unreachable ticks that reached OFFLINE.
#
# Any function here NEVER touches the network, I/O, or the UI. It only reads a
# probe mode + a page-has-self-recovered flag + an injected clock, and returns a
# decision object. When the decision object .Reload is $true the client performs
# the single WebView2 reload. The whole decision path is therefore CI-deterministic.

$script:DshReconnectGraceSec = 10        # continuous online before considering reload
$script:DshReconnectCooldownSec = 120    # min gap between auto reloads
$script:DshReconnectOfflineHitsThreshold = 2  # unreachable ticks before declaring OFFLINE

function New-DshReconnectState {
    return [pscustomobject]@{
        version         = 1
        mode            = 'online'      # online | degraded | offline | unknown
        offlineSince    = $null
        offlineHits     = 0
        reloaded        = $false        # auto reload already done this episode
        lastReloadAt    = $null
        recoveryStartAt = $null         # first online tick of an offline->online recovery
        episodeCounter  = 0
    }
}

function Get-DshReconnectState([int]$Port = 3080) {
    # Persisted client reconnect state is intentionally NOT stored on disk from the
    # pure function; the client keeps it in-process ($script:reconn). This helper
    # exists for symmetry and future persistence (best-effort, never throws).
    return New-DshReconnectState
}

# ---- clone helper: the pure function must not mutate the caller's state in-place;
# it returns an updated copy so the caller decides when to persist it. ----
function _cloneDshReconnectState([object]$s) {
    return [pscustomobject]@{
        version         = 1
        mode            = [string]$s.mode
        offlineSince    = $s.offlineSince
        offlineHits     = [int]$s.offlineHits
        reloaded        = [bool]$s.reloaded
        lastReloadAt    = $s.lastReloadAt
        recoveryStartAt = $s.recoveryStartAt
        episodeCounter  = [int]$s.episodeCounter
    }
}

# ---- PURE transition. Deterministic given (State, Mode, LastNavigationSucceeded, Now).
# LastNavigationSucceeded = the client's latest navigation to the server succeeded
# (page self-recovered); used to decide reload vs. no-reload after a stable grace window.
# Returns @{ Operation; Mode; Reload; Reason; State; Diagnostic }.
function Invoke-DshReconnectTransition(
    [object]$State = $null,
    [string]$Mode = 'unknown',
    [bool]$LastNavigationSucceeded = $false,
    [datetime]$Now = $null,
    [int]$GraceSec = $script:DshReconnectGraceSec,
    [int]$CooldownSec = $script:DshReconnectCooldownSec,
    [int]$OfflineHitsThreshold = $script:DshReconnectOfflineHitsThreshold
) {
    if (-not $Now) { $Now = Get-Date }
    if (-not $State) { $State = New-DshReconnectState }
    $st = _cloneDshReconnectState $State

    $base = [pscustomobject]@{
        Operation  = 'noop'
        Mode       = [string]$st.mode
        Reload     = $false
        Reason     = ''
        State      = $st
        Diagnostic = $null
    }

    $modeStr = [string]$Mode

    # ---- probe unreachable (offline / unknown) ----
    if ($modeStr -in @('offline', 'unknown')) {
        if ($st.offlineHits -lt $OfflineHitsThreshold) { $st.offlineHits++ }
        if ($st.mode -ne 'offline' -and $st.offlineHits -ge $OfflineHitsThreshold) {
            # first time crossing the threshold -> declare a new OFFLINE episode
            $st.mode = 'offline'
            $st.offlineSince = $Now
            $st.episodeCounter++
            $st.reloaded = $false
            $st.recoveryStartAt = $null
            $base.Operation = 'offline_declared'
            $base.Mode = 'offline'
            $base.Reason = "unreachable x$($st.offlineHits); declared OFFLINE (episode #$($st.episodeCounter))"
            $base.State = $st
            return $base
        }
        # still below threshold, or already offline
        $base.Operation = if ($st.mode -eq 'offline') { 'offline_stable' } else { 'offline_observe' }
        $base.Mode = [string]$st.mode
        $base.Reason = "unreachable; hits=$($st.offlineHits)/$OfflineHitsThreshold mode=$($st.mode)"
        $base.State = $st
        return $base
    }

    # ---- probe degraded (alive but not ready) ----
    if ($modeStr -eq 'degraded') {
        $st.mode = 'degraded'
        $st.offlineHits = 0
        # keep recoveryStartAt if we came from an offline episode, so a later online
        # still requires the FULL grace window. Never reload on degraded.
        $base.Operation = 'degrade'
        $base.Mode = 'degraded'
        $base.Reason = 'degraded (alive but unready); never reload'
        $base.Reload = $false
        $base.State = $st
        return $base
    }

    # ---- probe online ----
    if ($modeStr -eq 'online') {
        if ($st.mode -eq 'offline') {
            # OFFLINE -> ONLINE recovery: require a stable grace window.
            if (-not $st.recoveryStartAt) { $st.recoveryStartAt = $Now }
            $elapsed = [math]::Max(0.0, ($Now - $st.recoveryStartAt).TotalSeconds)
            if ($elapsed -lt $GraceSec) {
                $base.Operation = 'recovery_grace'
                $base.Mode = 'online'
                $base.Reason = ("offline->online; recovery grace not elapsed ({0}s/{1}s)" -f [int]$elapsed, $GraceSec)
                $base.Reload = $false
                $base.State = $st
                return $base
            }
            # grace elapsed -> decide. Prefer observing page self-recovery.
            if ($LastNavigationSucceeded) {
                $st.mode = 'online'
                $st.offlineSince = $null
                $st.recoveryStartAt = $null
                $st.offlineHits = 0
                $st.reloaded = $false
                $base.Operation = 'no_reload_page_recovered'
                $base.Mode = 'online'
                $base.Reason = 'offline->online; page self-recovered; no auto reload'
                $base.Reload = $false
                $base.State = $st
                return $base
            }
            $cooldownOk = ($null -eq $st.lastReloadAt) -or (($Now - $st.lastReloadAt).TotalSeconds -ge $CooldownSec)
            if (-not $st.reloaded -and $cooldownOk) {
                $st.reloaded = $true
                $st.lastReloadAt = $Now
                $st.mode = 'online'
                $st.offlineSince = $null
                $st.recoveryStartAt = $null
                $base.Operation = 'auto_reload'
                $base.Mode = 'online'
                $base.Reason = "offline->online; page not recovered; auto reload (1x, cooldown ok)"
                $base.Reload = $true
                $base.State = $st
                return $base
            }
            # already reloaded this episode, or in cooldown -> do not reload again
            $st.mode = 'online'
            $st.offlineSince = $null
            $st.recoveryStartAt = $null
            if ($st.reloaded) {
                $base.Operation = 'no_reload_already_reloaded'
                $base.Reason = 'offline->online; already auto-reloaded this episode; no reload'
            } else {
                $base.Operation = 'no_reload_cooldown'
                $base.Reason = "offline->online; in cooldown; no reload"
            }
            $base.Mode = 'online'
            $base.Reload = $false
            $base.State = $st
            return $base
        } elseif ($st.mode -eq 'degraded') {
            # DEGRADED -> ONLINE: ALWAYS 0 auto reload (R2 Blocker 1 requirement B).
            $st.mode = 'online'
            $st.offlineHits = 0
            $base.Operation = 'no_reload_degraded_to_online'
            $base.Mode = 'online'
            $base.Reason = 'degraded->online; always 0 auto reload'
            $base.Reload = $false
            $base.State = $st
            return $base
        } else {
            # already online / unknown -> stable.
            if ($st.mode -ne 'online') { $st.mode = 'online' }
            $st.offlineHits = 0
            $base.Operation = 'online_stable'
            $base.Mode = 'online'
            $base.Reason = 'online; stable'
            $base.Reload = $false
            $base.State = $st
            return $base
        }
    }

    # ---- unknown probe mode ----
    $base.Operation = 'unknown_mode'
    $base.Mode = [string]$st.mode
    $base.Reason = "unknown probe mode: $modeStr"
    $base.Reload = $false
    $base.State = $st
    return $base
}
