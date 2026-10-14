@echo off
cd /d "%~dp0"
set PORT=3030
echo Starting LongV at http://127.0.0.1:3030
echo Keep this server window open to see errors and runtime logs.
start "LongV Server" /D "%~dp0" cmd /k "npm start"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:3030"
echo Browser opened. Use stop.bat to stop LongV.
pause
