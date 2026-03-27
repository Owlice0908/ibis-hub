@echo off
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
)

if not exist "dist" (
  echo Building...
  call npm run build
)

echo.
echo   Ibis Hub starting...
echo   http://localhost:9100
echo.

start "" "http://localhost:9100"
node server.mjs
