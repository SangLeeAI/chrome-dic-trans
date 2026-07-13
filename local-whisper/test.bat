@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "URL=http://127.0.0.1:9000"

echo Checking health...
curl -s "%URL%/health"
echo.
echo.

if "%~1"=="" (
  echo Usage: test.bat path\to\audio.mp3
  echo Example: test.bat sample.wav
  echo Server must be running via run.bat
  pause
  exit /b 0
)

if not exist "%~1" (
  echo [ERROR] File not found: %~1
  pause
  exit /b 1
)

echo Transcribing: %~1
curl -s -X POST "%URL%/v1/audio/transcriptions" -F "file=@%~1" -F "language=en" -F "response_format=json"
echo.
pause
