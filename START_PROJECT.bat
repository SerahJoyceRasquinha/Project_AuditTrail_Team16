@echo off
REM ===================================================================
REM  Audit Trail - one-click launcher
REM
REM  Double-click this file. It will:
REM    1. find the project folder (wherever you unzipped it)
REM    2. check Node.js and npm
REM    3. install dependencies if they are missing
REM    4. open a BACKEND terminal   -> PERSISTENCE=memory -> npm run dev
REM    5. wait until the backend actually answers on port 4001
REM    6. open a FRONTEND terminal  -> npm run dev
REM    7. wait until Vite actually serves on port 5173
REM    8. open http://localhost:5173/ in your browser
REM
REM  WHY THIS FILE WAS REWRITTEN
REM  ---------------------------
REM  The previous version failed whenever the project sat in a folder whose
REM  name contained a bracket - for example
REM  "...\Project_AuditTrail_Team16_fixed (1)\..." , which is exactly what
REM  Windows names a second copy of a download. Batch parses a multi-line
REM  if ( ... ) block by scanning for the closing bracket, so a path holding
REM  a ")" closed the block early and the script died on a syntax error
REM  before it started anything.
REM
REM  This version therefore contains no multi-line bracket blocks at all.
REM  Every branch is a GOTO to a label, every path is quoted, and
REM  %ProgramFiles(x86)% - which carries a bracket in its own name - is only
REM  ever expanded inside its own subroutine. It is longer and plainer, and
REM  it survives paths containing brackets, spaces and ampersands.
REM
REM  Close this window at any time - the two server terminals keep running.
REM  To stop the project, close those two terminals (or press Ctrl+C in each).
REM ===================================================================

setlocal EnableExtensions DisableDelayedExpansion
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
if not defined ROOT goto :NoProject

echo  [1/7] Project found:
echo        "%ROOT%"
echo.

REM ---------- 2. Check Node and npm ----------------------------------
where node >nul 2>&1
if errorlevel 1 goto :NoNode

where npm >nul 2>&1
if errorlevel 1 goto :NoNpm

set "NODEVER="
for /f "tokens=*" %%V in ('node -v') do set "NODEVER=%%V"
echo  [2/7] Node.js %NODEVER% detected.

REM Node 20.11+ is required. The major version is enough to catch a bad one.
set "NODEMAJOR="
for /f "tokens=1 delims=." %%A in ("%NODEVER:v=%") do set "NODEMAJOR=%%A"
if not defined NODEMAJOR goto :SkipVersionCheck
if %NODEMAJOR% LSS 20 goto :OldNode
:SkipVersionCheck
echo.

REM ---------- 3. Install dependencies if missing ----------------------
REM Installing here, in this window, rather than inside the server terminals.
REM When it was done there, a failed install scrolled past inside a window
REM that immediately tried to start a server, and the real error was easy to
REM miss. Here the launcher stops and says so.
echo  [3/7] Checking dependencies...

if exist "%ROOT%\backend\node_modules\express" goto :BackendDepsOk
echo        Installing backend dependencies (this can take a couple of minutes)...
pushd "%ROOT%\backend"
call npm install --no-audit --no-fund
set "INSTALLFAILED=%ERRORLEVEL%"
popd
if not "%INSTALLFAILED%"=="0" goto :BackendInstallFailed
goto :BackendDepsDone
:BackendDepsOk
echo        Backend dependencies already present.
:BackendDepsDone

if exist "%ROOT%\frontend\node_modules\vite" goto :FrontendDepsOk
echo        Installing frontend dependencies (this can take a couple of minutes)...
pushd "%ROOT%\frontend"
call npm install --no-audit --no-fund
set "INSTALLFAILED=%ERRORLEVEL%"
popd
if not "%INSTALLFAILED%"=="0" goto :FrontendInstallFailed
goto :FrontendDepsDone
:FrontendDepsOk
echo        Frontend dependencies already present.
:FrontendDepsDone
echo.

REM ---------- 4. Warn if the ports are already busy -------------------
call :PortBusy 4001
if "%PORTBUSY%"=="1" echo  [!] Port 4001 is already in use - the backend may already be running.
call :PortBusy 5173
if "%PORTBUSY%"=="1" echo  [!] Port 5173 is already in use - the frontend may already be running.

REM ---------- 5. Start the BACKEND -----------------------------------
REM PERSISTENCE=memory runs the whole system in-process with no MongoDB.
REM AUTH_SEED_DEMO_ACCOUNTS=true creates the operator/viewer demo logins the
REM sign-in page offers. Both are for this local demo only.
echo  [4/7] Opening the BACKEND terminal...

