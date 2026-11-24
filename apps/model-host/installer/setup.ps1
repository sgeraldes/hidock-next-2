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

# What a second run of setup (an upgrade) keeps from the old config.json. Everything
# else is rebuilt here (paths, runtime detection, TLS, the pyannote check) or does
# not belong in that file: the Hugging Face token lives in secrets.json.
#
# The model proofs are copied untouched, fingerprint included. The service
# recomputes each fingerprint when it starts and drops a proof whose runtime or
# model files changed, so keeping a proof here never makes a stale one trusted.
# 'validated' is not kept on purpose: pyannote is tested again with this install.
# Returns the names it kept, for the log. Throws, leaving $Config as it was, when
# the old file cannot be read.
function Merge-PreservedConfig {
  param(
    [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Config,
    [Parameter(Mandatory = $true)] [string] $ConfigFile
  )
  # The service writes this file as UTF-8 without a BOM. Windows PowerShell 5.1 reads
  # that as the ANSI code page unless told otherwise, which garbles non-ASCII text.
  $previous = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($previous -isnot [System.Management.Automation.PSCustomObject]) { throw 'config.json does not hold an object.' }

  $kept = New-Object System.Collections.Generic.List[string]
  # tlsPort is port + 1, so the port has to be a whole number that leaves room for it.
  $port = 0
  $numbers = [System.Globalization.NumberStyles]::Integer
  $invariant = [System.Globalization.CultureInfo]::InvariantCulture
  if ($null -ne $previous.port -and [int]::TryParse([string]$previous.port, $numbers, $invariant, [ref]$port) -and $port -ge 1 -and $port -le 65534) {
    $Config['port'] = $port
    $kept.Add('port')
  }
  $policy = @('cpuPercent', 'model', 'fallbackModel', 'minSpeechSeconds', 'timeoutMs', 'stepAside', 'bindAddress')
  $proofs = @('asrModels', 'asrValidation', 'diarizationValidation', 'semanticEmbeddingValidation', 'realtimeAsrValidation')
  foreach ($name in ($policy + $proofs)) {
    $property = $previous.PSObject.Properties[$name]
    if ($null -ne $property -and $null -ne $property.Value) {
      $Config[$name] = $property.Value
      $kept.Add($name)
    }
  }
  return $kept.ToArray()
}

# The default JSON depth is 2 and writes anything deeper as the text "@{...}". A
# realtime proof keeps its events three levels down, so the depth is explicit.
function Save-HostConfig {
  param(
    [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Config,
    [Parameter(Mandatory = $true)] [string] $ConfigFile
  )
  ConvertTo-Json -InputObject $Config -Depth 32 | Set-Content -LiteralPath $ConfigFile -Encoding utf8
}

Step 'This machine'
$cpu = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$ramGiB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Say "Logical processors: $cpu"
Say "Installed RAM: $ramGiB GiB"

$gpuName = $null
$driver = $null
# No stderr redirection: in Windows PowerShell 5.1 a redirected stderr line is a
# terminating error under 'Stop', and the catch then read a GPU that answered
# as "no NVIDIA driver", which installs the CPU build of torch.
$smiExe = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smiExe) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $smi = & $smiExe.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits
  $smiCode = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($smiCode -eq 0 -and $smi) {
    $parts = (@($smi)[0]) -split ','
    $gpuName = $parts[0].Trim()
    $vram = $parts[1].Trim()
    $driver = $parts[2].Trim()
    Say "GPU: $gpuName, $vram MiB, driver $driver"
  } else {
    Say "nvidia-smi answered with code $smiCode"
  }
}

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

# With a GPU, torch has to see CUDA. If it does not (a CPU build arrived some
# other way), reinstall the pinned CUDA build over it, once, and say so.
function Test-Cuda {
  $out = & $PythonExe -c "import torch; print('cuda' if torch.cuda.is_available() else 'cpu', torch.__version__)"
  Say "torch says: $out"
  return "$out" -like 'cuda*'
}
if ($gpuName) {
  if (-not (Test-Cuda)) {
    Say "torch does not see the GPU; reinstalling $($torchPins -join ', ') from $torchIndex"
    & $PythonExe -m pip install --no-warn-script-location --force-reinstall --no-deps --index-url $torchIndex @torchPins
    if (-not (Test-Cuda)) {
      Write-Host '  torch still does not see the GPU. The host works on the CPU, slower; HiDock shows it and can ask for a repair.' -ForegroundColor Yellow
    }
  }
}

