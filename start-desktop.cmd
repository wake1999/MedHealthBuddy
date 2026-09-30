@echo off
rem Launch dsh-ssh-desktop from the source tree (development build), using the
rem Electron runtime copied out of the project by setup-electron-runtime.cmd
rem (see that file for why it cannot run from inside the project).
setlocal
set "RUNTIME=%LOCALAPPDATA%\dsh-ssh-desktop-dev\electron"
set "PROJECT_DIST=%~dp0packages\desktop\node_modules\electron\dist"

if not exist "%RUNTIME%\electron.exe" (
  echo The Electron runtime has not been set up yet.
  echo Double-click setup-electron-runtime.cmd first, then run this again.
  pause
  exit /b 1
)

rem The copy must match the project's Electron version.
fc /b "%RUNTIME%\version" "%PROJECT_DIST%\version" >nul 2>&1
if errorlevel 1 (
  echo The project's Electron version changed since the runtime was copied.
  echo Double-click setup-electron-runtime.cmd again, then run this again.
  pause
  exit /b 1
)

start "" "%RUNTIME%\electron.exe" "%~dp0packages\desktop" %*
