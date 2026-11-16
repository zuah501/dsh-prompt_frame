@echo off
rem ===========================================================================
rem  dsh-prompt-frame installer  (ASCII only, CRLF, double-click safe)
rem
rem  What it does:
rem    1. robocopy this folder into
rem       %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-prompt-frame
rem    2. run _patch_bundles.mjs to add "dsh-prompt-frame" to the profile
rem       package.json (removing the legacy dsh-mini-inject / dsh-purge entries)
rem    3. verify the copied files and print the tail of dsh.profile.bundles
rem
rem  It does NOT restart anything. Fully quit the desktop app first, then run
rem  this script, then start the app again.
rem
rem  Log: install.log next to this script.
rem ===========================================================================
setlocal enableextensions
pushd "%~dp0"
if errorlevel 1 goto :pushdfail

set "LOGF=%~dp0install.log"
set "SRC=%~dp0"
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"
set "DST=%PROFILE%\node_modules\dsh-prompt-frame"

echo. >> "%LOGF%"
echo [install] %DATE% %TIME% >> "%LOGF%"

echo dsh-prompt-frame installer
echo   source : %SRC%
echo   target : %DST%
echo   log    : %LOGF%
echo.

if not exist "%SRC%package.json" goto :nosrc
if not exist "%SRC%assets\frame.md" goto :noasset
if not exist "%SRC%vendor\identity.js" goto :noasset
if not exist "%PROFILE%\package.json" goto :noprofile

if not exist "%DST%" mkdir "%DST%"
if errorlevel 1 goto :mkdirfail

echo [1/3] copying files ...
robocopy "%SRC%." "%DST%" /E /NFL /NDL /NJH /NJS /XD .git node_modules /XF install.log uninstall.log _test*.mjs _smoke*.mjs >> "%LOGF%" 2>&1
if errorlevel 8 goto :copyfail
echo       ok

echo [2/3] registering bundle ...
node "%SRC%_patch_bundles.mjs" >> "%LOGF%" 2>&1
if errorlevel 1 goto :patchfail
echo       ok

echo [3/3] verifying ...
set "MISSING="
for %%F in (package.json cordis.patch.yml lib\index.js lib\core-logic.js lib\console.js lib\pipeline.js lib\state.js client\client.js vendor\identity.js vendor\capability-protocol.js vendor\phase1-keep.js vendor\net-scope-lite.js assets\frame.md README.md NOTICE LICENSE) do if not exist "%DST%\%%F" set "MISSING=1"
if defined MISSING goto :verifyfail
for %%F in (package.json lib\index.js lib\core-logic.js lib\console.js lib\pipeline.js client\client.js vendor\identity.js vendor\net-scope-lite.js assets\frame.md) do echo       OK %%F
for /f %%C in ('dir /b /s "%DST%" ^| find /c /v ""') do echo       files: %%C
node -e "const p=require(process.argv[1]);console.log('      bundles tail: '+JSON.stringify(p.dsh.profile.bundles.slice(-2)))" "%PROFILE%\package.json" >> "%LOGF%" 2>&1
node -e "const p=require(process.argv[1]);console.log('      bundles tail: '+JSON.stringify(p.dsh.profile.bundles.slice(-2)))" "%PROFILE%\package.json"

echo.
echo DONE.
echo   1. fully quit the desktop app, then start it again
echo   2. after one turn, check %%USERPROFILE%%\.dsh\dsh-prompt-frame.log
echo      an applied:true line means the prompt was rewritten
echo   3. create %%USERPROFILE%%\.dsh\.dsh-prompt-frame.off to switch injection off
echo      without restarting (delete that file to switch it back on)
echo.
echo [install] done >> "%LOGF%"
goto :end

:pushdfail
echo FAIL: cannot pushd into the script directory.
echo [install] FAIL pushd >> "%LOGF%"
pause
exit /b 1

:nosrc
echo FAIL: package.json not found next to this script.
echo Put install.cmd inside the dsh-prompt-frame folder.
echo [install] FAIL nosrc >> "%LOGF%"
pause
exit /b 1

:noasset
echo FAIL: assets\frame.md or vendor\identity.js is missing next to this script.
echo The package folder is incomplete; copy the whole folder before installing.
echo [install] FAIL noasset >> "%LOGF%"
pause
exit /b 1

:noprofile
echo FAIL: desktop profile not found: %PROFILE%
echo Install the DSH desktop app first, or set the profile path by hand.
echo [install] FAIL noprofile >> "%LOGF%"
pause
exit /b 1

:mkdirfail
echo FAIL: cannot create %DST%
echo [install] FAIL mkdir >> "%LOGF%"
pause
exit /b 1

:copyfail
echo FAIL: robocopy returned an error, see %LOGF%
echo [install] FAIL robocopy >> "%LOGF%"
pause
exit /b 1

:patchfail
echo FAIL: _patch_bundles.mjs failed, see %LOGF%
echo The node_modules copy is in place but the bundle is NOT registered.
echo [install] FAIL patch >> "%LOGF%"
pause
exit /b 1

:verifyfail
echo FAIL: some files are missing under %DST%
echo [install] FAIL verify >> "%LOGF%"
pause
exit /b 1

:end
popd
endlocal
pause
