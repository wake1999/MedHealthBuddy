@echo off
rem Compatibility entry point. Use start-studio.cmd (default local) going forward.
call "%~dp0start-studio.cmd" local %*
exit /b %ERRORLEVEL%
