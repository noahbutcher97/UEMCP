@echo off
REM scripts\check-leaks.bat — Windows wrapper.
setlocal

set "BASH_EXE="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"
if "%BASH_EXE%"=="" if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files (x86)\Git\bin\bash.exe"
if "%BASH_EXE%"=="" (
    where bash >nul 2>&1
    if not errorlevel 1 set "BASH_EXE=bash"
)

if "%BASH_EXE%"=="" (
    echo [check-leaks] ERROR: bash.exe not found.
    echo [check-leaks] Install Git for Windows then re-run.
    exit /b 1
)

"%BASH_EXE%" "%~dp0check-leaks.sh"
exit /b %errorlevel%
