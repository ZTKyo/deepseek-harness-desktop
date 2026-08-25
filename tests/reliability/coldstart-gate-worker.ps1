# coldstart-gate-worker.ps1 - Phase 02 Security-Hardening SH-R4.
#
# INDEPENDENT worker that executes the three-phase cold-start credential gate.
# Spawned by Test-ColdStartCredentialGate.ps1 via Start-Process, it is NOT a
# child of the DSH host, so it survives the negative cold boot and always runs
# restore + normal cold boot. Every credential mutation is wrapped in try/finally
# and the credentials file is restored BYTE-FOR-BYTE from the original bytes
# before exit on ANY failure path.
#
# Results are written to a JSON file the controller polls:
#   { checks: [ { name, ok, detail } ] }

param(
    [string]$CredsFile,
    [string]$PatchFile,
    [string]$PreflightLog,
    [string]$IntentsFile,
    [string]$RestartScript,
    [string]$ResultFile,
    [int]$Port = 3080,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$checks = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $checks.Add([pscustomobject]@{ name = $Name; ok = [bool]$Ok; detail = $Detail })
    $label = if ($Ok) { 'PASS' } else { 'FAIL' }
    if ($Detail) { Write-Host "$label  $Name  $Detail" } else { Write-Host "$label  $Name" }
}

function Write-Result([int]$Code) {
    try {
        $obj = [pscustomobject]@{ checks = @($checks); exitCode = $Code; ts = (Get-Date).ToUniversalTime().ToString('o') }
        $obj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultFile -Encoding UTF8
    } catch { Write-Host "result write failed: $($_.Exception.Message)" }
    exit $Code
}

function Get-HttpStatus {
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8; return [int]$r.StatusCode }
    catch { return -1 }
}

function Wait-HttpReady([int]$MaxSeconds = 40) {
    $deadline = (Get-Date).AddSeconds($MaxSeconds)
    while ((Get-Date) -lt $deadline) {
        $s = Get-HttpStatus
        if ($s -eq 200) { return $true }
        Start-Sleep -Seconds 3
    }
    return ($(Get-HttpStatus) -eq 200)
}

function Get-NotionMcpLoaded {
    # STRUCTURED probe: never conflates "probe failed" with "notion not loaded".
    # The DSH host API exposes NO MCP tool list (UNARY_ROUTES has only
    # session.*/subagent.*/host.*/workspace.*/skill.list), so the loaded state
    # is detected by checking the mcp-notion stdio child process: when the entry
    # is disabled (no NOTION_TOKEN), dsh-mcp-client never spawns
    # `npx @notionhq/notion-mcp-server`, so no such process exists.
    # Returns PSCustomObject: probe_ok / notion_loaded / tool_count / error.
    [pscustomobject]$result = @{ probe_ok = $false; notion_loaded = $false; tool_count = 0; error = '' }
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='npx.exe' OR Name='cmd.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -match 'notion-mcp-server' }
        $list = @($procs)
        $result.probe_ok = $true
        $result.tool_count = $list.Count
        $result.notion_loaded = ($list.Count -gt 0)
        return $result
    } catch {
        $result.error = $_.Exception.Message
        return $result
    }
}

# ---- byte-for-byte credential save/restore ----------------------------------
$originalBytes = $null
$originalBytes = [System.IO.File]::ReadAllBytes($CredsFile)
# SH-R5: capture the pre-mutation SHA256 and DACL so B1 can assert REAL equality
# (not just "the token line exists") after the finally-restore.
$originalSha256 = (Get-FileHash -LiteralPath $CredsFile -Algorithm SHA256).Hash
$originalDaclText = (icacls $CredsFile 2>&1 | Out-String)

function Write-OriginalBytes {
    if ($null -ne $originalBytes -and $originalBytes.Length -gt 0) {
        [System.IO.File]::WriteAllBytes($CredsFile, $originalBytes)
    }
}

