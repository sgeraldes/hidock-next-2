import { app } from 'electron'
import { cpus, freemem, totalmem } from 'os'
import { performance } from 'perf_hooks'
import { getQueueState, canRestartLocalStage } from './transcription'
import { getActiveTranscriptions } from './transcription-activity'
import { getConfig } from './config'
import { queryAll, getOwnedProcessingRuns, getProcessingRevision, type ProcessingRun } from './database'
import { resolveSpeakerEngine } from './speaker-engines'
import { checkModelHost } from './model-host-client'
import { OwnedResourceSampler } from './backend-resources'
import { localComputePauseReason } from './local-compute-slot'
import { STAGE_CHECKPOINT_SCHEMA } from './stage-checkpoints'
import { PROVIDER_CHECKPOINT_SCHEMA } from './provider-checkpoints'
import { run as executeSql } from './database'
import { getLocalEmbedder } from './local-embedder'
import type { PipelineSpan, PipelineTelemetry } from '../../../src/shared/pipeline-telemetry'

const sampler = new OwnedResourceSampler()
let timer: NodeJS.Timeout | null = null
let lastTick = performance.now()
let delayMs = 0
let peakDelayMs = 0
let inFlight: Promise<PipelineTelemetry> | null = null
let previousSystemCpu: { total: number; idle: number } | null = null

export function startPipelineMonitor(): void {
  if (timer) return
  lastTick = performance.now()
  timer = setInterval(() => {
    const now = performance.now()
    delayMs = Math.max(0, now - lastTick - 1000)
    peakDelayMs = Math.max(peakDelayMs, delayMs)
    lastTick = now
  }, 1000)
  timer.unref()
  app.once('before-quit', () => { if (timer) clearInterval(timer); timer = null })
}

function object(text: string | null): Record<string, any> {
  try { const value = JSON.parse(text || '{}'); return value && typeof value === 'object' ? value : {} }
  catch { return {} }
}

export function spanFromRun(run: ProcessingRun, active: boolean, now: number): PipelineSpan {
  const quality = object(run.quality_json)
  const usage = object(run.usage_json)
  const tokens = usage.tokens || {}
  const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const end = run.completed_at ? Date.parse(run.completed_at) : active ? now : NaN
  const location = quality.executionLocation === 'remote'
    ? String(quality.host || 'Remote host')
    : quality.executionLocation === 'local' ? 'This computer'
      : run.stage === 'diarization' && run.tool !== 'not-available' ? 'Location not recorded'
        : run.execution === 'local' ? 'This computer'
          : run.execution === 'cloud' ? `${run.provider} cloud` : run.execution || 'Not reported'
  return {
    id: run.id, stage: run.stage, tool: run.tool, model: run.model,
    status: run.status === 'running' && !active ? 'interrupted / not active' : run.status,
    startedAt: run.started_at, completedAt: run.completed_at,
    durationMs: Number.isFinite(end) ? Math.max(0, end - Date.parse(run.started_at)) : 0,
    location, device: typeof quality.device === 'string' ? quality.device : null,
    tokens: finite(tokens.totalTokens), outputTokens: finite(tokens.outputTokens),
    error: run.error_message || null,    resourcePolicy: quality.resourcePolicy && typeof quality.resourcePolicy === 'object' ? {      cpuPercent: finite(quality.resourcePolicy.cpuPercent), threads: finite(quality.resourcePolicy.runtimeThreads),      priority: typeof quality.resourcePolicy.priority === 'string' ? quality.resourcePolicy.priority : null    } : undefined,
    hostJobId: typeof quality.hostJobId === 'string' ? quality.hostJobId : null
  }
}

