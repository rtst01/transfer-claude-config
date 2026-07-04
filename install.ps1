# Установка ccsync (Windows):
#   irm https://raw.githubusercontent.com/rtst01/transfer-claude-config/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'rtst01/transfer-claude-config'
$asset = 'ccsync-windows-x64.zip'
$url = "https://github.com/$repo/releases/latest/download/$asset"

$installDir = Join-Path $env:LOCALAPPDATA 'ccsync'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Write-Host "Скачиваю $asset…"
$tmp = Join-Path $env:TEMP $asset
Invoke-WebRequest -Uri $url -OutFile $tmp
Expand-Archive -Path $tmp -DestinationPath $installDir -Force
Remove-Item $tmp

# добавить в PATH пользователя, если ещё нет
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$installDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  Write-Host "✓ $installDir добавлен в PATH (перезапусти терминал)"
}

Write-Host "✓ Установлено: $installDir\ccsync.exe"
Write-Host "Запускай: ccsync"
