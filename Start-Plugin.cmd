@echo off
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0scripts\local-ui.mjs"
) else (
  node "%~dp0scripts\local-ui.mjs"
)
if errorlevel 1 pause
