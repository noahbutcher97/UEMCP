@echo off
setlocal
pushd "%~dp0server"
if "%~1"=="" (
  node run-live-smoke.mjs --targets-first
) else (
  node run-live-smoke.mjs %*
)
set EXITCODE=%ERRORLEVEL%
popd
echo.
echo smoke-live finished with exit code %EXITCODE%.
pause
exit /b %EXITCODE%
