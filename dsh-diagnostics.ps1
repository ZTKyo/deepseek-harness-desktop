# dsh-diagnostics.ps1 - Unified diagnostics bundle for DSH Harness (redacted, bounded)
param([int]$Port=3080, [string]$OutDir = $null)
$ErrorActionPreference='Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if(-not $OutDir){ $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-diag-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Collecting diagnostics to $OutDir"

function Safe-Write([string]$name, $obj){
    try { ($obj | ConvertTo-Json -Depth 4) | Out-File (Join-Path $OutDir "$name.json") -Encoding utf8 } catch { "error: $_" | Out-File (Join-Path $OutDir "$name.txt") -Encoding utf8 }
}
function Redact-Secrets([string]$text){
    if(-not $text){ return $text }
    $text = $text -replace 'ntn_[A-Za-z0-9_-]{16,}','***'
    $text = $text -replace 'sk-[A-Za-z0-9_\-]{16,}','***'
    $text = $text -replace '-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----','***PRIVATE KEY***'
    return $text
}
# system
Safe-Write 'system' @{ os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber); node=(node --version 2>$null); dsh=(dsh --version 2>$null); pnpm=(pnpm --version 2>$null) }
# generation
try { . (Join-Path $root 'dsh-generation.ps1'); Safe-Write 'generation' (Get-DshGenerationInfo -Port $Port) } catch { Safe-Write 'generation' @{ error=$_.Exception.Message } }
# health
try { . (Join-Path $root 'dsh-readiness.ps1'); Safe-Write 'readiness' (Test-DshReadiness -Port $Port) } catch { Safe-Write 'readiness' @{ error=$_.Exception.Message } }
try { . (Join-Path $root 'dsh-readiness.ps1'); Safe-Write 'readiness-ws' (Test-DshReadiness -Port $Port -RequireWebSockets) } catch { Safe-Write 'readiness-ws' @{ error=$_.Exception.Message } }
# settings (redacted)
try { $s=Redact-Secrets (Get-Content "$env:USERPROFILE\.dsh\settings.yaml" -Raw -ErrorAction Stop); $s | Out-File (Join-Path $OutDir 'settings.yaml.redacted') -Encoding utf8 } catch {}
# cordis patch (redacted)
try { $c=Redact-Secrets (Get-Content "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Raw -ErrorAction Stop); $c | Out-File (Join-Path $OutDir 'cordis.patch.yml.redacted') -Encoding utf8 } catch {}
# guardian lastgood meta
try { if(Test-Path "$env:LOCALAPPDATA\DSHHarness\verified-lastgood\meta.json"){ Copy-Item "$env:LOCALAPPDATA\DSHHarness\verified-lastgood\meta.json" (Join-Path $OutDir 'verified-lastgood-meta.json') } } catch {}
# restart budget
try { . (Join-Path $root 'dsh-restart-budget.ps1'); Safe-Write 'restart-budget' (Read-DshRestartBudget) } catch { Safe-Write 'restart-budget' @{ error=$_.Exception.Message } }
# guardian heartbeat
try { if(Test-Path "$env:LOCALAPPDATA\DSHHarness\state\guardian-heartbeat.json"){ Copy-Item "$env:LOCALAPPDATA\DSHHarness\state\guardian-heartbeat.json" (Join-Path $OutDir 'guardian-heartbeat.json') } } catch {}
try { if(Test-Path "$env:LOCALAPPDATA\DSHHarness\logs\guardian.log"){ Get-Content "$env:LOCALAPPDATA\DSHHarness\logs\guardian.log" -Tail 100 | Out-File (Join-Path $OutDir 'guardian.log.tail') -Encoding utf8 } } catch {}
# sessions count
try { $sess=Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Directory -ErrorAction Stop; Safe-Write 'sessions' @{ count=$sess.Count; names=@($sess | Select-Object -First 10 Name) } } catch { Safe-Write 'sessions' @{ error=$_.Exception.Message } }
# evolution state
try { if(Test-Path "$env:LOCALAPPDATA\DSHHarness\state\evolution-state.json"){ Copy-Item "$env:LOCALAPPDATA\DSHHarness\state\evolution-state.json" (Join-Path $OutDir 'evolution-state.json') } } catch {}
# port owner
try { . (Join-Path $root 'dsh-process-identity.ps1'); Safe-Write 'port-owner' (Get-DshLoopbackOwner -Port $Port) } catch { Safe-Write 'port-owner' @{ error=$_.Exception.Message } }

Write-Host "Diagnostics collected: $OutDir"
Get-ChildItem $OutDir | Select-Object Name,Length | Format-Table -AutoSize
# also check for secret leak in bundle
$leak = Select-String -Path (Join-Path $OutDir '*') -Pattern 'ntn_[A-Za-z0-9_-]{16,}|sk-or-[A-Za-z0-9_-]{16,}' -ErrorAction SilentlyContinue
if($leak){ Write-Host "WARNING: potential secret pattern found in diagnostics bundle!" -ForegroundColor Red } else { Write-Host "Secret redaction: PASS (no secret patterns)" -ForegroundColor Green }
Write-Host "Bundle: $OutDir"
