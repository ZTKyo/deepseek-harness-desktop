# build.ps1 - builds the DSH Harness native client WITHOUT installing any SDK.
#
# Uses:
#   * csc.exe from the built-in .NET Framework (C# 5, WPF code-only)
#   * WPF assemblies referenced from the GAC
#   * WebView2 .NET assemblies (Core + Wpf + Loader) found on disk or passed via -WebView2Dir
#   * the already-installed Microsoft Edge WebView2 Runtime
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -WebView2Dir "C:\path\to\folder-with-3-dlls"
param(
    [string]$WebView2Dir = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root 'src\DSHHarness.cs'
$out  = Join-Path $root 'DSH Harness.exe'
$ico  = Join-Path $root 'DeepSeek Whale.ico'

Write-Host '== DSH Harness build ==' -ForegroundColor Cyan

# ---------- 1. csc ----------
$csc = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'csc.exe not found (requires .NET Framework 4.x, built into Windows)' }
Write-Host "csc: $csc"

# ---------- 2. GAC references for WPF ----------
$gac = "$env:WINDIR\Microsoft.NET\assembly"
function Get-GacRef([string]$asm, [string]$arch) {
    $dir = Join-Path $gac ("GAC_MSIL" + $(if ($arch) { '' } else { '' }))
    $search = if ($arch) { "$gac\GAC_$arch\$asm" } else { "$gac\GAC_MSIL\$asm" }
    $f = Get-ChildItem $search -Filter "$asm.dll" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if (-not $f) { throw "GAC assembly not found: $asm" }
    return $f
}
$refs = @()
$refs += Get-GacRef 'PresentationFramework'
$refs += Get-GacRef 'PresentationCore' '64'
$refs += Get-GacRef 'WindowsBase'
$refs += Get-GacRef 'System.Xaml'

# ---------- 3. WebView2 .NET assemblies ----------
$wvCandidates = @()
if ($WebView2Dir) { $wvCandidates += $WebView2Dir }
$wvCandidates += Get-ChildItem "$env:ProgramFiles\Nutstore" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$wvCandidates += Get-ChildItem "$env:ProgramFiles\Nutstore" -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'bin-*' } | Where-Object { Test-Path $_ }
$wvDir = $null
foreach ($c in $wvCandidates) {
    if (Test-Path $c) {
        $dirs = if (Test-Path (Join-Path $c 'Microsoft.Web.WebView2.Wpf.dll')) { @($c) } else { @() }
        foreach ($d in $dirs) {
            $core = Join-Path $d 'Microsoft.Web.WebView2.Core.dll'
            $wpf  = Join-Path $d 'Microsoft.Web.WebView2.Wpf.dll'
            $ldr  = Join-Path $d 'WebView2Loader.dll'
            if ((Test-Path $core) -and (Test-Path $wpf) -and (Test-Path $ldr)) { $wvDir = $d; break }
        }
    }
    if ($wvDir) { break }
}
if (-not $wvDir) { throw 'WebView2 .NET assemblies not found. Pass -WebView2Dir <folder> containing Core/Wpf/Loader.' }
$wvCore = Join-Path $wvDir 'Microsoft.Web.WebView2.Core.dll'
$wvWpf  = Join-Path $wvDir 'Microsoft.Web.WebView2.Wpf.dll'
$wvLdr  = Join-Path $wvDir 'WebView2Loader.dll'
Write-Host "WebView2 assemblies: $wvDir"

# ---------- 4. icon ----------
# The canonical icon is "DeepSeek Whale.ico" (official whale, committed in this
# folder). Only generate the placeholder when the file is missing, so a rebuild
# never overwrites the whale with the placeholder.
if (Test-Path $ico) {
    Write-Host "Reusing existing icon: $ico"
} else {
    Write-Host 'Icon missing - generating placeholder (replace with the whale ico: DeepSeek Whale.ico)...'
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    # dark rounded background
    $rect = New-Object System.Drawing.Rectangle 8, 8, 240, 240
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rad = 48
    $path.AddArc($rect.X, $rect.Y, $rad, $rad, 180, 90)
    $path.AddArc($rect.Right - $rad, $rect.Y, $rad, $rad, 270, 90)
    $path.AddArc($rect.Right - $rad, $rect.Bottom - $rad, $rad, $rad, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $rad, $rad, $rad, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 30, 58, 138), [System.Drawing.Color]::FromArgb(255, 13, 17, 28), 45)
    $g.FillPath($brush, $path)
    # terminal prompt glyph ">_"
    $font = New-Object System.Drawing.Font('Consolas', 92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tf = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString('>_', $font, $tf, (New-Object System.Drawing.RectangleF 0, 0, 256, 256), $sf)
    $g.Dispose()

    # write ICO: BMP entries 16/32/48 + PNG entry 256
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $entries = @()
    foreach ($sz in @(16, 32, 48)) {
        $small = New-Object System.Drawing.Bitmap $sz, $sz
        $sg = [System.Drawing.Graphics]::FromImage($small)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $sg.DrawImage($bmp, 0, 0, $sz, $sz)
        $sg.Dispose()
        $pms = New-Object System.IO.MemoryStream
        $small.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)  # PNG payload in ico is fine on Vista+
        $small.Dispose()
        $entries += @{ Size = $sz; Bytes = $pms.ToArray() }
        $pms.Dispose()
    }
    $pms2 = New-Object System.IO.MemoryStream
    $bmp.Save($pms2, [System.Drawing.Imaging.ImageFormat]::Png)
    $entries += @{ Size = 256; Bytes = $pms2.ToArray() }
    $pms2.Dispose()
    $bmp.Dispose()

    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$entries.Count)
    $offset = 6 + 16 * $entries.Count
    foreach ($e in $entries) {
        $bw.Write([Byte]$(if ($e.Size -ge 256) { 0 } else { $e.Size }))
        $bw.Write([Byte]$(if ($e.Size -ge 256) { 0 } else { $e.Size }))
        $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]$e.Bytes.Length)
        $bw.Write([UInt32]$offset)
        $offset += $e.Bytes.Length
    }
    foreach ($e in $entries) { $bw.Write($e.Bytes) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
    Write-Host "icon written: $ico"
}

# ---------- 5. compile ----------
$args = @('/nologo', '/target:winexe', "/out:$out", "/win32icon:$ico", '/optimize+')
foreach ($r in $refs) { $args += "/r:$r" }
$args += "/r:$wvCore"
$args += "/r:$wvWpf"
$args += $src
Write-Host 'Compiling...'
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "compile failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $out)) { throw 'compile produced no output' }

# ---------- 6. deploy WebView2 DLLs next to exe ----------
# Skip copies when the destination already matches (avoids failing on files that a
# running client instance currently has loaded/locked).
function Sync-IfChanged([string]$src, [string]$dst) {
    if (-not (Test-Path $dst)) { Copy-Item $src $dst -Force; return }
    $h1 = (Get-FileHash $src -Algorithm SHA256).Hash
    $h2 = (Get-FileHash $dst -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { Copy-Item $src $dst -Force }
}
Sync-IfChanged $wvCore (Join-Path $root 'Microsoft.Web.WebView2.Core.dll')
Sync-IfChanged $wvWpf  (Join-Path $root 'Microsoft.Web.WebView2.Wpf.dll')
Sync-IfChanged $wvLdr  (Join-Path $root 'WebView2Loader.dll')

Write-Host ''
Write-Host "BUILD OK -> $out" -ForegroundColor Green
Write-Host "size: $((Get-Item $out).Length) bytes"
Write-Host 'Deployed WebView2 assemblies (Core/Wpf/Loader) next to the exe.'
