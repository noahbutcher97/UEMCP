@echo off
setlocal EnableDelayedExpansion

rem ============================================================================
rem test-uemcp-gate.bat — verify the D57 commandlet gate in UEMCP plugin
rem
rem Usage: test-uemcp-gate.bat [<path-to-.uproject>]
rem   With arg:    runs against that .uproject (scripted mode, no pause).
rem   Without arg: opens GUI file-picker; pauses before exit so you can
rem                read the result when launched from Explorer (double-click).
rem
rem What it does:
rem   1. Checks that TCP:55558 is free before the test.
rem   2. Runs UnrealEditor-Cmd.exe -run=NullCommandlet against the target
rem      .uproject, capturing full log to %TEMP%\uemcp-gate-test.log.
rem   3. Greps the log for the D57 gate line.
rem
rem Expected on PASS:
rem   LogUEMCP: UEMCP: commandlet detected — TCP server suppressed (D57 gate)
rem
rem Exit codes: 0 PASS, 1 missing UE binary or .uproject,
rem             2 gate did not fire (FAIL), 3 user cancelled GUI picker.
rem
rem Per CLAUDE.md §.bat convention: AUTO_YES=1 when arg passed (scripted),
rem AUTO_YES=0 when no arg (interactive — pauses before exit).
rem ============================================================================

set "AUTO_YES=1"
if "%~1"=="" set "AUTO_YES=0"
set "EXIT_CODE=0"

if "%~1"=="" (
    echo Opening .uproject file picker...
    for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Unreal Project|*.uproject'; $f.Title = 'Select the .uproject to run the D57 gate test against'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName } else { 'CANCELLED_PROJECT' }"`) do set "UPROJECT=%%I"
    if "!UPROJECT!"=="CANCELLED_PROJECT" (
        echo [INFO] .uproject selection cancelled. Exiting.
        set "EXIT_CODE=3" & goto :end
    )
    if "!UPROJECT!"=="" (
        echo [FAIL] No .uproject path returned from dialog.
        set "EXIT_CODE=1" & goto :end
    )
) else (
    set "UPROJECT=%~1"
)

set "UECMD=C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"

if not exist "%UECMD%" (
    echo [FAIL] UnrealEditor-Cmd.exe not found at: %UECMD%
    echo        Install UE 5.6 or edit UECMD path at top of this script.
    set "EXIT_CODE=1" & goto :end
)

if not exist "%UPROJECT%" (
    echo [FAIL] .uproject not found at: %UPROJECT%
    set "EXIT_CODE=1" & goto :end
)

echo.
echo === UEMCP D57 commandlet gate test ===
echo Project: %UPROJECT%
echo.

echo Step 1: Verifying port 55558 is free before commandlet run...
netstat -ano | findstr :55558
if %ERRORLEVEL%==0 (
    echo   [WARN] Port 55558 is already bound. Close editor or whatever is using it before running this test.
) else (
    echo   [OK] Port 55558 is free.
)
echo.

echo Step 2: Running commandlet (expect 5-17s; looking for D57 gate log)...
echo.

"%UECMD%" ^
 "%UPROJECT%" ^
 -run=NullCommandlet ^
 -unattended ^
 -nop4 ^
 -nosplash ^
 -LogCmds="LogUEMCP Verbose, LogPluginManager Verbose" ^
 -stdout > "%TEMP%\uemcp-gate-test.log" 2>&1

echo.
echo Commandlet exited with code %ERRORLEVEL%.
echo.

echo Step 3: Searching log for UEMCP lines...
findstr /C:"UEMCP" "%TEMP%\uemcp-gate-test.log"
echo.

echo === Result ===
findstr /C:"commandlet detected" "%TEMP%\uemcp-gate-test.log" >nul
if %ERRORLEVEL%==0 (
    echo   [PASS] D57 gate fired. TCP server was suppressed.
    set "EXIT_CODE=0"
) else (
    echo   [FAIL] No "commandlet detected" log line. Gate did not fire OR plugin did not load.
    echo   Inspect the full log manually: %TEMP%\uemcp-gate-test.log
    set "EXIT_CODE=2"
)
echo.

echo Full log preserved at: %TEMP%\uemcp-gate-test.log
goto :end

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [Gate exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
