# Explicit preparation of already imported assets. No model downloads or shared Python changes.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $ImportedModelDir,
  [string] $HostRoot = (Join-Path $env:LOCALAPPDATA 'HiDock Model Host'),
  [switch] $RestartTray
)
$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $PSCommandPath
$lock = $null
$transcriptStarted = $false
$LogDir = Join-Path $HostRoot 'logs'
if ($RestartTray) { Start-Sleep -Seconds 2 }
try {
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -LiteralPath (Join-Path $LogDir 'prepare-semantic.log') -Append | Out-Null
$transcriptStarted = $true
$ExpectedModel = [IO.Path]::GetFullPath((Join-Path $HostRoot 'models\nemotron-3-embed-1b'))
$ActualModel = (Resolve-Path -LiteralPath $ImportedModelDir).Path.TrimEnd('\')
if ($ActualModel -ne $ExpectedModel.TrimEnd('\')) { throw 'Import assets into the host models\nemotron-3-embed-1b directory first.' }
if ((Get-Item -LiteralPath $ActualModel).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked model directories are not supported.' }
$PythonExe = Join-Path $HostRoot 'runtime\python\python.exe'
$NodeExe = Join-Path $InstallDir 'node.exe'
if (!(Test-Path -LiteralPath $PythonExe) -or !(Test-Path -LiteralPath $NodeExe)) { throw 'Install the native model host first.' }
$Config = Get-Content -LiteralPath (Join-Path $HostRoot 'config.json') -Raw | ConvertFrom-Json
$health = $null
try { $health = Invoke-RestMethod "http://127.0.0.1:$($Config.port)/health" -TimeoutSec 3 } catch { }
if ($health) { throw 'Stop the model host from its tray before explicit model preparation.' }
$LogDir = Join-Path $HostRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$lock = $null
function Invoke-Bounded([string] $Executable, [string[]] $Arguments, [int] $Seconds, [string] $Label) {
  foreach ($argument in $Arguments) { if ($argument.Contains('"')) { throw 'Invalid quoted argument' } }
  $quoted = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "semantic-$Label.out.log") `
    -RedirectStandardError (Join-Path $LogDir "semantic-$Label.err.log")
  try {
    # Windows PowerShell 5.1 loses the exit code unless the handle is retained before waiting.
    $processHandle = $process.Handle
    if (!$process.WaitForExit($Seconds * 1000)) { $process.Kill(); throw "$Label exceeded preparation deadline." }
    $exitCode = $process.ExitCode
    Write-Output "$Label completed with exit code $exitCode"
    if ($null -eq $exitCode -or $exitCode -ne 0) { throw "$Label failed (exit $exitCode); inspect semantic preparation logs." }
  } finally { $process.Dispose() }
}
  $lock = [IO.File]::Open((Join-Path $HostRoot 'semantic-preparing.lock'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  Invoke-Bounded $PythonExe @('-c', 'import sys,transformers; assert sys.version_info[:2] == (3,11)') 30 'prerequisites'
  $site = Join-Path $HostRoot 'runtime\semantic-embeddings\site'
  Invoke-Bounded $PythonExe @('-m', 'pip', 'install', '--target', $site, '--upgrade', '--no-deps', '--only-binary=:all:', '--retries', '0', '--timeout', '60', 'onnxruntime==1.31.0', 'numpy==2.2.6') 600 'dependencies'
  Invoke-Bounded $PythonExe @((Join-Path $InstallDir 'src\prepare_semantic_embeddings.py'), '--model-dir', $ActualModel) 300 'manifest'
  Invoke-Bounded $NodeExe @((Join-Path $InstallDir 'src\validate-semantic-embeddings.mjs'), $HostRoot) 300 'validation'
  Write-Output 'Semantic embeddings validated. Start the host explicitly to advertise the capability.'
} catch {
  $_ | Out-String | Add-Content -LiteralPath (Join-Path $LogDir 'prepare-semantic-error.log')
  throw
} finally {
  if ($lock) { $lock.Dispose(); Remove-Item -LiteralPath (Join-Path $HostRoot 'semantic-preparing.lock') -Force -ErrorAction SilentlyContinue }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  if ($RestartTray) {
    Start-Process -FilePath (Join-Path $InstallDir 'HiDockModelHost.exe') -ArgumentList '--root', ('"' + $HostRoot + '"') -WindowStyle Hidden
  }
}
