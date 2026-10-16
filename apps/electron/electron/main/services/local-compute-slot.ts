/** A shared admission lane: ASR, diarization and embeddings cannot each consume
 * their independent CPU budget at the same time. Waiting does not spend a
 * worker's execution timeout. The slot is released only when the task settles.
 */
import { cpus, freemem, totalmem } from 'os'
import { getConfig } from './config'

let tail: Promise<unknown> = Promise.resolve()
let pauseReason: string | null = null
let previousCpu: { idle: number; total: number } | null = null
let cpuPercent: number | null = null
let sampler: NodeJS.Timeout | null = null
let stopped = false

export function stopLocalComputeAdmission(): void {
  stopped = true
  pauseReason = null
  if (sampler) clearInterval(sampler)
  sampler = null
}

export function localComputePauseReason(): string | null { return pauseReason }

/** Keep foreground headroom proportional to the machine, capped at 8 GiB. */
export function localMemoryReserveBytes(totalBytes = totalmem()): number {
  return Math.min(8 * 1024 ** 3, Math.max(1024 ** 3, totalBytes * 0.1))
}

export function resourcePauseReason(input: {
  freeBytes: number; totalBytes: number; cpuPercent: number | null; onBattery: boolean;
  pauseOnBattery: boolean; pauseWhenBusy: boolean
}): string | null {
  if (input.freeBytes < localMemoryReserveBytes(input.totalBytes)) return 'Waiting for available memory'
  if (input.pauseOnBattery && input.onBattery) return 'Local processing paused on battery power'
  if (input.pauseWhenBusy && input.cpuPercent !== null && input.cpuPercent >= 80) return 'Waiting for other CPU work to finish'
  return null
}

function sampleCpu(): void {
  const current = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
  if (previousCpu && current.total > previousCpu.total) {
    cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (current.idle - previousCpu.idle) / (current.total - previousCpu.total))))
  }
  previousCpu = current
}

export function inLocalComputeSlot<T>(task: () => Promise<T>, shouldContinue?: () => boolean,
  maxAdmissionWaitMs = Infinity): Promise<T> {
  const queuedAt = Date.now()
  const admitted = async () => {
    if (!sampler) { sampleCpu(); sampler = setInterval(sampleCpu, 1000); sampler.unref() }
    try {
      for (;;) {
        if (stopped || (shouldContinue && !shouldContinue())) throw new Error('Local processing cancelled')
        if (Date.now() - queuedAt >= maxAdmissionWaitMs) throw new Error('Local resource budget wait timed out; automatic retry disabled')
        const policy = getConfig().transcription
        let onBattery = false
        try { const { powerMonitor } = await import('electron'); onBattery = powerMonitor?.isOnBatteryPower?.() ?? false }
        catch { /* Platforms without battery telemetry do not invent battery state. */ }
        pauseReason = resourcePauseReason({ freeBytes: freemem(), totalBytes: totalmem(), cpuPercent, onBattery,
          pauseOnBattery: policy?.pauseLocalOnBattery !== false, pauseWhenBusy: policy?.pauseLocalWhenBusy !== false })
        if (!pauseReason) return await task()
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } finally { pauseReason = null }
  }
  const result = tail.then(admitted, admitted)
  tail = result.catch(() => undefined)
  return result
}
