@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "config.json" (
  if exist "config.example.json" copy /y "config.example.json" "config.json" >nul
  echo.
  echo   First run: edit config.json and set "apiKey" to your DeepSeek API key,
  echo   or set the DEEPSEEK_API_KEY environment variable.
  echo.
  pause
  exit /b 1
)

node server.mjs %*
if errorlevel 1 pause
