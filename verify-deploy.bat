@echo off
REM verify-deploy.bat — UEMCP pre-dispatch deployment verification CLI.
REM Usage: verify-deploy.bat [flags]
REM        verify-deploy.bat --help
REM
REM Reads .uemcp-targets.json profiles at repo root, falling back to legacy
REM .uemcp-targets.txt when no structured config exists. Reports per-target
REM whether deployed plugin matches repo source (SYNC / NEEDS-SYNC /
REM NEEDS-BUILD / NEEDS-DEPLOY / MISSING). Detects UnrealEditor.exe processes
REM locking each target's DLL (the §2.6 D135 re-smoke failure mode — editor
REM running during Build.bat silently no-op'd). Pairs with setup-watcher.bat
REM (auto-deploy on source change).
REM
REM Closes the D113 wasted-worker-session class structurally — orchestrator
REM no longer relies on procedural memory to grep deploy-state markers.
REM
REM This is a thin wrapper. Core logic lives in server/verify-deploy.mjs;
REM this script handles arg pass-through + pause-on-exit (CLAUDE.md §.bat).
REM
REM Exit codes (passed through from verify-deploy.mjs):
REM   0 — all targets SYNC
REM   1 — any target non-SYNC
REM   2 — config error (targets file missing, bad arg, etc.)

setlocal EnableDelayedExpansion

set "EXIT_CODE=0"
set "AUTO_YES=0"

REM --- Detect UEMCP repo (this script's directory) + verify-deploy helper ---
set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "VERIFY_MJS=!UEMCP_PATH!\server\verify-deploy.mjs"

if not exist "!VERIFY_MJS!" (
  echo [ERROR] Helper not found: !VERIFY_MJS!
  set "EXIT_CODE=2" & goto :end
)

REM --- Detect AUTO_YES sentinel for pause-on-exit (CLAUDE.md §.bat convention) ---
REM Scan args for -y / --yes / --no-pause; if any present, treat as scripted.
REM Note: --auto-sync / --auto-build are operational flags, not pause-skip
REM signals — those still pause unless explicit -y.
for %%A in (%*) do (
  if /i "%%~A"=="-y" set "AUTO_YES=1"
  if /i "%%~A"=="--yes" set "AUTO_YES=1"
  if /i "%%~A"=="--no-pause" set "AUTO_YES=1"
)

REM --- Validate Node.js ---
node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Run setup-uemcp.bat first to install Node.
  set "EXIT_CODE=2" & goto :end
)

REM --- Pass-through to verify-deploy.mjs (strip pause-only flags) ---
REM We swallow -y / --yes / --no-pause here because the .mjs doesn't know
REM about them; everything else passes through verbatim. CMD doesn't make
REM this easy, so we rebuild MJS_ARGS by iterating through %*.
set "MJS_ARGS="
:arg_loop
if "%~1"=="" goto :arg_done
if /i "%~1"=="-y" (shift & goto :arg_loop)
if /i "%~1"=="--yes" (shift & goto :arg_loop)
if /i "%~1"=="--no-pause" (shift & goto :arg_loop)
set "MJS_ARGS=!MJS_ARGS! %1"
shift
goto :arg_loop
:arg_done

REM Forward NO_COLOR env if non-TTY parent (e.g., piped output).
node "!VERIFY_MJS!" !MJS_ARGS!
set "EXIT_CODE=!errorlevel!"

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [verify-deploy exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
