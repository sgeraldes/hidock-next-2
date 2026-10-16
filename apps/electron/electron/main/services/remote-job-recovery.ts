import { readStageCheckpoint, saveStageCheckpoint } from './stage-checkpoints'
import { remoteDiarizationQuality, remoteTranscriptFields } from './remote-diarization-quality'
import { remoteWorkerRequestKey, type RemoteJobIdentity, validateRemoteResult, validateChannelResult } from './remote-worker-jobs'
import { recordedAudioStageFingerprint } from './recorded-audio-routing'
import { addActiveTranscription, getActiveTranscriptionCount, removeActiveTranscription } from './transcription-activity'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { tmpdir } from 'os'
import { modelHostFetch } from './model-host-transport'
import { listRecoverableRemoteJobs, remoteJobCheckpoints } from './remote-job-checkpoints'
import { createProcessingRun, completeProcessingRun, failProcessingRun, getTranscriptByRecordingId, queryOne } from './database'
import { RecordedAudioState } from './recorded-audio-state'
import { getConfig } from './config'
import { prepareStoredAudioChannels, STORED_AUDIO_TRANSFORM_VERSION } from './stored-audio-channels'
import { analyzeAudioPreflight } from './audio-preflight'
import { resolveRemoteWorkerLanguage } from './remote-worker-language'

type RecoveryObserver = { recordingId: string; cancel: boolean; stop: boolean; registered: boolean }
const observers = new Map<string, RecoveryObserver>()

class RecoveryOwnershipLostError extends Error {
  constructor() {
    super('A local transcription pipeline took ownership; remote recovery stopped')
    this.name = 'RecoveryOwnershipLostError'
  }
}

class RecoveryStoppedError extends Error {
  constructor() {
    super('Remote recovery stopped; durable identity retained')
    this.name = 'RecoveryStoppedError'
  }
}

class RecoveryCancelledError extends Error {
  constructor() {
    super('Remote job cancelled by explicit request')
    this.name = 'RecoveryCancelledError'
  }
}

function registeredRecoveryOwners(recordingId: string): number {
  let count = 0
  for (const observer of observers.values()) {
    if (observer.recordingId === recordingId && observer.registered) count++
  }
  return count
}

function assertRecoveryOwnership(observer: RecoveryObserver, allowCancel = false): void {
  if (getActiveTranscriptionCount(observer.recordingId) > registeredRecoveryOwners(observer.recordingId)) {
    observer.stop = true
    throw new RecoveryOwnershipLostError()
  }
  if (observer.stop) throw new RecoveryStoppedError()
  if (observer.cancel && !allowCancel) throw new RecoveryCancelledError()
}

export interface CompletedRemoteJobReceipt {
  localRecordingId: string
  expectedRemoteRecordingId: string
  base: string
  jobId: string
  idempotencyKey: string
  sourceAudioHash: string
  sourceTrackId: string
  sourceChannelIndex: 1
  transformVersion: typeof STORED_AUDIO_TRANSFORM_VERSION
}

export interface CompletedRemoteJob {
  id: string
  status: string
  recordingId?: string | null
  audioHash: string
  bytes: number
  model: string
  stage: string
  language?: string
  channelMode?: 'mixed' | 'separate'
  channelMap?: unknown[]
  activeChannels?: unknown[]
  result?: Record<string, unknown>
  resultHash?: string
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** GET the exact retained job only. There is deliberately no create/upload branch in receipt recovery. */
export async function getCompletedRemoteJob(base: string, token: string, jobId: string,
  fetchFn: typeof fetch = fetch): Promise<CompletedRemoteJob> {
  const response = await modelHostFetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  }, fetchFn)
  if (!response.ok) throw new Error(`Remote job recovery GET failed (HTTP ${response.status})`)
  return await response.json() as CompletedRemoteJob
}

