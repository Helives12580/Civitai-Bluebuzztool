@echo off
chcp 65001 >nul
title civitai Blue Buzz
cd /d "%~dp0"

rem NOTE: this file must stay pure ASCII.
rem cmd.exe parses .bat byte-by-byte and does NOT understand UTF-8 multibyte chars,
rem so any Chinese text here (even with a BOM) gets cut mid-line and executed as a
rem bogus command. All localized output is printed by server.mjs instead, which is
rem fine because chcp 65001 applies to its stdout.

rem Panel port -- change this line to use another port
if not defined CIVITAI_BUZZ_PORT set CIVITAI_BUZZ_PORT=7864

rem Ask server.mjs to open the panel in the default browser once it is listening
set CIVITAI_BUZZ_OPEN=1

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install Node.js 18+ and add it to PATH.
  echo   ^(Node.js 18+ / PATH^)
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting civitai Blue Buzz helper...
echo   Panel: http://127.0.0.1:%CIVITAI_BUZZ_PORT%/
echo.

node server.mjs
pause