Step 'Decision models runtime (Clef and Clef-Flash)'
# transformers, accelerate and bitsandbytes at the constrained versions; the weights come later,
# the first time HiDock asks for a model. Diarization does not depend on this step.
$decideRequirements = Join-Path $InstallDir 'decide-requirements.txt'
$decideRuntime = $false
if (-not $gpuName) {
  Say 'No NVIDIA GPU: the decision models need one and are not installed.'
} elseif (-not (Test-Path -LiteralPath $decideRequirements)) {
  Say "The installer is missing $decideRequirements; the decision models are not installed."
} else {
  # Clef's Qwen processor needs torchvision. It comes from the same CUDA index as torch, at the
  # build made for it; --no-deps leaves torch alone.
  $visionPin = @(Get-Content -LiteralPath $Constraints | Where-Object { $_ -match '^torchvision==' })
  if ($visionPin.Count -ne 1) { throw 'constraints.txt does not pin torchvision.' }
  & $PythonExe -m pip install --no-warn-script-location --no-deps --index-url $torchIndex @visionPin
  if ($LASTEXITCODE -eq 0) {
    & $PythonExe -m pip install --no-warn-script-location -r $decideRequirements -c $Constraints
  }
  if ($LASTEXITCODE -eq 0) {
    $versions = & $PythonExe -c "import torchvision, transformers, bitsandbytes; print('torchvision', torchvision.__version__, 'transformers', transformers.__version__, 'bitsandbytes', bitsandbytes.__version__)"
    $decideRuntime = ($LASTEXITCODE -eq 0)
    Say "$versions"
  }
  if (-not $decideRuntime) {
    Write-Host '  The decision runtime did not install. Diarization works as before; HiDock sees no decide capability.' -ForegroundColor Yellow
  }
}

Step 'Settings for the service'
# validated stays false: the service runs the model once, by itself, after
# HiDock sends its Hugging Face token. The port, what HiDock chose for stepping
# aside and the model proofs survive a second run of setup (Merge-PreservedConfig).
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
  decideRuntime = $decideRuntime
}
if (Test-Path -LiteralPath $ConfigFile) {
  try {
    $kept = @(Merge-PreservedConfig -Config $config -ConfigFile $ConfigFile)
    if ($kept.Count -gt 0) { Say "Kept from the previous config.json: $($kept -join ', ')" }
  } catch {
    Say 'The previous config.json could not be read; starting from the defaults.'
  }
}
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
Step 'Private TLS identity for remote connections'
& $PythonExe -m pip install --no-warn-script-location 'cryptography>=42,<51'
if ($LASTEXITCODE -ne 0) { throw 'TLS dependency installation failed; existing configuration was preserved.' }
$TlsRoot = Join-Path $HostRoot 'tls'
New-Item -ItemType Directory -Force -Path $TlsRoot | Out-Null
$TlsOwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $TlsRoot /inheritance:r /grant:r "*${TlsOwnerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the private TLS directory.' }
$TlsJson = & $PythonExe (Join-Path $InstallDir 'src\provision_tls.py') $TlsRoot
if ($LASTEXITCODE -ne 0) { throw 'TLS identity creation failed; existing configuration was preserved.' }
$TlsIdentity = $TlsJson | ConvertFrom-Json
$config.tlsCertPath = $TlsIdentity.certificate
$config.tlsKeyPath = $TlsIdentity.key
$config.tlsPort = $config.port + 1
Save-HostConfig -Config $config -ConfigFile $ConfigFile
Say "Wrote $ConfigFile"
Say "Remote address: https://$($TlsIdentity.hostname):$($config.tlsPort)"
Say "Import only this PUBLIC file in HiDock: $($TlsIdentity.certificate)"
Say "Certificate SHA-256: $($TlsIdentity.sha256)"

Step 'Done'
Say 'The tray icon starts now. HiDock pairs with it, sends its Hugging Face token,'
Say 'and the host tests the voice model by itself. Nothing else to do here.'
