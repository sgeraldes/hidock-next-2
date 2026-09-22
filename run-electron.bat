@echo off
REM HiDock Meeting Intelligence - Launch Script
setlocal
echo Starting HiDock Meeting Intelligence...
echo.

REM Navigate to script directory (project root)
cd /d "%~dp0"

REM Check if electron app directory exists
if not exist "apps\electron" (
    echo Error: apps\electron directory not found!
    echo Make sure the hidock-next project structure is intact.
    echo Current directory: %CD%
    pause
    exit /b 1
)

REM The Electron app uses local file dependencies from packages\. On a fresh
REM checkout npm runs some of their prepare scripts while installing the app,
REM so their own build tools must be installed first. Check the shared build
REM outputs too because a failed app install can still leave electron-vite.
set "SHARED_PACKAGES_INCOMPLETE=0"
set "APP_DEPENDENCIES_INCOMPLETE=0"
if not exist "apps\electron\node_modules\.bin\electron-vite.cmd" set "APP_DEPENDENCIES_INCOMPLETE=1"
call npm --prefix apps\electron ls --depth=0 --silent >nul 2>&1
if errorlevel 1 set "APP_DEPENDENCIES_INCOMPLETE=1"
for %%P in (ai-providers calendar-sync connectors connectors-slack database jensen-protocol knowledge-graph transcription) do (
    if not exist "packages\%%P\dist\index.js" set "SHARED_PACKAGES_INCOMPLETE=1"
)
if "%SHARED_PACKAGES_INCOMPLETE%"=="1" set "APP_DEPENDENCIES_INCOMPLETE=1"

if "%SHARED_PACKAGES_INCOMPLETE%"=="1" (
    echo Preparing shared packages...
    for %%P in (ai-providers calendar-sync connectors connectors-slack database jensen-protocol knowledge-graph transcription) do (
        echo   - %%P
        pushd "packages\%%P"
        call npm ci
        if errorlevel 1 (
            popd
            echo.
            echo Failed to install shared package %%P.
            pause
            exit /b 1
        )
        call npm run build --if-present
        if errorlevel 1 (
            popd
            echo.
            echo Failed to build shared package %%P.
            pause
            exit /b 1
        )
        popd
    )
)

REM Navigate to electron app directory
cd apps\electron

REM Check for the executable used by the development launcher. A failed npm
REM install can leave node_modules behind, so checking the directory alone is
REM not enough to prove that dependencies are usable.
if "%APP_DEPENDENCIES_INCOMPLETE%"=="1" (
    echo Dependencies are missing or incomplete. Installing from package-lock.json...
    call npm ci
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

REM Electron 44 no longer downloads its binary during npm install. electron-vite
REM resolves the binary path directly, so download it explicitly before startup.
if not exist "node_modules\electron\dist\electron.exe" (
    echo Downloading the Electron runtime...
    call npx install-electron --no
    if errorlevel 1 (
        echo.
        echo Failed to download the Electron runtime.
        pause
        exit /b 1
    )
)

echo.
echo ================================
echo HiDock Meeting Intelligence
echo ================================
echo.
echo To stop the application, close the window or press Ctrl+C here.
echo.

REM Run the electron app in development mode
call npm run dev

REM Keep window open if there's an error
if errorlevel 1 (
    echo.
    echo Application exited with an error.
    pause
)
endlocal
