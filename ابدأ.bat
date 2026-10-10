@echo off
chcp 65001 >nul
title Skriblo - Local Server
cd /d "%~dp0"

if not exist "node_modules" (
  echo [1/2] Installing packages...
  call npm install --no-audit --no-fund
)

echo.
echo ============================================
echo   Skriblo game server is running
echo   Open:  http://localhost:3000
echo.
echo   To play with friends on other devices:
echo   give them:  http://YOUR-IP:3000
echo ============================================
echo.
node server.js
pause
