# Freeze watcher v2 (ASCII only, no nested pwsh, no CIM). Exit 0 = all freeze conditions met, 3 = timeout.
param([int]$MaxMinutes = 30)
$repo = 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2'
$base = 'c5aa5beb0541e8b442cedd0d435472c02fabf025'
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$head=''; $dirty=-1; $quiet=-1; $recent=0
while ((Get-Date) -lt $deadline) {
  $head  = (git -C $repo log -1 --format=%H).Trim()
  $dirty = @(git -C $repo status --porcelain | Where-Object { $_ -ne '' }).Count
  $last  = (Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  $quiet = [math]::Round(((Get-Date) - $last.LastWriteTime).TotalMinutes, 1)
  $recent = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-5) }).Count
  if ($head -ne $base -and $dirty -eq 0 -and $quiet -ge 10 -and $recent -eq 0) {
    Write-Output "FREEZE_MET head=$head at=$(Get-Date -Format 'HH:mm:ss') quiet=${quiet}min dirty=0 recent_node=0"
    exit 0
  }
  Start-Sleep -Seconds 60
}
$lastw = ((Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime)
Write-Output "FREEZE_TIMEOUT at=$(Get-Date -Format 'HH:mm:ss') head=$head dirty=$dirty quiet=${quiet}min recent_node=$recent last_write=$($lastw.ToString('HH:mm:ss'))"
exit 3
