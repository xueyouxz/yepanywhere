@echo off
setlocal EnableExtensions

if /I not "%OS%"=="Windows_NT" (
  echo Error: This script is for Windows only.
  exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "DESKTOP_DIR=%SCRIPT_DIR%.."

call "%SCRIPT_DIR%prepare-sidecar.bat"
if errorlevel 1 exit /b %ERRORLEVEL%

set "TSC=%DESKTOP_DIR%\node_modules\typescript\lib\tsc.js"
set "VITE=%DESKTOP_DIR%\node_modules\vite\bin\vite.js"

if not exist "%TSC%" (
  echo Error: Cannot find TypeScript compiler at %TSC%. Run pnpm install first.
  exit /b 1
)

if not exist "%VITE%" (
  echo Error: Cannot find Vite CLI at %VITE%. Run pnpm install first.
  exit /b 1
)

pushd "%DESKTOP_DIR%" || exit /b 1
node "%TSC%"
set "BUILD_EXIT=%ERRORLEVEL%"
if not "%BUILD_EXIT%"=="0" (
  popd
  exit /b %BUILD_EXIT%
)

node "%VITE%" build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
exit /b %BUILD_EXIT%
