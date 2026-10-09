@echo off
REM ============================================================
REM  IBM i & z/OS Explorer - one-click setup + run
REM  Double-click this file (it must stay in the ibmi-zos-explorer folder).
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo [1/4] Checking Node.js and VS Code...
where node >nul 2>&1 || (echo ERROR: Node.js is not installed. Install it from https://nodejs.org and run again. & pause & exit /b 1)
where code >nul 2>&1 || (echo ERROR: The "code" command was not found. In VS Code press Ctrl+Shift+P and run "Shell Command: Install 'code' command in PATH", or reinstall VS Code with "Add to PATH" ticked. & pause & exit /b 1)

echo [2/4] Preparing the .vscode debug folder...
if exist "vscode\launch.json" if not exist ".vscode\launch.json" (
  if not exist ".vscode" mkdir ".vscode"
  copy /y "vscode\*.json" ".vscode\" >nul
  echo        .vscode folder created.
)
if exist ".vscode\launch.json" (echo        OK) else (echo        WARNING: .vscode\launch.json missing - use the .code-workspace file instead.)

echo [3/4] Installing packages (first time only)...
if not exist "node_modules" (
  call npm install || (echo ERROR: npm install failed. & pause & exit /b 1)
) else (echo        already installed.)

echo [4/4] Building the extension...
call npm run compile || (echo ERROR: build failed - see messages above. & pause & exit /b 1)

echo.
echo Build OK. Choose:
echo    1 = Run the extension now (opens an Extension Development Host window)
echo    2 = Open the project in VS Code to debug with F5 (breakpoints)
echo    3 = Build an installable .vsix file
choice /c 123 /n /m "Your choice [1/2/3]: "
if errorlevel 3 goto vsix
if errorlevel 2 goto debug

:run
start "" code --new-window --extensionDevelopmentPath="%~dp0."
goto end

:debug
start "" code "%~dp0."
echo In VS Code: click Run and Debug (left bar), pick "Run Extension (F5)", press F5.
goto end

:vsix
call npm run package && echo Created the .vsix in this folder. Install it via Extensions - ... - Install from VSIX.

:end
echo.
pause
