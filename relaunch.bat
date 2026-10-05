@echo off
rem Do not launch another copy if ownership checks or stopping failed.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-services.ps1"
if errorlevel 1 (
  echo Relaunch cancelled. Resolve the reported conflict before trying again.
  exit /b 1
)
echo Relaunching...
call "%~dp0start-all.bat"
exit /b %ERRORLEVEL%
