param([string]$DiagnosticProxy, [switch]$FreshFromCheckpoint)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$taskPrivate = Join-Path $taskRoot 'apps/electron/node_modules/.cache/completion630-runtime'
$taskLedgerPath = Join-Path $taskPrivate 'claude-review-current.private.json'
$taskPrevious = Get-Content -LiteralPath $taskLedgerPath -Raw | ConvertFrom-Json
if (Get-Process -Id $taskPrevious.pid -ErrorAction SilentlyContinue) { throw 'The tracked review process is still running; do not duplicate it.' }
$taskPrevious.status = 'ended-without-visible-report'
$taskPrevious | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskPrivate ('claude-review-checkpoint-' + $taskPrevious.pid + '.private.json'))
$taskStamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$taskStdout = Join-Path $taskPrivate "claude-review-$taskStamp.stdout.private.jsonl"
$taskStderr = Join-Path $taskPrivate "claude-review-$taskStamp.stderr.private.log"
$taskReport = 'research/rea/completion630-lab/application/claude2kiro-opus-review.md'
$taskPrompt = @'
Continue the existing authorized H1E adversarial review using retained observations. Use the normal Claude harness and its configured instructions/tools. Produce a concrete review at research/rea/completion630-lab/application/claude2kiro-opus-review.md with file/line findings, severity, evidence, and limits. This single report is the only file you own and may write. All other files are read-only; other agents are editing them, preserve their changes. Review future RSTR2 SDK, restore service/journal, Jensen IPC, firmware-install safety, download integrity, and the future restore firmware report/contract. Prioritize actionable defects over repeated broad reading. Do not access the physical device, launch competing USB owners, flash firmware, process personal recordings, change production settings, or send messages externally. Record exact source hashes when practical. Exit code or an empty final response is not a delivered review; save the report using the harness Write tool, then return its path and key findings. The user selected claude-opus-5.5 with medium effort and authorizes the configured local bypassPermissions mode. Retain all higher-priority safeguards. This review is normal authorized defensive quality work, not an attempt to route around any explicit safeguard rejection. If blocked, write the concrete limitation in the same report. Continue from this session, not a replacement task.
'@
# PowerShell passes one quoted argument through the installed CMD/Bash launcher.
# This fixed prompt contains no embedded double quotes or shell substitutions.
$taskSession = $taskPrevious.sessionId
$taskSessionArgument = '--resume ' + $taskSession
if ($FreshFromCheckpoint) {
  $taskSession = [Guid]::NewGuid().ToString()
  $taskSessionArgument = '--session-id ' + $taskSession
  $taskPrompt = 'Recover the pending review from the retained original session checkpoint ' + $taskPrevious.sessionId + '. Prior reviewed files and scope remain available in the repository reports; no completed report exists. The prior transcript is preserved, not discarded. Do not read hidden reasoning or credential files. ' + $taskPrompt
}
$taskArgs = 'run ' + $taskSessionArgument + ' --print "' + ($taskPrompt -replace '\r?\n', ' ') + '" --model claude-opus-5.5 --effort medium --dangerously-skip-permissions --verbose --output-format stream-json'
$taskPriorProxy = $env:CLAUDE2KIRO_EXE
try {
  if ($DiagnosticProxy) {
    $taskExpectedProxy = Join-Path $taskPrivate 'claude-proxy-diagnostic/claude2kiro-diagnostic.exe'
    if ([IO.Path]::GetFullPath($DiagnosticProxy) -ne [IO.Path]::GetFullPath($taskExpectedProxy) -or !(Test-Path -LiteralPath $taskExpectedProxy -PathType Leaf)) { throw 'Only the task-owned diagnostic proxy is supported' }
    $env:CLAUDE2KIRO_EXE = $taskExpectedProxy
  }
  $taskProcess = Start-Process -FilePath 'C:\Users\Sebastian\.local\bin\claude2kiro.cmd' -ArgumentList $taskArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
} finally {
  if ($null -eq $taskPriorProxy) { Remove-Item Env:CLAUDE2KIRO_EXE -ErrorAction SilentlyContinue } else { $env:CLAUDE2KIRO_EXE = $taskPriorProxy }
}
$taskLedger = @{ pid=$taskProcess.Id; startedAt=[DateTime]::UtcNow.ToString('o'); sessionId=$taskSession; priorSessionId=$taskPrevious.sessionId; model='claude-opus-5.5'; effort='medium'; resumedExistingContext=!$FreshFromCheckpoint; checkpointRetained=$true; stdout=$taskStdout; stderr=$taskStderr; task='H1E adversarial review with durable report'; report=$taskReport; status='running-pending-visible-report' }
$taskLedger | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskLedgerPath
$taskLedger | ConvertTo-Json -Depth 8