function Remove-CredentialRef([string]$Ref) {
    # SH-R4: use a YAML-aware rewrite instead of hand-editing lines. The
    # credentials file MUST keep the `version: 1` + `refs:` layout that
    # dsh-credentials-local requires (any other shape makes the DSH host crash
    # at boot with "pre-release flat layout", which is exactly what SH-R3's
    # negative cold boot exposed). The rewrite also stays WITHOUT BOM to match
    # the original file byte layout.
    $cur = [System.IO.File]::ReadAllBytes($CredsFile)
    $text = [System.Text.Encoding]::UTF8.GetString($cur)
    # strip BOM if present so the Python-free JS parse below sees clean YAML
    $textNoBom = if ($text.StartsWith([char]0xFEFF)) { $text.Substring(1) } else { $text }
    $tmpJs = Join-Path $env:TEMP ("cred-remove-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
    $scriptBody = @"
const fs = require('fs');
const { createRequire } = require('module');
const require2 = createRequire(process.cwd() + '/');
let yaml = null;
const candidates = [
  process.env.APPDATA ? process.env.APPDATA.replace(/\\/g,'/') + '/npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml' : null,
  process.env.APPDATA ? process.env.APPDATA.replace(/\\/g,'/') + '/npm/node_modules/js-yaml' : null,
  process.env.NODE_PATH ? (process.env.NODE_PATH + '/js-yaml') : null,
  'js-yaml'
];
for (const c of candidates) {
  if (!c) continue;
  try { yaml = require2(c); if (yaml && typeof yaml.load === 'function') break; } catch (e) {}
}
if (!yaml || typeof yaml.load !== 'function') { console.error('JSYAML-UNAVAILABLE'); process.exit(2); }
if (!process.env.CRED_FILE || !process.env.OUT_FILE) { console.error('ENV-MISSING'); process.exit(3); }
const src = fs.readFileSync(process.env.CRED_FILE, 'utf8').replace(/^\uFEFF/, '');
const doc = yaml.load(src);
if (!doc || typeof doc !== 'object') { console.error('NOT-YAML'); process.exit(4); }
if (!('version' in doc)) { console.error('NO-VERSION'); process.exit(5); }
delete doc['$Ref'];
if (!doc.refs) doc.refs = {};
delete doc.refs['$Ref'];
const out = yaml.dump(doc, { lineWidth: -1, noRefs: true }).replace(/\n$/, '') + '\n';
fs.writeFileSync(process.env.OUT_FILE, out, 'utf8');
console.log('OK');
"@
    [System.IO.File]::WriteAllText($tmpJs, $scriptBody, (New-Object System.Text.UTF8Encoding($false)))
    $outFile = Join-Path $env:TEMP ("cred-removed-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.yaml')
    # SH-R4: the node helper reads/writes paths via ENVIRONMENT variables so no
    # quoting can ever mangle them (a cmd /c quoting bug previously made node
    # parse its own script as YAML). $ErrorActionPreference is temporarily set
    # to Continue so PowerShell 5.1 does not upgrade a native stderr write into a
    # terminating NativeCommandError (that previously killed the worker).
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exit = -1
    try {
        $env:CRED_FILE = $CredsFile
        $env:OUT_FILE = $outFile
        $nodeOut = & node $tmpJs 2>&1 | Out-String
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host "cred-remove node exit=$exit out=$($nodeOut.Trim())" }
    } catch {
        Write-Host "cred-remove wrapper threw: $($_.Exception.Message)"
        $exit = 1
    } finally {
        Remove-Item Env:CRED_FILE -ErrorAction SilentlyContinue
        Remove-Item Env:OUT_FILE -ErrorAction SilentlyContinue
        $ErrorActionPreference = $savedEAP
    }
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
    if ($exit -ne 0 -or -not (Test-Path $outFile)) {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        return $false
    }
    # replace the live file with the YAML-safe rewrite (no BOM, version+refs kept)
    [System.IO.File]::Copy($outFile, $CredsFile, $true)
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    # self-check: the rewritten file must still parse as version+refs and must
    # no longer contain the removed ref (any other shape would crash DSH boot)
    $check = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($CredsFile))
    $hasVersion = ($check -match '(?m)^version: 1')
    $hasRefs = ($check -match '(?m)^refs:')
    $stillHasRef = ($check -match ('(?m)^[ \t]*' + [regex]::Escape($Ref) + '[ \t]*:'))
    $ok = ($hasVersion -and $hasRefs -and (-not $stillHasRef))
    return $ok
}

