@echo off
setlocal
cd /d "%~dp0apps\electron"
set "HIDOCK_RECOVERY_MODE=1"
if not exist "node_modules\electron\dist\electron.exe" exit /b 1
if not exist "out\main\index.js" exit /b 1
echo HiDock recovery: software rendering, no automatic device connection,
echo no background processing, no local embedding model. Settings are preserved.
echo This bounded diagnostic closes HiDock after five minutes.
echo Close any existing HiDock instance before starting this test.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\diagnostics\guarded-process.ps1" -Executable "%CD%\node_modules\electron\dist\electron.exe" -Arguments ". --recovery-mode" -WorkingDirectory "%CD%" -Seconds 300 -Output "%TEMP%\hidock-recovery-memory.jsonl"
exit /b %errorlevel%
