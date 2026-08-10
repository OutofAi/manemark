@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.manemark.storage" /f >nul 2>&1
del "%~dp0com.manemark.storage.json" >nul 2>&1
echo Manemark native storage helper registration removed.
pause
