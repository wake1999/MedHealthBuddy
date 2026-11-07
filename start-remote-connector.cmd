@echo off
setlocal
rem Remote connector shell: wraps a DSH / Hermes / Studio server reachable
rem through system SSH. This is not the current Studio desktop app.
rem
rem The connector runtime is prepared by setup-electron-runtime.cmd.

set "RUNTIME=%LOCALAPPDATA%\medhealthbuddy-dev\electron"
set "PROJECT_DIST=%~dp0packages\desktop\node_modules\electron\dist"
set "LAUNCHER=%RUNTIME%\MedHealthBuddy.exe"
if not exist "%LAUNCHER%" set "LAUNCHER=%RUNTIME%\electron.exe"

if not exist "%RUNTIME%\electron.exe" (
  echo The Electron runtime has not been set up yet.
  echo Double-click setup-electron-runtime.cmd first, then run this again.
  pause
  exit /b 1
)

rem The copied runtime must match the project's Electron version.
fc /b "%RUNTIME%\version" "%PROJECT_DIST%\version" >nul 2>&1
if errorlevel 1 (
  echo The project's Electron version changed since the runtime was copied.
  echo Double-click setup-electron-runtime.cmd again, then run this again.
  pause
  exit /b 1
)

echo Launching MedHealthBuddy remote connector ...
start "" "%LAUNCHER%" "%~dp0packages\desktop" %*
endlocal
