# Fixed official model preparation and bounded native generation verification.
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
$lockStream = $null

function Invoke-BoundedChild([string] $Executable, [string[]] $Arguments, [int] $TimeoutSeconds) {
  $childLog = Join-Path $logDir ('generation-child-' + [guid]::NewGuid().ToString())
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
      throw "Generation preparation child exceeded $TimeoutSeconds seconds."
    }
    $child.WaitForExit() # drain redirected output after the bounded wait completed
    $child.Refresh()
    if ($null -eq $child.ExitCode) { throw "Generation preparation child exit status unavailable; see $childLog.err.log." }
    if ($child.ExitCode -ne 0) { throw "Generation preparation child failed (exit $($child.ExitCode)); see $childLog.err.log." }
  } finally { $child.Dispose() }
}

try {
  if ($RestartTray) { Start-Sleep -Seconds 2 }
  $logDir = Join-Path $HostRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Transcript -LiteralPath (Join-Path $logDir 'prepare-generation.log') -Append | Out-Null
  $transcriptStarted = $true
  $config = Get-Content -LiteralPath (Join-Path $HostRoot 'config.json') -Raw | ConvertFrom-Json
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($InstallDir) -and $_.CommandLine.Contains('main.mjs')
  }
  if ($running) { throw 'Quit the host tray before preparing managed generation.' }
  $health = $null
  try { $health = Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 3 } catch { }
  if ($health) { throw 'The host daemon must be stopped before generation verification.' }
  if (Test-Path -LiteralPath (Join-Path $HostRoot 'asr-preparing.lock')) { throw 'Another model preparation is active.' }
  $lockStream = [IO.File]::Open((Join-Path $HostRoot 'asr-preparing.lock'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $node = Join-Path $InstallDir 'node.exe'
  $prepare = Join-Path $InstallDir 'src\prepare_generation.py'
  $validate = Join-Path $InstallDir 'src\validate-generation.mjs'
  Invoke-BoundedChild $config.pythonPath @('-S', ('"' + $prepare + '"'), '--root', ('"' + $HostRoot + '"')) 3600
  Invoke-BoundedChild $node @(('"' + $validate + '"'), ('"' + $HostRoot + '"'), '--preparation-locked') 150
  Write-Host 'Managed generation preparation passed.'
} finally {
  foreach ($path in @($sample, $raw)) {
    if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  if ($lockStream) { $lockStream.Dispose(); Remove-Item -LiteralPath (Join-Path $HostRoot 'asr-preparing.lock') -Force }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  if ($RestartTray) {
    Start-Process -FilePath (Join-Path $InstallDir 'HiDockModelHost.exe') -ArgumentList '--root', ('"' + $HostRoot + '"') -WindowStyle Hidden
  }
}
