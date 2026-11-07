@echo off
setlocal EnableExtensions

rem Unified launcher for the current Studio desktop application.
rem
rem   start-studio.cmd            local mode (default)
rem   start-studio.cmd local      local bundled server on 127.0.0.1:8748
rem   start-studio.cmd remote     SSH tunnel + remote Studio on 127.0.0.1:8648
rem
rem Local mode also supports remote devices through the app's device manager.
rem Remote mode is only a convenience shortcut for the SSH-tunnel path.

set "MODE=%~1"
if not defined MODE set "MODE=local"
if /I "%MODE%"=="local" goto local
if /I "%MODE%"=="remote" goto remote

echo Usage: start-studio.cmd [local^|remote]
exit /b 2

:local
set "APP=%~dp0studio\packages\desktop"
call :resolve_electron
if errorlevel 1 exit /b 1

rem Keep the Web UI data next to the program instead of %USERPROFILE%.
set "HERMES_WEB_UI_HOME=%~dp0data\hermes-web-ui"
set "HERMES_WEBUI_STATE_DIR=%~dp0data\hermes-web-ui"

if not exist "%~dp0studio\dist\server\index.js" (
  echo studio/dist is missing. Run: cd /d "%~dp0studio" ^&^& npm run build
  exit /b 1
)
if not exist "%APP%\resources\node\win-x64\node.exe" (
  echo Bundled node runtime is missing. Run: cd /d "%APP%" ^&^& npm run fetch:node
)

start "" "%ELECTRON%" "%APP%"
exit /b 0

:remote
set "SRV="
if exist "%~dp0.deploy.local" (
  for /f "usebackq delims=" %%a in ("%~dp0.deploy.local") do if not defined SRV set "SRV=%%a"
)
if not defined SRV (
  echo No server configured: put a line like user@host into .deploy.local
  exit /b 1
)

set "APP=%~dp0studio\packages\desktop"
call :resolve_electron
if errorlevel 1 exit /b 1

echo Starting SSH tunnel to %SRV% (local 8648 -^> remote 8648) ...
start "" /min ssh -N -L 8648:127.0.0.1:8648 %SRV%

echo Waiting for the tunnel ...
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8648/health/ready' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 700 }; exit 1"
if errorlevel 1 (
  echo The tunnel did not come up - check that the Studio server is running on 8648.
  exit /b 1
)

set "EKKO_STUDIO_DESKTOP_SERVER_URL=http://127.0.0.1:8648"
echo Launching Studio desktop (remote SSH mode) ...
start "" "%ELECTRON%" "%APP%"
exit /b 0

:resolve_electron
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" if exist "%~dp0.electron-dist-cache\electron.exe" set "ELECTRON=%~dp0.electron-dist-cache\electron.exe"
if not exist "%ELECTRON%" (
  echo Electron is not installed. Run:
  echo   cd /d "%APP%" ^&^& npm ci ^&^& node node_modules\electron\install.js
  exit /b 1
)
exit /b 0
