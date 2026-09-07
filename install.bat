@echo off
rem Install browser-tester as a GLOBAL pi extension: copy browser-tester\ into
rem %USERPROFILE%\.pi\agent\extensions\browser-tester. Re-run after any edit —
rem the old copy is deleted first so no stale file survives.
setlocal
set "SRC=%~dp0browser-tester"
set "DST=%USERPROFILE%\.pi\agent\extensions\browser-tester"

if not exist "%SRC%\index.ts" (
  echo [install] not found: %SRC%\index.ts
  exit /b 1
)

rem Stale-copy check: /L lists what /D would copy, /Q keeps it to the summary
rem line. "0 File(s)" = the installed copy is current; anything else = stale.
if exist "%DST%" (
  xcopy "%SRC%" "%DST%\" /E /I /Y /Q /L /D > "%TEMP%\cext-stale.txt" 2>nul
  findstr /L /C:"0 File(s)" "%TEMP%\cext-stale.txt" >nul
  if errorlevel 1 echo [install] STALE: the installed copy is out of date - refreshing it now.
  del "%TEMP%\cext-stale.txt" >nul 2>nul
)

if exist "%DST%" rmdir /s /q "%DST%"
xcopy "%SRC%" "%DST%\" /E /I /Y /Q
if errorlevel 1 (
  echo [install] copy failed
  exit /b 1
)

echo [install] copied to %DST%
echo [install] no setup in this folder: playwright is a global npm package.
echo [install] Missing it? npm install -g playwright  (first cext_launch does it
echo [install] for you). Nothing is installed inside the copied folder.
echo [install] then restart pi or run /reload
endlocal
