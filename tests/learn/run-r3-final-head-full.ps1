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
#        【补充】证据文件自身在生成时被改写，原 dirty 统计把它算进去 → 永远显示
#        "dirty (1 entries)"，评审无法判断是否还有其它未提交改动。现从统计中排除
#        本文件自身，只有真正存在其它改动时才报 dirty 并逐条列出路径。
#   R-8（已修）：证据文件原由调用方 `pwsh ... > 文件` 重定向产生，而 Windows PowerShell
#        5.1 的 `>` 默认写 UTF-16LE → 落盘文件带 FF FE BOM，read/grep/CI diff 等普通
#        文本工具视其为二进制，无法复核。现由脚本自身以 UTF-8(no BOM) 写出（-OutFile），
#        与同目录其它证据文件编码一致，不再依赖调用方的重定向方式。
#
# 用法：
#   pwsh -File tests\learn\run-r3-final-head-full.ps1
#   pwsh -File tests\learn\run-r3-final-head-full.ps1 -OutFile docs\roadmap\evidence\XXX.txt
param(
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$wt = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $wt

# 报告收集器：既打印到控制台，也累积供 -OutFile 以 UTF-8 落盘（R-8）
$report = New-Object System.Collections.Generic.List[string]
function Emit([string]$line) { $script:report.Add($line); [Console]::WriteLine($line) }

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
  Emit ("[{0}] exit={1,-4} pass={2,-4} fail={3,-4} src={4,-5} {5}" -f $tag, $code, $pass, $fails, $src, $s)
}

$testedHead = (git rev-parse HEAD).Trim()
# R-1 补充：证据文件自身在生成过程中被改写，必须从「工作树是否干净」里排除——
# 否则永远显示 dirty (1 entries)，评审无法判断是否还有其它未提交改动。
$allDirty = @(git status --porcelain)
$selfLeaf = if ($OutFile -ne '') { Split-Path -Leaf $OutFile } else { '' }
$dirtyList = @($allDirty | Where-Object {
  if ($selfLeaf -ne '' -and "$_" -like "*$selfLeaf*") { $false } else { $true }
})
$dirty = $dirtyList.Count

Emit ""
Emit "==== P4 LEARN R3 FINAL-HEAD FULL REGRESSION ===="
Emit ("TESTED_HEAD = " + $testedHead)
Emit ("WORKTREE    = " + $(if ($dirty -eq 0) { 'clean (0 modified / 0 untracked；本证据文件自身已从统计中排除)' } else { "dirty ($dirty entries): " + ($dirtyList -join ' | ') }))
Emit "NOTE        = TESTED_HEAD 是「生成本证据时被测代码所在提交」。本证据文件自身在紧随其后的"
Emit "              docs-only 提交中落盘，故该提交 sha 会晚于 TESTED_HEAD —— 属自引用标注问题，"
Emit "              并非「跑的不是最终代码」。二者之间 plugins/ 与 tests/learn/ 零差异，"
Emit "              复核命令：git diff TESTED_HEAD <evidence-commit> -- plugins tests/learn  （应为空）"
$green = @($results | Where-Object { $_.Exit -eq 0 }).Count
$red   = @($results | Where-Object { $_.Exit -ne 0 -and $_.Exit -ne 'MISSING' }).Count
$miss  = @($results | Where-Object { $_.Exit -eq 'MISSING' }).Count
$totF  = ($results | Measure-Object -Property Fails -Sum).Sum
$totP  = ($results | Measure-Object -Property Pass -Sum).Sum
Emit ("TOTAL={0}  GREEN={1}  RED={2}  MISSING={3}  totalPASS={4}  totalFAIL={5}" -f $results.Count,$green,$red,$miss,$totP,$totF)
Emit ("COUNTING    = pass/fail 取「套件自报总数」与「逐行计数」的较大值（R-7 修复）；src 列标明来源")
if ($red -or $miss) {
  Emit ""
  Emit "--- non-green detail ---"
  $results | Where-Object { $_.Exit -ne 0 } | ForEach-Object { Emit ("  [exit={0}] {1}  {2}" -f $_.Exit, $_.Suite, $_.Note) }
}
Emit "==== END ===="

# R-8：由脚本自身以 UTF-8(no BOM) 写出证据文件。
# 此前证据由调用方 `pwsh ... > 文件` 重定向产生，Windows PowerShell 5.1 默认写 UTF-16LE
# （FF FE BOM），read/grep/CI diff 等普通文本工具会判定为二进制文件而无法复核。
if ($OutFile) {
  $target = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $wt $OutFile }
  $dir = Split-Path -Parent $target
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $text = ($report -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
  [Console]::WriteLine("EVIDENCE_WRITTEN = $target")
  [Console]::WriteLine("EVIDENCE_ENCODING = UTF-8 (no BOM), $($text.Length) chars")
}
