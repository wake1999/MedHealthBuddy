@echo off
rem Compatibility entry point. The root packages/desktop app is the remote
rem connector for DSH / Hermes / Studio servers; use start-remote-connector.cmd.
call "%~dp0start-remote-connector.cmd" %*
exit /b %ERRORLEVEL%
