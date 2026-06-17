@echo off
REM migrate-targets.bat - convert legacy .uemcp-targets.txt into structured profiles.
REM Usage: migrate-targets.bat [--from path] [--to path] [--profiles default,smoke,release-gate]

setlocal EnableDelayedExpansion

set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "MIGRATE_MJS=!UEMCP_PATH!\server\migrate-targets.mjs"

if not exist "!MIGRATE_MJS!" (
  echo [ERROR] Helper not found: !MIGRATE_MJS!
  endlocal & exit /b 2
)

node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Run setup-uemcp.bat first to install Node.
  endlocal & exit /b 2
)

node "!MIGRATE_MJS!" %*
set "EXIT_CODE=!errorlevel!"

endlocal & exit /b %EXIT_CODE%
