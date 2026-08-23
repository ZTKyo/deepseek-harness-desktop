@echo off
rem DSH Harness - Edge app-mode client (double-click me).
rem SAC-safe: runs only Microsoft-signed binaries (powershell.exe + msedge.exe).
rem "start "": cmd exits immediately; the short-lived powershell runs with a hidden
rem console and exits on its own after launching Edge (nothing lingers).
rem Starts the dsh web server if needed, then opens the GUI in a standalone window.
setlocal
start "" powershell -NoProfile -WindowStyle Hidden -File "%~dp0DSH-Client.ps1" %*
endlocal
