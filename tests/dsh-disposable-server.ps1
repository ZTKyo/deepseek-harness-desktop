# dsh-disposable-server.ps1 - throwaway loopback HTTP server for RH1 tests.
#
# NOT the real dsh web server. Listens on 127.0.0.1:<Port> and answers based on
# a mode control file (ModeFile):
#   ready   -> HTTP 200
#   unready -> HTTP 503  (proves "alive but not ready" != death)
#   refuse  -> stop the listener and exit (the port becomes unreachable/refused)
# Used ONLY by tests\rh1-tests.ps1. Never touches port 3080.
param(
    [int]$Port = 3091,
    [string]$ModeFile = (Join-Path $env:TEMP ('dsh-disposable-{0}.mode' -f $Port))
)
$ErrorActionPreference = 'Stop'
$listener = New-Object System.Net.HttpListener
try { $listener.Prefixes.Add("http://127.0.0.1:$Port/") } catch {
    Write-Error ("disposable-server: prefix add failed: {0}" -f $_.Exception.Message); exit 9
}
try { $listener.Start() } catch {
    Write-Error ("disposable-server: start failed (port busy?): {0}" -f $_.Exception.Message); exit 9
}
$alive = $true
while ($alive) {
    $ctx = $null
    try { $ctx = $listener.GetContext() } catch { break }
    $mode = 'ready'
    try { if (Test-Path -LiteralPath $ModeFile) { $mode = (Get-Content -LiteralPath $ModeFile -Raw).Trim() } } catch { }
    if ($mode -eq 'refuse') {
        # Stop listening and exit so the port becomes unreachable (connection refused).
        try { $listener.Stop() } catch { }
        $alive = $false
        break
    }
    $status = if ($mode -eq 'unready') { 503 } else { 200 }
    $body = "disposable-$status"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    try {
        $ctx.Response.StatusCode = $status
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.ContentType = 'text/plain'
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.Close()
    } catch { }
}
try { $listener.Close() } catch { }
