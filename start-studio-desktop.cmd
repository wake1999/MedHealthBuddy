@echo off
rem Compatibility entry point for the old remote-SSH name.
rem Use: start-studio.cmd remote
call "%~dp0start-studio.cmd" remote %*
exit /b %ERRORLEVEL%
