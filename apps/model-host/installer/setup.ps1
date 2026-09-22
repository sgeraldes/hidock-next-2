# First run for the HiDock Model Host.
#
# Checks the hardware, puts a private Python next to the host, installs the CUDA
# build of torch and pyannote into it, downloads the diarization model, then
# proves the whole chain on a synthetic clip before saying it works.
#
# It never touches a system Python, PATH, a CUDA toolkit or an existing Ollama,
# and it never installs a display driver.

[CmdletBinding()]
param(
  [string] $HostRoot = (Join-Path $env:LOCALAPPDATA 'HiDock Model Host'),
  [string] $HuggingFaceToken = '',
  # 12.1 matches the wheels pyannote's torch is built against today.
  [string] $CudaTag = 'cu121',
  [switch] $SkipValidation
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
$torchIndex = if ($gpuName) { "https://download.pytorch.org/whl/$CudaTag" } else { 'https://download.pytorch.org/whl/cpu' }
Say "torch from $torchIndex (about 2.5 GB on CUDA)"
& $PythonExe -m pip install --no-warn-script-location --index-url $torchIndex torch torchaudio
if ($LASTEXITCODE -ne 0) { throw 'Installing torch failed. Nothing else was changed.' }

$requirements = Join-Path $InstallDir 'resources\speaker-linking\requirements.txt'
Say "pyannote from $requirements"
& $PythonExe -m pip install --no-warn-script-location -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Installing pyannote failed. Nothing else was changed.' }

Step 'Diarization model'
if (-not $HuggingFaceToken) {
  Write-Host '  pyannote models need a Hugging Face token and their licence accepted.' -ForegroundColor Yellow
  Write-Host '  Accept at https://huggingface.co/pyannote/speaker-diarization-community-1'
  Write-Host '  then create a token at https://huggingface.co/settings/tokens'
  $HuggingFaceToken = Read-Host '  Paste the token (or press Enter to do this later)'
}

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

# The Hugging Face token is a real credential and it does NOT go in
# config.json, which is written with default ACLs. It gets its own file,
# readable by this account only, the same treatment tokens.json gets.
function Write-Secrets($token) {
  $secretsFile = Join-Path $HostRoot 'secrets.json'
  @{ hfToken = $token } | ConvertTo-Json | Set-Content -LiteralPath $secretsFile -Encoding utf8
  $acl = Get-Acl -LiteralPath $secretsFile
  $acl.SetAccessRuleProtection($true, $false)
  $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $secretsFile -AclObject $acl
  Say "Wrote $secretsFile, readable by this account only"
}

# config.json is written only after the model has actually run. A config on
# disk is what makes the host advertise that it can diarize, and writing it
# before validation is exactly the green light that never ran the model.
function Write-HostConfig {
  $config = @{
    port = 8765
    cpuPercent = 50
    model = 'pyannote/speaker-diarization-community-1'
    fallbackModel = 'pyannote/speaker-diarization-3.1'
    minSpeechSeconds = 1.5
    timeoutMs = 3600000
    pythonPath = $PythonExe
    workerPath = (Join-Path $InstallDir 'resources\speaker-linking\worker.py')
    ffmpegPath = ''
    validated = $true
  }
  $config | ConvertTo-Json | Set-Content -LiteralPath $ConfigFile -Encoding utf8
  Say "Wrote $ConfigFile"
}

if ($HuggingFaceToken) { Write-Secrets $HuggingFaceToken }

if ($SkipValidation -or -not $HuggingFaceToken) {
  Step 'Not validated'
  Say 'Setup finished without running the model once, so the host will not'
  Say 'advertise that it can diarize. Run this setup again with a token to'
  Say 'finish, or diarize one recording locally in the meantime.'
  exit 0
}

Step 'Proving it works'
# A synthetic clip, so this says something about THIS machine rather than about
# a green light. Two tones with a gap, which pyannote reads as two turns.
$wav = Join-Path $env:TEMP 'hidock-host-validate.wav'
$py = @'
import math, struct, wave, sys
rate = 16000
frames = []
for i in range(rate * 6):
    t = i / rate
    freq = 180 if t < 2.5 else (0 if t < 3.5 else 320)
    value = 0 if freq == 0 else int(12000 * math.sin(2 * math.pi * freq * t))
    frames.append(struct.pack('<h', value))
with wave.open(sys.argv[1], 'wb') as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate)
    f.writeframes(b''.join(frames))
'@
$tmpScript = Join-Path $env:TEMP 'hidock-make-wav.py'
Set-Content -LiteralPath $tmpScript -Value $py -Encoding utf8
& $PythonExe $tmpScript $wav
Remove-Item -LiteralPath $tmpScript -Force

$env:HF_TOKEN = $HuggingFaceToken
$env:HUGGINGFACE_HUB_TOKEN = $HuggingFaceToken
$worker = Join-Path $InstallDir 'resources\speaker-linking\worker.py'
$output = & $PythonExe $worker --audio $wav --model 'pyannote/speaker-diarization-community-1' --fallback-model 'pyannote/speaker-diarization-3.1' --min-speech-seconds 0.5 2>&1
$code = $LASTEXITCODE
Remove-Item -LiteralPath $wav -Force -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Write-Host '  Diarization did not run on this machine.' -ForegroundColor Red
  Write-Host ($output | Select-Object -Last 15)
  throw 'Setup installed the runtime but could not prove it works. Fix the error above and run setup again.'
}

try {
  $result = $output | ConvertFrom-Json
  Write-HostConfig
  Say "Model: $($result.model) $($result.modelVersion)"
  Say "Device: $($result.device)"
  Say "Turns found on the test clip: $($result.segments.Count)"
  if ($gpuName -and $result.device -notlike 'cuda*') {
    Write-Host '  The GPU is present but the model ran on the CPU.' -ForegroundColor Yellow
    Write-Host '  Check that the torch build matches the driver; the host still works, slower.'
  }
} catch {
  throw "The worker ran but its output could not be read: $output"
}

Step 'Done'
Say "Start the host from the Start Menu, then open http://localhost:8765/"
Say 'Press Start there, then Show a pairing code, and pair HiDock Next with it.'
