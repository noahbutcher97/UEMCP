@echo off
REM setup-watcher.bat — UEMCP plugin auto-deploy file-watcher.
REM Usage: setup-watcher.bat
REM        setup-watcher.bat --debounce-ms 1000
REM        setup-watcher.bat --targets path\to\custom-targets.json --profile smoke
REM
REM Long-running process. Watches D:\DevTools\UEMCP\plugin\UEMCP\Source\
REM recursively. On any change (excluding Binaries\, Intermediate\, *.tmp),
REM debounces 500ms then runs `sync-plugin.bat <target> -y` for each target
REM in the selected local target profile. Press Ctrl+C to stop.
REM
REM Pairs with verify-deploy.bat — watcher prevents NEW staleness; verify-
REM deploy catches existing staleness across machines / cross-stream pulls.
REM Together they close the D113 wasted-worker-session class structurally.
REM
REM This is a thin wrapper. Core logic in server/verify-deploy.mjs --watch.
REM
REM Exit codes:
REM   0 — clean shutdown via Ctrl+C
REM   2 — config error (no targets file, source dir missing, Node not found)

setlocal EnableDelayedExpansion

set "EXIT_CODE=0"
REM Watcher is interactive by nature (long-running, Ctrl+C-driven). No
REM AUTO_YES flag; Ctrl+C ends it. We DO pause on config-error exits so
REM users see the message before a double-clicked window closes.

set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "VERIFY_MJS=!UEMCP_PATH!\server\verify-deploy.mjs"

if not exist "!VERIFY_MJS!" (
  echo [ERROR] Helper not found: !VERIFY_MJS!
  set "EXIT_CODE=2" & goto :end
)

node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo         Run setup-uemcp.bat first to install Node.
  set "EXIT_CODE=2" & goto :end
)

REM Forward all args after --watch to the helper.
node "!VERIFY_MJS!" --watch %*
set "EXIT_CODE=!errorlevel!"

:end
echo.
REM Pause only on config-error exits (2). Clean Ctrl+C exits (0) skip pause
REM since the user already interrupted; double-pausing on Ctrl+C is annoying.
if "!EXIT_CODE!"=="2" (
  echo [setup-watcher exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
