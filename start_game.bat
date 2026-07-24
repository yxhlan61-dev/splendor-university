@echo off
cd /d "%~dp0"
set "PYEXE=%LocalAppData%\Programs\Python\Python314\python.exe"
if exist "%PYEXE%" goto run
where py >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=py"
  goto run
)
where python >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=python"
  goto run
)
echo Python was not found.
echo Please install Python, or run this project with VS Code Live Server.
pause
exit /b 1
:run
echo Starting local server...
echo Project folder: %CD%
"%PYEXE%" "%~dp0start_game.py"
echo Server stopped or failed.
pause
