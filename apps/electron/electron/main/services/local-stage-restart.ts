type Run = { id: string; stage: string; execution: string | null; status: string; provider?: string | null }

export function mayRestartLocalStage(runs: Run[], owned: Set<string>): boolean {
  const stages = runs.filter(run => owned.has(run.id) && run.status === 'running' && run.stage !== 'pipeline' &&
    !(run.stage === 'diarization' && run.execution === 'provider-managed' &&
      ['local-asr', 'vibevoice'].includes(run.provider ?? '')))
  return stages.length > 0 && stages.every(run => run.execution === 'local' &&
    ['vad', 'transcription', 'diarization'].includes(run.stage))
}

const restarting = new Map<string, { cancelled: boolean }>()

/** A later explicit Cancel always wins over an earlier restart request. */
export function cancelLocalStageRestart(recordingId?: string): void {
  for (const [id, request] of restarting) {
    if (!recordingId || id === recordingId) request.cancelled = true
  }
}

/** The new CPU policy is read at admission. Never overlap old and replacement work. */
export async function restartLocalStageAfterExit(recordingId: string, deps: {
  eligible: () => boolean; cancel: () => void; isOwned: () => boolean;
  enqueue: () => void; wait?: () => Promise<void>; now?: () => number
}): Promise<void> {
  if (restarting.has(recordingId)) throw new Error('A restart is already pending for this recording')
  if (!deps.eligible()) throw new Error('Only a cancellable local audio stage can be restarted with a new CPU limit')
  const request = { cancelled: false }
  restarting.set(recordingId, request)
  const now = deps.now ?? Date.now
  const deadline = now() + 30000
  try {
    deps.cancel()
    while (deps.isOwned()) {
      if (now() >= deadline) throw new Error('Previous worker has not exited; replacement was not queued')
      await (deps.wait?.() ?? new Promise(resolve => setTimeout(resolve, 100)))
    }
    if (request.cancelled) throw new Error('Restart cancelled; replacement was not queued')
    deps.enqueue()
  } finally { restarting.delete(recordingId) }
}
