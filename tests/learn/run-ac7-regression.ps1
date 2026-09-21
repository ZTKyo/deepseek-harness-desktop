# P4 LEARN R1 — AC7 regression sweep (pure-node suites only).
# Deliberately EXCLUDES anything that starts/stops/restarts the dsh service or binds port 3080.
# Runs each suite directly (not via Start-Process) so $LASTEXITCODE is reliable.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$wt = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # <root>\tests\learn\ -> <root>
Set-Location $wt

$suites = @(
  'tests\autonomy\test-autonomy-state-core.mjs',
  'tests\context-memory\verify-context-memory.mjs',
  'tests\install-plugin\verify-install-plugin.mjs',
  'tests\reliability\test-capacity-resolver.mjs',
  'tests\reliability\test-completion-truth.mjs',
  'tests\reliability\test-ec-router-bridge.mjs',
  'tests\reliability\test-failure-classifier-v1.mjs',
  'tests\reliability\test-model-registry.mjs',
  'tests\reliability\test-r5-addendum-ec.mjs',
  'tests\reliability\test-resume-defer.mjs',
  'tests\reliability\test-rh2-ec.mjs',
  'tests\reliability\test-rh2-r11-goal-resume.mjs',
  'tests\reliability\test-runtime-capacity-adapter.mjs',
  'tests\reliability\test-secret-scan-fixtures.mjs',
  'tests\reliability\yaml-parse-check.mjs',
  'tests\router\test-deepseek-native-multimodal.mjs',
  'tests\router\test-exact-model-preservation.mjs',
  'tests\supervisor\test-supervisor-mutation-state.mjs',
  'tests\learn\test-learn-core.mjs',
  'tests\learn\test-learn-r3-fixes.mjs',
  'tests\learn\run-learn-real-e2e.mjs'
)

$results = @()
foreach ($s in $suites) {
  if (-not (Test-Path $s)) { $results += [pscustomobject]@{ Suite=$s; Exit='MISSING'; Note=''; Fails=0 }; continue }

  $out = Join-Path $env:TEMP ('p4reg-' + [IO.Path]::GetFileNameWithoutExtension($s) + '.txt')
  & node $s *> $out
  $code = $LASTEXITCODE

  $lines = @(Get-Content $out -ErrorAction SilentlyContinue)
  $fails = @($lines | Where-Object { $_ -match '^\s*FAIL' }).Count
  $note  = ($lines | Where-Object { $_ -match 'RESULT:|PASS /|ALL .*PASS|OK$|SUMMARY|E2E:' } | Select-Object -Last 1)
  if (-not $note) { $note = ($lines | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $note = "$note".Trim()
  if ($note.Length -gt 90) { $note = $note.Substring(0, 90) }

  $results += [pscustomobject]@{ Suite=$s; Exit=$code; Note=$note; Fails=$fails }
  Write-Host ("exit={0,-4} fails={1,-4} {2}" -f $code, $fails, $s)
  if ($note) { Write-Host ("             {0}" -f $note) }
}

Write-Host ""
Write-Host "==== P4 AC7 REGRESSION SUMMARY ===="
$green = @($results | Where-Object { $_.Exit -eq 0 }).Count
$red   = @($results | Where-Object { $_.Exit -ne 0 -and $_.Exit -ne 'MISSING' }).Count
$miss  = @($results | Where-Object { $_.Exit -eq 'MISSING' }).Count
$totFails = ($results | Measure-Object -Property Fails -Sum).Sum
Write-Host ("GREEN={0}  RED={1}  MISSING={2}  TOTAL={3}  totalFAILlines={4}" -f $green,$red,$miss,$results.Count,$totFails)
if ($red -or $miss) {
  Write-Host ""
  Write-Host "--- non-green detail ---"
  $results | Where-Object { $_.Exit -ne 0 } | ForEach-Object {
    Write-Host ("  [exit={0}] {1}" -f $_.Exit, $_.Suite)
    if ($_.Note) { Write-Host ("        " + $_.Note) }
  }
}
