@echo off
setlocal EnableExtensions

set "HOST_NAME=com.manemark.storage"
set "EXT_ID=%~1"
if not defined EXT_ID (
  echo.
  echo Manemark Native Storage Helper
  echo ------------------------------
  set /p "EXT_ID=Paste the Manemark extension ID shown on its Storage settings page: "
)

if not defined EXT_ID (
  echo No extension ID supplied.
  pause
  exit /b 1
)

set "ROOT=%~dp0"
set "HOST_PATH=%ROOT%windows\manemark-native-host.exe"
set "MANIFEST_PATH=%ROOT%%HOST_NAME%.json"

if not exist "%HOST_PATH%" (
  echo Native host binary not found:
  echo %HOST_PATH%
  pause
  exit /b 1
)

set "HOST_JSON=%HOST_PATH:\=\\%"

> "%MANIFEST_PATH%" echo {
>>"%MANIFEST_PATH%" echo   "name": "%HOST_NAME%",
>>"%MANIFEST_PATH%" echo   "description": "Manemark custom folder storage helper",
>>"%MANIFEST_PATH%" echo   "path": "%HOST_JSON%",
>>"%MANIFEST_PATH%" echo   "type": "stdio",
>>"%MANIFEST_PATH%" echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
>>"%MANIFEST_PATH%" echo }

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
if errorlevel 1 (
  echo Failed to register the helper in the Windows registry.
  pause
  exit /b 1
)

echo.
echo Installed successfully for extension ID:
echo %EXT_ID%
echo.
echo Return to Manemark Storage settings and click Choose folder.
pause
