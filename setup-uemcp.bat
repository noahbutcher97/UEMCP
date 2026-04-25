@echo off
REM setup-uemcp.bat — one-line UEMCP onboarding for Windows.
REM Usage: setup-uemcp.bat "<path-to-.uproject>"
REM   or:  setup-uemcp.bat                (GUI dialogs: workspace + .uproject)
REM
REM Interactive mode (no arg) shows two dialogs:
REM   1. Folder picker for the Claude workspace (where .mcp.json lands).
REM   2. File picker for the target .uproject (plugin copied into its Plugins\).
REM
REM Arg mode (path to .uproject) auto-detects workspace:
REM   - If the parent of the .uproject's dir has .claude\ or CLAUDE.md,
REM     that parent is treated as the workspace root (wrapped layout,
REM     e.g. P4-synced project layouts where a wrapper dir holds .claude + CLAUDE.md).
REM   - Otherwise .mcp.json is written next to the .uproject (flat layout).
REM
REM Also copies the UEMCP plugin into <project>\Plugins\UEMCP (physical copy;
REM junctions proved unreliable for UE commandlet discovery 2026-04-21).
REM
REM Exit codes: 0 success, 1 bad args/cancelled/missing deps, 2 npm install fail,
REM             3 .mcp.json write fail, 4 plugin copy fail.
REM
REM See CLAUDE.md "Onboarding a new machine" for details.

setlocal EnableDelayedExpansion

REM --- AUTO_YES detection for pause-before-exit (per CLAUDE.md §.bat convention) ---
REM When double-clicked from Explorer or run from a fresh cmd, the console
REM closes on exit. `pause` before exit keeps errors visible. We only pause
REM when no arg is passed (GUI / double-click launch pattern).
REM AUTO_YES=1 means scripted mode (no pause); AUTO_YES=0 means interactive.
set "AUTO_YES=1"
if "%~1"=="" set "AUTO_YES=0"
set "EXIT_CODE=0"

