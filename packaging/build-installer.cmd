@echo off
rem Builds packaging\dist\Marteloio-Setup.exe. Double-click this file.
rem All the work is done by build-installer.ps1, which also writes packaging\dist\build.log.
rem No labels or jumps on purpose: this file works with either line ending.
setlocal
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"
"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
set "BUILD_RESULT=%ERRORLEVEL%"
echo.
if "%BUILD_RESULT%"=="0" echo The installer is ready in the packaging\dist folder. The full log is packaging\dist\build.log.
if not "%BUILD_RESULT%"=="0" echo The build failed. The message above says why; the full log is packaging\dist\build.log.
echo.
pause
exit /b %BUILD_RESULT%
