@echo off
cd /d "%~dp0"
node src\launch.mjs %*
if errorlevel 1 pause
