@echo off
rem Add Marteloio to the Start menu and the desktop for this Windows user.
rem   create-shortcuts.bat            add the shortcuts (run again after moving this folder)
rem   create-shortcuts.bat /nodesktop  Start menu only
rem   create-shortcuts.bat /remove     remove the shortcuts that point at this folder
setlocal
cd /d "%~dp0"
set "REMOVE="
set "NODESKTOP="
for %%A in (%*) do (
  if /i "%%~A"=="/remove" set "REMOVE=-Remove"
  if /i "%%~A"=="-remove" set "REMOVE=-Remove"
  if /i "%%~A"=="/nodesktop" set "NODESKTOP=-NoDesktop"
  if /i "%%~A"=="-nodesktop" set "NODESKTOP=-NoDesktop"
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcuts.ps1" %REMOVE% %NODESKTOP%
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
