@echo off
rem Copy the Electron runtime out of the project, once per Electron version.
rem
rem Why: this workspace carries a Low mandatory integrity label (inherited from
rem the agent sandbox's working directory). An .exe inside it starts at Low
rem integrity, where Chromium cannot set up its own sandbox (it crashes with
rem 0x80000003, even for --version) and cannot write %APPDATA% or %TEMP%.
rem A copy made by you, outside the labelled tree, runs at your normal level
rem with the sandbox on. Run this by double-clicking it in Explorer.
setlocal
set "SRC=%~dp0packages\desktop\node_modules\electron\dist"
set "DST=%LOCALAPPDATA%\dsh-ssh-desktop-dev\electron"

if not exist "%SRC%\electron.exe" (
  echo Electron is not installed in the project: %SRC%
  goto :fail
)

echo Copying %SRC%
echo      to %DST%
robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS /NP
if %errorlevel% GEQ 8 (
  echo The copy failed, robocopy exit code %errorlevel%.
  goto :fail
)

echo.
echo Checking that it starts with the sandbox on:
"%DST%\electron.exe" --version
if errorlevel 1 (
  echo Electron still fails to start from %DST%.
  goto :fail
)

echo.
echo Done. Start the app with start-desktop.cmd.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
