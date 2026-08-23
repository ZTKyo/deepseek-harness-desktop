@echo off
rem DSH Server Autostart - called at sign-in by the Startup shortcut.
rem Ensures the dsh web server runs detached (no windows); exits immediately
rem if the server is already up.
rem "start "": cmd exits immediately; the short-lived powershell runs with a hidden
rem console and exits on its own (nothing lingers at sign-in).
setlocal
start "" powershell -NoProfile -WindowStyle Hidden -File "%~dp0start-dsh-server.ps1" %*
endlocal
