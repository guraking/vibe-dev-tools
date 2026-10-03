@echo off
cd /d "%~dp0"
node server.js --background || pause