# ---- main guarded body: credential mutation inside try/finally ---------------
try {
    # ---- Phase A: NEGATIVE cold boot ----------------------------------------
    Write-Host ''
    Write-Host '=== Phase A: NEGATIVE cold boot (NOTION_TOKEN removed) ==='
    $removed = Remove-CredentialRef 'NOTION_TOKEN'
    Check 'A1 credential ref removed for negative boot' $removed ''

    if ($NoRestart) {
        Check 'A2 (dry-run) restart skipped, host not touched' $true ''
        Check 'A3 (dry-run) skip probe' $true ''
    } else {
        & $RestartScript -RestartAndWait -DelaySeconds 2 -Port $Port -TimeoutSec 240 -Reason 'sh-r4-negative-boot' | Out-Null
        # Poll for readiness (a cold boot of npx-hosted MCP servers is slow; the
        # guardian may also be re-raising the host if the restart attempt itself
        # hit a process_none/starter-exit-2 race). The negative contract requires
        # the host to EVENTUALLY answer 200; the attempt ledger is NOT the
        # authority for this gate, live HTTP is.
        $httpReady = Wait-HttpReady -MaxSeconds 150
        Check 'A2 host HTTP 200 after negative cold boot' $httpReady ("http=" + $(if ($httpReady) { 200 } else { -1 }))

        $probe = Get-NotionMcpLoaded
        # STRICT negative contract: the probe must have succeeded AND the notion
        # tools must be absent. A failed probe is a FAIL, not a PASS.
        Check 'A3 probe succeeded (probe_ok=true)' ($probe.probe_ok -eq $true) ("probe_ok=" + $probe.probe_ok + " error=" + $probe.error)
        Check 'A4 mcp-notion NOT loaded (notion_loaded=false)' ($probe.probe_ok -eq $true -and $probe.notion_loaded -eq $false) ("notion_loaded=" + $probe.notion_loaded + " tool_count=" + $probe.tool_count)

        $chainOk = $false
        if (Test-Path $IntentsFile) {
            try {
                $j = Get-Content -LiteralPath $IntentsFile -Raw | ConvertFrom-Json
                $bad = @($j.intents.PSObject.Properties | Where-Object { $_.Value.state -eq 'FAILED_FATAL' })
                $chainOk = ($bad.Count -eq 0)
            } catch { $chainOk = $false }
        }
        Check 'A5 recovery chain unaffected (no FAILED_FATAL intents)' $chainOk ''

        $preLog = Get-Content -LiteralPath $PreflightLog -Tail 6 -ErrorAction SilentlyContinue | Out-String
        Check 'A6 preflight audit log records SAFE-DEGRADE' ($preLog -match 'SAFE-DEGRADE') ('tail has SAFE-DEGRADE: ' + ($preLog -match 'SAFE-DEGRADE'))
    }
} finally {
    # ---- ALWAYS restore the credentials file byte-for-byte before exiting ----
    Write-OriginalBytes
    Write-Host ''
    Write-Host '=== credentials file restored (byte-for-byte, finally) ==='
    # SH-R5: B1 is a REAL equality gate - compare SHA256 of the file before the
    # mutation vs after the finally-restore (a regex "token line present" check
    # could PASS even if the rest of the file bytes were corrupted). DACL must
    # also be unchanged (we never touch ACLs, but prove it).
    $shaAfter = (Get-FileHash -LiteralPath $CredsFile -Algorithm SHA256).Hash
    $bytesEqual = ($shaAfter -eq $originalSha256)
    Check 'B1 credentials byte-for-byte restored (SHA256 equality)' $bytesEqual ("sha=" + $shaAfter.Substring(0, 12) + "...")
    $daclAfter = (icacls $CredsFile 2>&1 | Out-String)
    $daclOk = ($daclAfter -eq $originalDaclText)
    Check 'B1b credentials DACL unchanged' $daclOk ('dacl-identical=' + $daclOk)
}

# ---- Phase C: NORMAL cold boot (only when live) -----------------------------
if (-not $NoRestart) {
    Write-Host ''
    Write-Host '=== Phase C: NORMAL cold boot (credential present) ==='
    & $RestartScript -RestartAndWait -DelaySeconds 2 -Port $Port -TimeoutSec 240 -Reason 'sh-r4-normal-boot' | Out-Null
    $httpReady2 = Wait-HttpReady -MaxSeconds 40
    $status2 = if ($httpReady2) { 200 } else { -1 }
    Check 'C1 host HTTP 200 after normal cold boot' ($status2 -eq 200) ("http=" + $status2)
    $probe2 = Get-NotionMcpLoaded
    Check 'C2 mcp-notion loaded after restore' ($probe2.probe_ok -eq $true -and $probe2.notion_loaded -eq $true) ("probe_ok=" + $probe2.probe_ok + " notion_loaded=" + $probe2.notion_loaded + " error=" + $probe2.error)
}

$failed = @($checks | Where-Object { -not $_.ok }).Count
Write-Host ''
Write-Host ($checks.Count.ToString() + ' checks, ' + $failed.ToString() + ' failed')
if ($failed -gt 0) { Write-Result 1 }
Write-Result 0