@echo off
REM sync-plugin.bat — propagate UEMCP plugin source to a target UE project.
REM Usage: sync-plugin.bat "<path-to-.uproject>" [-y|--yes] [--force-clean] [--no-marker]
REM   or:  sync-plugin.bat                          (GUI dialog for .uproject)
REM
REM Copies D:\DevTools\UEMCP\plugin\UEMCP\ to <uproject parent>\Plugins\UEMCP\,
REM excluding Binaries\ and Intermediate\ (those live per-project).
REM
REM Why this exists (D61): physical xcopy is the working dev workflow for
REM plugin propagation; symlinks, junctions, and AdditionalPluginDirectories
REM all had failure modes (commandlet discovery, UBT staleness). This script
REM automates that one operation so plugin workers don't re-hit the friction.
REM
REM W-L (D138) hardening:
REM   - Per-workspace editor-lock detection — replaces the coarse "any
REM     UnrealEditor.exe → abort" check with a Get-CimInstance Win32_Process
REM     CommandLine match against THIS sync's target .uproject. A sync
REM     against workspace B is no longer blocked by an editor running
REM     against workspace A.
REM   - Upgrade-cache auto-bust — writes a deploy marker after each successful
REM     sync recording manifest version + uplugin Version + commit SHAs. On
REM     the next sync, compares incoming versions; mismatch → auto-nukes
REM     <dest>/Binaries + <dest>/Intermediate before xcopy so UBT does a
REM     clean rebuild against the structural change. D61's procedural
REM     nuke-rebuild hint becomes structural.
REM
REM Flags:
REM   -y / --yes      auto-confirm overwrite + skip exit pause (scripted use)
REM   --force-clean   nuke <dest>/Binaries + <dest>/Intermediate regardless of
REM                   marker comparison; useful for debugging stale-cache states
REM   --no-marker     skip marker read/write entirely (escape hatch if marker
REM                   logic itself is buggy in future)
REM
REM Exit codes: 0 success, 1 bad args / validation / editor locked,
REM             2 xcopy failure, 3 user declined overwrite.

setlocal EnableDelayedExpansion

REM --- Pause-on-exit unless -y/--yes (scripted use) ---
REM Without this, double-click + error paths close the window before user
REM can read output. Same class as setup-uemcp.bat had (D78-era).
set "EXIT_CODE=0"

REM --- Detect UEMCP repo location (this script's directory) ---
set "UEMCP_PATH=%~dp0"
if "!UEMCP_PATH:~-1!"=="\" set "UEMCP_PATH=!UEMCP_PATH:~0,-1!"

REM --- Parse args: first non-flag is the .uproject; flags toggle behavior ---
set "PROJECT_ARG="
set "AUTO_YES=0"
set "FORCE_CLEAN=0"
set "NO_MARKER=0"
:parse_args
if "%~1"=="" goto :parse_done
if /i "%~1"=="-y" (
  set "AUTO_YES=1"
  shift
  goto :parse_args
)
if /i "%~1"=="--yes" (
  set "AUTO_YES=1"
  shift
  goto :parse_args
)
if /i "%~1"=="--force-clean" (
  set "FORCE_CLEAN=1"
  shift
  goto :parse_args
)
if /i "%~1"=="--no-marker" (
  set "NO_MARKER=1"
  shift
  goto :parse_args
)
if "!PROJECT_ARG!"=="" (
  set "PROJECT_ARG=%~1"
  shift
  goto :parse_args
)
echo [ERROR] Unexpected extra arg: %~1
set "EXIT_CODE=1" & goto :end
:parse_done

REM --- No arg: GUI picker (reuse setup-uemcp.bat pattern) ---
if "!PROJECT_ARG!"=="" (
  echo Opening .uproject file picker...
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Unreal Project|*.uproject'; $f.Title = 'Select the .uproject to sync UEMCP plugin into'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName } else { 'CANCELLED_PROJECT' }"`) do set "PROJECT_ARG=%%I"
  if "!PROJECT_ARG!"=="CANCELLED_PROJECT" (
    echo [INFO] .uproject selection cancelled. Exiting.
    set "EXIT_CODE=1" & goto :end
  )
)

REM Strip any surrounding quotes from arg or GUI output.
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
  set "EXIT_CODE=1" & goto :end
)

set "UPROJECT_DIR=!UPROJECT_DIR_RAW!"
if "!UPROJECT_DIR:~-1!"=="\" set "UPROJECT_DIR=!UPROJECT_DIR:~0,-1!"

