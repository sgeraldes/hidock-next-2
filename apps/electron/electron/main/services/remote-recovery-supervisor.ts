export type RemoteRecoveryConfig = { modelHostUrl?: string; modelHostToken?: string }
export type RemoteRecoveryComplete = (recordingId: string, model: string, stage: string) => void
export type RemoteRecoveryScan = (config: RemoteRecoveryConfig, onComplete: RemoteRecoveryComplete) => Promise<void>

export const REMOTE_RECOVERY_SCAN_INTERVAL_MS = 30_000

export interface RemoteRecoverySupervisor {
  start(): void
  stop(): void
}

/**
 * Re-scans retained remote job identities while the transcription processor runs.
 * A scan only attaches observers to identities already stored; the observer map and
 * owner checks inside `recover` keep it from duplicating a live observer, and it
 * never creates or uploads a job.
 */
export function createRemoteRecoverySupervisor(options: {
  getConfig: () => RemoteRecoveryConfig
  recover: RemoteRecoveryScan
  onComplete: RemoteRecoveryComplete
  intervalMs?: number
}): RemoteRecoverySupervisor {
  const baseMs = options.intervalMs ?? REMOTE_RECOVERY_SCAN_INTERVAL_MS
  const maxMs = baseMs * 10
  let delayMs = baseMs
  // Bumped by every start and stop, so a scan, timer or callback from an earlier
  // lifecycle can neither schedule work nor resume a pipeline.
  let generation = 0
  let running = false
  let scanning = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function schedule(owner: number): void {
    if (!running || owner !== generation) return
    timer = setTimeout(() => { timer = null; void scan(owner) }, delayMs)
    timer.unref?.()
  }

  async function scan(owner: number): Promise<void> {
    if (!running || owner !== generation) return
    // A scan from a stopped lifecycle may still be settling; wait instead of overlapping it.
    if (scanning) { schedule(owner); return }
    scanning = true
    try {
      await options.recover(options.getConfig(), (recordingId, model, stage) => {
        if (running && owner === generation) options.onComplete(recordingId, model, stage)
      })
      delayMs = baseMs
    } catch (error) {
      delayMs = Math.min(delayMs * 2, maxMs)
      console.warn('[Remote recovery]', error instanceof Error ? error.message : 'Observation failed')
    } finally {
      scanning = false
      schedule(owner)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      generation++
      delayMs = baseMs
      void scan(generation)
    },
    stop() {
      running = false
      generation++
      if (timer) { clearTimeout(timer); timer = null }
    }
  }
}