REM --- Detect UEMCP repo location (this script's directory) ---
set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"
set "UEMCP_PATH_FWD=!UEMCP_PATH:\=/!"

echo UEMCP setup starting...
echo ^(script dir: %~dp0^)
echo.

REM --- Validate Node.js ---
echo Checking for Node.js...
node --version 2>nul
if errorlevel 1 (
  echo.
  echo [NOTICE] Node.js is not installed or not on PATH for cmd.exe.
  echo.
  echo Note: if you have Claude Code installed, it uses a *bundled* Node that is
  echo NOT exposed on system PATH. This script needs a standalone Node install.
  goto :try_install_node
)
echo   Node OK.
echo.
goto :node_done

REM ============================================================================
REM Node install flow — Tier 1 (winget) → Tier 2 (direct MSI) → manual fallback.
REM On success, we CANNOT continue in this cmd session: newly-installed Node is
REM in the registry-level PATH but won't be visible until a fresh cmd is opened.
REM So all success paths here exit the script with "close and re-run" guidance.
REM
REM To auto-accept install prompts (CI / scripted use): set SETUP_AUTO_YES=1
REM before invoking the script.
REM ============================================================================

:try_install_node
echo.
where winget >nul 2>&1
if errorlevel 1 (
  echo winget not found on this machine. Falling back to direct MSI download.
  goto :try_install_node_direct
)

set "REPLY="
if defined SETUP_AUTO_YES (
  set "REPLY=y"
) else (
  set /p "REPLY=Install Node LTS via winget (user scope, no admin needed)? [Y/n]: "
)
if "!REPLY!"=="" set "REPLY=y"
if /i not "!REPLY!"=="y" goto :try_install_node_direct

echo.
echo Running: winget install OpenJS.NodeJS.LTS --scope user ...
winget install OpenJS.NodeJS.LTS --scope user --accept-source-agreements --accept-package-agreements
set "WINGET_EXIT=!errorlevel!"
if not "!WINGET_EXIT!"=="0" (
  echo.
  echo [WARN] winget exit !WINGET_EXIT!. Falling back to direct MSI download.
  goto :try_install_node_direct
)
echo.
echo [SUCCESS] Node installed via winget.
goto :node_install_done

:try_install_node_direct
echo.
set "REPLY="
if defined SETUP_AUTO_YES (
  set "REPLY=y"
) else (
  set /p "REPLY=Download Node LTS installer from nodejs.org and run it? [Y/n]: "
)
if "!REPLY!"=="" set "REPLY=y"
if /i not "!REPLY!"=="y" goto :node_install_manual

REM PowerShell fetches index.json, finds latest LTS, downloads the x64 MSI into
REM %TEMP%, and invokes msiexec /passive (UAC prompt appears — user must accept).
REM PS code is kept on a single line for robustness — CMD line continuation (^)
REM under CRLF conversion is fragile. Uses single-quoted PS strings + string
REM concatenation instead of nested "..." to avoid CMD-vs-PS quoting collisions.
set "NODE_MSI_PATH=%TEMP%\nodejs-lts-x64.msi"
echo.
echo Downloading Node LTS MSI to !NODE_MSI_PATH! ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $idx=Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'; $lts=($idx | Where-Object { $_.lts } | Select-Object -First 1); $ver=$lts.version; $url=('https://nodejs.org/dist/' + $ver + '/node-' + $ver + '-x64.msi'); Write-Host ('LTS version: ' + $ver); Write-Host ('URL: ' + $url); Invoke-WebRequest -Uri $url -OutFile '!NODE_MSI_PATH!' -UseBasicParsing"
if errorlevel 1 (
  echo.
  echo [ERROR] Node MSI download failed.
  goto :node_install_manual
)
if not exist "!NODE_MSI_PATH!" (
  echo.
  echo [ERROR] Download claimed success but MSI not at !NODE_MSI_PATH!.
  goto :node_install_manual
)

echo.
echo Launching MSI installer ^(UAC prompt will appear^)...
echo Accept the UAC prompt to proceed with install. Decline = manual fallback.
start /wait msiexec /i "!NODE_MSI_PATH!" /passive
set "MSI_EXIT=!errorlevel!"
del /q "!NODE_MSI_PATH!" >nul 2>&1
if not "!MSI_EXIT!"=="0" (
  echo.
  echo [ERROR] Node MSI installer exited with code !MSI_EXIT!.
  echo         Common causes: UAC declined, antivirus blocked, or corp policy.
  goto :node_install_manual
)
echo [SUCCESS] Node installed via MSI.
goto :node_install_done

:node_install_manual
echo.
echo [ERROR] Automated Node install did not complete.
echo.
echo Install options ^(any one works^):
echo   1. Winget:  winget install OpenJS.NodeJS.LTS
echo   2. Direct:  https://nodejs.org/ ^(pick the LTS installer^)
echo   3. nvm-windows: https://github.com/coreybutler/nvm-windows
echo.
echo After install, OPEN A FRESH cmd window ^(so PATH refreshes^) and re-run.
echo Quick verify:  node --version    should print v20.x or v22.x.
set "EXIT_CODE=1" & goto :end

:node_install_done
echo.
echo +-------------------------------------------------------------------+
echo ^| Node is installed, but this cmd window still has the OLD PATH.   ^|
echo ^| Close this window and re-run setup-uemcp.bat in a FRESH cmd.     ^|
echo ^| The fresh cmd will pick up the new Node on PATH automatically.   ^|
echo +-------------------------------------------------------------------+
set "EXIT_CODE=0" & goto :end

:node_done

REM --- Accept target project path ---
REM   Arg given: use it (programmatic / repeat-run mode).
REM   No arg: show GUI dialogs (workspace folder first, then .uproject file).
REM   PowerShell WinForms: standard Windows-installer pattern for GUI pickers.
set "PROJECT_ARG=%~1"
set "WORKSPACE_OVERRIDE="
if "!PROJECT_ARG!"=="" (
  echo Opening workspace folder picker...
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select your Claude workspace folder (.mcp.json will be placed here)'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { 'CANCELLED_WORKSPACE' }"`) do set "WORKSPACE_OVERRIDE=%%I"
  if "!WORKSPACE_OVERRIDE!"=="CANCELLED_WORKSPACE" (
    echo [INFO] Workspace folder selection cancelled. Exiting.
    set "EXIT_CODE=1" & goto :end
  )
  if "!WORKSPACE_OVERRIDE!"=="" (
    echo [ERROR] Workspace browse returned empty path. Exiting.
    echo        PowerShell WinForms may have failed — check PS execution policy.
    set "EXIT_CODE=1" & goto :end
  )
  echo Opening .uproject file picker...
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Unreal Project|*.uproject'; $f.Title = 'Select the .uproject to enable UEMCP for'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName } else { 'CANCELLED_PROJECT' }"`) do set "PROJECT_ARG=%%I"
  if "!PROJECT_ARG!"=="CANCELLED_PROJECT" (
    echo [INFO] .uproject selection cancelled. Exiting.
    set "EXIT_CODE=1" & goto :end
  )
)
REM Strip any surrounding double quotes from either GUI or arg input.
set "PROJECT_ARG=!PROJECT_ARG:"=!"
if "!PROJECT_ARG!"=="" (
  echo [ERROR] No project path provided.
  set "EXIT_CODE=1" & goto :end
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
  set "EXIT_CODE=1" & goto :end
)
if /i not "!PROJECT_EXT!"==".uproject" (
  echo [ERROR] Expected a .uproject file, got extension: !PROJECT_EXT!
  echo Provide the full path to your project's .uproject file.
  set "EXIT_CODE=1" & goto :end
)

REM --- UNREAL_PROJECT_ROOT env var = directory containing the .uproject ---
set "UPROJECT_DIR=!UPROJECT_DIR_RAW!"
if "!UPROJECT_DIR:~-1!"=="\" set "UPROJECT_DIR=!UPROJECT_DIR:~0,-1!"
set "UPROJECT_DIR_FWD=!UPROJECT_DIR:\=/!"

REM --- Auto-detect workspace root (where .mcp.json is consumed by Claude) ---
REM Wrapped layout: <parent>\.claude\ or <parent>\CLAUDE.md present (common P4 pattern).
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

REM GUI-picked workspace overrides auto-detect.
if not "!WORKSPACE_OVERRIDE!"=="" (
  set "WORKSPACE_ROOT=!WORKSPACE_OVERRIDE!"
  if "!WORKSPACE_ROOT:~-1!"=="\" set "WORKSPACE_ROOT=!WORKSPACE_ROOT:~0,-1!"
  set "LAYOUT=explicit (GUI browse)"
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
    set "EXIT_CODE=0" & goto :end
  )
)

