param(
  [string]$ProfilePath = 'C:\Users\Sebastian\AppData\Roaming\hidock-universal-knowledge-hub',
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [int]$Samples = 12,
  [int]$IntervalSeconds = 3
)
$ErrorActionPreference = 'Stop'
if ($Samples -lt 1 -or $Samples -gt 40 -or $IntervalSeconds -lt 2) { throw 'Invalid bounded sampling window' }
$discovery = Get-Content -LiteralPath (Join-Path $ProfilePath 'brain.json') -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($discovery.token)" }
$base = "http://127.0.0.1:$($discovery.port)"
$health = Invoke-RestMethod -Uri "$base/health" -Headers $headers -TimeoutSec 2
if ($health.pid -ne $discovery.pid -or $health.instanceId -ne $discovery.instanceId) { throw 'Backend identity mismatch' }
$rows = @()
$lastCpu = $null
$lastAt = $null
$logicalCores = [Environment]::ProcessorCount
for ($i = 0; $i -lt $Samples; $i++) {
  $at = [DateTimeOffset]::UtcNow
  $proc = Get-Process -Id $discovery.pid -ErrorAction SilentlyContinue
  $cpu = if ($proc) { $proc.TotalProcessorTime.TotalSeconds } else { $null }
  $percent = if ($null -ne $lastCpu -and $null -ne $cpu) {
    [Math]::Round(100 * ($cpu - $lastCpu) / ($at - $lastAt).TotalSeconds / $logicalCores, 2)
  } else { $null }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $state = $null
  $fault = $null
  try { $state = Invoke-RestMethod -Uri "$base/backend/status" -Headers $headers -TimeoutSec 2 }
  catch { $fault = $_.Exception.GetType().Name }
  $timer.Stop()
  $remote = $null
  try { $remote = Invoke-RestMethod -Uri 'http://gamestation:8765/health' -TimeoutSec 2 }
  catch { $remote = @{ state = 'unreachable' } }
  $rows += [pscustomobject]@{
    timestamp = $at.ToString('o'); mainPid = $discovery.pid
    mainCpuPercentOfMachine = $percent
    mainWorkingSetMiB = if ($proc) { [Math]::Round($proc.WorkingSet64 / 1MB, 1) } else { $null }
    backendResponseMs = $timer.ElapsedMilliseconds; backendError = $fault
    queue = $state.queue; hostState = $remote.state
  }
  $lastCpu = $cpu; $lastAt = $at
  if ($i -lt $Samples - 1) { Start-Sleep -Seconds $IntervalSeconds }
}
@{ sampledAt = [DateTimeOffset]::UtcNow.ToString('o'); logicalCores = $logicalCores
  limitations = 'Main process only; excludes renderer/workers, system commit, GPU and IRQs. Busy host does not identify job ownership. HTTP timeout does not alone prove a system freeze.'
  samples = $rows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output "Saved $($rows.Count) samples to $OutputPath"
