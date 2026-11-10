@echo off
setlocal
cd /d "%~dp0"
set "LOCKET_PYTHON=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
if exist "%LOCKET_PYTHON%" goto run_python
py -3.14 --version >nul 2>&1
if not errorlevel 1 goto run_py
echo Python 3.14 was not found. Install Python 3.14, then open this launcher again.
pause
exit /b 1

:run_python
"%LOCKET_PYTHON%" "%~dp0run_backend.py" --tunnel
goto finished

:run_py
py -3.14 "%~dp0run_backend.py" --tunnel

:finished
set "LOCKET_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %LOCKET_EXIT_CODE%
