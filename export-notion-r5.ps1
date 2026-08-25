# export-notion-r5.ps1 - export Notion page 3c5357fd children blocks to markdown
$ErrorActionPreference = 'Stop'
$cred = Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml" -Raw
if ($cred -match '(?m)^\s*NOTION_TOKEN:\s*"?([^"\r\n]+)"?') {
    $token = $Matches[1].Trim()
    $out = "C:\Users\Administrator\Desktop\sdeepseek harness\_research\phase01-tmp\sh-ext-review-r5.md"
    $blocks = @(); $cursor = $null
    do {
        $uri = "https://api.notion.com/v1/blocks/3c5357fd-c5d6-81c2-b477-c7850f984eb7/children?page_size=100"
        if ($cursor) { $uri += "&start_cursor=$cursor" }
        $r2 = Invoke-RestMethod -Uri $uri -Headers @{ "Authorization" = "Bearer $token"; "Notion-Version" = "2022-06-28" } -Method Get -TimeoutSec 30
        $blocks += $r2.results; $cursor = $r2.next_cursor; $hasMore = $r2.has_more
    } while ($hasMore -and $blocks.Count -lt 900)
    $sb = New-Object System.Text.StringBuilder
    $tick = '```'
    foreach ($b in $blocks) {
        $txt = ""
        try {
            switch ($b.type) {
                "heading_2" { $txt = ($b.heading_2.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "heading_3" { $txt = ($b.heading_3.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "callout" { $txt = ($b.callout.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "bulleted_list_item" { $txt = ($b.bulleted_list_item.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "numbered_list_item" { $txt = ($b.numbered_list_item.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "code" { $txt = ($b.code.rich_text | ForEach-Object { $_.plain_text }) -join "" }
                "paragraph" { $txt = ($b.paragraph.rich_text | ForEach-Object { $_.plain_text }) -join "" }
            }
        } catch { $txt = "" }
        switch ($b.type) {
            "heading_2" { [void]$sb.AppendLine("## " + $txt) }
            "heading_3" { [void]$sb.AppendLine("### " + $txt) }
            "callout" { [void]$sb.AppendLine("> " + $txt) }
            "bulleted_list_item" { [void]$sb.AppendLine("- " + $txt) }
            "numbered_list_item" { [void]$sb.AppendLine("1. " + $txt) }
            "code" { [void]$sb.AppendLine($tick); [void]$sb.AppendLine($txt); [void]$sb.AppendLine($tick) }
            default { if ($txt) { [void]$sb.AppendLine($txt) } }
        }
    }
    [System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "exported: $out ($($sb.Length) chars)"
} else { Write-Host "no token" }
