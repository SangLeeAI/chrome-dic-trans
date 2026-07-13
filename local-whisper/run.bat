@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
  echo [ERROR] Run setup.bat first.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [ERROR] Failed to activate .venv
  pause
  exit /b 1
)

REM ---- settings ----
set "WHISPER_MODEL=large-v3-turbo"
set "WHISPER_DEVICE=cuda"
set "WHISPER_COMPUTE_TYPE=float16"
REM 0.0.0.0 = listen on all interfaces (LAN / remote)
set "WHISPER_HOST=0.0.0.0"
set "WHISPER_PORT=9000"

echo ============================================
echo  Local Whisper server
echo  Model:  %WHISPER_MODEL%
echo  Device: %WHISPER_DEVICE% (%WHISPER_COMPUTE_TYPE%)
echo  Bind:   http://%WHISPER_HOST%:%WHISPER_PORT%
echo  Local:  http://127.0.0.1:%WHISPER_PORT%/health
echo  Docs:   http://127.0.0.1:%WHISPER_PORT%/docs
echo ============================================
echo.
echo Access from other devices:
echo   http://YOUR-PC-IP:%WHISPER_PORT%/health
echo   Find IP: ipconfig  -^> IPv4 Address
echo.
echo Allow inbound TCP %WHISPER_PORT% in Windows Firewall.
echo Keep this window open while the server runs.
echo.

echo --- IPv4 addresses ---
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo  %%a
echo ----------------------
echo.

python -c "import fastapi,faster_whisper; print('deps: ok')" 2>nul
if errorlevel 1 (
  echo [ERROR] fastapi / faster-whisper not found in venv.
  echo Run setup.bat again, then run.bat.
  pause
  exit /b 1
)

python server.py
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited with error.
  pause
)