REM Smoke-check this is a real UE project directory.
if not exist "!UPROJECT_DIR!\Content\" (
  echo [ERROR] !UPROJECT_DIR!\Content\ not found — doesn't look like a UE project.
  set "EXIT_CODE=1" & goto :end
)

REM --- Auto-register project codenames into NDA forbidden-tokens block-list ---
REM Mirrors setup-uemcp.bat — sync-plugin.bat is the other universal entry
REM point where new projects enter UEMCP's deployment surface, so any new
REM .uproject this script touches must also auto-register its codename.
REM Idempotent + sorted dedup; skips generic UE / version-folder names.
REM See setup-uemcp.bat for full rationale + standing NDA-scope policy.
for %%I in ("!UPROJECT_DIR!\..") do set "PARENT_DIR_FULL=%%~fI"
if "!PARENT_DIR_FULL:~-1!"=="\" set "PARENT_DIR_FULL=!PARENT_DIR_FULL:~0,-1!"
for %%I in ("!PARENT_DIR_FULL!") do set "PARENT_DIR_NAME=%%~nxI"
node --version >nul 2>&1
if errorlevel 1 (
  echo [WARN] Node.js not on PATH; skipping codename registration.
  echo        Install Node + run setup-uemcp.bat once to populate forbidden-tokens.
  goto :codename_reg_done
)
echo Registering project codenames in NDA forbidden-tokens block-list...
REM CMD-quoting: nest a DisableDelayedExpansion scope so `!` (JS not-op) and
REM `^` (JS regex anchor) inside the node -e body are literal during CMD's
REM scan. See setup-uemcp.bat for full rationale.
setlocal DisableDelayedExpansion
set "TOKENS_PATH=%UEMCP_PATH%\.git\info\forbidden-tokens"
set "CANDIDATES=%PROJECT_NAME%|%PARENT_DIR_NAME%"
node -e "const f=require('fs'),p=require('path');const tp=process.env.TOKENS_PATH;const cs=(process.env.CANDIDATES||'').split('|').filter(Boolean);const sl=new Set(['engine','ue5','unrealprojects','unrealengine','plugins','source','content','config','saved','game','unrealeditor','intermediate','binaries','deriveddatacache','programs','restricted','platforms','editor','build','target','public','private','default','local','staged','cooked','tools','batchfiles']);const sr=/^\d+(\.\d+)*$/;const hd=['# .git/info/forbidden-tokens - NDA codenames for this checkout.','# Per-checkout (under .git/), never tracked or pushed. Edit freely.','#','# Format: literal substrings (case-insensitive) by default; lines starting','# with regex: prefix use extended regex.','','# Target-project codenames (NDA-protected)'];let ph=null,ex=[],er=[];try{f.mkdirSync(p.dirname(tp),{recursive:true});}catch(e){}if(f.existsSync(tp)){const ls=f.readFileSync(tp,'utf8').split(/\r?\n/);if(ls.length&&ls[ls.length-1]==='')ls.pop();let bs=false;const hb=[];for(const l of ls){const t=l.trim();if(!bs){if(t===''||t.startsWith('#')){hb.push(l);continue;}bs=true;}if(t===''||t.startsWith('#'))continue;if(t.startsWith('regex:')){er.push(t);continue;}ex.push(t);}if(hb.length>0)ph=hb;}if(!ph)ph=hd;const seen=new Set(ex.map(l=>l.toLowerCase()));const add=[];for(const cR of cs){const c=(cR||'').trim();if(!c)continue;if(sr.test(c)){console.log('SKIP-VERSION: '+c);continue;}if(sl.has(c.toLowerCase())){console.log('SKIP-GENERIC: '+c);continue;}if(seen.has(c.toLowerCase())){console.log('Already registered: '+c);continue;}seen.add(c.toLowerCase());add.push(c);console.log('Added '+c+' to forbidden-tokens');}if(add.length>0){const all=[...ex,...add];const ds=new Set();const ded=[];for(const l of all){const k=l.toLowerCase();if(!ds.has(k)){ds.add(k);ded.push(l);}}ded.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));const out=[...ph,...ded];if(er.length>0){out.push('');out.push(...er);}const tmp=tp+'.uemcp-tmp';f.writeFileSync(tmp,out.join('\n')+'\n','utf8');f.renameSync(tmp,tp);}"
set "REG_EXIT=%errorlevel%"
endlocal & set "REG_EXIT=%REG_EXIT%"
if not "!REG_EXIT!"=="0" (
  echo [WARN] Codename registration returned exit !REG_EXIT!; continuing.
)
:codename_reg_done