REM --- npm install (idempotent: skip if node_modules exists) ---
if not exist "!UEMCP_PATH!\server\node_modules\" (
  echo Installing server dependencies ^(npm install in server/^)...
  pushd "!UEMCP_PATH!\server"
  if errorlevel 1 (
    echo [ERROR] Failed to enter !UEMCP_PATH!\server
    set "EXIT_CODE=2" & goto :end
  )
  call npm install
  set "NPM_EXIT=!errorlevel!"
  popd
  if not "!NPM_EXIT!"=="0" (
    echo [ERROR] npm install failed with exit code !NPM_EXIT!.
    set "EXIT_CODE=2" & goto :end
  )
) else (
  echo server\node_modules already present; skipping npm install.
)

REM --- Generate .mcp.json from template via node -e ---
set "TEMPLATE_PATH=!UEMCP_PATH!\.mcp.json.example"
if not exist "!TEMPLATE_PATH!" (
  echo [ERROR] Template not found: !TEMPLATE_PATH!
  set "EXIT_CODE=3" & goto :end
)

REM Export values for node to read via process.env (avoids CMD-quoting hazards
REM and the JS string-literal escape pitfalls of interpolating %VAR% into code).
set "TARGET_PATH=!TARGET_MCP!"
set "PROJECT_ROOT_FWD=!UPROJECT_DIR_FWD!"
node -e "const fs=require('fs');const t=fs.readFileSync(process.env.TEMPLATE_PATH,'utf8');const o=t.split('<UEMCP_REPO_PATH>').join(process.env.UEMCP_PATH_FWD).split('<UNREAL_PROJECT_ROOT>').join(process.env.PROJECT_ROOT_FWD).split('<UNREAL_PROJECT_NAME>').join(process.env.PROJECT_NAME);fs.writeFileSync(process.env.TARGET_PATH,o);"
if errorlevel 1 (
  echo [ERROR] Failed to generate .mcp.json.
  set "EXIT_CODE=3" & goto :end
)

