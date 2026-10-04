# "HiDock Model Host - pause or resume": the desktop and Start Menu shortcut.
#
# Pauses a working host (the job it was running is cancelled and the other
# computer does it instead) and resumes or starts any other. Says what it did in
# a small window that closes by itself after a few seconds.

param(
  [int] $Port = 0,
  [switch] $NoPopup
)

$ErrorActionPreference = 'Stop'

if ($Port -le 0) {
  $Port = 8765
  $configFile = Join-Path $env:LOCALAPPDATA 'HiDock Model Host\config.json'
  try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($config.port) { $Port = [int]$config.port }
  } catch {
    $Port = 8765
  }
}

try {
  $answer = Invoke-RestMethod -Method Post -Uri "http://localhost:$Port/control?format=json" `
    -Body @{ action = 'toggle' } -TimeoutSec 15 -UseBasicParsing
  $text = $answer.text
} catch {
  $text = 'The Model Host is not running, so nothing runs on this GPU. Start it from the Start Menu when you want to lend it again.'
}

if ($NoPopup) {
  Write-Output $text
} else {
  # 64 = information icon; the window closes itself after 5 seconds.
  [void](New-Object -ComObject WScript.Shell).Popup($text, 5, 'HiDock Model Host', 64)
}
