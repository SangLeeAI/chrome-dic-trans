@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=9000"
if not "%~1"=="" set "PORT=%~1"

echo ============================================
echo  Whisper remote access diagnostics
echo ============================================
echo.

echo [1] Listening ports (should show 0.0.0.0:%PORT% or [::]:%PORT%)
netstat -ano | findstr ":%PORT% "
echo.

echo [2] Local health
curl -s -m 3 "http://127.0.0.1:%PORT%/health"
echo.
echo.

echo [3] Health via LAN IP (if 192.168.2.247 is this PC)
curl -s -m 3 "http://192.168.2.247:%PORT%/health"
echo.
echo.

echo [4] Firewall rules matching Whisper / port %PORT%
netsh advfirewall firewall show rule name=all | findstr /i "Whisper %PORT%"
echo.

echo [5] Network profile (Public often blocks inbound)
powershell -NoProfile -Command "Get-NetConnectionProfile | Format-Table Name,InterfaceAlias,NetworkCategory -AutoSize"
echo.

echo [6] IPv4 addresses
ipconfig | findstr /c:"IPv4"
echo.
echo Tips:
echo  - Use IP starting with 192.168.  (not 169.254. or 172.24.)
echo  - On remote PC browser open: http://192.168.2.247:%PORT%/health
echo  - If local OK but remote fails: re-run open-firewall.bat as Admin
echo  - Ensure both PCs are on same Wi-Fi / LAN (not guest/isolation Wi-Fi)
echo.
pause
