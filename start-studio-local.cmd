@echo off
setlocal
rem Start the Ekko Studio desktop app in LOCAL mode: it boots its own bundled
rem server on 127.0.0.1:8748 and needs no SSH tunnel or remote deployment.
rem Requires a prior `npm run build` in studio/ (produces dist/client + dist/server).

set "APP=%~dp0studio\packages\desktop"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
rem The packaging pipeline keeps a local Electron runtime in .electron-dist-cache
rem so it does not get bundled into the Web UI. Use it when node_modules was trimmed.
if not exist "%ELECTRON%" if exist "%~dp0.electron-dist-cache\electron.exe" set "ELECTRON=%~dp0.electron-dist-cache\electron.exe"

rem Keep the Web UI data (DB, token, logs, workspaces) next to the program
rem instead of the default %USERPROFILE%\.hermes-web-ui: the app lives on E:,
rem so its data should not scatter into C:.
set "HERMES_WEB_UI_HOME=%~dp0data\hermes-web-ui"
set "HERMES_WEBUI_STATE_DIR=%~dp0data\hermes-web-ui"

if not exist "%ELECTRON%" (
  echo Electron is not installed. Run:
  echo   cd /d "%APP%" ^&^& npm ci ^&^& node node_modules\electron\install.js
  exit /b 1
)
if not exist "%~dp0studio\dist\server\index.js" (
  echo studio/dist is missing. Run: cd /d "%~dp0studio" ^&^& npm run build
  exit /b 1
)
if not exist "%APP%\resources\node\win-x64\node.exe" (
  echo Bundled node runtime is missing. Run: cd /d "%APP%" ^&^& npm run fetch:node
)

start "" "%ELECTRON%" "%APP%"
endlocal
