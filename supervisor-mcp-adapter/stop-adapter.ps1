<#
  stop-adapter.ps1 — supervisor-mcp-adapter 一键 kill-switch
  ==========================================================
  用途：独立关闭 8091 上的 MCP adapter 进程（不触碰 3080 dsh web / 8090 supervisor）。
  用法：powershell -ExecutionPolicy Bypass -File stop-adapter.ps1 [-Port 8091] [-Force]
  幂等：8091 无监听时输出 "no adapter listening" 并正常退出（exit 0）。
  安全：只按 8091 端口定位 OwningProcess；绝不按名称杀 node（避免误伤 3080 服务）。
#>
param(
  [int]$Port = 8091,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Write-Host "adapter: no listener on 127.0.0.1:$Port (already stopped)" -ForegroundColor Green
  exit 0
}
$pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid0 in $pids) {
  if ($pid0 -eq $PID) { Write-Warning "skip self pid $pid0"; continue }
  $proc = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  Write-Host "adapter: stopping pid $pid0 ($($proc.ProcessName)) on port $Port ..."
  if ($Force) { Stop-Process -Id $pid0 -Force } else { Stop-Process -Id $pid0 }
  $proc.WaitForExit(5000) | Out-Null
}
Start-Sleep -Milliseconds 300
$left = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($left) { Write-Warning "adapter: port $Port still listening after stop" } else { Write-Host "adapter: stopped, port $Port released" -ForegroundColor Green }
