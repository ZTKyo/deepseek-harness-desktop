# _f2-mutation-proof.ps1 —— F2 回归门的**变异敏感度**证明
#
# 目的：证明 test-learn-r2-f2-store-min.mjs 不是"恒绿"的空断言。
# 做法：把真实源码**改回缺陷态**（变异 M1 / M2），跑套件，必须 RED；
#       随后逐字节恢复（SHA256 比对），再跑一次必须 GREEN。
#
# M1 = 把 config 载入层改回**修复前那行**（下限 1 ⇒ 63 被静默接受）——真实回归场景。
# M2 = 把 learn-core 的最小受支持值改回 1（纯函数层被放宽）——证明 A 组也在起作用。
#
# 红线：只改 plugins 下这两个文件；变异前后都记 SHA256；finally 里**必须**恢复。
#       绝不触碰 stateDir / ~/.dsh / 会话数据。
#
# 实现注意：本脚本刻意**不使用**「双引号串里嵌 $( ... '...' ... )」这类嵌套引号构造
#   （PowerShell 5.1 解析器会误判字符串终止符，报出与真实位置不符的行号）。
#   所有需要嵌入代码文本的载荷一律用**单引号 here-string**，插值一律用字符串拼接。

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$u8 = New-Object System.Text.UTF8Encoding($false)

$pLearn = Join-Path $repo 'plugins\learn.mjs'
$pCore = Join-Path $repo 'plugins\learn-core.mjs'
$pSuite = Join-Path $repo 'tests\learn\test-learn-r2-f2-store-min.mjs'

# ── 变异载荷（单引号 here-string：内部单引号是字面量，无需转义）──────────────
$m1Needle = @'
  cfg.sessionStoreMaxFiles = readSessionStoreMaxFiles();
'@
$m1Patch = @'
  cfg.sessionStoreMaxFiles = envPosInt('LEARN_SESSION_STORE_MAX_FILES', cfg.sessionStoreMaxFiles, 1); // <<< M1 MUTATION
'@
$m2Needle = @'
export const MIN_SESSION_STORE_MAX_FILES = 64;
'@
$m2Patch = @'
export const MIN_SESSION_STORE_MAX_FILES = 1; // <<< M2 MUTATION
'@

$original = @{}
$original[$pLearn] = [System.IO.File]::ReadAllText($pLearn, $u8)
$original[$pCore] = [System.IO.File]::ReadAllText($pCore, $u8)
$original[$pSuite] = [System.IO.File]::ReadAllText($pSuite, $u8)
$paths = @($pLearn, $pCore, $pSuite)
$hashBefore = @{}
foreach ($p in $paths) { $hashBefore[$p] = (Get-FileHash $p -Algorithm SHA256).Hash }

function Restore-All {
  foreach ($p in $paths) { [System.IO.File]::WriteAllText($p, $original[$p], $u8) }
}

function Test-Restored {
  $bad = @()
  foreach ($p in $paths) {
    $h = (Get-FileHash $p -Algorithm SHA256).Hash
    if ($h -ne $hashBefore[$p]) { $bad += $p }
  }
  if ($bad.Count -gt 0) { throw ('恢复失败（逐字节不符）：' + ($bad -join ' ; ')) }
  Write-Host '  [恢复校验] 三个文件 SHA256 与变异前逐字节一致 OK' -ForegroundColor Green
  foreach ($p in $paths) { Write-Host ('    ' + (Split-Path $p -Leaf) + ' = ' + $hashBefore[$p]) }
}

function Invoke-Suite {
  $text = & node $pSuite 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ms = [regex]::Matches($text, 'RESULT:\s*(\d+)\s*PASS\s*/\s*(\d+)\s*FAIL')
  $np = -1
  $nf = -1
  if ($ms.Count -gt 0) {
    $last = $ms[$ms.Count - 1]
    $np = [int]$last.Groups[1].Value
    $nf = [int]$last.Groups[2].Value
  }
  $names = @()
  foreach ($m in [regex]::Matches($text, '(?m)^\s*FAIL\s+(.+?)\s+')) { $names += $m.Groups[1].Value.Trim() }
  $o = New-Object psobject
  $o | Add-Member NoteProperty Text $text
  $o | Add-Member NoteProperty Code $code
  $o | Add-Member NoteProperty Pass $np
  $o | Add-Member NoteProperty Fail $nf
  $o | Add-Member NoteProperty FailedNames $names
  return $o
}

function Show-Run($r, $label) {
  Write-Host ('  [' + $label + '] exit=' + $r.Code + '  ' + $r.Pass + ' PASS / ' + $r.Fail + ' FAIL')
  foreach ($n in $r.FailedNames) { Write-Host ('    RED -> ' + $n) -ForegroundColor Yellow }
}

$results = @()
$row = New-Object psobject

Write-Host ('=' * 78)
Write-Host 'F2 变异敏感度证明（真实源码变异 → 套件必须 RED → 恢复后必须 GREEN）'
Write-Host ('=' * 78)

