@echo off
REM setup-uemcp.bat — one-line UEMCP onboarding for Windows.
REM Usage: setup-uemcp.bat "<path-to-.uproject>"
REM   or:  setup-uemcp.bat                (prompts interactively)
REM
REM Generates .mcp.json at your Claude workspace root (auto-detected):
REM   - If the parent of the .uproject's dir has .claude\ or CLAUDE.md,
REM     that parent is treated as the workspace root (wrapped layout,
REM     e.g. ProjectA where the P4-synced wrapper holds .claude + CLAUDE.md).
REM   - Otherwise .mcp.json is written next to the .uproject (flat layout).
REM
REM See CLAUDE.md "Onboarding a new machine" for details.

setlocal EnableDelayedExpansion

REM --- Detect UEMCP repo location (this script's directory) ---
set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "UEMCP_PATH_FWD=!UEMCP_PATH:\=/!"

REM --- Validate Node.js ---
node --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo Install Node.js LTS from https://nodejs.org/ then re-run this script.
  exit /b 1
)

REM --- Accept target project path (arg 1, else prompt) ---
set "PROJECT_ARG=%~1"
if "!PROJECT_ARG!"=="" (
  set /p "PROJECT_ARG=Enter path to .uproject file: "
)
REM Strip any surrounding double quotes from interactive input.
set "PROJECT_ARG=!PROJECT_ARG:"=!"
if "!PROJECT_ARG!"=="" (
  echo [ERROR] No project path provided.
  exit /b 1
)

REM --- Resolve and validate the .uproject path ---
for %%I in ("!PROJECT_ARG!") do (
  set "UPROJECT_FULL=%%~fI"
  set "UPROJECT_DIR_RAW=%%~dpI"
  set "PROJECT_NAME=%%~nI"
  set "PROJECT_EXT=%%~xI"
)
if not exist "!UPROJECT_FULL!" (
  echo [ERROR] File not found: !UPROJECT_FULL!
  exit /b 1
)
if /i not "!PROJECT_EXT!"==".uproject" (
  echo [ERROR] Expected a .uproject file, got extension: !PROJECT_EXT!
  echo Provide the full path to your project's .uproject file.
  exit /b 1
)

REM --- UNREAL_PROJECT_ROOT env var = directory containing the .uproject ---
set "UPROJECT_DIR=!UPROJECT_DIR_RAW!"
if "!UPROJECT_DIR:~-1!"=="\" set "UPROJECT_DIR=!UPROJECT_DIR:~0,-1!"
set "UPROJECT_DIR_FWD=!UPROJECT_DIR:\=/!"

REM --- Auto-detect workspace root (where .mcp.json is consumed by Claude) ---
REM Wrapped layout: <parent>\.claude\ or <parent>\CLAUDE.md present (ProjectA pattern).
REM Flat layout: default to the .uproject's own directory.
for %%I in ("!UPROJECT_DIR!\..") do set "PARENT_DIR=%%~fI"
if "!PARENT_DIR:~-1!"=="\" set "PARENT_DIR=!PARENT_DIR:~0,-1!"

set "WORKSPACE_ROOT=!UPROJECT_DIR!"
set "LAYOUT=flat"
if exist "!PARENT_DIR!\.claude\" (
  set "WORKSPACE_ROOT=!PARENT_DIR!"
  set "LAYOUT=wrapped (.claude\ at parent)"
) else if exist "!PARENT_DIR!\CLAUDE.md" (
  set "WORKSPACE_ROOT=!PARENT_DIR!"
  set "LAYOUT=wrapped (CLAUDE.md at parent)"
)

echo.
echo UEMCP repo      : !UEMCP_PATH!
echo Project         : !PROJECT_NAME!
echo Project dir     : !UPROJECT_DIR!   (UNREAL_PROJECT_ROOT)
echo Workspace root  : !WORKSPACE_ROOT!  (layout: !LAYOUT!)
echo.

REM --- Overwrite-prompt for existing .mcp.json (default N) ---
set "TARGET_MCP=!WORKSPACE_ROOT!\.mcp.json"
if exist "!TARGET_MCP!" (
  echo .mcp.json already exists at !TARGET_MCP!
  set "CONFIRM="
  set /p "CONFIRM=Overwrite? [y/N]: "
  if /i not "!CONFIRM!"=="y" (
    echo Aborted. Existing .mcp.json preserved.
    endlocal
    exit /b 0
  )
)

REM --- npm install (idempotent: skip if node_modules exists) ---
if not exist "!UEMCP_PATH!\server\node_modules\" (
  echo Installing server dependencies ^(npm install in server/^)...
  pushd "!UEMCP_PATH!\server"
  if errorlevel 1 (
    echo [ERROR] Failed to enter !UEMCP_PATH!\server
    exit /b 2
  )
  call npm install
  set "NPM_EXIT=!errorlevel!"
  popd
  if not "!NPM_EXIT!"=="0" (
    echo [ERROR] npm install failed with exit code !NPM_EXIT!.
    exit /b 2
  )
) else (
  echo server\node_modules already present; skipping npm install.
)

REM --- Generate .mcp.json from template via node -e ---
set "TEMPLATE_PATH=!UEMCP_PATH!\.mcp.json.example"
if not exist "!TEMPLATE_PATH!" (
  echo [ERROR] Template not found: !TEMPLATE_PATH!
  exit /b 3
)

REM Export values for node to read via process.env (avoids CMD-quoting hazards
REM and the JS string-literal escape pitfalls of interpolating %VAR% into code).
set "TARGET_PATH=!TARGET_MCP!"
set "PROJECT_ROOT_FWD=!UPROJECT_DIR_FWD!"
node -e "const fs=require('fs');const t=fs.readFileSync(process.env.TEMPLATE_PATH,'utf8');const o=t.split('<UEMCP_REPO_PATH>').join(process.env.UEMCP_PATH_FWD).split('<UNREAL_PROJECT_ROOT>').join(process.env.PROJECT_ROOT_FWD).split('<UNREAL_PROJECT_NAME>').join(process.env.PROJECT_NAME);fs.writeFileSync(process.env.TARGET_PATH,o);"
if errorlevel 1 (
  echo [ERROR] Failed to generate .mcp.json.
  exit /b 3
)

REM --- Verify generated JSON parses ---
node -e "JSON.parse(require('fs').readFileSync(process.env.TARGET_PATH,'utf8'));" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Generated .mcp.json is not valid JSON: !TARGET_PATH!
  exit /b 3
)

echo.
echo [SUCCESS] Wrote !TARGET_PATH!
echo.
echo Next steps:
echo   1. Close any running Claude Code session in this project.
echo   2. cd !WORKSPACE_ROOT!
echo   3. Start Claude Code (claude) -- UEMCP attaches automatically.
echo   4. In Claude, run project_info to sanity-check the connection.
echo.
echo TCP tools (actors, blueprints-write, widgets) need the UE editor with
echo the UnrealMCP plugin active. Offline tools work against project files
echo on disk with no editor running.

endlocal
exit /b 0
