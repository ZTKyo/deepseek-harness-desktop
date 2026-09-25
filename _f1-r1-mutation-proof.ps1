# _f1-r1-mutation-proof.ps1 -- reproducible mutation proof for the F1 R1 trust anchor.
# M1: force the host-fact re-verification to always pass (=> ledger is authority again).
# M2: drop the content-binding requirement inside hostApprovalRecord.
# Both mutations are applied to plugins/learn-core.mjs, the suite is run, then the file is
# restored from a byte copy and the SHA256 is compared with the pre-mutation value.
# ASCII only on purpose (Windows PowerShell encoding safety). No production state is touched.

$root = 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2'
$plugin = Join-Path $root 'plugins\learn-core.mjs'
$suite = Join-Path $root 'tests\learn\test-learn-r3-approval-forgery.mjs'
$evidence = Join-Path $root '_f1-r1-forgery-mutation-evidence.txt'
$log = New-Object System.Collections.Generic.List[string]

$h0 = (Get-FileHash $plugin -Algorithm SHA256).Hash
$log.Add('F1 R1 section-6 forgery gate -- gate + mutation evidence')
$log.Add('date                      = ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$log.Add('plugin                    = plugins/learn-core.mjs')
$log.Add('pristine sha256           = ' + $h0)
$log.Add('suite                     = tests/learn/test-learn-r3-approval-forgery.mjs')
$log.Add('')

function Invoke-Mutation {
  param([string]$Tag, [string]$Old, [string]$New, [string]$Label)
  $bak = Join-Path $env:TEMP ('f1-proof-' + $Tag + '-pristine.mjs')
  Copy-Item $plugin $bak -Force
  try {
    $t = [IO.File]::ReadAllText($plugin)
    if (-not $t.Contains($Old)) { throw ('anchor not found for ' + $Tag) }
    [IO.File]::WriteAllText($plugin, $t.Replace($Old, $New), (New-Object System.Text.UTF8Encoding($false)))
    $hm = (Get-FileHash $plugin -Algorithm SHA256).Hash
    $log.Add('=== ' + $Tag + ' mutation: ' + $Label)
    $log.Add('mutation sha256           = ' + $hm)
    $raw = & node $suite 2>&1
    $code = $LASTEXITCODE
    $log.Add('suite exit code           = ' + $code + '  (1 = expected RED)')
    foreach ($line in $raw) {
      if ($line -match '^\s+FAIL' -or $line -match '^RESULT') { $log.Add('  ' + $line.Trim()) }
    }
  } finally {
    Copy-Item $bak $plugin -Force
    $hr = (Get-FileHash $plugin -Algorithm SHA256).Hash
    $log.Add('restored sha256           = ' + $hr)
    $log.Add('byte-identical to pristine= ' + ($hr -eq $h0))
    $log.Add('')
    Remove-Item $bak -Force -ErrorAction SilentlyContinue
  }
}

Invoke-Mutation -Tag 'M1' -Label 'host-fact re-verification forced to ok (trust anchor removed)' `
  -Old "  const verify = handle && typeof handle.verifyHostFact === 'function' ? handle.verifyHostFact : null;" `
  -New "  const verify = () => ({ ok: true, reason: 'ok' }); // M1"

Invoke-Mutation -Tag 'M2' -Label 'content-binding requirement removed in hostApprovalRecord' `
  -Old "  if (!digest) return { ok: false, reason: 'approval_reason_not_content_bound' };" `
  -New "  if (!digest) return { ok: true, reason: 'ok', ref: approvalRef, digest: 'a'.repeat(64) }; // M2"

$log.Add('=== pristine gate run (no mutation) ===')
$raw = & node $suite 2>&1
$log.Add('suite exit code           = ' + $LASTEXITCODE + '  (0 = expected GREEN)')
foreach ($line in $raw) { if ($line -match '^RESULT') { $log.Add('  ' + $line.Trim()) } }
$log.Add('final sha256              = ' + (Get-FileHash $plugin -Algorithm SHA256).Hash)

[System.IO.File]::WriteAllLines($evidence, $log, (New-Object System.Text.UTF8Encoding($false)))
$log | ForEach-Object { Write-Host $_ }
