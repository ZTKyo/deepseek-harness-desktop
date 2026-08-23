# Invoke-ContinuationRun.ps1
# Ox-Alpha Continuation Diagnosis — single run driver.
#
# Usage:
#   powershell -File Invoke-ContinuationRun.ps1 -RouteProvider <routeId> -Model <modelId> -Workspace <dir> -TaskPrompt <text> [-TaskTag <tag>]
#
# Creates a fresh Harness session in the given workspace, sends the task,
# polls until turn/end or budget expiry (NO manual "continue" is injected),
# then reports structured metrics. Leaves cleanup of route/primary to caller.
#
# Machine-first only: no GUI/screenshot/Vision.

param(
    [int]$Port = 3080,
    [string]$RouteProvider,
    [string]$Model,
    [string]$Workspace,
    [string]$TaskPrompt,
    [string]$TaskTag = 'run',
    [int]$PollBudgetSec = 300
)

$ErrorActionPreference = 'Continue'

function Invoke-Rpc([string]$Method, $Payload, [int]$TimeoutSec = 15) {
    $body = @{ type = 'client-request'; rpcId = ('cr-' + [guid]::NewGuid().ToString('N')); method = $Method; payload = $Payload } | ConvertTo-Json -Compress -Depth 20
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/$Method" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
        return $resp.result
    } catch { return @{ ok = $false; error = @{ message = $_.Exception.Message } } }
}

$report = [ordered]@{ tag = $TaskTag; routeProvider = $RouteProvider; model = $Model; startedAt = (Get-Date -Format o) }

# snapshot primary before (restore is caller's job, but we record)
$primSnap = Invoke-Rpc 'settings.describe' @{ ns = 'agent-default-model' }
$primBefore = ($primSnap.value.namespaces | Where-Object { $_.ns -eq 'agent-default-model' }).value
$report.primaryBefore = "$($primBefore.provider)/$($primBefore.model)"

# point default model at the test route (restored by caller in finally)
$pm = Invoke-Rpc 'settings.mutate' @{ ns = 'agent-default-model'; ops = @(@{ op = 'set'; path = @('provider'); value = $RouteProvider }, @{ op = 'set'; path = @('model'); value = $Model }) }
$report.primaryPointed = $pm.ok
Start-Sleep -Milliseconds 1500

# create fresh session in isolated workspace
$sc = Invoke-Rpc 'session.create' @{ cwd = $Workspace }
$sessionId = $sc.value.sessionId
$report.sessionId = $sessionId
$report.sessionCreated = ($null -ne $sessionId)

$turnEnd = $null
$toolCalls = 0
$steps = 0
$userMsgs = 0
$headers = @()

if ($sessionId) {
    # prompt the task
    $prompt = @{ sessionId = $sessionId; mode = 'queue'; content = @(@{ type = 'text'; text = $TaskPrompt }) }
    $pr = Invoke-Rpc 'session.prompt' $prompt 20
    $report.promptAccepted = $pr.ok

    # poll for turn/end (bounded). NO manual continue is ever sent.
    $deadline = (Get-Date).AddSeconds($PollBudgetSec)
    while ((Get-Date) -lt $deadline -and $null -eq $turnEnd) {
        Start-Sleep -Seconds 3
        $hist = Invoke-Rpc 'session.history' @{ sessionId = $sessionId } 10
        if ($hist.ok -and $hist.value) {
            foreach ($e in @($hist.value.events)) {
                if ($e.event.type -eq 'turn/end') { $turnEnd = $e.event.data }
                if ($e.event.type -eq 'tool/call') { $toolCalls++ }
                if ($e.event.type -eq 'step/start') { $steps++ }
                if ($e.event.type -eq 'user/message') { $userMsgs++ }
                if ($e.event.type -eq 'request/header') {
                    $h = $e.event.data.header
                    $headers += "$($h.config.provider)/$($h.config.model)"
                }
            }
        }
    }
    $report.turnEnd = if ($turnEnd) { ($turnEnd.reason.kind) } else { 'TIMEOUT' }
    $report.turnEndReasonDetail = if ($turnEnd) { ($turnEnd | ConvertTo-Json -Depth 4 -Compress) } else { '' }
    $report.wallClockSec = [Math]::Round(((Get-Date) - [datetime]$report.startedAt).TotalSeconds)
    $report.toolCalls = $toolCalls
    $report.steps = $steps
    $report.userMessages = $userMsgs
    $report.headers = ($headers -join ' | ')
    $report.primaryAfter = if ($primBefore) { $null } else { $null }

    # post-turn: fetch final assistant message + todo state
    $hist2 = Invoke-Rpc 'session.history' @{ sessionId = $sessionId } 10
    $lastAsst = ''
    $lastAsstType = ''
    $futureTense = $false
    if ($hist2.ok -and $hist2.value) {
        $asstMsgs = @($hist2.value.events | Where-Object { $_.event.type -eq 'assistant/message' })
        if ($asstMsgs.Count -gt 0) {
            $last = $asstMsgs[-1]
            $lastAsst = ($last.event.data.message.content | Out-String).Trim()
            $lastAsstType = 'text'
            $futureTense = ($lastAsst -match 'I will|Next I|I''ll proceed|I am going|I will proceed|接下来我会|下一步我会|我现在将|我会继续')
        }
    }
    $report.lastAssistantType = $lastAsstType
    $report.futureTensePattern = $futureTense
    $report.lastAssistantSnippet = $lastAsst.Substring(0, [Math]::Min(300, $lastAsst.Length))
}

$report | ConvertTo-Json -Depth 6