REM --- Compute source + target paths ---
set "PLUGIN_SRC=!UEMCP_PATH!\plugin\UEMCP"
set "PLUGIN_DEST=!UPROJECT_DIR!\Plugins\UEMCP"

if not exist "!PLUGIN_SRC!" (
  echo [ERROR] Plugin source not found at !PLUGIN_SRC!
  set "EXIT_CODE=1" & goto :end
)

echo.
echo UEMCP repo    : !UEMCP_PATH!
echo Project       : !PROJECT_NAME!
echo Source        : !PLUGIN_SRC!
echo Target        : !PLUGIN_DEST!
echo.

REM --- Per-workspace editor-lock detection (W-L / D138) ---
REM Replaces the prior coarse "any UnrealEditor.exe → abort" check with a
REM per-workspace match: only abort if an editor is running with THIS sync's
REM .uproject in its CommandLine. A sync against workspace B should not be
REM blocked by an editor running against workspace A. Mirrors verify-deploy
REM .mjs's [EDITOR-LOCKED] discrimination logic via shared listEditorProcesses
REM + extractUprojectFromCommandLine + normalizePath helpers.
REM
REM Exit codes from helper: 0 = clear, 1 = locked (DLL exists + matched editor),
REM 2 = warn (matched editor but no DLL — sync source still safe).
set "DLL_PATH=!PLUGIN_DEST!\Binaries\Win64\UnrealEditor-UEMCP.dll"
node --version >nul 2>&1
if errorlevel 1 (
  echo [WARN] Node.js not on PATH; falling back to coarse editor-lock check.
  tasklist /FI "IMAGENAME eq UnrealEditor.exe" 2>nul | findstr /I "UnrealEditor.exe" >nul
  if not errorlevel 1 (
    if exist "!DLL_PATH!" (
      echo [ERROR] UnrealEditor.exe is running and plugin DLL exists at target.
      echo         Close Unreal Editor and re-run this script.
      set "EXIT_CODE=1" & goto :end
    )
    echo [WARN] UnrealEditor.exe is running but no plugin DLL at target yet.
    echo        Sync will proceed; restart the editor after to load the plugin.
    echo.
  )
) else (
  node "!UEMCP_PATH!\server\sync-plugin-helper.mjs" lock-check "!UPROJECT_FULL!"
  set "LOCK_EXIT=!errorlevel!"
  if "!LOCK_EXIT!"=="1" (
    echo [ERROR] UnrealEditor.exe is running AGAINST THIS WORKSPACE; DLL is locked.
    echo         Close that editor and re-run this script.
    set "EXIT_CODE=1" & goto :end
  )
  if "!LOCK_EXIT!"=="2" (
    echo [WARN] Editor running against this workspace but no DLL at target yet.
    echo        Sync will proceed; restart the editor after to load the plugin.
    echo.
  )
  REM LOCK_EXIT 0 = clear; either no editor at all OR editor against a different workspace.
)

REM --- Prompt before overwriting existing plugin dir ---
if exist "!PLUGIN_DEST!" (
  if "!AUTO_YES!"=="0" (
    echo Plugin already installed at !PLUGIN_DEST!.
    set "CONFIRM="
    set /p "CONFIRM=Overwrite? [y/N]: "
    if /i not "!CONFIRM!"=="y" (
      echo Aborted. Existing plugin preserved.
      set "EXIT_CODE=3" & goto :end
    )
  ) else (
    echo Overwriting existing plugin at !PLUGIN_DEST! [auto-yes].
  )

  REM Remove only source-controlled subdirs so we don't nuke Binaries/Intermediate
  REM (those are UBT output the user may want preserved for an incremental build).
  if exist "!PLUGIN_DEST!\Source\" rmdir /s /q "!PLUGIN_DEST!\Source"
  if exist "!PLUGIN_DEST!\UEMCP.uplugin" del /q "!PLUGIN_DEST!\UEMCP.uplugin"
)

