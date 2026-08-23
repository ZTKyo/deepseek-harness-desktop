# dsh-restart-budget.ps1 - persistent, bounded restart budget.
# Callers must hold dsh-process-identity.ps1's restart mutex while mutating it.

$script:DshRestartBudgetPath = if ($env:DSH_RESTART_BUDGET_PATH) {
    $env:DSH_RESTART_BUDGET_PATH
} else {
    Join-Path $env:LOCALAPPDATA 'DSHHarness\state\restart-budget.json'
}

function Get-DshRestartBudgetDefault {
    [pscustomobject]@{
        windowStart = $null
        attempts = 0
        hourWindowStart = $null
        hourAttempts = 0
        pauseUntil = $null
        lastReason = $null
        lastAttempt = $null
        lastSuccess = $null
    }
}

function Read-DshRestartBudget {
    if (-not (Test-Path -LiteralPath $script:DshRestartBudgetPath)) { return (Get-DshRestartBudgetDefault) }
    try {
        $value = Get-Content -LiteralPath $script:DshRestartBudgetPath -Raw | ConvertFrom-Json
        if ($null -eq $value.attempts) { return (Get-DshRestartBudgetDefault) }
        return $value
    } catch { return (Get-DshRestartBudgetDefault) }
}

function Write-DshRestartBudget($Value) {
    $dir = Split-Path -Parent $script:DshRestartBudgetPath
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tmp = "$($script:DshRestartBudgetPath).tmp-$PID"
    $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding UTF8
    try { Move-Item -LiteralPath $tmp -Destination $script:DshRestartBudgetPath -Force -ErrorAction Stop }
    catch {
        Remove-Item -LiteralPath $script:DshRestartBudgetPath -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $tmp -Destination $script:DshRestartBudgetPath -Force
    }
}

function Convert-DshDate([object]$Value) {
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    try { return [DateTimeOffset]::Parse([string]$Value) } catch { return $null }
}

function Test-DshRestartAllowed {
    $now = [DateTimeOffset]::Now
    $s = Read-DshRestartBudget
    $window = Convert-DshDate $s.windowStart
    $hour = Convert-DshDate $s.hourWindowStart
    $pause = Convert-DshDate $s.pauseUntil
    if ($window -and (($now - $window).TotalMinutes -ge 10)) { $s.windowStart = $null; $s.attempts = 0 }
    if ($hour -and (($now - $hour).TotalHours -ge 1)) { $s.hourWindowStart = $null; $s.hourAttempts = 0 }
    $pause = Convert-DshDate $s.pauseUntil
    if ($pause -and $pause -gt $now) {
        Write-DshRestartBudget $s
        return [pscustomobject]@{ Allowed = $false; Reason = 'circuit_open'; PauseUntil = $pause; Budget = $s }
    }
    if ([int]$s.attempts -ge 3 -or [int]$s.hourAttempts -ge 6) {
        $s.pauseUntil = $now.AddMinutes(15).ToString('o')
        Write-DshRestartBudget $s
        return [pscustomobject]@{ Allowed = $false; Reason = 'budget_exhausted'; PauseUntil = [DateTimeOffset]::Parse($s.pauseUntil); Budget = $s }
    }
    Write-DshRestartBudget $s
    return [pscustomobject]@{ Allowed = $true; Reason = 'allowed'; PauseUntil = $null; Budget = $s }
}

function Register-DshRestartAttempt([string]$Reason) {
    $now = [DateTimeOffset]::Now
    $s = Read-DshRestartBudget
    $window = Convert-DshDate $s.windowStart
    $hour = Convert-DshDate $s.hourWindowStart
    if (-not $window -or (($now - $window).TotalMinutes -ge 10)) { $s.windowStart = $now.ToString('o'); $s.attempts = 0 }
    if (-not $hour -or (($now - $hour).TotalHours -ge 1)) { $s.hourWindowStart = $now.ToString('o'); $s.hourAttempts = 0 }
    $s.attempts = [int]$s.attempts + 1
    $s.hourAttempts = [int]$s.hourAttempts + 1
    $s.lastReason = [string]$Reason
    $s.lastAttempt = $now.ToString('o')
    Write-DshRestartBudget $s
    return $s
}

function Register-DshRestartSuccess {
    $s = Read-DshRestartBudget
    $s.windowStart = $null
    $s.attempts = 0
    $s.pauseUntil = $null
    $s.lastSuccess = [DateTimeOffset]::Now.ToString('o')
    Write-DshRestartBudget $s
    return $s
}
