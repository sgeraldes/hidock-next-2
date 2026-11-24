/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => env.userData }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn(async () => undefined) }))
vi.mock('../database', () => ({ getRecordingByFilenameVariants: () => undefined, insertRecording: vi.fn(), isFilePurged: () => false,
  getMeetings: () => [], linkRecordingToMeeting: vi.fn(), updateRecordingLifecycle: vi.fn() }))
import { insertRecording } from '../database'
import { queueTranscriptionIfEnabled } from '../transcription'
import { markNativeFileManualOnly } from '../device-native-file-policy'
import { shouldAutomaticallyTranscribeRecording, startRecordingWatcher, stopRecordingWatcher } from '../recording-watcher'
beforeEach(() => { vi.clearAllMocks(); env.userData = mkdtempSync(join(tmpdir(), 'native-watcher-')) })
afterEach(() => { stopRecordingWatcher(); expect(dirname(env.userData)).toBe(resolve(tmpdir())); rmSync(env.userData, { recursive: true, force: true }) })

describe('native file watcher automatic boundary', () => {
  it('imports a protected saved variant unchanged but does not automatically enqueue it', async () => {
    await markNativeFileManualOnly('2026Oct11-120000-NativeTest.hda')
    const protectedPath = join(env.userData, '2026Oct11-120000-NativeTest.MP3')
    writeFileSync(protectedPath, Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(env.userData, '2026Oct11-120001-Other.mp3'), Buffer.from([5, 6]))
    expect(shouldAutomaticallyTranscribeRecording(protectedPath)).toBe(false)
    expect(shouldAutomaticallyTranscribeRecording(protectedPath.replace(/MP3$/, 'wav'))).toBe(false)
    startRecordingWatcher()
    await vi.waitFor(() => expect(insertRecording).toHaveBeenCalledTimes(2))
    expect(queueTranscriptionIfEnabled).toHaveBeenCalledOnce()
    const protectedRecording = vi.mocked(insertRecording).mock.calls.find(([row]) => row.filename.endsWith('NativeTest.MP3'))?.[0]
    expect(protectedRecording).toMatchObject({ source: 'hidock', is_imported: 0, transcription_status: 'none' })
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalledWith(protectedRecording?.id)
  })
})
