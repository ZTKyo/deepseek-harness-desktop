# telegram-alert.ps1 - send a Telegram alert via the existing bot credentials.
#
# Reuses the DSH bot (@mydeepssekharnessbot) already configured for remote
# control: token from ~/.dsh/.credentials.yaml, allowed chat id from
# telegram-bot\allowed-chat.json, proxy from credentials (TELEGRAM_PROXY).
# Non-fatal: failures are silent (exit 1), never block the caller.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\telegram-alert.ps1 "message text"
param(
    [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = 'SilentlyContinue'

$credFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$allowFile = Join-Path $PSScriptRoot 'telegram-bot\allowed-chat.json'

$token = $null; $proxy = $null
if (Test-Path $credFile) {
    foreach ($line in Get-Content $credFile) {
        if ($line -match '^TELEGRAM_BOT_TOKEN\s*:\s*(\S+)') { $token = $Matches[1] }
        elseif ($line -match '^TELEGRAM_PROXY\s*:\s*(\S+)') { $proxy = $Matches[1] }
    }
}
$chatId = $null
if (Test-Path $allowFile) {
    try { $chatId = (Get-Content $allowFile -Raw | ConvertFrom-Json).chatId } catch {}
}
if (-not $token -or -not $chatId) { exit 1 }

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) { exit 1 }

$args = @('-s', '--max-time', '15')
if ($proxy) { $args += @('-x', $proxy) }
$args += @('--data-urlencode', "chat_id=$chatId")
$args += @('--data-urlencode', "text=$Message")
$args += @('https://api.telegram.org/bot' + $token + '/sendMessage')

& $curl.Source @args | Out-Null
exit $LASTEXITCODE