REM --- Upgrade-cache auto-bust via deploy marker (W-L / D138) ---
REM Read the prior deploy marker (if any) and compare manifest + uplugin
REM versions against the incoming repo state. On mismatch (or --force-clean),
REM nuke <dest>/Binaries + <dest>/Intermediate before xcopy so UBT does a
REM clean rebuild against the structural change. First sync after W-L
REM lands has no prior marker → no nuke (preserves any hand-built cache).
REM
REM Helper exit codes: 0 = no nuke needed, 10 = NUKE recommended, 1 = error.
set "NUKE_REASON="
if "!NO_MARKER!"=="1" (
  echo [INFO] --no-marker: skipping deploy-marker check.
) else if "!FORCE_CLEAN!"=="1" (
  set "NUKE_REASON=--force-clean flag"
) else (
  node --version >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Node.js not on PATH; skipping deploy-marker check.
  ) else (
    node "!UEMCP_PATH!\server\sync-plugin-helper.mjs" check "!PLUGIN_DEST!" "!UEMCP_PATH!"
    set "MARKER_EXIT=!errorlevel!"
    if "!MARKER_EXIT!"=="10" (
      set "NUKE_REASON=manifest/uplugin version changed"
    ) else if not "!MARKER_EXIT!"=="0" (
      echo [WARN] Marker check failed (exit !MARKER_EXIT!); continuing without nuke.
    )
  )
)

if defined NUKE_REASON (
  echo.
  echo [INFO] Clearing cached Binaries + Intermediate before sync ^(reason: !NUKE_REASON!^).
  if exist "!PLUGIN_DEST!\Binaries\" rmdir /s /q "!PLUGIN_DEST!\Binaries"
  if exist "!PLUGIN_DEST!\Intermediate\" rmdir /s /q "!PLUGIN_DEST!\Intermediate"
  echo.
)

REM --- Build xcopy exclude file in %TEMP% ---
REM xcopy /EXCLUDE: matches these substrings against the full source path, so
REM wrapping each with backslashes anchors them to directory boundaries.
set "EXCLUDE_FILE=%TEMP%\uemcp-sync-exclude.txt"
> "!EXCLUDE_FILE!" echo \Binaries\
>> "!EXCLUDE_FILE!" echo \Intermediate\

echo Copying plugin source (excluding Binaries\, Intermediate\)...
xcopy /E /I /Y /Q /EXCLUDE:!EXCLUDE_FILE! "!PLUGIN_SRC!" "!PLUGIN_DEST!" >nul
set "XCOPY_EXIT=!errorlevel!"
del /q "!EXCLUDE_FILE!" >nul 2>&1

if not "!XCOPY_EXIT!"=="0" (
  echo [ERROR] xcopy failed with exit code !XCOPY_EXIT!.
  set "EXIT_CODE=2" & goto :end
)

REM --- Write deploy marker post-sync (W-L / D138) ---
REM Records manifest version + uplugin Version + commit SHAs at <dest>/
REM .uemcp-deploy-marker.json. Subsequent syncs read this back and compare
REM against the new incoming repo state. Atomic write (.uemcp-tmp + rename)
REM so a partial-write failure can't corrupt the marker.
if "!NO_MARKER!"=="1" (
  echo [INFO] --no-marker: skipping marker write.
) else (
  node --version >nul 2>&1
  if errorlevel 1 (
    echo [WARN] Node.js not on PATH; skipping marker write.
  ) else (
    node "!UEMCP_PATH!\server\sync-plugin-helper.mjs" write "!PLUGIN_DEST!" "!UEMCP_PATH!"
    if errorlevel 1 (
      echo [WARN] Marker write failed; sync still succeeded.
    )
  )
)

echo [SUCCESS] Plugin synced to !PLUGIN_DEST!.
echo.
echo ----------------------------------------------------------------------
echo D61 nuke-rebuild hint (W-L / D138 auto-busts version-change cases):
echo.
echo Version-change cleanup is now AUTOMATIC: when manifest.json version OR
echo UEMCP.uplugin Version differs from the prior deploy marker, this script
echo nukes Binaries + Intermediate before xcopy. The marker lives at
echo   !PLUGIN_DEST!\.uemcp-deploy-marker.json
echo Use --force-clean to nuke regardless of marker comparison.
echo.
echo Manual nuke is still useful for rare cases the marker doesn't catch
echo (e.g., UBT cache corruption from a prior failed build):
echo.
echo   rmdir /s /q "!PLUGIN_DEST!\Binaries"
echo   rmdir /s /q "!PLUGIN_DEST!\Intermediate"
echo   "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" !PROJECT_NAME!Editor Win64 Development -project="!UPROJECT_FULL!" -WaitMutex
echo.
echo If only .cpp bodies changed, a normal editor Live Coding or hot reload
echo should suffice; no nuke needed.
echo ----------------------------------------------------------------------
set "EXIT_CODE=0"
goto :end

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [Sync exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
