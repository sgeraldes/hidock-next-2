param(
  [string]$OutputDirectory = 'C:\Users\Sebastian\.codex\diagnostics\hidock-oct07',
  [ValidateRange(5,60)][int]$Seconds = 10
)
$ErrorActionPreference = 'Stop'
$tool = 'C:\Program Files (x86)\Windows Kits\10\Windows Performance Toolkit\xperf.exe'
if (!(Test-Path -LiteralPath $tool)) { throw 'Windows Performance Toolkit xperf is required.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this diagnostic in an elevated PowerShell window.'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$raw = Join-Path $OutputDirectory "dpc-$stamp-raw.etl"
$merged = Join-Path $OutputDirectory "dpc-$stamp.etl"
$log = Join-Path $OutputDirectory "dpc-$stamp.log"
# No CPU sampling, stacks or model/device calls. A failed start must never stop
# another recording session. 64–256 64-KiB buffers bound ETW buffering.
& $tool -on 'PROC_THREAD+LOADER+DPC+INTERRUPT' -buffersize 64 -minbuffers 64 -maxbuffers 256 -f $raw *> $log
if ($LASTEXITCODE -ne 0) { throw "Kernel capture was not started; see $log" }
try { Start-Sleep -Seconds $Seconds }
finally {
  & $tool -d $merged *>> $log
  if ($LASTEXITCODE -ne 0) { throw "Kernel capture could not be merged; see $log. Raw trace retained." }
}
& $tool -i $merged -o (Join-Path $OutputDirectory "dpc-$stamp-summary.txt") -a dpcisr -summary *>> $log
& $tool -i $merged -o (Join-Path $OutputDirectory "dpc-$stamp-quality.txt") -a tracestats *>> $log
Write-Output "Saved $merged"
