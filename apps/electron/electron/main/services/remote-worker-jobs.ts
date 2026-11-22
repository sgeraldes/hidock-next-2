import { modelHostFetch } from './model-host-transport'
import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'

export interface RemoteJobIdentity {
  key: string; id?: string; restartTerminal?: boolean;
  request?: { base: string; audioHash: string; bytes?: number; model: string; stage: 'diarization' | 'vad' | 'transcription'; language?: string; recordingId?: string; channelMode?: 'separate'; channelMap?: RemoteAudioChannelMap; activeChannels?: Array<0 | 1>; sourceContext?: RemoteJobSourceContext };
  observedStatus?: string
}
export interface RemoteJobSourceContext {
  localRecordingId?: string
  remoteRecordingId?: string
  sourceAudioHash: string
  sourceTrackId: string
  sourceChannelIndex: 0 | 1
  transformVersion: string
  activeChannels: Array<0 | 1>
}
export interface RemoteJobStore {
  load(key: string): RemoteJobIdentity | undefined
  save(key: string, identity: RemoteJobIdentity): void
  loadResult?(key: string): unknown
  saveResult?(key: string, result: unknown): void
}
type Job = { id: string; status: string; audioHash: string; result?: unknown; resultHash?: string; error?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export type RemoteAudioChannelMap = Array<{ sourceChannel: 0 | 1; role: 'unknown' | 'microphone' | 'system'; evidence: 'unverified' | 'firmware-manifest' | 'user-confirmed' }>

/** Shared key for normal jobs and verified imports of an already-created job. */
export function remoteWorkerRequestKey(input: {
  base: string; audioHash: string; model: string; stage: 'diarization' | 'vad' | 'transcription';
  language?: string; channelMode?: 'separate'; channelMap?: RemoteAudioChannelMap; activeChannels?: Array<0 | 1>
}): string {
  const base = input.base.replace(/\/+$/, '')
  const channelMap = input.channelMap?.map(row => ({ ...row })).sort((a, b) => a.sourceChannel - b.sourceChannel)
  const activeChannels = input.activeChannels?.slice().sort()
  return digest(JSON.stringify([base, input.audioHash, input.model, input.stage,
    ...(input.stage === 'transcription' ? [input.language || 'es'] : []),
    ...(input.channelMode ? ['channels-v1', input.channelMode, channelMap ?? [], activeChannels ?? null] : [])]))
}

/** No local fallback or duplicate execution after an uncertain network outcome. */
export async function runRemoteWorkerJob(input: {
  path: string; base: string; token: string; model: string; timeoutMs: number;
  stage?: 'diarization' | 'vad' | 'transcription'; language?: string; recordingId?: string;
  channelMode?: 'separate'; channelMap?: RemoteAudioChannelMap; activeChannels?: Array<0 | 1>;
  shouldContinue?: () => boolean; store: RemoteJobStore; fetchFn?: typeof fetch
}): Promise<unknown> {
  if (input.recordingId !== undefined && (typeof input.recordingId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.recordingId))) {
    throw new Error('Invalid recording identity')
  }
  const url = new URL(input.base)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Remote worker requires HTTPS outside loopback. Configure a trusted host certificate before sending audio.')
  }
  const base = input.base.replace(/\/+$/, '')
  const stage = input.stage ?? 'diarization'
  const language = stage === 'transcription' ? input.language || 'es' : input.language
  if (input.channelMode && (input.channelMode !== 'separate' || stage !== 'transcription')) throw new Error('Invalid remote channel mode')
  const channelMap = input.channelMap?.map(row => ({ ...row })).sort((a, b) => a.sourceChannel - b.sourceChannel)
  const activeChannels = input.activeChannels?.slice().sort()
  if (activeChannels && (!input.channelMode || !activeChannels.length || activeChannels.length > 2 ||
    new Set(activeChannels).size !== activeChannels.length || activeChannels.some(index => ![0, 1].includes(index)))) throw new Error('Invalid active source channels')
  if (channelMap && (!input.channelMode || channelMap.length > 2 || new Set(channelMap.map(row => row.sourceChannel)).size !== channelMap.length ||
      channelMap.some(row => ![0, 1].includes(row.sourceChannel) || !['unknown', 'microphone', 'system'].includes(row.role) ||
        !['unverified', 'firmware-manifest', 'user-confirmed'].includes(row.evidence) || (row.role !== 'unknown' && row.evidence === 'unverified')))) {
    throw new Error('Invalid remote channel map')
  }
  const fetchFn = input.fetchFn || fetch
  const headers = { authorization: `Bearer ${input.token}` }
  const cancelled = () => input.shouldContinue?.() === false
  const deadline = Date.now() + input.timeoutMs
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(input.path)) {
    if (cancelled()) throw new Error('Local processing cancelled')
    hash.update(chunk)
  }
  const audioHash = hash.digest('hex')
  const bytes = (await stat(input.path)).size
  const lookup = remoteWorkerRequestKey({ base, audioHash, model: input.model, stage, language: input.language,
    ...(input.channelMode ? { channelMode: input.channelMode, channelMap, activeChannels } : {}) })
  let identity = input.store.load(lookup)
  if (identity?.request?.recordingId && identity.request.recordingId !== input.recordingId) {
    throw new Error('Remote worker recording identity mismatch; retained original job')
  }
  if (identity?.request && (identity.request.base !== base || identity.request.audioHash !== audioHash ||
      identity.request.model !== input.model || identity.request.stage !== stage ||
      (stage === 'transcription' && (identity.request.language || 'es') !== language) ||
      (identity.request.bytes !== undefined && identity.request.bytes !== bytes))) {
    throw new Error('Remote worker request identity mismatch; retained original job')
  }
  const savedResult = input.store.loadResult?.(lookup)
  if (savedResult) { validateRemoteResult(savedResult as Record<string, unknown>, stage, input.model); validateChannelResult(savedResult as Record<string, unknown>, input.channelMode, audioHash, channelMap, activeChannels); return savedResult }
  const isNewIdentity = !identity
  if (!identity) {
    identity = { key: randomUUID() }
    input.store.save(lookup, identity) // Durable intent precedes every network mutation.
  }
  // Legacy intent may already exist on the host with no recording ID (lost POST response).
  // Preserve its exact attribution until an explicit terminal restart creates a new intent.
  const recordingId = isNewIdentity ? input.recordingId : identity.request?.recordingId
  identity.request = { base, audioHash, bytes, model: input.model, stage, language, ...(recordingId ? { recordingId } : {}),
    ...(identity.request?.sourceContext ? { sourceContext: identity.request.sourceContext } : {}),
    ...(input.channelMode ? { channelMode: input.channelMode, channelMap: channelMap ?? [], ...(activeChannels ? { activeChannels } : {}) } : {}) }
  input.store.save(lookup, identity)
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await modelHostFetch(base + path, { ...init, redirect: 'error', headers: { ...headers, ...init.headers },
      signal: init.signal || AbortSignal.timeout(10000) }, fetchFn)
    if (!response.ok) throw new Error(`Remote worker HTTP ${response.status}; retained job identity for resume`)
    return response.json()
  }
  const capability = await request('/v1/capabilities')
  if (capability.protocolVersion !== 1 || !capability.stages?.includes(stage) ||
      !capability.models?.includes(input.model)) throw new Error('Remote worker does not support the selected stage/model')
  if (input.channelMode && (capability.audioChannels?.version !== 1 || capability.audioChannels?.separate !== true || capability.audioChannels?.maxChannels !== 2)) {
    throw new Error('Remote host does not support preserved audio channels; no upload or mono fallback was started')
  }
  if (activeChannels && capability.audioChannels?.activeChannelSelection !== true) throw new Error('Remote host cannot preserve quiet-channel selection; no upload was started')
  let initialJob: Job | undefined
  if (identity.id) {
    initialJob = await request(`/v1/jobs/${identity.id}`) as Job
    if (identity.restartTerminal) {
      // Only an explicit Resume/Restart may replace a confirmed terminal job.
      // A missing host, lost GET or running job never authorizes another upload.
      if (['failed', 'cancelled', 'interrupted'].includes(initialJob.status)) identity = { key: randomUUID(), request: { ...identity.request!, ...(input.recordingId ? { recordingId: input.recordingId } : {}) } }
      else identity = { ...identity, restartTerminal: false }
      input.store.save(lookup, identity)
    }
  }
  if (!identity.id) {
    initialJob = await request('/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: identity.key, ...(identity.request?.recordingId ? { recordingId: identity.request.recordingId } : {}), audioHash, bytes, model: input.model,
        stage, ...(stage === 'transcription' ? { language: input.language || 'es' } : {}),
        ...(input.channelMode ? { channelMode: input.channelMode, channelMap: channelMap ?? [], ...(activeChannels ? { activeChannels } : {}) } : {}), extension: extname(input.path) || '.wav' }) }) as Job
    if (!/^[a-f0-9-]{36}$/.test(initialJob.id)) throw new Error('Remote worker returned an invalid job identity')
    identity.id = initialJob.id
    input.store.save(lookup, identity)
  }
  if (!initialJob) throw new Error('Remote worker did not return a job')
  let job: Job = initialJob
  const cancel = async () => {
    await request(`/v1/jobs/${identity.id}/cancel`, { method: 'POST' })
    const cancelDeadline = Date.now() + 10000
    while (Date.now() < cancelDeadline) {
      const observed = await request(`/v1/jobs/${identity.id}`) as Job
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(observed.status)) {
        throw new Error(`Remote worker stopped (${observed.status}); automatic retry disabled`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Remote cancellation not confirmed; retained job identity for reconciliation; automatic retry disabled')
  }
  if (cancelled()) return cancel()
  if (job.status === 'awaiting-upload') {
    const controller = new AbortController()
    const watch = setInterval(() => { if (cancelled() || Date.now() >= deadline) controller.abort() }, 250)
    const body = createReadStream(input.path)
    try {
      // Node streams the file; no full recording Buffer is retained in Electron.
      job = await request(`/v1/jobs/${identity.id}/audio`, { method: 'PUT',
        body: body as unknown as BodyInit, duplex: 'half', signal: controller.signal,
        headers: { 'content-type': 'application/octet-stream' } } as RequestInit)
    } catch (error) {
      if (cancelled()) return cancel()
      // The PUT may have committed even if its response was lost. Observe, never re-upload blindly.
      if (Date.now() >= deadline) throw new Error('Remote worker timeout; retained job identity for resume', { cause: error })
      job = await request(`/v1/jobs/${identity.id}`)
    } finally { clearInterval(watch); body.destroy() }
  }
  for (;;) {
    if (cancelled()) return cancel()
    if (job.audioHash !== audioHash) throw new Error('Remote worker audio hash mismatch')
    if (job.status === 'completed') {
      if (!job.result || digest(JSON.stringify(job.result)) !== job.resultHash) throw new Error('Remote worker result hash mismatch')
      const result = job.result as Record<string, unknown>
      validateRemoteResult(result, stage, input.model)
      validateChannelResult(result, input.channelMode, audioHash, channelMap, activeChannels)
      const verified = { ...result, hostJobId: job.id }
      input.store.saveResult?.(lookup, verified)
      identity.observedStatus = 'completed'
      input.store.save(lookup, identity)
      return verified
    }
    if (['failed', 'cancelled', 'interrupted', 'cleanup-failed', 'awaiting-upload'].includes(job.status)) {
      const detail = typeof job.error === 'string' ? job.error.trim().slice(-2000) : ''
      throw new Error(`Remote worker ${job.status}${detail ? `: ${detail}` : ''}; automatic retry disabled`)
    }
    if (Date.now() >= deadline) throw new Error('Remote worker timeout; retained job identity for resume')
    await new Promise(resolve => setTimeout(resolve, 1000))
    try { job = await request(`/v1/jobs/${identity.id}`) }
    catch { /* Reconnect only to this durable job; the deadline still bounds waiting. */ }
  }
}

/** A host cannot satisfy a separate-channel request by silently returning a mixed transcript. */
export function validateChannelResult(result: Record<string, unknown>, mode?: 'separate', audioHash?: string,
  mapping: RemoteAudioChannelMap = [], activeChannels?: Array<0 | 1>): void {
  if (!mode) return
  const channels = Number(result.sourceChannels)
  const summaries = Array.isArray(result.channelResults) ? result.channelResults : []
  const segments = Array.isArray(result.segments) ? result.segments : []
  const seconds = Number(result.audioSeconds)
  const frames = Number(result.decodedFrames)
  if (result.channelMode !== 'separate' || ![1, 2].includes(channels) || summaries.length !== channels ||
      !Number.isFinite(seconds) || seconds <= 0 || !/^[a-f0-9]{64}$/.test(String(result.sourceAudioSha256)) ||
      (audioHash && result.sourceAudioSha256 !== audioHash) || result.decodedSampleRate !== 16000 ||
      !Number.isInteger(frames) || frames < 1 || Math.abs(frames / 16000 - seconds) > 0.00001 ||
      (activeChannels && JSON.stringify(result.activeChannels) !== JSON.stringify(activeChannels))) throw new Error('Remote worker did not preserve the requested audio channels')
  for (let channel = 0; channel < channels; channel++) {
    const summary = summaries.find(row => row?.sourceChannel === channel)
    const rows = segments.filter(row => row?.sourceChannel === channel)
    const expected = mapping.find(row => row.sourceChannel === channel) ?? { role: 'unknown', evidence: 'unverified' }
    if (activeChannels && !activeChannels.includes(channel as 0 | 1) && (rows.length || summary?.status !== 'no-activity-skip')) throw new Error('Remote worker processed an excluded quiet source channel')
    if (!summary || summary.segmentCount !== rows.length || rows.some(row => row.channelRole !== expected.role ||
        row.channelProvenance !== expected.evidence || !Number.isFinite(row.start) || !Number.isFinite(row.end) ||
        row.start < 0 || row.end <= row.start || row.end > seconds + 0.05)) {
      throw new Error('Remote worker returned inconsistent audio channel provenance')
    }
  }
  if (new Set(summaries.map(row => row?.sourceChannel)).size !== channels ||
      segments.some(row => !Number.isInteger(row?.sourceChannel) || row.sourceChannel < 0 || row.sourceChannel >= channels)) {
    throw new Error('Remote worker returned invalid audio channel indexes')
  }
}

export function validateRemoteResult(result: Record<string, unknown>, stage: string, model: string): void {
  if (stage === 'transcription' && result.diarizationStatus === 'degraded') {
    const segments = Array.isArray(result.segments) ? result.segments : []
    const missing = segments.filter(s => s?.diarizationStatus === 'unavailable')
    if (!Number.isInteger(result.diarizationUnavailableSegments) || missing.length < 1
      || result.diarizationUnavailableSegments !== missing.length || result.speakerEmbeddingsAvailable !== false
      || missing.some(s => s.speaker !== 'Speaker unresolved' || s.speakerAttribution !== 'unresolved'
        || s.speakerConfidence !== 0 || s.modelSpeakerLabel !== undefined || s.speakerScope !== undefined)) {
      throw new Error('Remote worker returned inconsistent unavailable diarization metadata; automatic retry disabled')
    }
  }
  const validStage = stage === 'diarization'
    ? Array.isArray(result.speakers) && Array.isArray(result.segments)
    : stage === 'transcription' ? typeof result.text === 'string' && Array.isArray(result.segments) &&
      result.segments.every(s => s && typeof s.text === 'string' && typeof s.speaker === 'string' &&
    Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)
    : ['speech_present', 'no_speech'].includes(String(result.status)) &&
      Number.isFinite(result.durationSeconds) && Number(result.durationSeconds) > 0 &&
      Array.isArray(result.activityIntervals)
  if (result.model !== model || typeof result.modelVersion !== 'string' || !validStage) {
    throw new Error(`Remote worker returned an incomplete ${stage} result; automatic retry disabled`)
  }
}
