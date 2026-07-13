@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Local Whisper setup (Windows + NVIDIA GPU)
echo ============================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python not found in PATH.
  echo Install Python 3.11 or 3.12 from https://www.python.org/downloads/
  echo Enable "Add python.exe to PATH" during install.
  pause
  exit /b 1
)

python --version
echo.

if not exist ".venv" (
  echo [1/4] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERROR] venv failed.
    pause
    exit /b 1
  )
) else (
  echo [1/4] .venv already exists
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [ERROR] Cannot activate .venv
  pause
  exit /b 1
)

echo [2/4] Upgrading pip...
python -m pip install -U pip

echo [3/4] Installing packages (faster-whisper + CUDA DLLs)...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed.
  pause
  exit /b 1
)

echo [4/4] Checking cublas DLL presence...
python -c "import os,glob,sys; sp=os.path.join(sys.prefix,'Lib','site-packages','nvidia','cublas','bin'); print('cublas dir:', sp); print('exists:', os.path.isdir(sp)); print('dlls:', len(glob.glob(sp+'\\*.dll')) if os.path.isdir(sp) else 0)"

echo.
echo Checking NVIDIA GPU...
where nvidia-smi >nul 2>&1
if errorlevel 1 (
  echo [WARN] nvidia-smi not found. Install GeForce driver.
) else (
  nvidia-smi
)

echo.
python -c "import fastapi,faster_whisper,numpy; print('Import check: OK')"
if errorlevel 1 (
  echo [ERROR] Import check failed.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Setup complete.
echo  Next: open-firewall.bat as Admin (once)
echo        then run.bat
echo ============================================
pause
