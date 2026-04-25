@echo off
REM scripts\install-hooks.bat — Windows wrapper that delegates to the bash script.
REM
REM Idempotent: safe to re-run.
REM Opt-out from setup-uemcp.bat via env: SETUP_SKIP_HOOKS=1

setlocal

REM Locate Git Bash (ships with Git for Windows). Try the standard install path,
REM then PATH.
set "BASH_EXE="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"
if "%BASH_EXE%"=="" if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files (x86)\Git\bin\bash.exe"
if "%BASH_EXE%"=="" (
    where bash >nul 2>&1
    if not errorlevel 1 set "BASH_EXE=bash"
)

if "%BASH_EXE%"=="" (
    echo [install-hooks] ERROR: bash.exe not found.
    echo [install-hooks] Install Git for Windows ^(https://git-scm.com/download/win^)
    echo [install-hooks] then re-run this script.
    exit /b 1
)

REM Run the cross-platform installer
"%BASH_EXE%" "%~dp0install-hooks.sh"
exit /b %errorlevel%
