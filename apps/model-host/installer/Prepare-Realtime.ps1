# Explicit native realtime verification. No downloads, external audio, or client configuration changes.
[CmdletBinding()]
param(
  [string] $HostRoot = (Join-Path $env:LOCALAPPDATA 'HiDock Model Host'),
  [switch] $RestartTray
)
$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $PSCommandPath
$transcriptStarted = $false
$sample = $null
$raw = $null

function Invoke-BoundedChild([string] $Executable, [string[]] $Arguments, [int] $TimeoutSeconds) {
  $childLog = Join-Path $logDir ('realtime-child-' + [guid]::NewGuid().ToString())
  $child = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput ($childLog + '.out.log') -RedirectStandardError ($childLog + '.err.log')
  # Windows PowerShell 5.1 can lose fast-child exit status unless the native
  # process handle is retained before waiting (observed with real child exits).
  $null = $child.Handle
  try {
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) {
      # Only the process tree created by this invocation; the Python supervisor's
      # kill-on-close Job supplies a second boundary for native descendants.
      & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null
      $child.WaitForExit(5000) | Out-Null
      throw "Realtime preparation child exceeded $TimeoutSeconds seconds."
    }
    $child.WaitForExit() # drain redirected output after the bounded wait completed
    $child.Refresh()
    if ($null -eq $child.ExitCode) { throw "Realtime preparation child exit status unavailable; see $childLog.err.log." }
    if ($child.ExitCode -ne 0) { throw "Realtime preparation child failed (exit $($child.ExitCode)); see $childLog.err.log." }
  } finally { $child.Dispose() }
}

try {
  if ($RestartTray) { Start-Sleep -Seconds 2 }
  $logDir = Join-Path $HostRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Transcript -LiteralPath (Join-Path $logDir 'prepare-realtime.log') -Append | Out-Null
  $transcriptStarted = $true
  $config = Get-Content -LiteralPath (Join-Path $HostRoot 'config.json') -Raw | ConvertFrom-Json
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($InstallDir) -and $_.CommandLine.Contains('main.mjs')
  }
  if ($running) { throw 'Quit the host tray before verifying realtime transcription.' }
  $health = $null
  try { $health = Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 3 } catch { }
  if ($health) { throw 'The host daemon must be stopped before realtime verification.' }
  if (Test-Path -LiteralPath (Join-Path $HostRoot 'asr-preparing.lock')) { throw 'Another model preparation is active.' }
  $node = Join-Path $InstallDir 'node.exe'
  $ffmpeg = Join-Path $InstallDir 'ffmpeg.exe'
  $helper = Join-Path $InstallDir 'src\validate-native-realtime.mjs'
  foreach ($path in @($node, $ffmpeg, $helper)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Install the complete model host package first.' }
  }
  $id = [guid]::NewGuid().ToString()
  $raw = Join-Path $HostRoot ("realtime-test-$id-raw.wav")
  $sample = Join-Path $HostRoot ("realtime-test-$id.wav")
  # Use the Windows PowerShell System.Speech runtime even when invoked from pwsh.
  # Synthesis itself runs in an owned bounded child, never indefinitely in the tray operation.
  $escapedRaw = $raw.Replace("'", "''")
  $speechScript = @"
`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
`$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  `$speech.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [Globalization.CultureInfo]::GetCultureInfo('en-US'))
  `$speech.SetOutputToWaveFile('$escapedRaw')
  `$speech.Speak('This is a live transcription test. We are checking the microphone stream. The meeting starts tomorrow morning.')
} finally { `$speech.Dispose() }
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($speechScript))
  Invoke-BoundedChild "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) 30
  Invoke-BoundedChild $ffmpeg @('-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', ('"' + $raw + '"'),
    '-t', '15', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', ('"' + $sample + '"')) 30
  # This helper checks both daemon ports, owns the shared preparation lock,
  # verifies CUDA process attribution and persists proof only after clean teardown.
  Invoke-BoundedChild $node @(('"' + $helper + '"'), ('"' + $HostRoot + '"'), ('"' + $sample + '"'), 'en', '--already-stopped') 150
  Write-Host 'Native realtime partial, final, cancellation and teardown verification passed.'
} finally {
  foreach ($path in @($sample, $raw)) {
    if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  if ($RestartTray) {
    Start-Process -FilePath (Join-Path $InstallDir 'HiDockModelHost.exe') -ArgumentList '--root', ('"' + $HostRoot + '"') -WindowStyle Hidden
  }
}
