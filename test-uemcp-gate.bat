@echo off
setlocal

rem ============================================================================
rem test-uemcp-gate.bat — verify the D57 commandlet gate in UEMCP plugin
rem
rem Usage: test-uemcp-gate.bat [path-to-.uproject]
rem   Default project: D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject
rem
rem What it does:
rem   1. Checks that TCP:55558 is free before the test.
rem   2. Runs UnrealEditor-Cmd.exe -run=NullCommandlet against the target
rem      .uproject, capturing full log to %TEMP%\uemcp-gate-test.log.
rem   3. Greps the log for the D57 gate line.
rem
rem Expected on PASS:
rem   LogUEMCP: UEMCP: commandlet detected — TCP server suppressed (D57 gate)
rem ============================================================================

if "%~1"=="" (
    set "UPROJECT=D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject"
    echo [INFO] No .uproject arg passed — defaulting to ProjectA.
) else (
    set "UPROJECT=%~1"
)

set "UECMD=C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"

if not exist "%UECMD%" (
    echo [FAIL] UnrealEditor-Cmd.exe not found at: %UECMD%
    echo        Install UE 5.6 or edit UECMD path at top of this script.
    goto :end
)

if not exist "%UPROJECT%" (
    echo [FAIL] .uproject not found at: %UPROJECT%
    goto :end
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
) else (
    echo   [FAIL] No "commandlet detected" log line. Gate did not fire OR plugin did not load.
    echo   Inspect the full log manually: %TEMP%\uemcp-gate-test.log
)
echo.

echo Full log preserved at: %TEMP%\uemcp-gate-test.log

:end
echo.
pause
