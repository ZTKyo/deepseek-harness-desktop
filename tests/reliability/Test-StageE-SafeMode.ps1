# Test-StageE-SafeMode.ps1 - True Safe Mode isolated tests (no real profile/service touched).
$ErrorActionPreference = 'Continue'
$failCount = 0
function Assert([bool]$Cond, [string]$Name, [string]$Detail = '') {
    if ($Cond) { Write-Host ("PASS  {0}  {1}" -f $Name, $Detail) }
    else { Write-Host ("FAIL  {0}  {1}" -f $Name, $Detail); $script:failCount++ }
}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# isolate profile dir + boot-mode path
$tmp = Join-Path $env:TEMP ("dsh-safe-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'profile') | Out-Null
$env:DSH_SAFE_PROFILE_DIR = Join-Path $tmp 'profile'
$env:DSH_BOOT_MODE_PATH = Join-Path $tmp 'boot-mode.json'

Write-Host '== E1: safe profile build (isolated) =='
. (Join-Path $root 'dsh-safe-profile.ps1')
$p = New-DshSafeProfile
Assert (Test-Path (Join-Path $p.Dir 'cordis.patch.yml')) 'E1 cordis.patch.yml created'
Assert (Test-Path (Join-Path $p.Dir 'cordis.yml')) 'E1 cordis.yml created'
Assert (Test-Path (Join-Path $p.Dir 'package.json')) 'E1 package.json created'

Write-Host '== E2: safe profile composition (KEEP minimal, DISABLE the rest) =='
$patch = Get-Content (Join-Path $p.Dir 'cordis.patch.yml') -Raw
foreach ($keep in @('completion-notify','secret-gate','keepalive-patch','system-prompt')) {
    Assert ($patch -match $keep) "E2 keep: $keep"
}
foreach ($dis in @('computer-use','vision-bridge','ask-telegram','agent-inspector','openrouter-router','commandcode-router','agentrouter-wire','tool-output-offload','mcp-notion')) {
    Assert ($patch -notmatch $dis) "E2 disabled: $dis"
}
Assert ($patch -match 'SAFE MODE') 'E2 safe persona present'

Write-Host '== E3: launcher profile args (unit) =='
$launcherSrc = Get-Content (Join-Path $root 'dsh-launcher.js') -Raw
Assert ($launcherSrc -match "profileArgs = \(bootMode === 'safe'") 'E3 launcher has profile branch'
Assert ($launcherSrc -match "\['--profile', bootMode\]") 'E3 launcher passes --profile'

Write-Host '== E4: safe-mode.ps1 Status (isolated) =='
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'dsh-safe-mode.ps1') -Status 2>&1 | Out-String
Assert ($out -match 'bootMode') 'E4 status outputs bootMode'

Write-Host '== E5: safe-mode.ps1 Enter prepares without touching real profile =='
# NoRestart: prepare only; verify safe flag + boot-mode written to ISOLATED paths
# (explicit params beat env vars across process boundaries)
$env:DSH_BOOT_MODE_PATH = Join-Path $tmp 'boot-mode.json'
$env:DSH_SAFE_FLAG_PATH = Join-Path $tmp 'safe-mode.json'
$e5out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'dsh-safe-mode.ps1') -Enter -NoRestart -Port 3080 -FlagPath (Join-Path $tmp 'safe-mode.json') -BootModePath (Join-Path $tmp 'boot-mode.json') -ProfileDir (Join-Path $tmp 'profile') 2>&1
Write-Host ("E5 enter output: {0}" -f (($e5out | Out-String).Trim()))
$bm = Get-Content (Join-Path $tmp 'boot-mode.json') -Raw | ConvertFrom-Json
Assert ($bm.mode -eq 'safe') 'E5 boot-mode set to safe' "mode=$($bm.mode)"
$sf = Get-Content (Join-Path $tmp 'safe-mode.json') -Raw | ConvertFrom-Json
Assert ($sf.active -eq $true) 'E5 safe flag written (isolated)'
$realFlag = Join-Path $env:LOCALAPPDATA 'DSHHarness\state\safe-mode.json'
Assert (-not (Test-Path $realFlag)) 'E5 real safe-mode.json untouched'

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SAFE_PROFILE_DIR -ErrorAction SilentlyContinue
Remove-Item Env:DSH_BOOT_MODE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SAFE_FLAG_PATH -ErrorAction SilentlyContinue

Write-Host ''
if ($failCount -eq 0) { Write-Host 'RESULT: PASS (Stage E Safe Mode isolated)'; exit 0 }
else { Write-Host "RESULT: FAIL ($failCount failed)"; exit 1 }
