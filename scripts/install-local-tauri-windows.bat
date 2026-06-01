@echo off
setlocal EnableExtensions EnableDelayedExpansion

if /I not "%OS%"=="Windows_NT" (
  echo Error: This script is for Windows only.
  exit /b 1
)

set "NO_LAUNCH=0"
set "SKIP_BUILD=0"

:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--no-launch" (
  set "NO_LAUNCH=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--skip-build" (
  set "SKIP_BUILD=1"
  shift
  goto :parse_args
)
echo Usage: %~nx0 [--skip-build] [--no-launch]
exit /b 1

:args_done
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%"
set "DESKTOP_DIR=%REPO_ROOT%packages\desktop"
if not exist "%DESKTOP_DIR%\src-tauri\tauri.conf.json" (
  set "REPO_ROOT=%SCRIPT_DIR%.."
  set "DESKTOP_DIR=%SCRIPT_DIR%..\packages\desktop"
)
set "TAURI_CONFIG=%DESKTOP_DIR%\src-tauri\tauri.conf.json"

if not exist "%TAURI_CONFIG%" (
  echo Error: Cannot find desktop package at %DESKTOP_DIR%
  exit /b 1
)

if "%SKIP_BUILD%"=="0" (
  echo Building desktop frontend and Windows sidecars...
  call "%DESKTOP_DIR%\scripts\build-windows.bat"
  if errorlevel 1 exit /b %ERRORLEVEL%

  echo Building Tauri app in release mode ^(unsigned NSIS^)...
  pushd "%DESKTOP_DIR%" || exit /b 1
  if not exist "node_modules\@tauri-apps\cli\tauri.js" (
    popd
    echo Error: Cannot find Tauri CLI. Run pnpm install first.
    exit /b 1
  )
  node "node_modules\@tauri-apps\cli\tauri.js" build --no-sign --bundles nsis --config "src-tauri\tauri.local-windows.conf.json"
  set "BUILD_EXIT=!ERRORLEVEL!"
  popd
  if not "!BUILD_EXIT!"=="0" exit /b !BUILD_EXIT!
)

set "BUNDLE_DIR=%DESKTOP_DIR%\src-tauri\target\release\bundle\nsis"
if not exist "%BUNDLE_DIR%" (
  echo Error: Built installer directory not found at %BUNDLE_DIR%
  exit /b 1
)

set "INSTALLER="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%BUNDLE_DIR%' -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"`) do set "INSTALLER=%%F"

if not defined INSTALLER (
  echo Error: Built installer not found in %BUNDLE_DIR%
  exit /b 1
)

echo Installing with %INSTALLER%...
"%INSTALLER%" /S
if errorlevel 1 (
  echo Error: Installer failed with exit code %ERRORLEVEL%
  exit /b %ERRORLEVEL%
)

set "INSTALL_LOCATION="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\YepAnywhere" /v InstallLocation 2^>nul ^| findstr /I "InstallLocation"') do set "INSTALL_LOCATION=%%B"
set "INSTALL_LOCATION=%INSTALL_LOCATION:"=%"

set "APP_EXE="
if defined INSTALL_LOCATION (
  for %%P in ("%INSTALL_LOCATION%\yep-anywhere-desktop.exe" "%INSTALL_LOCATION%\Yep Anywhere.exe" "%INSTALL_LOCATION%\YepAnywhere.exe") do (
    if not defined APP_EXE if exist "%%~P" set "APP_EXE=%%~fP"
  )
)

for %%P in ("%LOCALAPPDATA%\YepAnywhere\yep-anywhere-desktop.exe" "%LOCALAPPDATA%\Programs\YepAnywhere\Yep Anywhere.exe" "%LOCALAPPDATA%\Programs\YepAnywhere\YepAnywhere.exe" "%LOCALAPPDATA%\Programs\Yep Anywhere\Yep Anywhere.exe" "%LOCALAPPDATA%\Programs\Yep Anywhere\YepAnywhere.exe") do (
  if not defined APP_EXE if exist "%%~P" set "APP_EXE=%%~fP"
)

if not defined APP_EXE (
  echo Error: Installed app executable not found.
  exit /b 1
)

echo Installed: %APP_EXE%

if "%NO_LAUNCH%"=="0" (
  echo Launching Yep Anywhere...
  start "" "%APP_EXE%"
)

exit /b 0
