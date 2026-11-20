@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
where.exe node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 LTS and try again.
  pause
  exit /b 1
)
node.exe server.js
if errorlevel 1 (
  pause
  exit /b 1
)
