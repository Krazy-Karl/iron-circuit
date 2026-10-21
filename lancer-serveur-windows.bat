@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Iron Circuit - serveur LAN
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js n est pas installe sur ce PC.
  echo   Telecharge la version LTS sur https://nodejs.org puis relance ce fichier.
  echo.
  pause
  exit /b 1
)
node server.js %*
pause
