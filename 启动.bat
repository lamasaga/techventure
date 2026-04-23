@echo off
REM Use ASCII only in this file so CMD (GBK) never misparses UTF-8 bytes.
setlocal EnableExtensions
title TechVenture
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install Node and add it to PATH.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Running npm install ...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
)

echo.
echo TechVenture - open http://127.0.0.1:3780/admin.html
echo On phones use http://YOUR-PC-LAN-IP:3780/play.html
echo Press Ctrl+C to stop the server.
echo.

call npm run dev

echo.
pause
endlocal
