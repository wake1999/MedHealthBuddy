# Give the dev Electron runtime an executable that carries the app's icon.
#
# The Windows taskbar falls back to the process executable's icon whenever it
# cannot resolve the app's identity (dev runs have no installer-created
# identity, and Electron's dev shortcuts do not carry an AUMID the taskbar
# accepts). A copy of electron.exe next to it, with our icon stamped in by
# rcedit, makes the taskbar show the app icon no matter what.
#
# Run after setup-electron-runtime.cmd (and again after an Electron upgrade,
# since the runtime copy is replaced):
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-runtime-icon.ps1

$ErrorActionPreference = 'Stop'

$desktop = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$repo    = Split-Path -Parent (Split-Path -Parent $desktop)
$runtime = "$env:LOCALAPPDATA\medhealthbuddy-dev\electron"
$source  = Join-Path $runtime 'electron.exe'
$branded = Join-Path $runtime 'MedHealthBuddy.exe'
$icon    = Join-Path $desktop 'assets\app.ico'
$rcedit  = Get-ChildItem (Join-Path $repo 'node_modules\.pnpm') -Recurse -Filter 'rcedit.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName

if (-not (Test-Path $source)) { throw "runtime not found: $source (run setup-electron-runtime.cmd first)" }
if (-not (Test-Path $icon))   { throw "icon not found: $icon" }
if ($null -eq $rcedit)        { throw "rcedit.exe not found under node_modules\.pnpm (run pnpm install first)" }

Copy-Item $source $branded -Force
& $rcedit $branded --set-icon $icon
if ($LASTEXITCODE -ne 0) { throw "rcedit failed with exit code $LASTEXITCODE" }
Write-Output "branded runtime: $branded"
