@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
if exist "runtime\node.exe" (
  set "CARESTUDIO_NODE=runtime\node.exe"
) else (
  where.exe node.exe >nul 2>nul
  if errorlevel 1 (
    echo Node.js 24 LTS was not found. Use the portable ZIP or install Node.js 24 LTS.
    pause
    popd
    exit /b 1
  )
  set "CARESTUDIO_NODE=node.exe"
)
"%CARESTUDIO_NODE%" server.js
set "CARESTUDIO_EXIT=%ERRORLEVEL%"
if not "%CARESTUDIO_EXIT%"=="0" pause
popd
exit /b %CARESTUDIO_EXIT%
