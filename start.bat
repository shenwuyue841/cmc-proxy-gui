@echo off
chcp 65001 >nul
rem cmc-proxy launcher (Windows) - proxy only, no GUI
cd /d %~dp0

rem ------------------------------------------------------------------
rem  Outbound proxy, read from gui.config.json (edit it in the console's
rem  "Settings" page). Node's fetch ignores HTTP_PROXY unless
rem  NODE_USE_ENV_PROXY=1, so we set that too.
rem  Set CMC_PROXY yourself to override; leave it empty to go direct.
rem ------------------------------------------------------------------
for /f "delims=" %%P in ('node -e "try{process.stdout.write(require('./gui.config.json').proxy||'')}catch(e){}"') do set "CMC_PROXY=%%P"

if defined CMC_PROXY (
  set "HTTP_PROXY=%CMC_PROXY%"
  set "HTTPS_PROXY=%CMC_PROXY%"
  set "NODE_USE_ENV_PROXY=1"
  set "NO_PROXY=localhost,127.0.0.1,::1"
  echo   proxy: %CMC_PROXY%
) else (
  echo   proxy: (none - direct)
)

node proxy.js
pause
