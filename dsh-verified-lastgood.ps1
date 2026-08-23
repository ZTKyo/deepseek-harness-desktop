# dsh-verified-lastgood.ps1 - Health-Verified Last Good for DSH Harness
# Concept: LastGood means "config+profile+plugins that actually passed full health", not just "YAML valid"
# Saves: settings.yaml + cordis.patch.yml + cordis.yml snapshot after health PASS
# Used by: guardian (on stable window), update transaction, plugin transaction

function Get-VerifiedLastGoodDir {
    return Join-Path $env:LOCALAPPDATA 'DSHHarness\verified-lastgood'
}
function Get-GuardianLastGoodDir {
    return Join-Path $env:LOCALAPPDATA 'DSHHarness\guardian-lastgood'
}

function Test-FullReadiness {
    param([int]$Port = 3080)
    $ps = Join-Path $PSScriptRoot 'dsh-readiness.ps1'
    if(Test-Path $ps){ . $ps }
    try {
        # layered checks: identity -> API -> optional WS
        $r = Test-DshReadiness -Port $Port
        return ($r.State -in @('api_ready','client_ready'))
    } catch { return $false }
}
function Save-VerifiedLastGood {
    param([int]$Port = 3080, [string]$Reason = 'health-pass')
    if(-not (Test-FullReadiness -Port $Port)){ return @{ Saved=$false; Reason='health_not_ready' } }
    $src = @(
        @{ Path="$env:USERPROFILE\.dsh\settings.yaml"; Name='settings.yaml' },
        @{ Path="$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"; Name='cordis.patch.yml' },
        @{ Path="$env:USERPROFILE\.dsh\profiles\web\cordis.yml"; Name='cordis.yml' }
    )
    $dst = Get-VerifiedLastGoodDir
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $meta = @{ timestamp=(Get-Date -Format 'o'); reason=$Reason; port=$Port; dshVersion=((& dsh --version 2>$null) -join '').Trim() }
    foreach($f in $src){ if(Test-Path $f.Path){ Copy-Item $f.Path (Join-Path $dst $f.Name) -Force } }
    ($meta | ConvertTo-Json -Compress) | Out-File (Join-Path $dst 'meta.json') -Encoding utf8
    # also sync to guardian-lastgood (so guardian boot recovery uses same verified snapshot)
    $gDir = Get-GuardianLastGoodDir; New-Item -ItemType Directory -Force -Path $gDir | Out-Null
    foreach($f in $src){ $s=Join-Path $dst $f.Name; if(Test-Path $s){ Copy-Item $s (Join-Path $gDir $f.Name) -Force } }
    return @{ Saved=$true; Reason=$Reason; Dir=$dst }
}
function Restore-VerifiedLastGood {
    $src = Get-VerifiedLastGoodDir
    $restored = @()
    foreach($f in @('settings.yaml','cordis.patch.yml','cordis.yml')){
        $s = Join-Path $src $f
        if(-not (Test-Path $s)){ continue }
        $dst = switch($f){
            'settings.yaml' { "$env:USERPROFILE\.dsh\settings.yaml" }
            'cordis.patch.yml' { "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" }
            'cordis.yml' { "$env:USERPROFILE\.dsh\profiles\web\cordis.yml" }
        }
        Copy-Item $s $dst -Force
        $restored += $f
    }
    return @{ Restored=$restored; Count=$restored.Count }
}
function Get-VerifiedLastGoodMeta {
    $p = Join-Path (Get-VerifiedLastGoodDir) 'meta.json'
    if(-not (Test-Path $p)){ return $null }
    try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}