export function validateCompletedRemoteJob(job: CompletedRemoteJob, expected: {
  jobId: string; remoteRecordingId: string; audioHash: string; bytes: number; model: string; language: string
}): Record<string, unknown> {
  if (job.id !== expected.jobId || job.status !== 'completed' ||
      job.recordingId !== expected.remoteRecordingId || job.audioHash !== expected.audioHash ||
      job.bytes !== expected.bytes || job.model !== expected.model || job.stage !== 'transcription' ||
      job.language !== expected.language || (job.channelMode !== undefined && job.channelMode !== 'mixed') ||
      (job.channelMap !== undefined && (!Array.isArray(job.channelMap) || job.channelMap.length !== 0)) ||
      (job.activeChannels != null && (!Array.isArray(job.activeChannels) || job.activeChannels.length !== 0))) {
    throw new Error('Completed remote job receipt does not match the local source, remote identity, or selected ASR request')
  }
  if (!job.result || digest(JSON.stringify(job.result)) !== job.resultHash) {
    throw new Error('Completed remote job result hash mismatch')
  }
  validateRemoteResult(job.result, 'transcription', expected.model)
  if (!(job.result.text as string).trim()) throw new Error('Completed remote ASR result contains no transcript text')
  if (typeof job.result.language === 'string' && job.result.language !== expected.language) {
    throw new Error('Completed remote result language differs from the selected request')
  }
  return job.result
}

/**
 * Import a completed host result into the existing recorded-audio checkpoint path.
 * It authenticates with the currently paired host token and observes one existing
 * job by GET; this method cannot create a job, upload audio, or start inference.
 */
