# Explicit, optional ASR preparation on the worker PC. It never runs on the client.
[CmdletBinding()]
param(
  [ValidateSet('CohereLabs/cohere-transcribe-03-2026', 'microsoft/VibeVoice-ASR', 'nvidia/parakeet-tdt-0.6b-v3', 'Qwen/Qwen3-ASR-0.6B', 'moondream/parakeet-ultra', 'Qwen/Qwen3-ASR-1.7B', 'nvidia/nemotron-3.5-asr-streaming-0.6b', 'OpenMOSS-Team/MOSS-Transcribe-Diarize', 'nvidia/Nemotron-3-Diarization', 'Edge0/Audio8-ASR-Infinite')]
  [string] $Model = 'CohereLabs/cohere-transcribe-03-2026',
  [string] $HostRoot = (Join-Path $env:LOCALAPPDATA 'HiDock Model Host'),
  [switch] $RestartTray
)
$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $PSCommandPath
if ($RestartTray) { Start-Sleep -Seconds 2 }
$lock = $null
$transcriptStarted = $false
try {
$logDir = Join-Path $HostRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -LiteralPath (Join-Path $logDir 'prepare-asr.log') -Append | Out-Null
$transcriptStarted = $true
$PythonExe = Join-Path $HostRoot 'runtime\python\python.exe'
$ConfigFile = Join-Path $HostRoot 'config.json'
$Constraints = Join-Path $InstallDir 'constraints.txt'
$lockPath = Join-Path $HostRoot 'asr-preparing.lock'
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Install the HiDock Model Host first.' }
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
# Stop from the tray first: preparation must not compete with an admitted job.
$health = $null
try { $health = Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 3 } catch { }
if ($health) { throw 'Quit the worker tray before preparing ASR, then start it again after preparation.' }
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($InstallDir) -and $_.CommandLine.Contains('main.mjs') }
if ($running) { throw 'The host service is still running. Quit its tray before preparing ASR.' }
$env:HIDOCK_DIARIZATION_THREADS = [string][math]::Max(1, [math]::Floor([Environment]::ProcessorCount / 2))
foreach ($name in @('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS','TORCH_NUM_THREADS')) {
  [Environment]::SetEnvironmentVariable($name, $env:HIDOCK_DIARIZATION_THREADS, 'Process')
}
$env:HIDOCK_WORKER_PRIORITY = 'below-normal'
$env:HIDOCK_WORKER_MEMORY_MB = '16384'
$env:FFMPEG_PATH = Join-Path $InstallDir 'ffmpeg.exe'
$secretsFile = Join-Path $HostRoot 'secrets.json'
if (Test-Path -LiteralPath $secretsFile) { $env:HF_TOKEN = (Get-Content -LiteralPath $secretsFile -Raw | ConvertFrom-Json).hfToken }
Write-Host 'Installing ASR runtime. Model downloads may require several GB and accepted Hugging Face terms.'
if ($Model -eq 'Edge0/Audio8-ASR-Infinite') {
  # Official package supports Python 3.11/3.12 and Torch 2.13; reuse the matched
  # base CUDA torch/torchvision pair, never introduce a second CUDA runtime.
  & $PythonExe -c "import sys,torch; assert (3,11)<=sys.version_info[:2]<(3,13); assert torch.__version__.split('+')[0].startswith('2.13.'); assert torch.cuda.is_available()"
  if ($LASTEXITCODE -ne 0) { throw 'Audio8 requires base Python 3.11/3.12 and working CUDA Torch 2.13.' }
  $Audio8Site = Join-Path $HostRoot 'runtime\asr-audio8\site'
  & $PythonExe -m pip install --target $Audio8Site --upgrade --only-binary=:all: 'transformers==5.13.0' 'numpy==2.2.6' 'safetensors==0.8.0'
  if ($LASTEXITCODE -ne 0) { throw 'Isolated Audio8 Transformers installation failed.' }
  & $PythonExe (Join-Path $InstallDir 'src\prepare_audio8_asr.py') --model-dir (Join-Path $HostRoot 'models\audio8-asr-infinite')
  if ($LASTEXITCODE -ne 0) { throw 'Pinned Audio8 model/source preparation failed.' }
} elseif ($Model -eq 'OpenMOSS-Team/MOSS-Transcribe-Diarize') {
  $MossSite = Join-Path $HostRoot 'runtime\asr-moss\site'
  & $PythonExe -m pip install --target $MossSite --upgrade --no-deps 'transformers==5.10.2'
  if ($LASTEXITCODE -ne 0) { throw 'Isolated MOSS Transformers installation failed.' }
  & $PythonExe (Join-Path $InstallDir 'src\prepare_moss_asr.py') --model-dir (Join-Path $HostRoot 'models\moss-transcribe-diarize')
  if ($LASTEXITCODE -ne 0) { throw 'Pinned MOSS model preparation failed.' }
} elseif ($Model -eq 'nvidia/Nemotron-3-Diarization') {
  & $PythonExe (Join-Path $InstallDir 'src\prepare_nemotron_diarization.py') --root $HostRoot --model $Model
  if ($LASTEXITCODE -ne 0) { throw 'Pinned native diarization preparation failed.' }
} elseif ($Model -eq 'nvidia/nemotron-3.5-asr-streaming-0.6b') {
  & $PythonExe (Join-Path $InstallDir 'src\prepare_nemotron_asr.py') --root $HostRoot --model $Model
  if ($LASTEXITCODE -ne 0) { throw 'Pinned native Nemotron runtime/model preparation failed.' }
} elseif ($Model -in @('nvidia/parakeet-tdt-0.6b-v3', 'Qwen/Qwen3-ASR-0.6B')) {
  $OnnxSite = Join-Path $HostRoot 'runtime\asr-onnx\site'
  & $PythonExe -m pip install --target $OnnxSite --upgrade --only-binary=:all: 'sherpa-onnx==1.13.8' 'numpy==2.2.6' 'soundfile==0.13.1'
  if ($LASTEXITCODE -ne 0) { throw 'Isolated ONNX runtime installation failed.' }
  & $PythonExe (Join-Path $InstallDir 'src\prepare_onnx_asr.py') --root $HostRoot --model $Model
  if ($LASTEXITCODE -ne 0) { throw 'ASR model artifact preparation failed.' }
} elseif ($Model -in @('moondream/parakeet-ultra', 'Qwen/Qwen3-ASR-1.7B')) {
  $PhotonSite = Join-Path $HostRoot 'runtime\asr-photon\site'
  # Photon needs the CUDA Library API (>=12.8). Keep its torch isolated from
  # the existing cu126 diarization/Cohere environment.
  $PhotonTorch = Join-Path $PhotonSite 'torch\version.py'
  if (-not (Test-Path -LiteralPath $PhotonTorch) -or -not ((Get-Content -LiteralPath $PhotonTorch -Raw) -match '2\.9\.1\+cu128')) {
    & $PythonExe -m pip install --target $PhotonSite --upgrade --only-binary=:all: --no-deps 'https://download-r2.pytorch.org/whl/cu128/torch-2.9.1%2Bcu128-cp311-cp311-win_amd64.whl#sha256=633005a3700e81b5be0df2a7d3c1d48aced23ed927653797a3bd2b144a3aeeb6'
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Photon CUDA 12.8 torch installation failed.' }
  }
  & $PythonExe -m pip install --target $PhotonSite --upgrade --only-binary=:all: --no-deps 'moondream==2.6.1' 'kestrel==0.9.1' 'kestrel-native==0.1.8' 'kestrel-kernels==0.7.4' 'torch-c-dlpack-ext==0.1.5' 'kestrel-kernels-bundle-a==0.7.4' 'kestrel-kernels-bundle-b==0.7.4' 'kestrel-kernels-bundle-c==0.7.4' 'kestrel-kernels-bundle-d==0.7.4' 'kestrel-kernels-bundle-e==0.7.4'
  if ($LASTEXITCODE -ne 0) { throw 'Isolated Photon runtime installation failed.' }
  & $PythonExe (Join-Path $InstallDir 'src\prepare_photon_asr.py') --root $HostRoot --model $Model
  if ($LASTEXITCODE -ne 0) { throw 'Photon checkpoint preparation failed.' }
} else {
& $PythonExe -m pip install -c $Constraints 'transformers==5.10.2' accelerate soundfile librosa sentencepiece protobuf
if ($LASTEXITCODE -ne 0) { throw 'ASR dependencies failed; this engine remains unavailable.' }
if ($Model -eq 'microsoft/VibeVoice-ASR') {
  & $PythonExe -m pip install -c $Constraints 'https://github.com/microsoft/VibeVoice/archive/16fb2cb1217c9934a886e1948ffb06120caa2df5.zip'
  if ($LASTEXITCODE -ne 0) { throw 'VibeVoice installation failed; this engine remains unavailable.' }
}
}
$sample = Join-Path $HostRoot ('asr-test-' + [guid]::NewGuid().ToString() + '.wav')
try {
  Add-Type -AssemblyName System.Speech
  $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $speech.SetOutputToWaveFile($sample)
    $speech.Speak('This is a short test of the remote transcription worker. The meeting starts at nine tomorrow.')
  } finally { $speech.Dispose() }
  if ($Model -eq 'nvidia/Nemotron-3-Diarization') {
    & (Join-Path $InstallDir 'node.exe') (Join-Path $InstallDir 'src\validate-native-diarization.mjs') $HostRoot $sample
  } else {
    & (Join-Path $InstallDir 'node.exe') (Join-Path $InstallDir 'src\validate-asr.mjs') $HostRoot $Model $sample
  }
  if ($LASTEXITCODE -ne 0) { throw 'ASR model test failed; this engine remains unavailable.' }

} finally {
  Remove-Item -LiteralPath $sample -Force -ErrorAction SilentlyContinue
  Remove-Item Env:HF_TOKEN -ErrorAction SilentlyContinue
}

} finally {
  if ($null -ne $lock) {
    $lock.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  if ($RestartTray) {
    Start-Process -FilePath (Join-Path $InstallDir 'HiDockModelHost.exe') -ArgumentList '--root', ('"' + $HostRoot + '"') -WindowStyle Hidden
  }
}
