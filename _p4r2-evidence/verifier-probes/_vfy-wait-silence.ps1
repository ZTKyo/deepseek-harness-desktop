# Wait for true silence: >=10 min no working-tree writes, no _p4r2 node test processes.
$repo = 'C:\Users\Administrator\Desktop\sdeepseek harness\_p4r2'
$deadline = (Get-Date).AddMinutes(9)
$baseHead = (git -C $repo rev-parse HEAD).Trim()
Write-Output "baseHead=$baseHead  start=$(Get-Date -Format HH:mm:ss)  deadline=$($deadline.ToString('HH:mm:ss'))"
while ((Get-Date) -lt $deadline) {
  $last = Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notlike '*\.git\*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $quiet = [math]::Round(((Get-Date) - $last.LastWriteTime).TotalMinutes, 1)
  $head = (git -C $repo rev-parse HEAD).Trim()
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*_p4r2*" }).Count
  $headTag = 'same'
  if ($head -ne $baseHead) { $headTag = "NEW=$head" }
  Write-Output ("check {0}  quiet={1}min  last={2} {3}  head={4}  procs={5}" -f (Get-Date -Format HH:mm:ss), $quiet, $last.LastWriteTime.ToString('HH:mm:ss'), $last.FullName.Replace($repo,''), $headTag, $procs)
  if ($quiet -ge 10 -and $procs -eq 0) { Write-Output "SILENT CONFIRMED @ $(Get-Date -Format HH:mm:ss)"; break }
  Start-Sleep -Seconds 20
}
$head2 = (git -C $repo rev-parse HEAD).Trim()
Write-Output "finalHead=$head2  headChanged=$($head2 -ne $baseHead)"
git -C $repo log -2 --format='%h %ci %s'
