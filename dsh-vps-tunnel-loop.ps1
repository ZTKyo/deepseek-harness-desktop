# dsh-vps-tunnel-loop.ps1 - resident reverse-SSH tunnel: exposes local DSH :3080
# via VPS Caddy (VPS 18443 -> sshd 28443 -> local 3080). Auto-reconnects.
$key = 'C:\Users\Administrator\.ssh\google_vps_new'
$log = 'C:\Users\Administrator\Desktop\sdeepseek harness\DSH-Client\vps-tunnel.log'
while ($true) {
    try {
        $alive = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match '38443:127\.0\.0\.1:8843' })
        if ($alive.Count -eq 0) {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = 'C:\windows\System32\OpenSSH\ssh.exe'
            $psi.Arguments = '-i "' + $key + '" -p 52222 -N -R 38443:127.0.0.1:8843 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes google-vps@35.212.143.121'
            $psi.UseShellExecute = $true
            $psi.WindowStyle = 'Hidden'
            [System.Diagnostics.Process]::Start($psi) | Out-Null
            Add-Content -Path $log -Value ("{0}  tunnel re-established" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    } catch {}
    Start-Sleep -Seconds 30
}