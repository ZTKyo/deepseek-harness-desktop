# dsh-safe-profile.ps1 - True Safe Mode isolated profile management (Reliability v1, Stage E)
#
# Safe Mode NEVER modifies the Normal (web) profile. It builds/uses an isolated
# profile at $DSH_HOME/profiles/safe with a minimal plugin composition:
#   KEEP   : system-prompt, agent-presets, completion-notify, secret-gate, keepalive-patch
#   DISABLE: computer-use, vision-bridge, ask-telegram, agent-inspector, mcp-notion,
#            openrouter-router, commandcode-router, agentrouter-wire, tool-output-offload
#
# Principle: LESS, not MORE. Safe Mode only needs enough to diagnose and repair.

$script:SafeProfileDir = if ($env:DSH_SAFE_PROFILE_DIR) {
    $env:DSH_SAFE_PROFILE_DIR
} else {
    Join-Path $env:USERPROFILE '.dsh\profiles\safe'
}

function Get-SafeProfileDir { return $script:SafeProfileDir }

function New-DshSafeProfile {
    <#
    .SYNOPSIS
    Build (idempotent) the isolated Safe profile. Does NOT touch the web profile.
    #>
    $dir = Get-SafeProfileDir
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $webDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'

    # cordis.yml: same empty root as web
    Set-Content -Path (Join-Path $dir 'cordis.yml') -Value '[]' -Encoding UTF8

    # package.json: minimal profile package (mirrors web structure)
    $pkg = @{
        name = 'dsh-profile-safe'
        version = '1.0.0'
        private = $true
        type = 'module'
    }
    ($pkg | ConvertTo-Json -Depth 4) | Set-Content -Path (Join-Path $dir 'package.json') -Encoding UTF8
    Copy-Item (Join-Path $webDir 'pnpm-workspace.yaml') (Join-Path $dir 'pnpm-workspace.yaml') -Force -ErrorAction SilentlyContinue

    # cordis.patch.yml: minimal, safe-only composition
    $patch = @'
# Safe Mode profile - minimal recovery composition (Reliability v1, Stage E).
# KEEP only what is needed to diagnose and repair. NEVER run experimental/UI
# plugins here. This file is generated; manual edits are overwritten on rebuild.
- id: system-prompt
  config:
    persona: >-
      You are running in DSH SAFE MODE - minimal recovery environment.
      Your only job: diagnose and repair the Normal (web) profile so it can boot
      again. Do not install plugins, do not modify Normal configuration unless
      explicitly instructed to restore it.
- id: agent-presets
  config:
    default: autonomous
# completion-notify: keep so recovery completion notifications still reach the user
- insert:
    - id: completion-notify
      name: '../web/completion-notify.mjs'
      config: {}
# secret-gate: keep credential read capability (needed to use the stable provider)
- insert:
    - id: secret-gate
      name: '../web/secret-gate.mjs'
      config: {}
      client: '../web/secret-gate-client'
# keepalive-patch: harmless connection tuning, keep
- insert:
    - id: keepalive-patch
      name: '../web/keepalive-patch.mjs'
      config: {}
'@
    Set-Content -Path (Join-Path $dir 'cordis.patch.yml') -Value $patch -Encoding UTF8

    return @{ Dir = $dir; Rebuilt = $true }
}

function Test-DshSafeProfile {
    $dir = Get-SafeProfileDir
    return @{
        Exists = (Test-Path (Join-Path $dir 'cordis.patch.yml'))
        Dir = $dir
    }
}
