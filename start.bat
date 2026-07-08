@echo off
REM ============================================================
REM  Start the collaborative to-do list AND its public tunnel.
REM  Double-click this file whenever you want the site online.
REM  Two windows will open: the server and the ngrok tunnel.
REM  Close those windows (or press Ctrl+C in them) to take it
REM  offline. Keep them open to stay online.
REM ============================================================

cd /d "%~dp0"

REM Lists runs on 3001 so it won't clash with other apps on 3000.
set PORT=3001

echo Starting the to-do server on port %PORT%...
start "Lists server" cmd /k "cd /d %~dp0 && set PORT=%PORT% && node server.js"

echo Starting the public link (ngrok) - forwarding to port %PORT%...
start "Lists tunnel" cmd /k "ngrok http --url=https://marital-quicksand-contend.ngrok-free.dev %PORT%"

echo.
echo Your list is coming online at:
echo    Local:  http://localhost:%PORT%
echo    Public: https://marital-quicksand-contend.ngrok-free.dev
echo.
echo Two windows opened (server + tunnel). Keep them open while you
echo want the site reachable. Close them to take it offline.
echo.
pause
