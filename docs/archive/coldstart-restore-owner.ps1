# coldstart-restore-owner.ps1 - Phase 02 Security-Hardening SH-R7.
#
# INDEPENDENT restore owner for the cold-start credential gate.
#
# SH-R7: the restore owner must be provably independent of the DSH host kill
# tree - the controller and worker may both die when the host restarts, so the
# credential restore cannot depend on either of them. This script is spawned by
# the controller via Start-Process BEFORE the fault injection; it holds the
# original credential bytes (backup file) + expected SHA256 + original DACL, and
# polls until the credential file has been MUTATED (SHA differs from expected),
# then restores the original bytes and verifies SHA + DACL are exact again.
#
# It is intentionally a separate process: if the host restart kills the
# controller+worker tree but this process survives (it is NOT inside the DSH
# job/process tree and never attaches to the host), restore still happens.
#
# Results are written to <BackupFile>.restored.txt containing the after-SHA
# for the controller to read.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <this> \
#     -CredsFile <path> -BackupFile <path> -ExpectedSha <sha> -DaclFile <path>

param(
    [string]$CredsFile,
    [string]$BackupFile,
    [string]$ExpectedSha,
    [string]$DaclFile,
    [int]$PollSeconds = 3,
    [int]$MaxSeconds = 300
)

$ErrorActionPreference = 'Continue'

function Get-Sha([string]$Path) {
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } catch { return $null }
}

$deadline = (Get-Date).AddSeconds($MaxSeconds)
$restored = $false
$originalDacl = if (Test-Path $DaclFile) { (Get-Content -LiteralPath $DaclFile -Raw) } else { '' }

while ((Get-Date) -lt $deadline -and -not $restored) {
    $nowSha = Get-Sha $CredsFile
    # wait until the file has been MUTATED (differs from expected = the worker
    # removed NOTION_TOKEN), then restore immediately
    if ($nowSha -and $nowSha -ne $ExpectedSha -and (Test-Path $BackupFile)) {
        $bytes = [System.IO.File]::ReadAllBytes($BackupFile)
        try {
            [System.IO.File]::WriteAllBytes($CredsFile, $bytes)
            Start-Sleep -Milliseconds 500
            $after = Get-Sha $CredsFile
            if ($after -eq $ExpectedSha) {
                $restored = $true
                $daclNow = (icacls $CredsFile 2>&1 | Out-String)
                $daclOk = ($daclNow -eq $originalDacl)
                $result = @{ restored = $true; sha = $after; daclOk = $daclOk; ts = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
                [System.IO.File]::WriteAllText($BackupFile + '.restored.txt', $result, (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "RESTORE-OWNER: restored sha=$($after.Substring(0, 12)) daclOk=$daclOk"
            } else {
                Write-Host "RESTORE-OWNER: write-back mismatch (after=$($after.Substring(0, 12))) - will retry"
            }
        } catch {
            Write-Host "RESTORE-OWNER: restore error: $($_.Exception.Message) - will retry"
        }
    }
    if (-not $restored) { Start-Sleep -Seconds $PollSeconds }
}

if (-not $restored) {
    Write-Host 'RESTORE-OWNER: timeout - credential was never restored (or never mutated)'
    [System.IO.File]::WriteAllText($BackupFile + '.restored.txt', '{"restored":false}', (New-Object System.Text.UTF8Encoding($false)))
    exit 2
}
exit 0
