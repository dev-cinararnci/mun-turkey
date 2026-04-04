@echo off
setlocal
set ROOT=%~dp0

start "MUN Turkey Server" powershell -NoExit -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%ROOT%'; node server.js"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(20);" ^
  "while ((Get-Date) -lt $deadline) {" ^
  "  try {" ^
  "    Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/api/health' | Out-Null;" ^
  "    Start-Process 'http://localhost:3000';" ^
  "    exit 0;" ^
  "  } catch {" ^
  "    Start-Sleep -Milliseconds 500;" ^
  "  }" ^
  "}" ^
  "Start-Process 'http://localhost:3000';"

endlocal
