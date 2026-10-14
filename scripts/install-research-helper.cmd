@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-research-helper.ps1"
if errorlevel 1 pause
