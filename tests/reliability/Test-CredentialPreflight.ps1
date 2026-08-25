# Test-CredentialPreflight.ps1 - Phase 02 Security-Hardening SH-R2-4.
#
# Cold-start NEGATIVE tests for the credential preflight / safe-degrade path:
# a missing, unreadable, empty or malformed secret source must produce a
# predictable result, must NOT leak the secret value, and must NOT drag the host
# boot down (no throw, deterministic reason codes). Also asserts the config
# contract that mcp-notion disables itself when NOTION_TOKEN is absent.
#
# Windows PowerShell 5.1 compatible (no ternary / null-coalescing operators).

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) {
        $script:pass++
        if ($Detail) { Write-Host "PASS  $Name  $Detail" } else { Write-Host "PASS  $Name" }
    } else {
        $script:fail++
        if ($Detail) { Write-Host "FAIL  $Name  $Detail" } else { Write-Host "FAIL  $Name" }
    }
}

# --- locate repo root + helper -------------------------------------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$helper = Join-Path $repoRoot 'dsh-credential-preflight.ps1'
if (-not (Test-Path $helper)) {
    Write-Host "FAIL  helper not found: $helper"
    exit 1
}
. $helper

$tmpRoot = Join-Path $env:TEMP ("sh-r2-preflight-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

try {
    # --- 1) source missing -----------------------------------------------------
    $missing = Join-Path $tmpRoot 'nope\.credentials.yaml'
    $r = Invoke-DshNotionPreflight -CredentialsPath $missing
    Check 'source missing -> Ok=false reason=source-missing' ($r.Ok -eq $false -and $r.Reason -eq 'source-missing') ("reason=" + $r.Reason)
    Check 'source missing -> no value leaked (Length=0)' ($r.Length -eq 0) ("len=" + $r.Length)

    # --- 2) ref missing (file exists, other refs only) -------------------------
    $refMissing = Join-Path $tmpRoot 'ref-missing.yaml'
    Set-Content -LiteralPath $refMissing -Value "version: 1`nrefs:`n  OTHER_KEY: sk-something-else-value-1234567890`n" -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $refMissing
    Check 'ref missing -> Ok=false reason=ref-missing' ($r.Ok -eq $false -and $r.Reason -eq 'ref-missing') ("reason=" + $r.Reason)

    # --- 3) empty value --------------------------------------------------------
    $emptyVal = Join-Path $tmpRoot 'empty.yaml'
    Set-Content -LiteralPath $emptyVal -Value "version: 1`nrefs:`n  NOTION_TOKEN:`n" -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $emptyVal
    Check 'empty value -> Ok=false (empty or ref-missing)' ($r.Ok -eq $false -and ($r.Reason -eq 'empty' -or $r.Reason -eq 'ref-missing')) ("reason=" + $r.Reason)

    # --- 4) malformed: wrong prefix -------------------------------------------
    $badPrefix = Join-Path $tmpRoot 'bad-prefix.yaml'
    Set-Content -LiteralPath $badPrefix -Value "version: 1`nrefs:`n  NOTION_TOKEN: secret_value_without_ntn_prefix_padding_1234`n" -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $badPrefix
    Check 'wrong prefix -> Ok=false reason=bad-format' ($r.Ok -eq $false -and $r.Reason -eq 'bad-format') ("reason=" + $r.Reason)

    # --- 5) malformed: too short ----------------------------------------------
    $tooShort = Join-Path $tmpRoot 'short.yaml'
    Set-Content -LiteralPath $tooShort -Value "version: 1`nrefs:`n  NOTION_TOKEN: ntn_short`n" -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $tooShort
    Check 'too short -> Ok=false reason=bad-format' ($r.Ok -eq $false -and $r.Reason -eq 'bad-format') ("reason=" + $r.Reason)

    # --- 6) unexpanded template placeholder -----------------------------------
    $tmplVal = Join-Path $tmpRoot 'template.yaml'
    Set-Content -LiteralPath $tmplVal -Value "version: 1`nrefs:`n  NOTION_TOKEN: `${NOTION_TOKEN}`n" -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $tmplVal
    Check 'unexpanded ${...} template -> Ok=false' ($r.Ok -eq $false) ("reason=" + $r.Reason)

    # --- 7) valid fake token (shape only) -------------------------------------
    $okVal = Join-Path $tmpRoot 'ok.yaml'
    $fake = 'ntn_' + ('x' * 44)
    Set-Content -LiteralPath $okVal -Value ("version: 1`nrefs:`n  NOTION_TOKEN: " + $fake + "`n") -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $okVal
    Check 'valid shape -> Ok=true reason=ok' ($r.Ok -eq $true -and $r.Reason -eq 'ok') ("reason=" + $r.Reason)
    Check 'valid shape -> Length reported' ($r.Length -eq $fake.Length) ("len=" + $r.Length)

    # --- 8) quoted value handled ----------------------------------------------
    $quoted = Join-Path $tmpRoot 'quoted.yaml'
    Set-Content -LiteralPath $quoted -Value ("version: 1`nrefs:`n  NOTION_TOKEN: `"" + $fake + "`"`n") -Encoding UTF8
    $r = Invoke-DshNotionPreflight -CredentialsPath $quoted
    Check 'quoted value handled -> Ok=true' ($r.Ok -eq $true) ("reason=" + $r.Reason)

    # --- 9) result object must never carry the secret value -------------------
    $dump = ($r | Format-List | Out-String)
    Check 'preflight result never contains the token value' (-not $dump.Contains($fake)) 'result is secret-free'

    # --- 10) no throw on unreadable/garbage source ---------------------------
    $garbage = Join-Path $tmpRoot 'garbage.yaml'
    Set-Content -LiteralPath $garbage -Value "::: not : yaml : at all ][`n`x00`n" -Encoding UTF8
    $threw = $false
    try { $r = Invoke-DshNotionPreflight -CredentialsPath $garbage } catch { $threw = $true }
    Check 'garbage source -> no throw (host boot not dragged down)' (-not $threw) ''
    Check 'garbage source -> Ok=false deterministic' ($r.Ok -eq $false) ("reason=" + $r.Reason)

    # --- 11) config contract: mcp-notion self-disables without the token ------
    $tplPath = Join-Path $repoRoot 'plugins\cordis.patch.yml'
    Check 'repo template exists' (Test-Path $tplPath) $tplPath
    if (Test-Path $tplPath) {
        $tpl = Get-Content -LiteralPath $tplPath -Raw -Encoding UTF8
        Check 'template: mcp-notion has safe-degrade disabled expression' ($tpl -match 'disabled:\s*!!js\s*"!process\.env\.NOTION_TOKEN"') ''
        Check 'template: env uses process.env (ESM-safe, no require)' ($tpl -match 'NOTION_TOKEN:\s*!!js\s*"process\.env\.NOTION_TOKEN') ''
        Check 'template: no plaintext ntn_ token' (-not ($tpl -match 'NOTION_TOKEN:\s*ntn_')) ''
        Check 'template: no require() dynamic expression' (-not ($tpl -match '!!js\s*"require\(')) ''
    }

    # --- 12) starter contract: token only assigned when preflight Ok ----------
    $starter = Join-Path $repoRoot 'start-dsh-server.ps1'
    Check 'start-dsh-server.ps1 exists' (Test-Path $starter) ''
    if (Test-Path $starter) {
        $sc = Get-Content -LiteralPath $starter -Raw -Encoding UTF8
        Check 'starter calls Invoke-DshNotionPreflight' ($sc -match 'Invoke-DshNotionPreflight') ''
        Check 'starter assigns token inside Ok branch only' ($sc -match 'if\s*\(\$ntnPre\.Ok\)\s*\{[\s\S]{0,200}?\$env:NOTION_TOKEN\s*=') ''
        Check 'starter logs SAFE-DEGRADE on failure' ($sc -match 'SAFE-DEGRADE') ''
        Check 'starter never logs the token value' (-not ($sc -match 'Write-Host[^\r\n]*\$env:NOTION_TOKEN')) ''
        Check 'starter writes auditable preflight log line' ($sc -match 'Write-DshPreflightResultLog') ''
    }

    # --- 13) auditable log: secret-free decision line --------------------------
    $logPath = Join-Path $tmpRoot 'preflight.log'
    $okRes = Invoke-DshNotionPreflight -CredentialsPath $okVal
    $wrote = Write-DshPreflightResultLog -Result $okRes -LogPath $logPath
    Check 'preflight log write returns true' ($wrote -eq $true) ''
    Check 'preflight log file created' (Test-Path $logPath) ''
    if (Test-Path $logPath) {
        $logText = Get-Content -LiteralPath $logPath -Raw -Encoding UTF8
        Check 'log line marks verdict ok' ($logText -match 'NOTION-PREFLIGHT ok ref=NOTION_TOKEN reason=ok') ''
        Check 'log line contains no secret value' (-not $logText.Contains($fake)) ''
    }
    $failRes = Invoke-DshNotionPreflight -CredentialsPath (Join-Path $tmpRoot 'nope\.credentials.yaml')
    $null = Write-DshPreflightResultLog -Result $failRes -LogPath $logPath
    $logText2 = Get-Content -LiteralPath $logPath -Raw -Encoding UTF8
    Check 'log records SAFE-DEGRADE on failure' ($logText2 -match 'SAFE-DEGRADE \(not loaded\); host boot continues') ''

    # --- 14) logging failure must not throw (best-effort by design) ------------
    $threw2 = $false
    try { $null = Write-DshPreflightLog -Message 'probe' -LogPath 'Z:\definitely\missing\path\x.log' } catch { $threw2 = $true }
    Check 'log failure does not throw (boot never blocked)' (-not $threw2) ''
} finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("" + $script:pass + " passed, " + $script:fail + " failed")
if ($script:fail -gt 0) { Write-Host 'CREDENTIAL PREFLIGHT TEST FAILED'; exit 1 }
Write-Host 'CREDENTIAL PREFLIGHT TEST PASSED'
exit 0
