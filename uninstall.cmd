@echo off
rem ===========================================================================
rem  dsh-prompt-frame uninstaller  (ASCII only, CRLF, double-click safe)
rem
rem  What it does:
rem    1. run _patch_bundles.mjs --remove so "dsh-prompt-frame" disappears from
rem       the profile package.json
rem    2. delete
rem       %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-prompt-frame
rem    3. verify both, and print the tail of dsh.profile.bundles
rem
rem  It does NOT touch your own files:
rem    %USERPROFILE%\.dsh\prompt-inject.md
rem    %USERPROFILE%\.dsh\.dsh-prompt-frame.off
rem    %USERPROFILE%\.dsh\dsh-prompt-frame.log
rem  Delete those by hand if you want them gone.
rem
rem  Fully quit the desktop app first, then run this, then start it again.
rem  Log: uninstall.log next to this script.
rem ===========================================================================
setlocal enableextensions
pushd "%~dp0"
if errorlevel 1 goto :pushdfail

set "LOGF=%~dp0uninstall.log"
set "SRC=%~dp0"
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"
set "DST=%PROFILE%\node_modules\dsh-prompt-frame"

echo. >> "%LOGF%"
echo [uninstall] %DATE% %TIME% >> "%LOGF%"

echo dsh-prompt-frame uninstaller
echo   target : %DST%
echo   log    : %LOGF%
echo.

if not exist "%SRC%_patch_bundles.mjs" goto :nopatch
if not exist "%PROFILE%\package.json" goto :noprofile

echo [1/3] unregistering bundle ...
node "%SRC%_patch_bundles.mjs" --remove >> "%LOGF%" 2>&1
if errorlevel 1 goto :patchfail
echo       ok

echo [2/3] deleting package folder ...
if exist "%DST%" rmdir /s /q "%DST%"
if exist "%DST%" goto :rmfail
echo       ok

echo [3/3] verifying ...
if exist "%DST%" goto :verifyfail
node -e "const p=require(process.argv[1]);const b=p.dsh.profile.bundles||[];console.log('      has dsh-prompt-frame: '+b.includes('dsh-prompt-frame'));console.log('      bundles tail: '+JSON.stringify(b.slice(-2)))" "%PROFILE%\package.json"
node -e "const p=require(process.argv[1]);const b=p.dsh.profile.bundles||[];console.log('      has dsh-prompt-frame: '+b.includes('dsh-prompt-frame'));console.log('      bundles tail: '+JSON.stringify(b.slice(-2)))" "%PROFILE%\package.json" >> "%LOGF%" 2>&1
if exist "%PROFILE%\package.json.before-prompt-frame" echo       backup kept: package.json.before-prompt-frame

echo.
echo DONE. fully quit the desktop app, then start it again.
echo [uninstall] done >> "%LOGF%"
goto :end

:pushdfail
echo FAIL: cannot pushd into the script directory.
echo [uninstall] FAIL pushd >> "%LOGF%"
pause
exit /b 1

:nopatch
echo FAIL: _patch_bundles.mjs not found next to this script.
echo Run uninstall.cmd from inside the dsh-prompt-frame folder.
echo [uninstall] FAIL nopatch >> "%LOGF%"
pause
exit /b 1

:noprofile
echo FAIL: desktop profile not found: %PROFILE%
echo [uninstall] FAIL noprofile >> "%LOGF%"
pause
exit /b 1

:patchfail
echo FAIL: _patch_bundles.mjs --remove failed, see %LOGF%
echo Nothing was deleted; fix the error and run this again.
echo [uninstall] FAIL patch >> "%LOGF%"
pause
exit /b 1

:rmfail
echo FAIL: cannot delete %DST%
echo Close the desktop app first (it may hold the folder open), then retry.
echo [uninstall] FAIL rmdir >> "%LOGF%"
pause
exit /b 1

:verifyfail
echo FAIL: %DST% still exists.
echo [uninstall] FAIL verify >> "%LOGF%"
pause
exit /b 1

:end
popd
endlocal
pause
