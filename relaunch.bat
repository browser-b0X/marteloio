@echo off
rem Do not launch another copy if ownership checks or stopping failed.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-services.ps1"
if errorlevel 1 (
  echo Marteloio was not restarted. See the message above.
  exit /b 1
)
echo Starting Marteloio again...
call "%~dp0start-all.bat"
exit /b %ERRORLEVEL%
