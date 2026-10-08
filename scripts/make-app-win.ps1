# Creates "Agent Hub" shortcuts on the Desktop and in the Start menu (Windows).
#
# The shortcuts start Electron with this folder, so they always run the
# current code: after you change the code, close and reopen Agent Hub.
# Run this again only after `npm install` updates Electron or after the icon
# changes.
#
# Run: npm run make-app

param([switch]$Force)
$ErrorActionPreference = 'Stop'

$Project = Split-Path -Parent $PSScriptRoot

# The shortcuts should run the stable copy (the folder on master), not the
# folder where you make changes. Pass -Force to use another branch anyway.
$Branch = (git -C $Project branch --show-current)
if ($Branch -ne 'master' -and -not $Force) {
  Write-Host "This folder is on the '$Branch' branch. Make the shortcuts from the stable copy (the folder on master),"
  Write-Host "or run: npm run make-app -- --force"
  exit 1
}

$Electron = Join-Path $Project 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $Electron)) {
  Write-Host 'Electron is not installed. Run npm install first.'
  exit 1
}

$Icon = Join-Path $Project 'build\icon.ico'
$Folders = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)

$Shell = New-Object -ComObject WScript.Shell
foreach ($Folder in $Folders) {
  $Link = $Shell.CreateShortcut((Join-Path $Folder 'Agent Hub.lnk'))
  $Link.TargetPath = $Electron
  $Link.Arguments = '"' + $Project + '"'
  $Link.WorkingDirectory = $Project
  $Link.IconLocation = $Icon
  $Link.Description = 'Agent Hub'
  $Link.Save()
  Write-Host "Created $(Join-Path $Folder 'Agent Hub.lnk')"
}