/** Bound queries to the two actual processor lanes plus three recent recordings. No stale running-row count. */
async function collect(): Promise<PipelineTelemetry> {
  const now = Date.now()
  const config = getConfig().transcription
  const queue = getQueueState()
  const ownedRuns = getOwnedProcessingRuns()
  const revision = getProcessingRevision()
  const activeIds = new Set(ownedRuns.values())
  const cancellableIds = new Set(getActiveTranscriptions())
  // Rowid walks the last inserted spans without a full-table GROUP BY or unindexed time sort.
  const recent = queryAll<{ recording_id: string }>(
    'SELECT recording_id FROM processing_runs ORDER BY rowid DESC LIMIT 80'
  )
  const recentIds = [...new Set(recent.map(row => row.recording_id))].slice(0, 3)
  const ids = [...new Set([...activeIds, ...recentIds])]
  executeSql(STAGE_CHECKPOINT_SCHEMA)
  executeSql(PROVIDER_CHECKPOINT_SCHEMA)
  const jobs = ids.map(id => {
    const row = queryAll<{ filename: string }>(
      'SELECT filename FROM recordings WHERE id = ? AND deleted_at IS NULL', [id]
    )[0]
    if (!row) return null
    // Keep both failed acoustic and provider-managed attempts; omit the large VAD interval manifest.
    const runs = queryAll<ProcessingRun>(
      `SELECT id,stage,tool,model,provider,execution,status,started_at,completed_at,usage_json,error_message,
        CASE WHEN stage='diarization' THEN quality_json ELSE NULL END AS quality_json
       FROM processing_runs WHERE recording_id=? ORDER BY started_at DESC LIMIT 80`, [id]
    ).reverse()
    const latestCheckpoint = queryAll<{ stage: string; completed_at: string }>(
      'SELECT stage, completed_at FROM stage_checkpoints WHERE recording_id=? ORDER BY completed_at DESC LIMIT 1', [id])[0]
    const uncertainProviderRequest = !activeIds.has(id) && queryAll<{ request_key: string }>(
      "SELECT request_key FROM provider_checkpoints WHERE recording_id=? AND state='pending' LIMIT 1", [id]).length > 0
    return { latestCheckpoint: latestCheckpoint ? `${latestCheckpoint.stage} · ${latestCheckpoint.completed_at}` : null,
      uncertainProviderRequest, canCancel: cancellableIds.has(id),      canRestartLocalStage: activeIds.has(id) && canRestartLocalStage(id),
      canResume: !activeIds.has(id) && ['failed', 'cancelled'].includes(runs.filter(run => run.stage === 'pipeline').at(-1)?.status || ''),
      recordingId: id, filename: row?.filename ?? id, active: activeIds.has(id),
      spans: runs.map(run => spanFromRun(run, ownedRuns.has(run.id), now)) }
  }).filter((job): job is NonNullable<typeof job> => job !== null)
  const counters = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
  const systemCpuPercent = previousSystemCpu && counters.total > previousSystemCpu.total
    ? Math.max(0, Math.min(100, 100 * (1 - (counters.idle - previousSystemCpu.idle)
      / (counters.total - previousSystemCpu.total)))) : null
  previousSystemCpu = counters
  const ownCpu = process.cpuUsage()
  const resources = sampler.sample(app.getAppMetrics().map(metric => ({
    pid: metric.pid, creationTime: metric.creationTime,
    cpuSeconds: metric.pid === process.pid ? (ownCpu.user + ownCpu.system) / 1e6 : metric.cpu.cumulativeCPUUsage,
    rssKb: metric.memory.workingSetSize
  })), now, cpus().length, totalmem())
  const address = config.modelHostUrl?.trim() || ''
  const health = address ? await checkModelHost({ url: address, token: config.modelHostToken || '' }) : null
  return {
    revision,
    sampledAt: new Date(now).toISOString(),
    client: { cpuPercent: resources.cpuPercent, cpuPartial: resources.cpuPartial, ramMiB: resources.ramMb,
      systemCpuPercent,
      processCount: resources.processCount, freeRamMiB: freemem() / 1024 ** 2, totalRamMiB: totalmem() / 1024 ** 2,
      eventLoopDelayMs: delayMs, peakEventLoopDelayMs: peakDelayMs,
      localComputePauseReason: localComputePauseReason(),
      localIndexingPauseReason: getLocalEmbedder().getPauseReason?.() ?? null,
      localIndexingState: getLocalEmbedder().getState?.() ?? null },
    queue: { paused: queue.paused, pendingCount: queue.pendingCount, processingCount: activeIds.size },
    jobs, host: { address, reachable: !!health, state: health?.state ?? null,      usedForSpeakers: resolveSpeakerEngine(config) === 'model-host',
      telemetry: health?.telemetry ?? null }
  }
}

export function getPipelineTelemetry(): Promise<PipelineTelemetry> {
  if (!inFlight) inFlight = collect().finally(() => { inFlight = null })
  return inFlight
}
