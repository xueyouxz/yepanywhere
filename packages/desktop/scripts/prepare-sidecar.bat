@echo off
setlocal EnableExtensions

if /I not "%OS%"=="Windows_NT" (
  echo Error: This script is for Windows only. Use scripts\prepare-sidecar.sh on Unix.
  exit /b 1
)

set "BUN_VERSION=1.2.17"
set "SCRIPT_DIR=%~dp0"
set "BIN_DIR=%SCRIPT_DIR%..\src-tauri\binaries"

if defined TARGET_TRIPLE (
  set "TRIPLE=%TARGET_TRIPLE%"
) else (
  for /f "usebackq delims=" %%T in (`rustc --print host-tuple`) do set "TRIPLE=%%T"
)

if "%TRIPLE%"=="x86_64-pc-windows-msvc" (
  set "BUN_ASSET=bun-windows-x64"
) else (
  echo Error: Unsupported triple: %TRIPLE%
  exit /b 1
)

set "BUN_BIN=%BIN_DIR%\bun-%TRIPLE%.exe"
if exist "%BUN_BIN%" (
  echo Bun already present for %TRIPLE%
  exit /b 0
)

mkdir "%BIN_DIR%" >nul 2>nul

set "URL=https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/%BUN_ASSET%.zip"
set "TMP_DIR=%TEMP%\yep-bun-%RANDOM%-%RANDOM%"
mkdir "%TMP_DIR%" || exit /b 1

echo Downloading Bun %BUN_VERSION% for %TRIPLE%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%URL%' -OutFile '%TMP_DIR%\bun.zip' -UseBasicParsing"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%TMP_DIR%\bun.zip' -DestinationPath '%TMP_DIR%' -Force"
if errorlevel 1 goto :fail

if not exist "%TMP_DIR%\%BUN_ASSET%\bun.exe" (
  echo Error: Downloaded archive did not contain %TMP_DIR%\%BUN_ASSET%\bun.exe
  goto :fail
)

copy /Y "%TMP_DIR%\%BUN_ASSET%\bun.exe" "%BUN_BIN%" >nul
if errorlevel 1 goto :fail

rmdir /S /Q "%TMP_DIR%" >nul 2>nul
echo Bun %BUN_VERSION% ready for %TRIPLE% -^> %BUN_BIN%
exit /b 0

:fail
set "EXIT_CODE=%ERRORLEVEL%"
rmdir /S /Q "%TMP_DIR%" >nul 2>nul
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
exit /b %EXIT_CODE%
