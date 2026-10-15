/**
 * Directed transcription: the brain API's POST /transcriptions admits named
 * recordings, and only those.
 *
 * 15-oct-2026: Rec08 and Rec09 of 13-oct sat downloaded with no queue row and
 * agents had no way to ask for them (the bridge's `raw` was removed on 22-sep).
 * The route is that way; these tests hold its admission rules.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config', () => ({
  getConfig: () => ({ features: undefined, transcription: { autoTranscribe: false, provider: 'gemini' } })
}))
vi.mock('@hidock/transcription', () => ({ GeminiEngine: class {} }))
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class {} }))
vi.mock('../brains', () => ({ getBrainRegistry: vi.fn(), resolveGeminiApiKey: vi.fn(() => 'test-key') }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../knowledge-capture-backfill', () => ({
  ensureKnowledgeCaptureForRecording: vi.fn(),
  ensureNoSpeechKnowledgeCapture: vi.fn()
}))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))

const eligible = vi.hoisted(() => ({ ids: new Set<string>() }))
vi.mock('../recording-eligibility', () => ({
  isRecordingEligible: (id: string) => eligible.ids.has(id),
  isRecordingTranscribable: (id: string) => eligible.ids.has(id)
}))

const receipts = vi.hoisted(() => new Map<string, { fingerprint: string; jobs: unknown[] }>())
vi.mock('../targeted-request-store', () => ({
  requestFingerprint: (ids: string[], provider: string) => `${[...ids].sort().join(',')}|${provider}`,
  findTargetedReceipt: (requestId: string, fingerprint: string) => {
    const receipt = receipts.get(requestId)
    if (receipt && receipt.fingerprint !== fingerprint) throw new Error('requestId already used with different parameters')
    return receipt
  },
  saveTargetedReceipt: (requestId: string, receipt: { fingerprint: string; jobs: unknown[] }) => {
    receipts.set(requestId, JSON.parse(JSON.stringify(receipt)))
  }
}))

const dbSpies = vi.hoisted(() => {
  const names = [
    'addToQueue', 'getRecordingById', 'resolveRecordingId', 'updateRecordingTranscriptionStatus',
    'updateRecordingStatus', 'insertTranscript', 'getQueueItems', 'updateQueueItem',
    'updateQueueProgress', 'getMeetingById', 'findCandidateMeetingsForRecording',
    'addRecordingMeetingCandidate', 'linkRecordingToMeeting', 'updateKnowledgeCaptureTitle',
    'removeFromQueueByRecordingId', 'cancelPendingTranscriptions', 'run', 'runInTransaction',
    'saveDatabase', 'queryOne', 'queryAll', 'acquireTranscriptionLock', 'releaseTranscriptionLock',
    'clearStaleTranscriptionLock', 'resetStuckTranscriptions', 'getActiveProcessingRunsForRecording',
    'enrichRecordingScheduleMetadata', 'createProcessingRun', 'completeProcessingRun', 'failProcessingRun'
  ]
  const spies: Record<string, ReturnType<typeof import('vitest').vi.fn>> = {}
  return { names, spies }
})
vi.mock('../database', () => {
  const mod: Record<string, unknown> = {}
  for (const name of dbSpies.names) mod[name] = dbSpies.spies[name] = vi.fn()
  return mod
})

import { submitTargetedTranscriptions, targetedTranscriptionStatus } from '../transcription'

const db = dbSpies.spies

beforeEach(() => {
  for (const spy of Object.values(db)) spy.mockReset()
  receipts.clear()
  eligible.ids = new Set(['rec-new', 'rec-done', 'rec-b'])
  db['getQueueItems'].mockReturnValue([])
  db['getRecordingById'].mockImplementation((id: string) => ({ id, transcription_status: id === 'rec-done' ? 'complete' : 'none' }))
  db['queryOne'].mockReturnValue(undefined)
  db['acquireTranscriptionLock'].mockReturnValue(true)
  db['releaseTranscriptionLock'].mockReturnValue(true)
  db['runInTransaction'].mockImplementation((fn: () => unknown) => fn())
  db['addToQueue'].mockImplementation((id: string) => `q-${id}`)
})

/** The directed run starts asynchronously; let it reach its finally block. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('submitTargetedTranscriptions', () => {
  it('queues a recording without a transcript with the requested provider and frees the lock after', async () => {
    const result = submitTargetedTranscriptions(['rec-new'], 'local-asr', 'req-1')
    expect(result.jobs).toEqual([{ recordingId: 'rec-new', queueItemId: 'q-rec-new', status: 'pending' }])
    expect(db['addToQueue']).toHaveBeenCalledWith('rec-new', 'local-asr')
    await settle()
    expect(db['releaseTranscriptionLock']).toHaveBeenCalledWith(db['acquireTranscriptionLock'].mock.calls[0][0])
  })

  it('refuses the whole request when one id is ineligible, before admitting anything', () => {
    expect(() => submitTargetedTranscriptions(['rec-new', 'rec-personal'], undefined, 'req-2')).toThrow(/unavailable or ineligible/)
    expect(db['addToQueue']).not.toHaveBeenCalled()
    expect(db['acquireTranscriptionLock']).not.toHaveBeenCalled()
  })

  it('leaves a transcribed recording alone and takes no lock', () => {
    const result = submitTargetedTranscriptions(['rec-done'], undefined, 'req-3')
    expect(result.jobs).toEqual([{ recordingId: 'rec-done', status: 'already-transcribed' }])
    expect(db['addToQueue']).not.toHaveBeenCalled()
    expect(db['acquireTranscriptionLock']).not.toHaveBeenCalled()
  })

  it('reports a recording already in the queue instead of adding a second row', () => {
    db['getQueueItems'].mockReturnValue([{ id: 'q-old', recording_id: 'rec-new', status: 'processing', provider: null }])
    db['acquireTranscriptionLock'].mockReturnValue(false)
    expect(() => submitTargetedTranscriptions(['rec-new', 'rec-b'], undefined, 'req-4')).toThrow(/busy/)
    expect(db['addToQueue']).not.toHaveBeenCalled()
  })

  it('refuses a recording queued with a different provider', () => {
    db['getQueueItems'].mockReturnValue([{ id: 'q-old', recording_id: 'rec-new', status: 'pending', provider: 'gemini' }])
    expect(() => submitTargetedTranscriptions(['rec-new'], 'local-asr', 'req-5')).toThrow(/different provider/)
  })

  it('answers a repeated request id from its receipt without queueing again', async () => {
    submitTargetedTranscriptions(['rec-new'], undefined, 'req-6')
    await settle()
    const again = submitTargetedTranscriptions(['rec-new'], undefined, 'req-6')
    expect(again.replayed).toBe(true)
    expect(db['addToQueue']).toHaveBeenCalledTimes(1)
    expect(() => submitTargetedTranscriptions(['rec-b'], undefined, 'req-6')).toThrow(/different parameters/)
  })

  it('rejects an unknown provider and a malformed request id', () => {
    expect(() => submitTargetedTranscriptions(['rec-new'], 'whisper', 'req-7')).toThrow(/Unsupported/)
    expect(() => submitTargetedTranscriptions(['rec-new'], undefined, 'bad id!')).toThrow(/requestId/)
    expect(db['addToQueue']).not.toHaveBeenCalled()
  })
})

describe('targetedTranscriptionStatus', () => {
  it('answers only for eligible recordings, with their queue jobs', () => {
    db['getQueueItems'].mockReturnValue([
      { id: 'q1', recording_id: 'rec-new', status: 'failed', progress: 20, provider: null, error_message: 'Provider response retained' },
      { id: 'q2', recording_id: 'rec-personal', status: 'pending', progress: 0, provider: null, error_message: null }
    ])
    expect(targetedTranscriptionStatus(['rec-new', 'rec-personal'])).toEqual([
      {
        recordingId: 'rec-new',
        transcriptionStatus: 'none',
        jobs: [{ id: 'q1', status: 'failed', progress: 20, provider: null, error: 'Provider response retained' }]
      }
    ])
  })
})