export async function importCompletedRemoteJobReceipt(receipt: CompletedRemoteJobReceipt,
  fetchFn: typeof fetch = fetch): Promise<{ recordingId: string; hostJobId: string; audioHash: string; bytes: number }> {
  const config = getConfig().transcription
  const configuredBase = config.modelHostUrl?.replace(/\/+$/, '')
  if (!configuredBase || !config.modelHostToken) throw new Error('Pair the configured model host before recovering a completed job')
  const baseUrl = new URL(configuredBase)
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/' ||
      (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)))) {
    throw new Error('Configured model host is not a valid trusted origin')
  }
  const base = baseUrl.origin
  if (receipt.base.replace(/\/+$/, '') !== base) throw new Error('Receipt host differs from the currently configured host')
  const model = config.remoteAsrModel?.trim()
  const language = config.language || 'auto'
  if (config.provider !== 'remote-worker' || !model || language === 'auto' || !/^[a-z]{2,3}$/.test(language) ||
      config.recordedAudioChannelMode === 'mixed') {
    throw new Error('Selected provider, model, language, or channel policy differs from the completed job receipt')
  }
  if (!receipt.localRecordingId || receipt.localRecordingId.length > 200 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.expectedRemoteRecordingId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.jobId) ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(receipt.idempotencyKey) ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceAudioHash) || !/^[a-f0-9]{64}$/.test(receipt.sourceTrackId) ||
      receipt.sourceChannelIndex !== 1 || receipt.transformVersion !== STORED_AUDIO_TRANSFORM_VERSION) {
    throw new Error('Invalid completed remote job receipt')
  }
  const recording = queryOne<{ id: string; file_path: string }>(
    'SELECT id, file_path FROM recordings WHERE id = ? AND deleted_at IS NULL', [receipt.localRecordingId])
  if (!recording?.file_path) throw new Error('Local library recording or its source file was not found')
  const audioState = new RecordedAudioState()
  if (audioState.getMapping(recording.id, receipt.sourceAudioHash)) {
    throw new Error('Recorded channel roles are mapped; neutral receipt import requires unmapped source channels')
  }
  if (getTranscriptByRecordingId(recording.id)) {
    throw new Error('An existing transcript is preserved; completed job receipt was not imported')
  }
  const prepared = await prepareStoredAudioChannels(recording.file_path, tmpdir())
  try {
    if (prepared.transformVersion !== STORED_AUDIO_TRANSFORM_VERSION || prepared.layout.channels !== 2 ||
        prepared.layout.originalSha256 !== receipt.sourceAudioHash || prepared.tracks.length !== 2) {
      throw new Error('Local source does not match the original audio hash and preserved stereo layout in the receipt')
    }
    const sourceTrack = prepared.tracks[1]
    if (!sourceTrack || sourceTrack.channelIndex !== 1 || sourceTrack.id !== receipt.sourceTrackId ||
        sourceTrack.sourceRole !== 'unknown' || sourceTrack.mappingEvidence !== null) {
      throw new Error('Channel-1 source track does not match the neutral derived-track receipt')
    }
    const channelActivity = await Promise.all(prepared.tracks.map(track =>
      analyzeAudioPreflight(track.path, track.durationSeconds, () => true)))
    const activeChannels = prepared.tracks
      .filter(track => channelActivity[track.channelIndex]?.status === 'speech_present')
      .map(track => track.channelIndex)
    if (activeChannels.length !== 1 || activeChannels[0] !== receipt.sourceChannelIndex) {
      throw new Error('Local channel preflight does not confirm channel 1 active and channel 0 silent; receipt was not imported')
    }
    const sourceStats = await stat(sourceTrack.path)
    const inputHash = createHash('sha256')
    for await (const chunk of createReadStream(sourceTrack.path)) inputHash.update(chunk)
    const audioHash = inputHash.digest('hex')
    const bytes = sourceStats.size
    const mapping = [] as Array<{ sourceChannel: 0 | 1; role: 'unknown' | 'microphone' | 'system'; evidence: 'unverified' | 'firmware-manifest' | 'user-confirmed' }>
    const fingerprint = recordedAudioStageFingerprint(prepared.layout.originalSha256, true, mapping)
    const priorCheckpoint = readStageCheckpoint<Record<string, any>>(recording.id, 'transcription', fingerprint)
    const priorReceipt = priorCheckpoint?.remoteQuality?.completionReceipt
    if (priorCheckpoint && (priorReceipt?.kind !== 'completed-remote-job-import-v1' || priorReceipt.hostJobId !== receipt.jobId)) {
      throw new Error('A different transcription checkpoint already exists and will be preserved')
    }

    const result = validateCompletedRemoteJob(await getCompletedRemoteJob(base, config.modelHostToken, receipt.jobId, fetchFn), {
      jobId: receipt.jobId, remoteRecordingId: receipt.expectedRemoteRecordingId, audioHash, bytes,
      model, language
    })
    if (getTranscriptByRecordingId(recording.id)) {
      throw new Error('An existing transcript is preserved; completed job receipt was not imported')
    }
    const currentRecording = queryOne<{ id: string; file_path: string }>(
      'SELECT id, file_path FROM recordings WHERE id = ? AND deleted_at IS NULL', [recording.id])
    if (!currentRecording || currentRecording.file_path !== recording.file_path ||
        audioState.getMapping(recording.id, receipt.sourceAudioHash)) {
      throw new Error('Local source or channel attribution changed during receipt recovery; no result was imported')
    }
    const currentSourceHash = createHash('sha256')
    for await (const chunk of createReadStream(currentRecording.file_path)) currentSourceHash.update(chunk)
    if (currentSourceHash.digest('hex') !== receipt.sourceAudioHash) {
      throw new Error('Local source audio changed during receipt recovery; no result was imported')
    }
    const requestKey = remoteWorkerRequestKey({ base, audioHash, model, stage: 'transcription', language })
    const store = remoteJobCheckpoints(recording.id)
    const priorIdentity = store.load(requestKey)
    if (priorIdentity && (priorIdentity.id !== receipt.jobId || priorIdentity.key !== receipt.idempotencyKey ||
        priorIdentity.request?.recordingId !== receipt.expectedRemoteRecordingId)) {
      throw new Error('A different remote job identity already owns this exact audio request')
    }
    const verifiedResult = { ...result, hostJobId: receipt.jobId }
    const priorResult = store.loadResult?.(requestKey) as Record<string, unknown> | undefined
    if (priorResult && JSON.stringify(priorResult) !== JSON.stringify(verifiedResult)) {
      throw new Error('A different cached remote result already owns this exact audio request')
    }
    const channelSegments = (result.segments as Array<Record<string, unknown>>).map(segment => {
      if ((segment.sourceChannel !== undefined && segment.sourceChannel !== 1) ||
          (segment.channelRole !== undefined && segment.channelRole !== 'unknown')) {
        throw new Error('Mono job result contains conflicting source-channel attribution')
      }
      return { ...segment, sourceChannel: 1, channelRole: 'unknown', channelProvenance: 'unverified' }
    })

    const identity: RemoteJobIdentity = {
      key: receipt.idempotencyKey,
      id: receipt.jobId,
      observedStatus: 'completed',
      request: {
        base, audioHash, bytes, model, stage: 'transcription', language,
        recordingId: receipt.expectedRemoteRecordingId,
        sourceContext: { localRecordingId: recording.id, remoteRecordingId: receipt.expectedRemoteRecordingId,
          sourceAudioHash: prepared.layout.originalSha256, sourceTrackId: sourceTrack.id,
          sourceChannelIndex: 1, transformVersion: prepared.transformVersion, activeChannels: [1] }
      }
    }
    const transcript = {
      ...remoteTranscriptFields({ text: result.text as string, segments: channelSegments }),
      provider: (model.startsWith('microsoft/VibeVoice') ? 'vibevoice' : 'local-asr') as 'local-asr' | 'vibevoice',
      model,
      language: typeof result.language === 'string' ? result.language : language,
      audioChannels: {
        sourceHash: prepared.layout.originalSha256,
        sourceChannels: prepared.layout.channels,
        channelMode: 'separate',
        activeChannels,
        sourceTrackIds: prepared.tracks.map(track => track.id),
        sourceRoles: prepared.tracks.map(track => track.sourceRole),
        channelActivity: channelActivity.map((report, sourceChannel) => ({ sourceChannel,
          status: report.status, nonSilentSeconds: report.nonSilentSeconds, nonSilentRatio: report.nonSilentRatio,
          activityIntervals: report.activityIntervals })),
        completedSourceChannelIndex: 1,
        transformVersion: prepared.transformVersion,
        remoteInput: { audioHash, bytes }
      },
      remoteQuality: {
        executionLocation: 'remote', host: baseUrl.host, hostJobId: receipt.jobId,
        ...remoteDiarizationQuality(result),
        completionReceipt: {
          kind: 'completed-remote-job-import-v1', localRecordingId: recording.id,
          remoteRecordingId: receipt.expectedRemoteRecordingId, hostJobId: receipt.jobId,
          base, audioHash, bytes, sourceAudioHash: prepared.layout.originalSha256,
          sourceTrackId: sourceTrack.id, sourceChannelIndex: 1, transformVersion: prepared.transformVersion,
          model, stage: 'transcription', language
        }
      }
    }
    const savedTranscript = readStageCheckpoint<Record<string, any>>(recording.id, 'transcription', fingerprint)
    if (savedTranscript && JSON.stringify(savedTranscript) !== JSON.stringify(transcript)) {
      throw new Error('Imported checkpoint content differs from the already retained completed result')
    }

    audioState.saveLayout(recording.id, prepared.layout)
    audioState.saveTracks(recording.id, prepared.layout.originalSha256, prepared.transformVersion, prepared.tracks)
    store.save(requestKey, identity)
    store.saveResult?.(requestKey, verifiedResult)
    saveStageCheckpoint(recording.id, 'transcription', fingerprint, transcript)
    return { recordingId: recording.id, hostJobId: receipt.jobId, audioHash, bytes }
  } finally {
    await prepared.cleanup()
  }
}
export function cancelRecoveredRemote(recordingId?: string): void {
  for (const observer of observers.values()) if (!recordingId || observer.recordingId === recordingId) observer.cancel = true
}
export function stopRemoteRecovery(): void { for (const observer of observers.values()) observer.stop = true }
export function recoveredRemoteRecordings(): string[] { return [...new Set([...observers.values()].map(value => value.recordingId))] }

