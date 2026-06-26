@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js が見つかりません。
  echo      https://nodejs.org/ から「LTS」版をインストールして、
  echo      パソコンを一度再起動してから、もう一度このファイルをダブルクリックしてください。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 初回の準備をしています（数分かかります。そのままお待ちください）...
  call npm install
  if errorlevel 1 (
    echo.
    echo  [!] 準備に失敗しました。この画面の文字をそのまま石井さんに送ってください。
    echo.
    pause
    exit /b 1
  )
)

if not exist "dist" (
  echo 画面を組み立てています...
  call npm run build
  if errorlevel 1 (
    echo.
    echo  [!] 組み立てに失敗しました。この画面の文字をそのまま石井さんに送ってください。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Ibis Hub を起動します...
echo   ブラウザで http://localhost:9100 が自動で開きます。
echo   （この黒い画面は閉じないでください。閉じるとアプリも止まります）
echo.

start "" "http://localhost:9100"
node server.mjs
pause
