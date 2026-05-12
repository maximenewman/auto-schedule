@echo off
setlocal enableextensions

rem Run from the repo root so .env, data\, downloads\, dist\ all resolve.
cd /d "%~dp0"
if not exist logs mkdir logs

rem YYYY-MM-DD stamp via PowerShell (wmic is deprecated on Win 11 24H2+).
for /f "usebackq tokens=*" %%I in (`pwsh -NoProfile -Command "Get-Date -Format yyyy-MM-dd"`) do set "STAMP=%%I"

rem Tell the logger to also write to this file. The app still writes
rem to stdout normally, so manual runs show up in the terminal AND the file.
set "LOG_FILE=%CD%\logs\cron-%STAMP%.log"

rem Task Scheduler can launch with a stripped PATH. If node isn't visible,
rem probe the common install locations before giving up.
where node >nul 2>&1
if errorlevel 1 (
    for %%P in (
        "%ProgramFiles%\nodejs"
        "%ProgramFiles(x86)%\nodejs"
        "%LOCALAPPDATA%\Programs\nodejs"
        "%LOCALAPPDATA%\Volta\bin"
        "%APPDATA%\fnm"
    ) do (
        if exist "%%~P\node.exe" (
            set "PATH=%%~P;%PATH%"
            goto :have_node
        )
    )
    echo node.exe not found on PATH 1>&2
    endlocal & exit /b 127
)
:have_node

node dist\index.js run
set RC=%ERRORLEVEL%

rem Propagate the real exit code out through endlocal so Task Scheduler
rem records 0 / 1 / 2 (auth re-prompt) correctly.
endlocal & exit /b %RC%
