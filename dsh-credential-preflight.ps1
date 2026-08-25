# dsh-credential-preflight.ps1 - Phase 02 Security-Hardening SH-R2-4.
#
# Minimal dedicated helper that validates a credential reference BEFORE the
# Harness host is started, so a missing/unreadable/malformed secret source can
# never silently degrade into "MCP server loaded with an empty token".
#
# Design rules (from Security-Hardening External Review Round 1):
#   * pure functions only - this file is dot-sourceable and CI-importable;
#   * NEVER print, log or return the secret value (only booleans/lengths/reasons);
#   * explicit reason codes so the caller can safe-degrade deterministically;
#   * no throw on a missing/broken source - return a structured result instead,
#     so the host boot path stays predictable and is never dragged down.
#
# Reason codes: ok | source-missing | source-unreadable | ref-missing | empty | bad-format

Set-StrictMode -Version Latest

function Get-DshCredentialsPath {
    <#
    .SYNOPSIS
    Canonical path of the local credential store (secret-gate refs file).
    #>
    [CmdletBinding()]
    param([string]$Override)
    if ($Override) { return $Override }
    return (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml')
}

function Get-DshCredentialRefValue {
    <#
    .SYNOPSIS
    Read one credential reference value from the local refs store.
    .DESCRIPTION
    Returns the raw value string, or $null when the file or the reference is
    absent. Quote-aware and comment-aware; never writes the value anywhere.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$CredentialsPath
    )
    $path = Get-DshCredentialsPath -Override $CredentialsPath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
    } catch {
        return $null
    }
    if (-not $raw) { return $null }
    # Anchored, comment-skipping, quote-aware single-key lookup.
    $escaped = [regex]::Escape($Name)
    $pattern = '(?m)^[ \t]*' + $escaped + '[ \t]*:[ \t]*(?<v>.*?)[ \t]*$'
    $m = [regex]::Match($raw, $pattern)
    if (-not $m.Success) { return $null }
    $value = $m.Groups['v'].Value
    if ($null -eq $value) { return $null }
    $value = $value.Trim()
    if ($value.StartsWith('#')) { return $null }          # commented-out entry
    if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    return $value
}

function Test-DshTokenShape {
    <#
    .SYNOPSIS
    Shape-only validation of a token (no network call, no value output).
    #>
    [CmdletBinding()]
    param(
        [string]$Token,
        [string]$RequiredPrefix = '',
        [int]$MinLength = 20
    )
    if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
    if ($Token.Length -lt $MinLength) { return $false }
    if ($RequiredPrefix -and -not $Token.StartsWith($RequiredPrefix)) { return $false }
    # reject obvious placeholders / unexpanded templates
    if ($Token -match '^\$\{.*\}$') { return $false }
    if ($Token -match '^(changeme|placeholder|todo|none|null)$') { return $false }
    return $true
}

function Invoke-DshCredentialPreflight {
    <#
    .SYNOPSIS
    Preflight one credential reference; returns a structured, secret-free result.
    .OUTPUTS
    PSCustomObject: Ok(bool), Reason(string), Length(int), Ref(string), Source(string)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$CredentialsPath,
        [string]$RequiredPrefix = '',
        [int]$MinLength = 20
    )
    $path = Get-DshCredentialsPath -Override $CredentialsPath
    $result = [pscustomobject]@{
        Ok      = $false
        Reason  = 'source-missing'
        Length  = 0
        Ref     = $Name
        Source  = $path
    }
    if (-not (Test-Path -LiteralPath $path)) { return $result }
    try {
        $null = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
    } catch {
        $result.Reason = 'source-unreadable'
        return $result
    }
    $value = Get-DshCredentialRefValue -Name $Name -CredentialsPath $path
    if ($null -eq $value) {
        $result.Reason = 'ref-missing'
        return $result
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        $result.Reason = 'empty'
        return $result
    }
    $result.Length = $value.Length
    if (-not (Test-DshTokenShape -Token $value -RequiredPrefix $RequiredPrefix -MinLength $MinLength)) {
        $result.Reason = 'bad-format'
        return $result
    }
    $result.Ok = $true
    $result.Reason = 'ok'
    return $result
}

function Invoke-DshNotionPreflight {
    <#
    .SYNOPSIS
    Notion-specific preflight (ref NOTION_TOKEN, ntn_ prefix).
    #>
    [CmdletBinding()]
    param([string]$CredentialsPath)
    return Invoke-DshCredentialPreflight -Name 'NOTION_TOKEN' -CredentialsPath $CredentialsPath -RequiredPrefix 'ntn_' -MinLength 30
}

function Get-DshPreflightLogPath {
    <#
    .SYNOPSIS
    Canonical audit log for credential preflight decisions (never holds values).
    #>
    [CmdletBinding()]
    param([string]$Override)
    if ($Override) { return $Override }
    return (Join-Path (Join-Path $env:LOCALAPPDATA 'DSHHarness\logs') 'credential-preflight.log')
}

function Write-DshPreflightLog {
    <#
    .SYNOPSIS
    Append one auditable preflight line. NEVER logs the secret value.
    .DESCRIPTION
    The host starter runs in a hidden window, so console output alone is not
    auditable; this makes the safe-degrade decision observable afterwards.
    Best-effort by design: a logging failure must never block host boot.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$LogPath
    )
    try {
        $path = Get-DshPreflightLogPath -Override $LogPath
        $dir = Split-Path -Parent $path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        Add-Content -LiteralPath $path -Value ($stamp + ' ' + $Message) -Encoding UTF8 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Write-DshPreflightResultLog {
    <#
    .SYNOPSIS
    Log a preflight result in secret-free form (verdict + reason + length only).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Result,
        [string]$LogPath
    )
    $verdict = 'FAIL'
    if ($Result.Ok) { $verdict = 'ok' }
    $msg = 'NOTION-PREFLIGHT ' + $verdict + ' ref=' + $Result.Ref + ' reason=' + $Result.Reason + ' len=' + $Result.Length + ' (value not logged)'
    if (-not $Result.Ok) { $msg = $msg + ' -> mcp-notion SAFE-DEGRADE (not loaded); host boot continues' }
    return (Write-DshPreflightLog -Message $msg -LogPath $LogPath)
}
