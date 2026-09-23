/**
 * A manual transcription that fails must leave a mark.
 *
 * D-022 (2026-09-22): `recordings.transcribe(id)` threw "Recording not found or
 * no local file" and the recording stayed at `transcription_status = 'none'` —
 * byte-for-byte the state of a recording nobody had ever tried to transcribe.
 * The only evidence was a renderer event, which is gone the moment nothing is
 * listening. Two job interviews sat unnoticed for 12 days because of it.
 *
 * The queue path already did this correctly (marks 'error', writes the activity
 * log). These tests hold the manual path to the same standard.
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

const mockEmitActivityLog = vi.fn()
vi.mock('../activity-log', () => ({ emitActivityLog: (...a: unknown[]) => mockEmitActivityLog(...a) }))

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

import { transcribeManually } from '../transcription'

beforeEach(() => {
  for (const spy of Object.values(dbSpies.spies)) spy.mockClear()
  mockEmitActivityLog.mockClear()
})

describe('transcribeManually — a failure is recorded, not just announced', () => {
  it('marks the recording as errored when the local file cannot be resolved', async () => {
    // The recording row exists but carries no usable path — exactly the D-022 state.
    dbSpies.spies['getRecordingById'].mockReturnValue({
      id: 'rec-d022',
      filename: '2026Sep22-085950-Rec35.hda',
      file_path: null
    })

    await expect(transcribeManually('rec-d022')).rejects.toThrow(/no local file/)

    expect(dbSpies.spies['updateRecordingTranscriptionStatus']).toHaveBeenCalledWith('rec-d022', 'error')
  })

  it('writes the failure to the activity log so it survives the renderer', async () => {
    dbSpies.spies['getRecordingById'].mockReturnValue({
      id: 'rec-d022b',
      filename: '2026Sep10-184825-Rec86.hda',
      file_path: ''
    })

    await expect(transcribeManually('rec-d022b')).rejects.toThrow()

    expect(mockEmitActivityLog).toHaveBeenCalledWith(
      'error',
      'Transcription failed',
      expect.stringContaining('2026Sep10-184825-Rec86.hda')
    )
  })

  it('still rethrows so the IPC caller sees the failure', async () => {
    dbSpies.spies['getRecordingById'].mockReturnValue(undefined)
    dbSpies.spies['resolveRecordingId'].mockReturnValue(undefined)

    await expect(transcribeManually('ghost-id')).rejects.toThrow(/Recording not found/)
  })
})
