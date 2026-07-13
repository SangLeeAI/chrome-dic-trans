@echo off
setlocal EnableExtensions

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Right-click this file and choose "Run as administrator"
  pause
  exit /b 1
)

set "PORT=9000"
if not "%~1"=="" set "PORT=%~1"

echo Adding Windows Firewall inbound rules for TCP %PORT% ...
echo (Private + Domain + Public profiles - needed when Wi-Fi is Public)
echo.

netsh advfirewall firewall delete rule name="Local Whisper %PORT%" >nul 2>&1
netsh advfirewall firewall delete rule name="Local Whisper %PORT% (all)" >nul 2>&1

REM profile=any covers Private, Domain, and Public
netsh advfirewall firewall add rule name="Local Whisper %PORT% (all)" dir=in action=allow protocol=TCP localport=%PORT% profile=any enable=yes

if errorlevel 1 (
  echo [ERROR] Failed to add firewall rule.
  pause
  exit /b 1
)

echo OK: inbound TCP %PORT% allowed on ALL profiles.
echo.
echo Verify rule:
netsh advfirewall firewall show rule name="Local Whisper %PORT% (all)"
echo.
echo --- IPv4 addresses (use the 192.168.x.x one) ---
ipconfig | findstr /c:"IPv4"
echo.
echo From ANOTHER PC, test in browser or PowerShell:
echo   http://192.168.2.247:%PORT%/health
echo   curl http://192.168.2.247:%PORT%/health
echo.
echo If still blocked, also try (Admin PowerShell):
echo   New-NetFirewallRule -DisplayName "Local Whisper %PORT%" -Direction Inbound -Protocol TCP -LocalPort %PORT% -Action Allow
echo.
pause
