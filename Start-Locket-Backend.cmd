@echo off
setlocal
cd /d "%~dp0"
set "LOCKET_PYTHON=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
if exist "%LOCKET_PYTHON%" goto prepare_env
py -3.14 --version >nul 2>&1
if not errorlevel 1 goto prepare_py
echo Python 3.14 was not found. Install Python 3.14, then open this launcher again.
pause
exit /b 1

:prepare_py
if exist "%~dp0.venv\Scripts\python.exe" goto check_deps
py -3.14 -m venv "%~dp0.venv"
if errorlevel 1 goto failed
goto check_deps

:prepare_env
if exist "%~dp0.venv\Scripts\python.exe" goto check_deps
"%LOCKET_PYTHON%" -m venv "%~dp0.venv"
if errorlevel 1 goto failed

:check_deps
set "LOCKET_PYTHON=%~dp0.venv\Scripts\python.exe"
"%LOCKET_PYTHON%" -c "import PIL; raise SystemExit(0 if PIL.__version__ == '13.0.0' else 1)" >nul 2>&1
if not errorlevel 1 goto run_backend
echo Preparing the local Photobooth image library...
"%LOCKET_PYTHON%" -m pip install --disable-pip-version-check --only-binary=:all: -r "%~dp0requirements.txt"
if errorlevel 1 goto failed

:run_backend
"%LOCKET_PYTHON%" "%~dp0run_backend.py" --tunnel
goto finished

:failed
echo Could not prepare the project Python environment. Check Python and your Internet connection.
pause
exit /b 1

:finished
set "LOCKET_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %LOCKET_EXIT_CODE%