start "Audit Trail - BACKEND (port 4001)" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "$Host.UI.RawUI.WindowTitle='Audit Trail - BACKEND (port 4001)'; Set-Location -LiteralPath '%ROOT%\backend'; Write-Host '=== BACKEND ===' -ForegroundColor Cyan; $env:PERSISTENCE='memory'; $env:AUTH_SEED_DEMO_ACCOUNTS='true'; Write-Host 'PERSISTENCE = memory (no MongoDB needed)' -ForegroundColor Yellow; Write-Host 'Starting the API on http://localhost:4001 ...' -ForegroundColor Gray; Write-Host ''; npm run dev"

echo        Waiting for the backend to answer on port 4001...
call :WaitForPort 4001 300
if "%PORTUP%"=="0" goto :BackendDown
echo        Backend is up.
echo.

REM ---------- 6. Start the FRONTEND ----------------------------------
echo  [5/7] Opening the FRONTEND terminal...

start "Audit Trail - FRONTEND (port 5173)" powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "$Host.UI.RawUI.WindowTitle='Audit Trail - FRONTEND (port 5173)'; Set-Location -LiteralPath '%ROOT%\frontend'; Write-Host '=== FRONTEND ===' -ForegroundColor Cyan; Write-Host 'Starting the dashboard on http://localhost:5173 ...' -ForegroundColor Gray; Write-Host ''; npm run dev"

echo        Waiting for Vite to serve on port 5173...
call :WaitForPort 5173 300
if "%PORTUP%"=="0" goto :FrontendDown
echo        Frontend is up.
echo.

REM ---------- 7. Open the browser ------------------------------------
echo  [6/7] Opening the dashboard...

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME call :FindChromeX86
if not defined CHROME goto :DefaultBrowser
start "" "%CHROME%" --new-window "http://localhost:5173/"
goto :Opened
:DefaultBrowser
echo        Chrome not found - opening your default browser instead.
start "" "http://localhost:5173/"
:Opened

echo.
echo  [7/7] Done.
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
REM  Failure exits - each one a label, so no bracket block is needed
REM ===================================================================

:NoProject
echo  [X] Could not find the project.
echo.
echo      This launcher expects to sit either next to the "audit-trail"
echo      folder, or inside it next to "backend" and "frontend".
echo.
echo      It is currently in:
echo      "%CD%"
echo.
pause
exit /b 1

:NoNode
echo  [X] Node.js is not installed, or is not on your PATH.
echo      Install Node.js 20.11 or newer from https://nodejs.org
echo      then run this file again.
echo.
pause
exit /b 1

:NoNpm
echo  [X] npm was not found on your PATH, although Node.js was.
echo      Reinstall Node.js from https://nodejs.org and make sure the
echo      npm component is selected.
echo.
pause
exit /b 1

:OldNode
echo  [X] Node.js %NODEVER% is too old. This project needs 20.11 or newer.
echo      Install a current version from https://nodejs.org and try again.
echo.
pause
exit /b 1

:BackendInstallFailed
echo.
echo  [X] Installing the backend dependencies failed - see the errors above.
echo.
echo      To see the full message, run these two lines by hand:
echo        cd /d "%ROOT%\backend"
echo        npm install
echo.
pause
exit /b 1

:FrontendInstallFailed
echo.
echo  [X] Installing the frontend dependencies failed - see the errors above.
echo.
echo      To see the full message, run these two lines by hand:
echo        cd /d "%ROOT%\frontend"
echo        npm install
echo.
pause
exit /b 1

:BackendDown
echo.
echo  [X] The backend did not come up within 5 minutes.
echo      Check the BACKEND terminal window for errors.
echo.
pause
exit /b 1

:FrontendDown
echo.
echo  [X] The frontend did not come up within 5 minutes.
echo      Check the FRONTEND terminal window for errors.
echo.
pause
exit /b 1


REM ===================================================================
REM  Helpers
REM ===================================================================

:FindChromeX86
REM In its own subroutine so the bracket inside %ProgramFiles(x86)% is never
REM expanded on a line that sits within an if-block.
set "PFX86=%ProgramFiles(x86)%"
if not defined PFX86 goto :eof
if exist "%PFX86%\Google\Chrome\Application\chrome.exe" set "CHROME=%PFX86%\Google\Chrome\Application\chrome.exe"
goto :eof

:PortBusy
REM %1 = port. Sets PORTBUSY to 1 if something is already listening.
set "PORTBUSY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %1); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 set "PORTBUSY=1"
goto :eof

:WaitForPort
REM %1 = port, %2 = timeout in seconds. Sets PORTUP to 1 on success.
set "PORTUP=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddSeconds(%2); while ((Get-Date) -lt $deadline) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %1); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 700 } }; exit 1" >nul 2>&1
if not errorlevel 1 set "PORTUP=1"
goto :eof
