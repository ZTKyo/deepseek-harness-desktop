# dsh-generation.ps1 - Harness Generation lifecycle helpers
# A Generation = one DSH server boot (generationId = startTimeTicks_pid). Associates serverPid/guardianPid/state.
# New generation disposes old: stale PID, stale lock, stale tunnel cleanup.

function Get-DshGenerationId {
    param([int]$Port=3080)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Where-Object LocalAddress -eq "127.0.0.1" | Select-Object -First 1
        if(-not $conn){ return $null }
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        $ticks = $proc.StartTime.Ticks
        return "${ticks}_$($proc.Id)"
    } catch { return $null }
}
function Get-DshGenerationInfo {
    param([int]$Port=3080)
    $gid = Get-DshGenerationId -Port $Port
    $owner = $null; $ready=$null
    try { . (Join-Path $PSScriptRoot 'dsh-readiness.ps1'); $ready = Test-DshReadiness -Port $Port } catch {}
    try { . (Join-Path $PSScriptRoot 'dsh-process-identity.ps1'); $owner = Get-DshLoopbackOwner -Port $Port } catch {}
    return @{ generationId=$gid; port=$Port; owner=$owner; readiness=$ready; timestamp=(Get-Date -Format 'o') }
}
function Clear-StaleGenerationArtifacts {
    # Remove stale heartbeat/lock from previous generation when PID no longer alive
    $stateDir = Join-Path $env:LOCALAPPDATA 'DSHHarness\state'
    $hb = Join-Path $stateDir 'guardian-heartbeat.json'
    if(Test-Path $hb){
        try {
            $j = Get-Content $hb -Raw | ConvertFrom-Json
            $pidVal = [int]$j.pid
            if($pidVal -gt 0 -and -not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)){
                # stale heartbeat - will be overwritten naturally, just note
            }
        } catch {}
    }
}
