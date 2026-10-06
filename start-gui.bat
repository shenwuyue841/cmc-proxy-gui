@echo off
chcp 65001 >nul
rem ============================================================
rem  cmc-proxy-gui - single-window launcher (Windows)
rem    runs the console IN THIS WINDOW (no extra popup)
rem    auto-starts cmc-proxy if it is not running
rem    opens the default browser by itself
rem
rem  This file must sit in the SAME folder as cmc-proxy's proxy.js
rem  and config.json. Proxy address / ports live in gui.config.json
rem  - edit them in the console's "Settings" page.
rem ============================================================
cd /d %~dp0

node gui.js --auto-start --open
set CODE=%ERRORLEVEL%

echo.
echo   [cmc-gui] console exited (code=%CODE%)
echo   If that was not intentional, read the messages above.
echo.
pause >nul
