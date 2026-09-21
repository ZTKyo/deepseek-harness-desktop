# P4 LEARN R3 — 最终 HEAD 全量回归（AC7 22 套 + R3 红队/加固 7 套 = 29 套）
# 只跑纯 node 套件；不启动/停止/重启 dsh 服务，不占用 3080 端口。
#
# 修订记录（PRE-MERGE R-3 独立 Release Gate 评审记录项）：
#   R-7（已修）：原按 '^\s*PASS' 行计数，而汇总型套件（如 redteam-r3-isolation.mjs）
#        只输出一行 "  PASS=13  FAIL=0" → 被计成 pass=1，导致 totalPASS 少算 12。
#        现改为「优先采信套件自报总数，与逐行计数取较大值」，兼容
#        "RESULT: N PASS / M FAIL"、"PASS=N FAIL=M"、"（N 通过，M 失败）" 三种格式。
#   R-1（已修）：原只写 "HEAD = <sha>"，而该 sha 是「生成时 HEAD」，本证据文件本身
#        在紧随其后的 docs-only 提交里落盘 → 文件内 HEAD 看起来"不是最终 HEAD"。
#        现改为显式区分 TESTED_HEAD（被测代码）与证据文件落盘说明，并记录工作树状态。
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
  'tests\learn\test-learn-r3-secrets.mjs',
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
  $joined = ($lines -join "`n")

  # 口径一：逐行计数（适用于每个断言打印一行 PASS/FAIL 的套件）
  $passLines = @($lines | Where-Object { $_ -match '^\s*PASS' }).Count
  $failLines = @($lines | Where-Object { $_ -match '^\s*FAIL' }).Count

  # 口径二：套件自报总数（适用于只打印一行汇总的套件）——兼容四种格式
  $rp = 0; $rf = 0
  $pats = @(
    'RESULT:\s*(\d+)\s*PASS\s*/\s*(\d+)\s*FAIL',
    '(\d+)\s*PASS\s*/\s*(\d+)\s*FAIL',
    'PASS\s*=\s*(\d+)\s+FAIL\s*=\s*(\d+)',
    '（(\d+)\s*通过[，,]\s*(\d+)\s*失败）'
  )
  foreach ($p in $pats) {
    foreach ($m in [regex]::Matches($joined, $p)) {
      $a = [int]$m.Groups[1].Value; $b = [int]$m.Groups[2].Value
      if ($a -gt $rp) { $rp = $a; $rf = $b }
    }
  }

  # 取两者较大值：既不漏算汇总型套件（R-7 原缺陷），也不低估逐行型套件
  $pass  = [Math]::Max($rp, $passLines)
  $fails = [Math]::Max($rf, $failLines)
  $src = if ($rp -gt $passLines) { 'self' } elseif ($rp -gt 0 -and $rp -eq $passLines) { 'both' } else { 'lines' }

  $note  = ($lines | Where-Object { $_ -match 'RESULT:|PASS /|ALL .*PASS|OK$|SUMMARY|E2E:|complete' } | Select-Object -Last 1)
  if (-not $note) { $note = ($lines | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $note = "$note".Trim(); if ($note.Length -gt 80) { $note = $note.Substring(0,80) }

  $results += [pscustomobject]@{ Tag=$tag; Suite=$s; Exit=$code; Fails=$fails; Pass=$pass; Src=$src; Note=$note }
  Write-Host ("[{0}] exit={1,-4} pass={2,-4} fail={3,-4} src={4,-5} {5}" -f $tag, $code, $pass, $fails, $src, $s)
}

$testedHead = (git rev-parse HEAD).Trim()
$dirty = @(git status --porcelain).Count

Write-Host ""
Write-Host "==== P4 LEARN R3 FINAL-HEAD FULL REGRESSION ===="
Write-Host ("TESTED_HEAD = " + $testedHead)
Write-Host ("WORKTREE    = " + $(if ($dirty -eq 0) { 'clean (0 modified / 0 untracked)' } else { "dirty ($dirty entries)" }))
Write-Host "NOTE        = TESTED_HEAD 是「生成本证据时被测代码所在提交」。本证据文件自身在紧随其后的"
Write-Host "              docs-only 提交中落盘，故该提交 sha 会晚于 TESTED_HEAD —— 属自引用标注问题，"
Write-Host "              并非「跑的不是最终代码」。二者之间 plugins/ 与 tests/learn/ 零差异，"
Write-Host "              复核命令：git diff TESTED_HEAD <evidence-commit> -- plugins tests/learn  （应为空）"
$green = @($results | Where-Object { $_.Exit -eq 0 }).Count
$red   = @($results | Where-Object { $_.Exit -ne 0 -and $_.Exit -ne 'MISSING' }).Count
$miss  = @($results | Where-Object { $_.Exit -eq 'MISSING' }).Count
$totF  = ($results | Measure-Object -Property Fails -Sum).Sum
$totP  = ($results | Measure-Object -Property Pass -Sum).Sum
Write-Host ("TOTAL={0}  GREEN={1}  RED={2}  MISSING={3}  totalPASS={4}  totalFAIL={5}" -f $results.Count,$green,$red,$miss,$totP,$totF)
Write-Host ("COUNTING    = pass/fail 取「套件自报总数」与「逐行计数」的较大值（R-7 修复）；src 列标明来源")
if ($red -or $miss) {
  Write-Host ""
  Write-Host "--- non-green detail ---"
  $results | Where-Object { $_.Exit -ne 0 } | ForEach-Object { Write-Host ("  [exit={0}] {1}  {2}" -f $_.Exit, $_.Suite, $_.Note) }
}
Write-Host "==== END ===="
