@echo off
rem DSH Guardian Autostart - runs at sign-in (hidden).
rem Starts dsh-guardian.ps1 (keep-awake + server watchdog) detached.
setlocal
start "" powershell -NoProfile -WindowStyle Hidden -File "%~dp0dsh-guardian.ps1" %*
endlocal
