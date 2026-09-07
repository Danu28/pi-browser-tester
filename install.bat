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

if exist "%DST%" rmdir /s /q "%DST%"
xcopy "%SRC%" "%DST%\" /E /I /Y /Q
if errorlevel 1 (
  echo [install] copy failed
  exit /b 1
)

echo [install] copied to %DST%
echo [install] no npm install needed: on first cext_launch playwright is
echo [install] fetched once into %USERPROFILE%\.browser-tester (outside the copy,
echo [install] so re-installing never re-downloads it).
echo [install] then restart pi or run /reload
endlocal
