/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { startRecordingWatcher, stopRecordingWatcher } from '../recording-watcher'
import { insertRecording } from '../database'
import { queueTranscriptionIfEnabled } from '../transcription'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => '/test-library' }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn(async () => undefined) }))
vi.mock('fs', () => ({
  existsSync: () => true,
  readdirSync: () => ['Recording 2026-10-04 18-40 12345678-1234-1234-1234-123456789abc.webm'],
  statSync: () => ({ size: 100, mtime: new Date() }),
  watch: () => ({ close: vi.fn() })
}))
vi.mock('../database', () => ({
  getRecordingByFilenameVariants: () => undefined, insertRecording: vi.fn(), isFilePurged: () => false,
  getMeetings: () => [], linkRecordingToMeeting: vi.fn(), updateRecordingLifecycle: vi.fn()
}))
describe('PC recording privacy at the watcher boundary', () => {
  it('does not auto-import or queue an orphaned PC copy while its shared import is being recovered', async () => {
    startRecordingWatcher()
    await Promise.resolve()
    stopRecordingWatcher()
    expect(insertRecording).not.toHaveBeenCalled()
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
  })
})
