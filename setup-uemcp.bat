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
REM             3 .mcp.json write fail, 4 plugin copy fail,
REM             5 plugin-deps update fail (.uproject read/write/JSON-parse error).
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

REM --- Auto-register project codenames into NDA forbidden-tokens block-list ---
REM Per CLAUDE.md §Public-Repo Hygiene, .git/info/forbidden-tokens is the
REM repo-write gate enforced by .githooks/pre-commit + .githooks/pre-push.
REM Auto-registering the .uproject stem + the wrapper-dir name closes the
REM D109/D118 codename-leak class structurally — operators can't forget to
REM scrub a codename if a brand-new project's name lands on the block-list
REM the first time setup-uemcp.bat runs against it.
REM
REM Idempotent: skips already-registered, sorts + dedups after write.
REM Generic UE / version-folder names (Engine, Plugins, 5.6, etc.) skipped
REM via deny-list + regex; codename ownership is "register, then maintainer
REM removes if confirmed-safe", not the other way around.
REM
REM Standing policy (per D122 / feedback_nda_gate_scope.md): the NDA gate
REM is REPO-WRITE-ONLY. UEMCP tools may execute at full capability against
REM the user's own UE projects. The block-list governs ONLY what flows OUT
REM to github.com via committed content.
echo Registering project codenames in NDA forbidden-tokens block-list...
for %%I in ("!PARENT_DIR!") do set "PARENT_DIR_NAME=%%~nxI"
REM CMD-quoting: the JS body contains `!` (logical-not) and `^` (regex anchor).
REM Both are eaten by CMD's EnableDelayedExpansion second-pass scan EVEN inside
REM "..." quotes. Wrapping the node -e call in `setlocal DisableDelayedExpansion`
REM (a nested scope) makes `!` and `^` literal during the scan; the outer scope's
REM delayed expansion is untouched. The trailing `endlocal & set "REG_EXIT=..."`
REM is the standard idiom for propagating one var across the endlocal boundary
REM (the `%REG_EXIT%` is substituted at line-parse time, before endlocal runs).
setlocal DisableDelayedExpansion
set "TOKENS_PATH=%UEMCP_PATH%\.git\info\forbidden-tokens"
set "CANDIDATES=%PROJECT_NAME%|%PARENT_DIR_NAME%"
node -e "const f=require('fs'),p=require('path');const tp=process.env.TOKENS_PATH;const cs=(process.env.CANDIDATES||'').split('|').filter(Boolean);const sl=new Set(['engine','ue5','unrealprojects','unrealengine','plugins','source','content','config','saved','game','unrealeditor','intermediate','binaries','deriveddatacache','programs','restricted','platforms','editor','build','target','public','private','default','local','staged','cooked','tools','batchfiles']);const sr=/^\d+(\.\d+)*$/;const hd=['# .git/info/forbidden-tokens - NDA codenames for this checkout.','# Per-checkout (under .git/), never tracked or pushed. Edit freely.','#','# Format: literal substrings (case-insensitive) by default; lines starting','# with regex: prefix use extended regex.','','# Target-project codenames (NDA-protected)'];let ph=null,ex=[],er=[];try{f.mkdirSync(p.dirname(tp),{recursive:true});}catch(e){}if(f.existsSync(tp)){const ls=f.readFileSync(tp,'utf8').split(/\r?\n/);if(ls.length&&ls[ls.length-1]==='')ls.pop();let bs=false;const hb=[];for(const l of ls){const t=l.trim();if(!bs){if(t===''||t.startsWith('#')){hb.push(l);continue;}bs=true;}if(t===''||t.startsWith('#'))continue;if(t.startsWith('regex:')){er.push(t);continue;}ex.push(t);}if(hb.length>0)ph=hb;}if(!ph)ph=hd;const seen=new Set(ex.map(l=>l.toLowerCase()));const add=[];for(const cR of cs){const c=(cR||'').trim();if(!c)continue;if(sr.test(c)){console.log('SKIP-VERSION: '+c);continue;}if(sl.has(c.toLowerCase())){console.log('SKIP-GENERIC: '+c);continue;}if(seen.has(c.toLowerCase())){console.log('Already registered: '+c);continue;}seen.add(c.toLowerCase());add.push(c);console.log('Added '+c+' to forbidden-tokens');}if(add.length>0){const all=[...ex,...add];const ds=new Set();const ded=[];for(const l of all){const k=l.toLowerCase();if(!ds.has(k)){ds.add(k);ded.push(l);}}ded.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));const out=[...ph,...ded];if(er.length>0){out.push('');out.push(...er);}const tmp=tp+'.uemcp-tmp';f.writeFileSync(tmp,out.join('\n')+'\n','utf8');f.renameSync(tmp,tp);}"
set "REG_EXIT=%errorlevel%"
endlocal & set "REG_EXIT=%REG_EXIT%"
if not "!REG_EXIT!"=="0" (
  echo [WARN] Codename registration returned exit !REG_EXIT!; continuing.
)
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

