# P4 LEARN R3 — 最终 HEAD 全量回归（AC7 21 套 + R3 红队/加固 8 套）
# 只跑纯 node 套件；不启动/停止/重启 dsh 服务，不占用 3080 端口。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$wt = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $wt

$ac7 = @(
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

$r3 = @(
  'tests\learn\test-learn-r3-hardening.mjs',
  'tests\learn\redteam-r3-isolation.mjs',
  'tests\learn\redteam-r3-contamination.mjs',
  'tests\learn\redteam-r3-metrics.mjs',
  'tests\learn\redteam-r3-quality.mjs',
  'tests\learn\redteam-r3-injection-positions.mjs',
  'tests\learn\redteam-r3-probe.mjs'
)

$results = @()
foreach ($s in ($ac7 + $r3)) {
  $tag = if ($ac7 -contains $s) { 'AC7' } else { 'R3 ' }
  if (-not (Test-Path $s)) { $results += [pscustomobject]@{ Tag=$tag; Suite=$s; Exit='MISSING'; Fails=0; Pass=0; Note='' }; continue }

  $out = Join-Path $env:TEMP ('p4final-' + [IO.Path]::GetFileNameWithoutExtension($s) + '.txt')
  & node $s *> $out
  $code = $LASTEXITCODE

  $lines = @(Get-Content $out -ErrorAction SilentlyContinue)
  $fails = @($lines | Where-Object { $_ -match '^\s*FAIL' }).Count
  $pass  = @($lines | Where-Object { $_ -match '^\s*PASS' }).Count
  $note  = ($lines | Where-Object { $_ -match 'RESULT:|PASS /|ALL .*PASS|OK$|SUMMARY|E2E:|complete' } | Select-Object -Last 1)
  if (-not $note) { $note = ($lines | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $note = "$note".Trim(); if ($note.Length -gt 80) { $note = $note.Substring(0,80) }

  $results += [pscustomobject]@{ Tag=$tag; Suite=$s; Exit=$code; Fails=$fails; Pass=$pass; Note=$note }
  Write-Host ("[{0}] exit={1,-4} pass={2,-4} fail={3,-4} {4}" -f $tag, $code, $pass, $fails, $s)
}

Write-Host ""
Write-Host "==== P4 LEARN R3 FINAL-HEAD FULL REGRESSION ===="
Write-Host ("HEAD = " + (git rev-parse HEAD))
$green = @($results | Where-Object { $_.Exit -eq 0 }).Count
$red   = @($results | Where-Object { $_.Exit -ne 0 -and $_.Exit -ne 'MISSING' }).Count
$miss  = @($results | Where-Object { $_.Exit -eq 'MISSING' }).Count
$totF  = ($results | Measure-Object -Property Fails -Sum).Sum
$totP  = ($results | Measure-Object -Property Pass -Sum).Sum
Write-Host ("TOTAL={0}  GREEN={1}  RED={2}  MISSING={3}  totalPASS={4}  totalFAIL={5}" -f $results.Count,$green,$red,$miss,$totP,$totF)
if ($red -or $miss) {
  Write-Host ""
  Write-Host "--- non-green detail ---"
  $results | Where-Object { $_.Exit -ne 0 } | ForEach-Object { Write-Host ("  [exit={0}] {1}  {2}" -f $_.Exit, $_.Suite, $_.Note) }
}
Write-Host "==== END ===="
