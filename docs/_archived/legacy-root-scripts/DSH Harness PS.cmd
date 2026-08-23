@echo off
rem DSH Harness (PowerShell 原生感客户端) - double-click me.
rem SAC-safe: builds a WPF + WebView2 window at runtime under the Microsoft-signed
rem powershell.exe, so Smart App Control has nothing unsigned to block.
rem The script immediately re-launches itself with CREATE_NO_WINDOW (no console at
rem all), so only a brief console flash occurs and nothing lingers.
rem Starts the dsh web server if needed, then opens the GUI in a standalone window.
setlocal
powershell -NoProfile -Command "$f='%~dp0DSH-Harness-PS.ps1';$b=[IO.File]::ReadAllBytes($f);if($b[0]-ne0xEF-or$b[1]-ne0xBB-or$b[2]-ne0xBF){$h=[byte[]](0xEF,0xBB,0xBF);[IO.File]::WriteAllBytes($f,$h+$b)}"
powershell -NoProfile -STA -File "%~dp0DSH-Harness-PS.ps1" %*
endlocal
