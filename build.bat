@echo off
setlocal
cd /d "%~dp0"

echo Dead Souls Launcher - installer build
echo.

if not exist package.json goto :no_project

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node

echo Node.js version:
call node -v
echo.

echo [1/2] Installing dependencies...
call npm install
if errorlevel 1 goto :failed

echo.
echo [2/2] Building installer exe. The first run downloads Electron and can take several minutes...
call npm run dist
if errorlevel 1 goto :failed

echo.
echo Build finished. Output folder: %CD%\dist
dir /b dist\*.exe
echo.
pause
exit /b 0

:no_project
echo [ERROR] package.json not found. Put build.bat into the dead-souls-electron folder.
goto :error_exit

:no_node
echo [ERROR] Node.js not found. Install Node.js 22 LTS from nodejs.org, then close this window and run build.bat again.
goto :error_exit

:failed
echo.
echo [ERROR] Build failed. Copy the messages above.

:error_exit
echo.
pause
exit /b 1
