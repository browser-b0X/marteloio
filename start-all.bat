@echo off
setlocal
cd /d "%~dp0"
rem Prefer installed Python, keeping the existing uv runtime as a fallback.
where python >nul 2>&1
if not errorlevel 1 (
  python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
  if not errorlevel 1 goto python
)
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
  if not errorlevel 1 goto py
)
set "PYTHON_EXE=%USERPROFILE%\AppData\Roaming\uv\python\cpython-3.14.7-windows-x86_64-none\python.exe"
if exist "%PYTHON_EXE%" goto uv
echo Python 3.10 or newer was not found. Install Python and try again.
pause
exit /b 1
:python
python "%~dp0launch.py"
goto result
:py
py -3 "%~dp0launch.py"
goto result
:uv
"%PYTHON_EXE%" "%~dp0launch.py"
:result
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
