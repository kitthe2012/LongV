@echo off
echo Looking for the process listening on port 3030...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr LISTENING ^| findstr /R /C:":3030 "') do (
  echo Stopping process %%P
  taskkill /PID %%P /T /F >nul 2>&1
)
echo LongV stopped.
pause
