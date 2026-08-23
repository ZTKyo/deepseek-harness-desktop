# dsh-healthcheck.ps1 - one-shot health check for DSH Harness (unified, redacted).
param([int]$Port=3080)
$ErrorActionPreference='Continue'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$pass=0;$warn=0;$fail=0
function Report([string]$name,[string]$status,[string]$detail){
    $p="$($name.PadRight(26)) $status"; if($detail){$p+="  $detail"}; Write-Host $p
    switch($status){'PASS'{$script:pass++}'WARN'{$script:warn++}default{$script:fail++}}
}
try { . (Join-Path $root 'dsh-generation.ps1') 2>$null } catch {}
$genId = try { Get-DshGenerationId -Port $Port 2>$null } catch { $null }
Write-Host ("== DSH Health Check ({0}) | DSH {1} gen={2} ==" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (& dsh --version 2>$null), $genId)

# dsh CLI
try{$v=& dsh --version 2>$null; if($v){Report 'dsh CLI' 'PASS' "$v"}else{Report 'dsh CLI' 'FAIL' 'no version'}}catch{Report 'dsh CLI' 'FAIL' $_.Exception.Message}
# pnpm
if(Get-Command pnpm -ErrorAction SilentlyContinue){Report 'pnpm' 'PASS' 'ok'}else{Report 'pnpm' 'WARN' 'missing'}
# process identity + readiness (unified)
. (Join-Path $root 'dsh-readiness.ps1') 2>$null
. (Join-Path $root 'dsh-process-identity.ps1') 2>$null
try{
    $owner=Get-DshLoopbackOwner -Port $Port
    if($owner.State -eq 'ok'){Report 'Process Identity' 'PASS' "PID $($owner.Pid)"}else{Report 'Process Identity' 'FAIL' $owner.State}
} catch { Report 'Process Identity' 'FAIL' $_.Exception.Message }
try{
    $r=Test-DshReadiness -Port $Port
    if($r.State -in @('api_ready','client_ready')){Report 'Readiness' 'PASS' $r.State} else { Report 'Readiness' 'FAIL' $r.State }
} catch { Report 'Readiness' 'FAIL' $_.Exception.Message }
try{
    $cr=Test-DshReadiness -Port $Port -RequireWebSockets
    if($cr.State -eq 'client_ready'){Report 'Events (WS)' 'PASS' 'mux+host open'} else { Report 'Events (WS)' 'WARN' $cr.State }
} catch { Report 'Events (WS)' 'WARN' $_.Exception.Message }
# YAML validity
foreach($cf in @("$env:USERPROFILE\.dsh\settings.yaml","$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml")){
    $n=Split-Path $cf -Leaf
    try{
        $y=(Get-Content $cf -Raw); $node=(Get-Command node -ErrorAction SilentlyContinue).Source
        if($node){$tmp=[System.IO.Path]::GetTempFileName(); $y | Out-File $tmp -Encoding utf8; $ok=& $node -e "const y=require('js-yaml'),fs=require('fs');try{y.load(fs.readFileSync(process.argv[1],'utf8'));console.log('OK')}catch(e){console.log('ERR:'+e.message)}" $tmp 2>&1; Remove-Item $tmp -Force -ErrorAction SilentlyContinue; if("$ok" -match 'OK'){Report $n 'PASS' 'YAML valid'}else{Report $n 'FAIL' "$ok"}}else{Report $n 'WARN' 'no node'}
    }catch{Report $n 'FAIL' $_.Exception.Message}
}
# client files
$need=@('DSH Harness PS.cmd','DSH-Harness-PS.ps1','start-dsh-server.ps1')
$miss=@($need|Where-Object{-not (Test-Path (Join-Path $root $_))})
if($miss.Count -eq 0){Report 'Client files' 'PASS' 'ok'}else{Report 'Client files' 'FAIL' "missing $($miss -join ',')"}
# guardian
$guard=Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object{$_.CommandLine -match 'dsh-guardian\.ps1' -and $_.ProcessId -ne $PID}
$lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH Guardian Autostart.lnk'
if($guard -and (Test-Path $lnk)){Report 'Guardian' 'PASS' "PID $($guard.ProcessId -join ',')"}
elseif($guard){Report 'Guardian' 'WARN' 'no autostart'}
elseif(Test-Path $lnk){Report 'Guardian' 'WARN' 'not running'}
else{Report 'Guardian' 'WARN' 'not installed'}
# restart budget
try{
    . (Join-Path $root 'dsh-restart-budget.ps1') 2>$null
    $b=Read-DshRestartBudget 2>$null
    if($b -and $null -ne $b.attempts){Report 'Restart Budget' 'PASS' "attempts=$($b.attempts)"}else{Report 'Restart Budget' 'PASS' 'ok'}
} catch { Report 'Restart Budget' 'WARN' $_.Exception.Message }
# secret hygiene
try{
    $giOk=$false
    foreach($p in @("_release-staging\.gitignore",".gitignore")){
        if(Test-Path $p){
            $c=Get-Content $p -Raw 2>$null
            if($c -match '\*\.key' -and $c -match '\*\.pem'){ $giOk=$true; break }
        }
    }
    if($giOk){Report 'Secret hygiene' 'PASS' '.gitignore ok'}else{Report 'Secret hygiene' 'WARN' 'gitignore missing patterns'}
} catch { Report 'Secret hygiene' 'WARN' 'check failed' }
# disk
try{$d=Get-PSDrive C -ErrorAction Stop; $free=[math]::Round($d.Free/1GB,1); if($free -gt 5){Report 'Disk C:' 'PASS' "${free}GB"}else{Report 'Disk C:' 'WARN' "${free}GB"}}catch{Report 'Disk C:' 'WARN' 'unknown'}

Write-Host ""
Write-Host ("== Result: PASS={0} WARN={1} FAIL={2} ==" -f $pass,$warn,$fail)
if($fail -gt 0){exit 1} elseif($warn -gt 0){exit 2} else {exit 0}
