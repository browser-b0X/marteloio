@echo off
rem Stop only services verified as belonging to this project.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-services.ps1"
set "STOP_RESULT=%ERRORLEVEL%"
echo.
if not "%STOP_RESULT%"=="0" echo Nothing ambiguous was killed. Resolve the reported conflict before relaunching.
timeout /t 4 >nul
exit /b %STOP_RESULT%