REM --- Verify generated JSON parses ---
node -e "JSON.parse(require('fs').readFileSync(process.env.TARGET_PATH,'utf8'));" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Generated .mcp.json is not valid JSON: !TARGET_PATH!
  set "EXIT_CODE=3" & goto :end
)

echo.
echo [SUCCESS] Wrote !TARGET_PATH!

REM --- Copy UEMCP plugin into project's Plugins folder ---
set "PLUGIN_SRC=!UEMCP_PATH!\plugin\UEMCP"
set "PLUGIN_DEST=!UPROJECT_DIR!\Plugins\UEMCP"
set "PLUGIN_COPIED=0"

if not exist "!PLUGIN_SRC!" (
  echo.
  echo [WARN] Plugin source not found at !PLUGIN_SRC!; skipping plugin copy.
  goto :plugin_done
)

REM Editor-running hazard: DLL locked, xcopy would fail mid-copy.
REM Use findstr (not find) — find can be shadowed by Git Bash when .bat is
REM launched from a bash-hosted cmd /c.
tasklist /FI "IMAGENAME eq UnrealEditor.exe" 2>nul | findstr /I "UnrealEditor.exe" >nul
if not errorlevel 1 (
  echo.
  echo [WARN] UnrealEditor.exe is running. Plugin DLL is locked.
  echo        Close the editor before proceeding, or plugin files may fail to overwrite.
  set "CONFIRM="
  set /p "CONFIRM=Continue anyway? [y/N]: "
  if /i not "!CONFIRM!"=="y" (
    echo Plugin copy skipped. Re-run this script after closing the editor.
    goto :plugin_done
  )
)

if exist "!PLUGIN_DEST!" (
  echo.
  echo Plugin already installed at !PLUGIN_DEST!.
  set "CONFIRM="
  set /p "CONFIRM=Overwrite? [y/N]: "
  if /i not "!CONFIRM!"=="y" (
    echo Plugin copy skipped. Existing plugin preserved.
    goto :plugin_done
  )
  echo Removing old plugin copy...
  rmdir /s /q "!PLUGIN_DEST!"
  if exist "!PLUGIN_DEST!" (
    echo [ERROR] Failed to remove existing plugin at !PLUGIN_DEST!.
    echo         Files may still be locked. Close the editor and retry.
    set "EXIT_CODE=4" & goto :end
  )
)

echo.
echo Copying UEMCP plugin to !PLUGIN_DEST! ...
xcopy /E /I /Y /Q "!PLUGIN_SRC!" "!PLUGIN_DEST!" >nul
set "XCOPY_EXIT=!errorlevel!"
if not "!XCOPY_EXIT!"=="0" (
  echo [ERROR] Plugin copy failed. xcopy exit code: !XCOPY_EXIT!
  set "EXIT_CODE=4" & goto :end
)
echo [SUCCESS] Plugin installed at !PLUGIN_DEST!.
set "PLUGIN_COPIED=1"

:plugin_done
echo.
echo Next steps:
echo   1. Close any running Claude Code session in this project.
if "!PLUGIN_COPIED!"=="1" goto :steps_with_plugin
goto :steps_without_plugin

:steps_with_plugin
echo   2. Open !PROJECT_NAME! in Unreal Editor once to compile/load the plugin.
echo   3. cd !WORKSPACE_ROOT!
echo   4. Start Claude Code (claude) -- UEMCP attaches automatically.
echo   5. In Claude, run project_info to sanity-check the connection.
goto :tcp_note

:steps_without_plugin
echo   2. cd !WORKSPACE_ROOT!
echo   3. Start Claude Code (claude) -- UEMCP attaches automatically.
echo   4. In Claude, run project_info to sanity-check the connection.
echo.
echo   Note: plugin was not copied this run; TCP tools on port 55558 will
echo         not be available until the UEMCP plugin lands in
echo         !UPROJECT_DIR!\Plugins\UEMCP.
goto :tcp_note

:tcp_note
echo.
echo TCP tools (actors, blueprints-write, widgets) need the UE editor with
echo the UnrealMCP plugin active. Offline tools work against project files
echo on disk with no editor running.
set "EXIT_CODE=0"
goto :end

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [Setup exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
