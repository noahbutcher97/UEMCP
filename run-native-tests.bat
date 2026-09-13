@echo off
REM run-native-tests.bat — UEMCP headless plugin automation test runner CLI.
REM Usage: run-native-tests.bat [flags]
REM        run-native-tests.bat --help
REM
REM Resolves a target from .uemcp-targets.json profiles (like verify-deploy)
REM or an explicit --uproject, resolves the engine from UE_ENGINE_ROOT or the
REM .uproject's EngineAssociation, spawns UnrealEditor-Cmd headless through the
REM bounded process runner to run the plugin's UE automation tests, and parses
REM the exported report. An already-running UnrealEditor process only prints a
REM [WARN] (it shares port 55558) and does not block the run.
REM
REM This is a thin wrapper. Core logic lives in server/run-native-tests.mjs;
REM this script handles arg pass-through + pause-on-exit (CLAUDE.md §.bat).
REM
REM Exit codes (passed through from run-native-tests.mjs):
REM   0 — all tests passed
REM   1 — any test failed or did not run
REM   2 — preflight or config error
REM   3 — timeout
REM   4 — no report or zero tests

setlocal EnableDelayedExpansion

set "EXIT_CODE=0"
set "AUTO_YES=0"

REM --- Detect UEMCP repo (this script's directory) + runner helper ---
set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "RUNNER_MJS=!UEMCP_PATH!\server\run-native-tests.mjs"

if not exist "!RUNNER_MJS!" (
  echo [ERROR] Helper not found: !RUNNER_MJS!
  set "EXIT_CODE=2" & goto :end
)

REM --- Detect AUTO_YES sentinel for pause-on-exit (CLAUDE.md §.bat convention) ---
REM Scan args for -y / --yes / --no-pause; if any present, treat as scripted.
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

REM --- Pass-through to run-native-tests.mjs (strip pause-only flags) ---
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

node "!RUNNER_MJS!" !MJS_ARGS!
set "EXIT_CODE=!errorlevel!"

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [run-native-tests exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
