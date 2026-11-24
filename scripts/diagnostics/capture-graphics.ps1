param([ValidateRange(5,60)][int]$Seconds = 60)
$ErrorActionPreference = 'Stop'
$directory = 'C:\Users\Sebastian\.codex\diagnostics\hidock-oct07'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = "HiDockGraphics-$stamp"
$output = Join-Path $directory "graphics-$stamp.etl"
$log = Join-Path $directory "graphics-$stamp.log"
$providers = Join-Path $directory "graphics-$stamp-providers.txt"
# Present events plus low-overhead frame/input tracking only. Circular 32 MiB.
@(
  'Microsoft-Windows-DxgKrnl 0x8000000 4'
  'Microsoft-Windows-Dwm-Core 0x220008 4'
) | Set-Content -LiteralPath $providers -Encoding ascii
& logman create trace $name -pf $providers -o $output -f bincirc -max 32 -nb 16 32 -bs 64 -ets *> $log
if ($LASTEXITCODE -ne 0) { throw "Graphics capture did not start: $log" }
'Started' | Add-Content -LiteralPath $log
try { Start-Sleep -Seconds $Seconds }
finally { & logman stop $name -ets *>> $log }