REM --- Enable UEMCP's required built-in plugin deps in target .uproject ---
REM Required plugins (real .uplugin files in UE 5.6):
REM   - RemoteControl       per D66/D77 (Layer 4 HYBRID transport)
REM   - PythonScriptPlugin  per D107 (Layer 0 IPythonScriptPlugin runtime check)
REM   - GeometryScripting   per D106 (procedural mesh tools)
REM
REM NOT a plugin (do NOT add to .uproject Plugins[]):
REM   - Blutility — engine-built-in MODULE at Engine/Source/Editor/Blutility/.
REM     Provides UEditorUtilityBlueprint / UEditorUtilityWidgetBlueprint headers
REM     used by UEMCP's editor-utility handlers (D107). The module is satisfied
REM     by Blutility in UEMCP.Build.cs PrivateDependencyModuleNames; it does
REM     NOT correspond to any .uplugin file. Adding "Blutility" to .uproject
REM     Plugins[] causes UE to surface the "Missing Plugin" dialog at editor
REM     startup ("This project requires the 'Blutility' plugin, which could
REM     not be found"). An earlier version of this script incorrectly added it;
REM     the cleanup list below removes the stale entry idempotently from any
REM     .uproject that ran the broken version.
REM
REM Idempotent: skips already-enabled, flips Enabled=false to true, appends
REM missing entries, removes stale-cleanup entries. Atomic write (temp +
REM Move-Item -Force) guards against partial-write corruption.
REM
REM Path passes via env var (avoids CMD quoting hazards on paths with
REM single-quotes or special chars; matches the .mcp.json node -e pattern
REM at line 295). PS emits a single-line result:
REM   CHANGED:   <deltas>   (write happened; +N=added, ~N=flipped,
REM                          =N=ok, -N=removed-stale)
REM   UNCHANGED: <deltas>   (idempotent skip; all required already correct)
REM   ERROR:     <message>  (read/parse/write failure -> EXIT_CODE 5)
echo.
echo Updating UEMCP plugin dependencies in !UPROJECT_FULL!...
set "PLUGIN_DEPS_UPROJECT=!UPROJECT_FULL!"
set "PLUGIN_DEPS_RESULT="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $p = $env:PLUGIN_DEPS_UPROJECT; $u = Get-Content -Raw $p | ConvertFrom-Json; $cur = @(); if ($u.PSObject.Properties.Match('Plugins').Count -and $null -ne $u.Plugins) { $cur = @($u.Plugins) }; $req = @('RemoteControl','PythonScriptPlugin','GeometryScripting'); $cleanup = @('Blutility'); $changed = $false; $rep = @(); $kept = @(); foreach ($entry in $cur) { if ($cleanup -contains $entry.Name) { $changed = $true; $rep += ('-' + $entry.Name) } else { $kept += $entry } }; $cur = $kept; foreach ($n in $req) { $e = $cur | Where-Object { $_.Name -eq $n } | Select-Object -First 1; if (-not $e) { $cur += [pscustomobject]@{ Name = $n; Enabled = $true }; $changed = $true; $rep += ('+' + $n) } elseif (-not $e.Enabled) { $e.Enabled = $true; $changed = $true; $rep += ('~' + $n) } else { $rep += ('=' + $n) } }; if ($changed) { if ($u.PSObject.Properties.Match('Plugins').Count) { $u.Plugins = $cur } else { $u | Add-Member -Name Plugins -Value $cur -MemberType NoteProperty }; $tmp = $p + '.uemcp-tmp'; $json = $u | ConvertTo-Json -Depth 32; [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false)); Move-Item -Force $tmp $p; Write-Output ('CHANGED: ' + ($rep -join ' ')) } else { Write-Output ('UNCHANGED: ' + ($rep -join ' ')) } } catch { Write-Output ('ERROR: ' + ($_.Exception.Message -replace '[\r\n]+', ' | ')) }"`) do set "PLUGIN_DEPS_RESULT=%%I"
if "!PLUGIN_DEPS_RESULT!"=="" (
  echo [ERROR] Plugin-deps PowerShell returned no output ^(unexpected^).
  set "EXIT_CODE=5" & goto :end
)
echo !PLUGIN_DEPS_RESULT! | findstr /B /C:"ERROR:" >nul
if not errorlevel 1 (
  echo [ERROR] !PLUGIN_DEPS_RESULT!
  echo         If the .uproject is read-only ^(Perforce / git checkout^),
  echo         check it out then re-run. Otherwise verify the JSON is valid.
  set "EXIT_CODE=5" & goto :end
)
echo [SUCCESS] Plugin deps: !PLUGIN_DEPS_RESULT!

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
