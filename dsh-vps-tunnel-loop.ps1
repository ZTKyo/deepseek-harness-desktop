# dsh-vps-tunnel-loop.ps1 - resident reverse-SSH tunnel: exposes local DSH :LocalPort
# via your own VPS. Fill in YOUR server details below (this release ships with none).
# This is the same pattern as the personal build, minus any hardcoded user data.
$VpsHost   = 'user@your-vps-ip'   # <- your VPS SSH login string
$SshPort   = 52222                 # <- SSH port
$RemotePort= 38443                 # <- remote listening port on the VPS
$LocalPort = 3080                  # <- local DSH port
$SshKey    = Join-Path $PSScriptRoot 'vps-key'          # <- your private key file, put it next to this script
$log       = Join-Path (Split-Path -Parent $PSScriptRoot) 'vps-tunnel.log'

while ($true) {
    try {
        $alive = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match ($RemotePort.ToString() + ':127\.0\.0\.1:' + $LocalPort) })
        if ($alive.Count -eq 0) {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = 'C:\windows\System32\OpenSSH\ssh.exe'
            $psi.Arguments = '-i "' + $SshKey + '" -p ' + $SshPort + ' -N -R ' + $RemotePort + ':127.0.0.1:' + $LocalPort +
                ' -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes ' + $VpsHost
            $psi.UseShellExecute = $true
            $psi.WindowStyle = 'Hidden'
            [System.Diagnostics.Process]::Start($psi) | Out-Null
            Add-Content -Path $log -Value ("{0}  tunnel re-established" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    } catch {}
    Start-Sleep -Seconds 30
}
