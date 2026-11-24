param([switch]$FirmwareQualification, [switch]$PackagedSmoke)
$ErrorActionPreference = 'Stop'
if ($FirmwareQualification -and $PackagedSmoke) { throw 'Packaged smoke is read-only' }
$taskApps = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('electron.exe','HiDock Next.exe') })
# A verified --brain-only entry point never imports the device application.
# Preserve that independent process and its children; reject every other owner.
$taskBrainIds = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($taskApp in $taskApps) {
  if ($taskApp.CommandLine -match '(?:^|\s)--brain-only(?:\s|$)') { [void]$taskBrainIds.Add($taskApp.ProcessId) }
}
do {
  $taskAdded = $false
  foreach ($taskApp in $taskApps) {
    if ($taskBrainIds.Contains($taskApp.ParentProcessId) -and $taskBrainIds.Add($taskApp.ProcessId)) { $taskAdded = $true }
  }
} while ($taskAdded)
if (@($taskApps | Where-Object { -not $taskBrainIds.Contains($_.ProcessId) }).Count) { throw 'An existing device application owner is still running' }
$taskPrivate = Join-Path (Get-Location) 'node_modules\.cache\completion630-runtime'
$taskProfile = (Get-Content -LiteralPath (Join-Path $taskPrivate 'isolated-profile.private.json') -Raw | ConvertFrom-Json).profile
$taskPriorProfile = $env:HIDOCK_DEV_USERDATA
$taskNodeMode = $env:ELECTRON_RUN_AS_NODE
$env:HIDOCK_DEV_USERDATA = $taskProfile
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
try {
  $taskStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $taskArguments = @('.', '--recovery-mode')
  if ($FirmwareQualification) { $taskArguments += '--firmware-qualification' } else { $taskArguments += '--device-validation' }
  $taskExecutable = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
  if ($PackagedSmoke) {
    $taskExecutable = Join-Path (Get-Location) 'node_modules\.cache\firmware-flash-package-20261012-restore4-final\win-unpacked\HiDock Next.exe'
    if (!(Test-Path -LiteralPath $taskExecutable -PathType Leaf)) { throw 'Accepted packaged app is unavailable' }
    $taskArguments = @('--recovery-mode', '--device-validation', '--device-validation-smoke')
  }
  $taskProcess = Start-Process -FilePath $taskExecutable -ArgumentList $taskArguments -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskPrivate "app-$taskStamp.stdout.private.log") -RedirectStandardError (Join-Path $taskPrivate "app-$taskStamp.stderr.private.log") -PassThru
  @{ pid=$taskProcess.Id; stamp=$taskStamp } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $taskPrivate 'current-app.private.json')
  if ($PackagedSmoke) { @{pid=$taskProcess.Id; executable=$taskExecutable; isolatedProfile=$true; readOnlyDeviceValidation=$true; firmwareWritesRequested=0; stamp=$taskStamp} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskPrivate 'packed-app-restore4.private.json') }
  @{ started=$true; pid=$taskProcess.Id; isolatedLibrary=$true; hardwareMode=$(if ($FirmwareQualification) { 'explicit-firmware-qualification' } else { 'read-only-device-validation' }) } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $taskPriorProfile) { $env:HIDOCK_DEV_USERDATA=$taskPriorProfile } else { Remove-Item Env:HIDOCK_DEV_USERDATA -ErrorAction SilentlyContinue }
  if ($null -ne $taskNodeMode) { $env:ELECTRON_RUN_AS_NODE=$taskNodeMode }
}