/** Reattach by persisted identity. This path never creates a job or uploads audio. */
export async function recoverRemoteJobs(config: { modelHostUrl?: string; modelHostToken?: string },
  onComplete: (recordingId: string, model: string, stage: string) => void): Promise<void> {
  const base = config.modelHostUrl?.replace(/\/+$/, '')
  if (!base || !config.modelHostToken) return
  const url = new URL(base)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return
  for (const saved of listRecoverableRemoteJobs()) {
    const request = saved.identity.request!
    // Never forward a current credential to an old/different host.
    const observerKey = saved.recordingId + ':' + saved.key
    if (request.base !== base || !saved.identity.id || observers.has(observerKey) ||
        getActiveTranscriptionCount(saved.recordingId) > registeredRecoveryOwners(saved.recordingId)) continue
    const observer: RecoveryObserver = { recordingId: saved.recordingId, cancel: false, stop: false, registered: false }
    observers.set(observerKey, observer)
    void (async () => {
      let runId: string | undefined
      let cancellationConfirmed = false
      let networkFailures = 0
      const store = remoteJobCheckpoints(saved.recordingId)
      const path = base + '/v1/jobs/' + encodeURIComponent(saved.identity.id!)
      const headers = { authorization: `Bearer ${config.modelHostToken}` }
      const deadline = Date.now() + 60 * 60 * 1000
      try {
        while (!observer.stop && Date.now() < deadline) {
          // An explicit cancel is allowed to reach its POST before the next GET.
          assertRecoveryOwnership(observer, true)
          if (observer.cancel) {
            assertRecoveryOwnership(observer, true)
            let response: Response
            try {
              response = await modelHostFetch(path + '/cancel', {
                method: 'POST', headers, signal: AbortSignal.timeout(10000)
              })
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              throw new Error(`Remote cancellation not confirmed; ownership retained: ${reason}`, { cause: error })
            }
            assertRecoveryOwnership(observer, true)
            if (!response.ok) throw new Error('Remote cancellation not confirmed; ownership retained')
          }
          let response: Response
          try {
            response = await modelHostFetch(path, { headers, signal: AbortSignal.timeout(10000) })
            networkFailures = 0
          } catch (error) {
            assertRecoveryOwnership(observer, true)
            if (observer.cancel) {
              await new Promise(resolve => setTimeout(resolve, 1500))
              continue
            }
            if (runId) { failProcessingRun(runId, 'Remote connection lost; reconnecting by retained identity'); runId = undefined }
            if (observer.registered) {
              removeActiveTranscription(saved.recordingId)
              observer.registered = false
            }
            if (++networkFailures >= 3) throw error
            await new Promise(resolve => setTimeout(resolve, 1500))
            continue
          }
          assertRecoveryOwnership(observer, true)
          if (!response.ok) {
            if (observer.cancel) {
              await new Promise(resolve => setTimeout(resolve, 1500))
              continue
            }
            throw new Error(`Remote observation interrupted (HTTP ${response.status}); ownership retained`)
          }
          let job: any
          try {
            job = await response.json()
          } catch (error) {
            assertRecoveryOwnership(observer, true)
            if (observer.cancel) {
              await new Promise(resolve => setTimeout(resolve, 1500))
              continue
            }
            throw error
          }
          // Cancellation can arrive while fetch or JSON parsing is pending. A
          // late completion is discarded, then the next iteration sends the
          // explicit cancellation request before observing the job again.
          assertRecoveryOwnership(observer, true)
          if (job.id !== saved.identity.id || job.audioHash !== request.audioHash) {
            throw new Error('Recovered remote identity mismatch')
          }
          if (observer.cancel && job.status === 'cancelled') {
            cancellationConfirmed = true
            throw new RecoveryCancelledError()
          }
          if (observer.cancel) {
            await new Promise(resolve => setTimeout(resolve, 1500))
            continue
          }
          assertRecoveryOwnership(observer)
          if (job.status === 'completed') {
            if (!job.result || createHash('sha256').update(JSON.stringify(job.result)).digest('hex') !== job.resultHash ||
                job.result.model !== request.model || typeof job.result.modelVersion !== 'string') throw new Error('Recovered remote result failed verification')
            validateRemoteResult(job.result, request.stage, request.model)
            validateChannelResult(job.result, request.channelMode, request.audioHash, request.channelMap, request.activeChannels)
            if (request.channelMode === 'separate') {
              const audioState = new RecordedAudioState()
              const layout = audioState.getLayout(saved.recordingId, request.audioHash)
              if (!layout || layout.channels !== job.result.sourceChannels) {
                throw new Error('Recovered channel result has no matching stored source layout')
              }
              const transformVersion = 'host-channel-pcm16-16k-v1'
              const mappingEvidence = audioState.getMapping(saved.recordingId, request.audioHash)
              assertRecoveryOwnership(observer)
              audioState.saveTracks(saved.recordingId, request.audioHash, transformVersion,
                job.result.channelResults.map((row: { sourceChannel: 0 | 1 }) => {
                  const mapping = request.channelMap?.find(item => item.sourceChannel === row.sourceChannel)
                  return { id: createHash('sha256').update(`${request.audioHash}:${row.sourceChannel}:${transformVersion}`).digest('hex'),
                    channelIndex: row.sourceChannel, path: '', sampleRate: 16000 as const,
                    frames: job.result.decodedFrames, durationSeconds: job.result.audioSeconds,
                    sourceRole: mapping?.role ?? 'unknown', timelineOffsetSeconds: 0 as const,
                    mappingEvidence }
                }))
            }
            assertRecoveryOwnership(observer)
            store.saveResult!(saved.key, { ...job.result, hostJobId: job.id })
            if (request.stage === 'transcription' && job.result.text.trim()) {
              const language = resolveRemoteWorkerLanguage(job.result.language, request.language)
              assertRecoveryOwnership(observer)
              saveStageCheckpoint(saved.recordingId, 'transcription', recordedAudioStageFingerprint(request.audioHash,
                request.channelMode === 'separate', request.channelMap), {
                fullText: job.result.text, speakers: JSON.stringify(job.result.segments),
                provider: request.model.startsWith('microsoft/VibeVoice') ? 'vibevoice' : 'local-asr',
                model: request.model, language: language.language,
                ...(request.channelMode ? { audioChannels: { sourceHash: request.audioHash, channelMode: 'separate',
                  decodedFrames: job.result.decodedFrames, decodedSampleRate: job.result.decodedSampleRate,
                  activeChannels: job.result.activeChannels, channelResults: job.result.channelResults } } : {}),
                remoteQuality: { executionLocation: 'remote', host: url.host, hostJobId: job.id,
                  device: job.result.device, resourcePolicy: job.result.resourcePolicy,
                  outputTokens: job.result.outputTokens, wallSeconds: job.result.wallSeconds,
                  ...remoteDiarizationQuality(job.result), requestedLanguage: language.requestedLanguage,
                  reportedLanguage: language.reportedLanguage, languageSource: language.languageSource }
              })
            }
            assertRecoveryOwnership(observer)
            store.save(saved.key, { ...saved.identity, observedStatus: 'completed' })
            if (runId) {
              assertRecoveryOwnership(observer)
              completeProcessingRun(runId, { quality: { executionLocation: 'remote', host: url.host, hostJobId: job.id } })
            }
            runId = undefined
            if (!observer.cancel) {
              assertRecoveryOwnership(observer)
              onComplete(saved.recordingId, request.model, request.stage)
            }
            return
          }
          if (!['running', 'queued'].includes(job.status)) {
            assertRecoveryOwnership(observer)
            store.save(saved.key, { ...saved.identity, observedStatus: job.status })
            throw new Error(`Remote job ${job.status}; resume explicitly`)
          }
          if (!observer.registered) {
            assertRecoveryOwnership(observer)
            addActiveTranscription(saved.recordingId)
            observer.registered = true
          }
          if (!runId) {
            assertRecoveryOwnership(observer)
            runId = createProcessingRun({ recordingId: saved.recordingId, stage: request.stage,
              provider: 'remote-worker', tool: 'remote-recovery', model: request.model, execution: 'provider-managed' }).id
          }
          await new Promise(resolve => setTimeout(resolve, 1500))
        }
        throw new Error('Remote observation ended; durable identity retained')
      } catch (error) {
        if (runId) {
          // Close only this observer's processing run; never let a stale recovery
          // result overwrite or restart a pipeline that now owns the recording.
          const ownershipLost = getActiveTranscriptionCount(saved.recordingId) > registeredRecoveryOwners(saved.recordingId)
          failProcessingRun(runId, ownershipLost ? new RecoveryOwnershipLostError().message :
            error instanceof Error ? error.message : String(error), !ownershipLost && cancellationConfirmed)
        }
      } finally {
        if (observer.registered) {
          removeActiveTranscription(saved.recordingId)
          observer.registered = false
        }
        observers.delete(observerKey)
      }
    })()
  }
}
