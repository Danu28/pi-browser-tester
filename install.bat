@echo off
rem LEGACY: prefer "pi install git:github.com/Danu28/pi-browser-tester" (cross-platform, managed, auto-updates).
rem This .bat is kept for manual/offline installs: copies only the 3 files pi
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

rem --- staleness check: warn if installed copy is older than source (you edited but forgot to re-run) ---
if exist "%DST%\index.ts" (
  xcopy /L /D /E /Y "%SRC%\*" "%DST%\" 2>nul | findstr /C:"0 File(s)" >nul || echo [install] STALE — re-run install.bat ^(source newer than installed copy^)
)
rem Alternative: junction (mklink /J) makes edits live without re-copy, but needs Developer Mode and can surprise git/pi.
rem   rmdir /s /q "%DST%" 2>nul & mklink /J "%DST%" "%SRC%" & echo [install] junction created & endlocal & exit /b 0

if exist "%DST%" rmdir /s /q "%DST%"
mkdir "%DST%\src"

copy /y "%SRC%\index.ts" "%DST%\" >nul || exit /b 1
copy /y "%SRC%\package.json" "%DST%\" >nul || exit /b 1
copy /y "%SRC%\src\session.js" "%DST%\src\" >nul || exit /b 1

echo [install] copied index.ts, package.json, src\session.js to %DST%
echo [install] playwright is a global npm package — first cext_launch installs it.
echo [install] then restart pi or run /reload
endlocal
