# Freeze check + revision manifest + full suite on a temp copy (repo stays untouched)
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2'
$manifest = "$env:TEMP\_vfy-frozen-manifest.txt"
$copy = "$env:TEMP\_vfy-frozen-final"
$now = Get-Date

function Get-Manifest($root) {
  Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\.git\*' -and $_.FullName -notlike '*_f1-checkpoint*' -and $_.FullName -notlike '*_p4r2-evidence*' } |
    ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.FullName.Replace($root, '') } |
    Sort-Object
}

Write-Output "=== FREEZE CHECK @ $($now.ToString('HH:mm:ss')) ==="
$last = Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$quietMin = [math]::Round(($now - $last.LastWriteTime).TotalMinutes, 1)
Write-Output ("latest write: {0} {1}  -> quiet {2} min" -f $last.LastWriteTime.ToString('HH:mm:ss'), $last.FullName.Replace($repo,''), $quietMin)
$testProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*_p4r2*" })
Write-Output ("_p4r2 node processes: {0}" -f $testProcs.Count)
if ($quietMin -ge 10) { Write-Output "FROZEN CONFIRMED" } else { Write-Output "NOT FROZEN" }

Write-Output "=== REVISION ==="
$head = git -C $repo rev-parse HEAD
Write-Output "HEAD=$head"
git -C $repo status --porcelain | ForEach-Object { "  WT: $_" }
$m1 = Get-Manifest $repo
[System.IO.File]::WriteAllLines($manifest, $m1, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("manifest: {0} files -> {1}" -f $m1.Count, $manifest)

Write-Output "=== COPY TO TEMP ==="
robocopy $repo $copy /MIR /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null
$m2 = Get-Manifest $copy
$diff = @(Compare-Object $m1 $m2)
if ($diff.Count -gt 0) { Write-Output ("MISMATCH: {0}" -f $diff.Count); $diff | Select-Object -First 5 | ForEach-Object { "   $_" } }
else { Write-Output ("copy identical to source ({0} files)" -f $m2.Count) }

Write-Output "=== FULL SUITE (temp copy) @ $(Get-Date -Format HH:mm:ss) ==="
Set-Location $copy
node "$copy\tests\learn\run-learn-all-tests.mjs" 2>&1 | Tee-Object "$env:TEMP\_vfy-suite-out.txt" | Select-Object -Last 45

Write-Output "=== POST-RUN REPO INTEGRITY ==="
$m3 = Get-Manifest $repo
$d3 = @(Compare-Object $m1 $m3)
if ($d3.Count -gt 0) { Write-Output ("REPO CHANGED: {0}" -f $d3.Count); $d3 | Select-Object -First 10 | ForEach-Object { "   $_" } }
else { Write-Output "repo unchanged (0 diffs)" }
