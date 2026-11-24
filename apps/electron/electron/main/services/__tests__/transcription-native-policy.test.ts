/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: { autoTranscribe: true, provider: 'gemini' } }) }))
vi.mock('@hidock/transcription', () => ({ GeminiEngine: class {} }))
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class {} }))
vi.mock('../brains', () => ({ getBrainRegistry: vi.fn(), resolveGeminiApiKey: vi.fn(() => 'test-key') }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../knowledge-capture-backfill', () => ({ ensureKnowledgeCaptureForRecording: vi.fn(), ensureNoSpeechKnowledgeCapture: vi.fn() }))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../recording-eligibility', () => ({ isRecordingTranscribable: () => true, isRecordingEligible: () => true }))
const db = vi.hoisted(() => ({ getRecordingById: vi.fn(), addToQueue: vi.fn(() => 'queue-item'), acquireTranscriptionLock: vi.fn(), getActiveProcessingRunsForRecording: vi.fn(() => [{ stage: 'metadata', status: 'completed' }, { stage: 'schedule-match', status: 'completed' }]) }))
vi.mock('../database', () => {
  const names = ['resolveRecordingId', 'updateRecordingTranscriptionStatus', 'updateRecordingStatus', 'insertTranscript', 'getQueueItems', 'updateQueueItem', 'updateQueueProgress', 'getMeetingById', 'findCandidateMeetingsForRecording', 'addRecordingMeetingCandidate', 'linkRecordingToMeeting', 'updateKnowledgeCaptureTitle', 'removeFromQueueByRecordingId', 'cancelPendingTranscriptions', 'run', 'runInTransaction', 'saveDatabase', 'queryOne', 'queryAll', 'releaseTranscriptionLock', 'clearStaleTranscriptionLock', 'resetStuckTranscriptions', 'enrichRecordingScheduleMetadata', 'createProcessingRun', 'completeProcessingRun', 'failProcessingRun']
  return { ...Object.fromEntries(names.map(name => [name, vi.fn()])), ...db }
})
import { queueTranscriptionIfEnabled } from '../transcription'
import { markNativeFileManualOnly } from '../device-native-file-policy'
beforeEach(() => { vi.clearAllMocks(); env.userData = mkdtempSync(join(tmpdir(), 'native-funnel-')) })
afterEach(() => { expect(dirname(env.userData)).toBe(resolve(tmpdir())); rmSync(env.userData, { recursive: true, force: true }) })
describe('central automatic native-file transcription guard', () => {
  it('blocks every matching filename identity before queue insertion, prerequisites or provider processing despite global autoTranscribe=true', async () => {
    await markNativeFileManualOnly('native-auto-guard.hda')
    for (const fields of [
      { filename: 'native-auto-guard.mp3' },
      { filename: 'renamed.mp3', original_filename: 'native-auto-guard.hda' },
      { filename: 'renamed.mp3', file_path: join(env.userData, 'native-auto-guard.wav') }
    ]) {
      db.getRecordingById.mockReturnValue({ id: 'protected', ...fields })
      expect(queueTranscriptionIfEnabled('protected', { deferProcessing: true })).toBe(false)
    }
    expect(db.addToQueue).not.toHaveBeenCalled()
    expect(db.getActiveProcessingRunsForRecording).not.toHaveBeenCalled()
    expect(db.acquireTranscriptionLock).not.toHaveBeenCalled()
    db.getRecordingById.mockReturnValue({ id: 'other', filename: 'other-native.mp3' })
    expect(queueTranscriptionIfEnabled('other', { deferProcessing: true })).toBe(true)
    expect(db.addToQueue).toHaveBeenCalledWith('other')
  })
})
