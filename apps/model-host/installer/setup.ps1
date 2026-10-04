# Setup for the HiDock Model Host, run by the installer with no questions.
#
# Checks the hardware, puts a private Python next to the host, and installs the
# CUDA build of torch and pyannote into it at the client's versions. It asks for
# nothing: the Hugging Face token comes from HiDock when it pairs, and the
# service then runs the model once by itself before it offers to diarize.
#
# It never touches a system Python, PATH, a CUDA toolkit or an existing Ollama,
# and it never installs a display driver. Everything it prints also goes to
# logs\setup.log.

[CmdletBinding()]
param(
  [string] $HostRoot = (Join-Path $env:LOCALAPPDATA 'HiDock Model Host'),
  # The client's venv runs torch 2.13 built for CUDA 12.6. cu121 stopped at
  # torch 2.5, which pyannote 4 rejects, and pip then replaced it with the CPU
  # build from PyPI: a host on a 4090 that diarized on its CPU.
  [string] $CudaTag = 'cu126'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PythonVersion = '3.11.9'
$InstallDir = Split-Path -Parent $PSCommandPath
$RuntimeDir = Join-Path $HostRoot 'runtime'
$PythonDir = Join-Path $RuntimeDir 'python'
$PythonExe = Join-Path $PythonDir 'python.exe'
$ModelsDir = Join-Path $HostRoot 'models'
$ConfigFile = Join-Path $HostRoot 'config.json'
$LogsDir = Join-Path $HostRoot 'logs'
# The exact package versions of the client's working venv.
$Constraints = Join-Path $InstallDir 'constraints.txt'
# The worker decodes every file with ffmpeg; the installer ships one.
$Ffmpeg = Join-Path $InstallDir 'ffmpeg.exe'

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
Start-Transcript -LiteralPath (Join-Path $LogsDir 'setup.log') -Append | Out-Null

function Say($text) { Write-Host "  $text" }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

Step 'This machine'
$cpu = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$ramGiB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Say "Logical processors: $cpu"
Say "Installed RAM: $ramGiB GiB"

$gpuName = $null
$driver = $null
try {
  $smi = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null
  if ($LASTEXITCODE -eq 0 -and $smi) {
    $parts = ($smi -split "`n")[0] -split ','
    $gpuName = $parts[0].Trim()
    $vram = $parts[1].Trim()
    $driver = $parts[2].Trim()
    Say "GPU: $gpuName, $vram MiB, driver $driver"
  }
} catch { }

if (-not $gpuName) {
  Say 'No NVIDIA driver answered.'
  Say 'Work will run on the CPU, which is several times slower.'
  Say 'If this machine has an NVIDIA card, install the driver from'
  Say '  https://www.nvidia.com/Download/index.aspx'
  Say 'and run this setup again. Setup will not install a display driver for you.'
}

# The first character of a path is not a drive. On a UNC path it is a
# backslash, and Get-PSDrive then throws under ErrorActionPreference Stop,
# killing setup before anything is installed — in a script whose whole job is
# to fail gracefully.
$freeGiB = $null
try {
  New-Item -ItemType Directory -Force -Path $HostRoot | Out-Null
  $drive = (Get-Item -LiteralPath $HostRoot).PSDrive
  if ($drive -and $null -ne $drive.Free) {
    $freeGiB = [math]::Round($drive.Free / 1GB, 1)
  }
} catch {
  $freeGiB = $null
}

if ($null -eq $freeGiB) {
  Say 'Could not read the free space for that location; skipping the check.'
} else {
  Say "Free disk where the host will live: $freeGiB GiB"
  if ($freeGiB -lt 12) {
    throw "Setup needs about 12 GiB free and that location has $freeGiB GiB. Free some space and run it again."
  }
}

Step 'Private Python'
if (Test-Path $PythonExe) {
  Say "Already here: $PythonExe"
} else {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $zip = Join-Path $RuntimeDir "python-$PythonVersion-embed-amd64.zip"
  $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
  Say "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $PythonDir -Force
  Remove-Item -LiteralPath $zip -Force

  # The embeddable build ships with site-packages disabled; pip needs it on.
  $pth = Get-ChildItem -Path $PythonDir -Filter 'python*._pth' | Select-Object -First 1
  if ($pth) {
    (Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' |
      Set-Content $pth.FullName -Encoding ascii
  }
  $getPip = Join-Path $PythonDir 'get-pip.py'
  Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
  & $PythonExe $getPip --no-warn-script-location
  Remove-Item -LiteralPath $getPip -Force
  Say "Installed $PythonExe"
}

Step 'Model runtime'
if (-not (Test-Path -LiteralPath $Constraints)) { throw "The installer is missing $Constraints. Reinstall the Model Host." }
if (-not (Test-Path -LiteralPath $Ffmpeg)) { throw "The installer is missing $Ffmpeg. Reinstall the Model Host." }
$torchPins = @(Get-Content -LiteralPath $Constraints | Where-Object { $_ -match '^(torch|torchaudio)==' })
if ($torchPins.Count -ne 2) { throw "constraints.txt does not pin torch and torchaudio." }
$torchIndex = if ($gpuName) { "https://download.pytorch.org/whl/$CudaTag" } else { 'https://download.pytorch.org/whl/cpu' }
Say "$($torchPins -join ', ') from $torchIndex (about 2.5 GB on CUDA)"
& $PythonExe -m pip install --no-warn-script-location --index-url $torchIndex @torchPins
if ($LASTEXITCODE -ne 0) { throw 'Installing torch failed. Nothing else was changed.' }

$requirements = Join-Path $InstallDir 'resources\speaker-linking\requirements.txt'
Say "pyannote from $requirements, at the client's versions"
# The constraints keep pip from swapping the CUDA torch for PyPI's CPU build.
& $PythonExe -m pip install --no-warn-script-location -r $requirements -c $Constraints
if ($LASTEXITCODE -ne 0) { throw 'Installing pyannote failed. Nothing else was changed.' }

Step 'Settings for the service'
# validated stays false: the service runs the model once, by itself, after
# HiDock sends its Hugging Face token. The port and what HiDock chose for
# stepping aside survive a second run of setup.
$config = [ordered]@{
  port = 8765
  cpuPercent = 50
  model = 'pyannote/speaker-diarization-3.1'
  fallbackModel = 'pyannote/speaker-diarization-3.1'
  minSpeechSeconds = 1.5
  timeoutMs = 3600000
  pythonPath = $PythonExe
  workerPath = (Join-Path $InstallDir 'resources\speaker-linking\worker.py')
  ffmpegPath = $Ffmpeg
  validated = $false
  stepAside = 'games'
}
if (Test-Path -LiteralPath $ConfigFile) {
  try {
    $previous = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ($previous.port) { $config.port = [int]$previous.port }
    if ($previous.stepAside) { $config.stepAside = [string]$previous.stepAside }
  } catch {
    Say 'The previous config.json could not be read; starting from the defaults.'
  }
}
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$config | ConvertTo-Json | Set-Content -LiteralPath $ConfigFile -Encoding utf8
Say "Wrote $ConfigFile"

Step 'Done'
Say 'The tray icon starts now. HiDock pairs with it, sends its Hugging Face token,'
Say 'and the host tests the voice model by itself. Nothing else to do here.'
