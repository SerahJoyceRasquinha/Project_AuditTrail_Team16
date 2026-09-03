@echo off
REM ===================================================================
REM  Audit Trail - one-click launcher
REM
REM  Double-click this file. It will:
REM    1. find the project folder (wherever you unzipped it)
REM    2. open a BACKEND terminal   -> npm install -> PERSISTENCE=memory -> npm run dev
REM    3. wait until the backend is actually answering on port 4001
REM    4. open a FRONTEND terminal  -> npm install -> npm run dev
REM    5. wait until Vite is actually serving on port 5173
REM    6. open http://localhost:5173/ in Chrome
REM
REM  It waits for each server to genuinely accept a connection rather than
REM  sleeping for a fixed number of seconds, so a slow first `npm install`
REM  cannot make it open the browser too early on a blank page.
REM
REM  Close this window at any time - the two server terminals keep running.
REM  To stop the project, close those two terminals (or press Ctrl+C in each).
REM ===================================================================

setlocal EnableExtensions
title Audit Trail - Launcher
color 0B

echo.
echo  ==============================================
echo    AUDIT TRAIL - starting the full project
echo  ==============================================
echo.

cd /d "%~dp0"

REM ---------- 1. Locate the project ---------------------------------
REM Works whether this file sits next to the audit-trail folder or inside it.
set "ROOT="
if exist "audit-trail\backend\package.json" set "ROOT=%CD%\audit-trail"
if not defined ROOT if exist "backend\package.json" set "ROOT=%CD%"
if not defined ROOT if exist "Project_AuditTrail_Team16\audit-trail\backend\package.json" set "ROOT=%CD%\Project_AuditTrail_Team16\audit-trail"

if not defined ROOT (
  echo  [X] Could not find the project.
  echo.
  echo      This launcher expects to sit either next to the "audit-trail"
  echo      folder, or inside it next to "backend" and "frontend".
  echo.
  echo      It is currently in:
  echo      %CD%
  echo.
  pause
  exit /b 1
)

echo  [1/6] Project found:
echo        %ROOT%
echo.

REM ---------- 2. Check Node is installed -----------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js is not installed, or is not on your PATH.
  echo      Install Node.js 20.11 or newer from https://nodejs.org
  echo      then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%V in ('node -v') do set "NODEVER=%%V"
echo  [2/6] Node.js %NODEVER% detected.
echo.

REM ---------- 3. Warn if the ports are already busy -------------------
call :PortBusy 4001
if "%PORTBUSY%"=="1" (
  echo  [!] Port 4001 is already in use - the backend may already be running.
  echo      If the project misbehaves, close the old terminal and retry.
  echo.
)
call :PortBusy 5173
if "%PORTBUSY%"=="1" (
  echo  [!] Port 5173 is already in use - the frontend may already be running.
  echo.
)

REM ---------- 4. Start the BACKEND -----------------------------------
REM PERSISTENCE=memory runs the whole system in-process with no MongoDB.
REM AUTH_SEED_DEMO_ACCOUNTS=true creates the operator/viewer demo logins the
REM sign-in page offers. Both are set for this local demo only - delete the
REM AUTH_SEED_DEMO_ACCOUNTS line below if you would rather register your own
REM account each time.
echo  [3/6] Opening the BACKEND terminal...

start "Audit Trail - BACKEND (port 4001)" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
  "$Host.UI.RawUI.WindowTitle='Audit Trail - BACKEND (port 4001)'; Set-Location '%ROOT%\backend'; Write-Host '=== BACKEND ===' -ForegroundColor Cyan; Write-Host 'Installing dependencies...' -ForegroundColor Gray; npm install; if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed - see the errors above.' -ForegroundColor Red; return }; $env:PERSISTENCE='memory'; $env:AUTH_SEED_DEMO_ACCOUNTS='true'; Write-Host ''; Write-Host 'PERSISTENCE = memory (no MongoDB needed)' -ForegroundColor Yellow; Write-Host 'Starting the API on http://localhost:4001 ...' -ForegroundColor Gray; Write-Host ''; npm run dev"

echo        Waiting for the backend to answer on port 4001...
echo        (the first npm install can take a couple of minutes)

call :WaitForPort 4001 300
if "%PORTUP%"=="0" (
  echo.
  echo  [X] The backend did not come up within 5 minutes.
  echo      Check the BACKEND terminal window for errors.
  echo.
  pause
  exit /b 1
)
echo        Backend is up.
echo.

REM ---------- 5. Start the FRONTEND ----------------------------------
echo  [4/6] Opening the FRONTEND terminal...

start "Audit Trail - FRONTEND (port 5173)" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command ^
  "$Host.UI.RawUI.WindowTitle='Audit Trail - FRONTEND (port 5173)'; Set-Location '%ROOT%\frontend'; Write-Host '=== FRONTEND ===' -ForegroundColor Cyan; Write-Host 'Installing dependencies...' -ForegroundColor Gray; npm install; if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed - see the errors above.' -ForegroundColor Red; return }; Write-Host ''; Write-Host 'Starting the dashboard on http://localhost:5173 ...' -ForegroundColor Gray; Write-Host ''; npm run dev"

echo        Waiting for Vite to serve on port 5173...

call :WaitForPort 5173 300
if "%PORTUP%"=="0" (
  echo.
  echo  [X] The frontend did not come up within 5 minutes.
  echo      Check the FRONTEND terminal window for errors.
  echo.
  pause
  exit /b 1
)
echo        Frontend is up.
echo.

REM ---------- 6. Open the browser ------------------------------------
echo  [5/6] Opening the dashboard in Chrome...

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --new-window "http://localhost:5173/"
) else (
  echo        Chrome not found - opening your default browser instead.
  start "" "http://localhost:5173/"
)

echo.
echo  [6/6] Done.
echo.
echo  ==============================================
echo    Dashboard : http://localhost:5173/
echo    API       : http://localhost:4001/health
echo.
echo    Demo logins ^(created automatically^):
echo      Operator  ^(can run commands^) : operator / operator123
echo      Viewer    ^(read-only^)        : viewer   / viewer123
echo.
echo    Data is in memory only - restarting the
echo    backend clears every shipment.
echo.
echo    To stop: close the two server terminals.
echo  ==============================================
echo.
echo  This launcher window can be closed now.
timeout /t 20 >nul
exit /b 0


REM ===================================================================
REM  Helpers
REM ===================================================================

:PortBusy
REM %1 = port. Sets PORTBUSY to 1 if something is already listening.
set "PORTBUSY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %1); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 set "PORTBUSY=1"
goto :eof

:WaitForPort
REM %1 = port, %2 = timeout in seconds. Sets PORTUP to 1 on success.
set "PORTUP=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(%2); while ((Get-Date) -lt $deadline) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %1); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 700 } }; exit 1" >nul 2>&1
if not errorlevel 1 set "PORTUP=1"
goto :eof