Write-Host ''
Write-Host '-- 基线（未变异）--'
$base = Invoke-Suite
Show-Run $base 'BASELINE'
if (-not ($base.Code -eq 0 -and $base.Fail -eq 0)) {
  Restore-All
  throw '基线不是全绿，先修套件再谈变异'
}
$r0 = New-Object psobject
$r0 | Add-Member NoteProperty Case 'BASELINE(未变异)'
$r0 | Add-Member NoteProperty Expect 'GREEN'
$r0 | Add-Member NoteProperty Code $base.Code
$r0 | Add-Member NoteProperty Pass $base.Pass
$r0 | Add-Member NoteProperty Fail $base.Fail
$r0 | Add-Member NoteProperty Ok $true
$results += $r0

try {
  Write-Host ''
  Write-Host '-- M1 变异：learn.mjs 的 maxFiles 载入改回修复前的 envPosInt(...,1)（63 重新被静默接受）--'
  $t = [System.IO.File]::ReadAllText($pLearn, $u8)
  if (-not $t.Contains($m1Needle)) { throw 'M1 锚点未找到（learn.mjs 载入行已变，需更新本脚本）' }
  [System.IO.File]::WriteAllText($pLearn, $t.Replace($m1Needle, $m1Patch), $u8)
  $m1 = Invoke-Suite
  Show-Run $m1 'M1'
  $ok1 = ($m1.Code -ne 0 -and $m1.Fail -gt 0)
  if (-not $ok1) { Write-Host '  X M1 未被抓住：套件对该回归不敏感！' -ForegroundColor Red }
  $r1 = New-Object psobject
  $r1 | Add-Member NoteProperty Case 'M1(载入层下限=1, 63 被静默接受)'
  $r1 | Add-Member NoteProperty Expect 'RED'
  $r1 | Add-Member NoteProperty Code $m1.Code
  $r1 | Add-Member NoteProperty Pass $m1.Pass
  $r1 | Add-Member NoteProperty Fail $m1.Fail
  $r1 | Add-Member NoteProperty Ok $ok1
  $results += $r1
  Restore-All

  Write-Host ''
  Write-Host '-- M2 变异：learn-core.mjs 的 MIN_SESSION_STORE_MAX_FILES 改回 1 --'
  $t2 = [System.IO.File]::ReadAllText($pCore, $u8)
  if (-not $t2.Contains($m2Needle)) { throw 'M2 锚点未找到（learn-core 常量行已变，需更新本脚本）' }
  [System.IO.File]::WriteAllText($pCore, $t2.Replace($m2Needle, $m2Patch), $u8)
  $m2 = Invoke-Suite
  Show-Run $m2 'M2'
  $ok2 = ($m2.Code -ne 0 -and $m2.Fail -gt 0)
  if (-not $ok2) { Write-Host '  X M2 未被抓住：套件对该变异不敏感！' -ForegroundColor Red }
  $r2 = New-Object psobject
  $r2 | Add-Member NoteProperty Case 'M2(最小受支持值=1)'
  $r2 | Add-Member NoteProperty Expect 'RED'
  $r2 | Add-Member NoteProperty Code $m2.Code
  $r2 | Add-Member NoteProperty Pass $m2.Pass
  $r2 | Add-Member NoteProperty Fail $m2.Fail
  $r2 | Add-Member NoteProperty Ok $ok2
  $results += $r2

  Write-Host ''
  Write-Host '-- 恢复（逐字节）--'
  Restore-All
  Test-Restored
  $green = Invoke-Suite
  Show-Run $green 'RESTORED'
  $r3 = New-Object psobject
  $r3 | Add-Member NoteProperty Case 'RESTORED(恢复后复跑)'
  $r3 | Add-Member NoteProperty Expect 'GREEN'
  $r3 | Add-Member NoteProperty Code $green.Code
  $r3 | Add-Member NoteProperty Pass $green.Pass
  $r3 | Add-Member NoteProperty Fail $green.Fail
  $r3 | Add-Member NoteProperty Ok ($green.Code -eq 0 -and $green.Fail -eq 0)
  $results += $r3
}
finally {
  Restore-All
  $badf = @()
  foreach ($p in $paths) {
    if ((Get-FileHash $p -Algorithm SHA256).Hash -ne $hashBefore[$p]) { $badf += $p }
  }
  if ($badf.Count -gt 0) {
    Write-Host ('!! finally 恢复失败：' + ($badf -join ' ; ')) -ForegroundColor Red
  } else {
    Write-Host '  [finally] 三文件已确认与变异前逐字节一致 OK' -ForegroundColor Green
  }
}

Write-Host ''
Write-Host ('=' * 78)
$results | Format-Table -AutoSize Case, Expect, Code, Pass, Fail, Ok
$allOk = ($results | Where-Object { -not $_.Ok }).Count -eq 0
if ($allOk) {
  Write-Host '变异敏感度总判定：PASS（每个变异都被抓住，且修复态全绿）'
  Write-Host ('=' * 78)
  exit 0
} else {
  Write-Host '变异敏感度总判定：FAIL'
  Write-Host ('=' * 78)
  exit 1
}
