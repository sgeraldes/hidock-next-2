export interface HostResourceSnapshot {
  sampledAt: string
  hostname: string
  logicalCores: number
  cpuPercent: number | null
  memoryUsedMiB: number
  memoryTotalMiB: number
  serviceRssMiB: number
  gpu: { name: string; utilizationPercent: number | null; usedMiB: number | null; totalMiB: number | null } | null
  gpuSampledAt: string | null
  activeJobs: Array<{ id: string; stage: string; model: string; recordingId: string | null; elapsedMs: number; status?: string }>
  recentJobs: Array<{ id: string; stage: string; model: string; status: string; elapsedMs: number; device: string | null }>
  completedJobs: number
  totalJobMs: number
  tokens: number | null
  /** Legacy instantaneous rate is unavailable; never interpret the average as instantaneous. */
  outputTokensPerSecond: number | null
  outputTokensPerSecondAverage?: number | null
  tokenMeasuredJobs?: number
  tokenMeasuredJobMs?: number
  completedJobsWithoutTokenUsage?: number
  tokenRateBasis?: 'completed-measured-job-wall-average' 
}

export interface PipelineSpan {
  id: string
  stage: string
  tool: string | null
  model: string | null
  status: string
  startedAt: string
  completedAt: string | null
  durationMs: number
  location: string
  device: string | null
  tokens: number | null
  outputTokens: number | null
  hostJobId: string | null
  error?: string | null
  resourcePolicy?: { cpuPercent: number | null; threads: number | null; priority: string | null }
}

export interface PipelineTelemetry {
  revision?: number
  sampledAt: string
  client: {
    cpuPercent: number | null
    cpuPartial: boolean
    ramMiB: number | null
    freeRamMiB: number
    totalRamMiB: number
    processCount: number
    systemCpuPercent: number | null
    eventLoopDelayMs: number
    peakEventLoopDelayMs: number
    localComputePauseReason?: string | null
    localIndexingPauseReason: string | null
    localIndexingState: 'not-loaded' | 'working' | 'idle' | 'paused' | null
  }
  queue: { paused: boolean; pendingCount: number; processingCount: number }
  jobs: Array<{ recordingId: string; filename: string; active: boolean; spans: PipelineSpan[]; latestCheckpoint?: string | null; uncertainProviderRequest?: boolean; canCancel?: boolean; canResume?: boolean; canRestartLocalStage?: boolean }>
  host: {
    address: string
    reachable: boolean
    state?: string | null
    usedForSpeakers: boolean
    telemetry: HostResourceSnapshot | null
  }
}
