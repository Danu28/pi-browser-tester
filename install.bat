@echo off
rem Install browser-tester as a GLOBAL pi extension. Copies only the 3 files pi
rem loads: index.ts, package.json, src/session.js (scripts\ and scenarios\ are
rem dev-only, run from this repo). Re-run after any edit — the old copy is
rem deleted first so no stale file survives.
setlocal
set "SRC=%~dp0browser-tester"
set "DST=%USERPROFILE%\.pi\agent\extensions\browser-tester"

if not exist "%SRC%\index.ts" (
  echo [install] not found: %SRC%\index.ts
  exit /b 1
)

if exist "%DST%" rmdir /s /q "%DST%"
mkdir "%DST%\src"

copy /y "%SRC%\index.ts" "%DST%\" >nul || exit /b 1
copy /y "%SRC%\package.json" "%DST%\" >nul || exit /b 1
copy /y "%SRC%\src\session.js" "%DST%\src\" >nul || exit /b 1

echo [install] copied index.ts, package.json, src\session.js to %DST%
echo [install] playwright is a global npm package — first cext_launch installs it.
echo [install] then restart pi or run /reload
endlocal
