export interface ResourceLimits {
  cpuPercent: number
  ramMb: number
  ramPercent: number
  sustainedMs: number
  cooldownMs: number
}
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { cpuPercent: 70, ramMb: 2048, ramPercent: 25, sustainedMs: 15000, cooldownMs: 300000 }
export interface OwnedMetric { pid: number; creationTime: number; cpuSeconds?: number; rssKb: number }
export interface ResourceReading { cpuPercent: number | null; ramMb: number | null; ramPercent: number | null; cpuPartial: boolean; processCount: number }

/** Counter deltas avoid Electron API interval resets by other dependencies.
 * CPU counts only processes with a baseline from the previous sample (same pid and
 * creation time); none comparable means null, and a comparable zero delta is a real 0.
 * CPU is a share of all logical CPUs; RAM is the sum of measured working sets,
 * which can count shared pages more than once. Never system-wide utilisation.
 */
export class OwnedResourceSampler {
  private previous = new Map<string, number>()
  private sampledAt: number | null = null
  sample(metrics: OwnedMetric[], now: number, cores: number, physicalBytes: number): ResourceReading {
    const elapsed = this.sampledAt === null ? 0 : (now - this.sampledAt) / 1000
    const next = new Map<string, number>()
    let cpuSeconds = 0
    let comparableCounters = 0
    let partial = metrics.length === 0
    let ramKb = 0
    let ramComplete = metrics.length > 0
    for (const metric of metrics) {
      if (Number.isFinite(metric.rssKb) && metric.rssKb >= 0) ramKb += metric.rssKb
      else ramComplete = false
      const key = `${metric.pid}:${metric.creationTime}`
      if (metric.cpuSeconds === undefined || !Number.isFinite(metric.cpuSeconds) || metric.cpuSeconds < 0) {
        partial = true
        continue
      }
      next.set(key, metric.cpuSeconds)
      const before = this.previous.get(key)
      if (before === undefined) { partial = true; continue }
      comparableCounters++
      cpuSeconds += Math.max(0, metric.cpuSeconds - before)
    }
    this.previous = next
    this.sampledAt = now
    const canReportCpu = Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(cores) && cores > 0 && comparableCounters > 0
    return {
      cpuPercent: canReportCpu ? Math.min(100, cpuSeconds / elapsed / Math.max(1, cores) * 100) : null,
      ramMb: ramComplete ? ramKb / 1024 : null,
      ramPercent: ramComplete && Number.isFinite(physicalBytes) && physicalBytes > 0 ? ramKb * 1024 / physicalBytes * 100 : null,
      cpuPartial: partial || !canReportCpu,
      processCount: metrics.length,
    }
  }
}

export class SustainedResourceAlert {
  private overSince: number | null = null
  private lastAlert = -Infinity
  high = false
  evaluate(reading: ResourceReading, limits: ResourceLimits, now: number): { high: boolean; notify: boolean } {
    const over = (reading.cpuPercent !== null && reading.cpuPercent >= limits.cpuPercent)
      || (reading.ramMb !== null && reading.ramMb >= limits.ramMb)
      || (reading.ramPercent !== null && reading.ramPercent >= limits.ramPercent)
    const complete = reading.cpuPercent !== null && !reading.cpuPartial && reading.ramMb !== null && reading.ramPercent !== null
    const recovered = complete
      && reading.cpuPercent! < Math.max(0, limits.cpuPercent - 5)
      && reading.ramMb! < Math.max(0, limits.ramMb - 128)
      && reading.ramPercent! < Math.max(0, limits.ramPercent - 5)
    if (over) {
      this.overSince ??= now
      if (now - this.overSince >= limits.sustainedMs) this.high = true
    } else if (this.high ? recovered : true) {
      this.overSince = null
      this.high = false
    }
    const notify = this.high && now - this.lastAlert >= limits.cooldownMs
    if (notify) this.lastAlert = now
    return { high: this.high, notify }
  }
}

export type BackendTrayState = 'free' | 'working' | 'paused' | 'high-usage' | 'waiting'
export function backendTrayState(paused: boolean, active: number, high: boolean, waiting: boolean): BackendTrayState {
  return waiting ? 'waiting' : high ? 'high-usage' : paused ? 'paused' : active > 0 ? 'working' : 'free'
}
