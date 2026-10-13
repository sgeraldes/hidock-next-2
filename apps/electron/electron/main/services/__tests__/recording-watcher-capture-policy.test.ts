/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const folder = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => folder.path }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn(async () => undefined) }))
vi.mock('../database', () => ({
  getRecordingByFilenameVariants: () => undefined, insertRecording: vi.fn(), isFilePurged: () => false,
  getMeetings: () => [], linkRecordingToMeeting: vi.fn(), updateRecordingLifecycle: vi.fn()
}))

import { insertRecording } from '../database'
import { queueTranscriptionIfEnabled } from '../transcription'
import { shouldAutomaticallyTranscribeRecording, startRecordingWatcher, stopRecordingWatcher } from '../recording-watcher'
import { liveNotePath, RealtimeRecorder, recoverPartialLiveRecordings, wavHeader } from '../realtime-recorder'

beforeEach(() => { vi.clearAllMocks(); folder.path = mkdtempSync(join(tmpdir(), 'capture-policy-')) })
afterEach(() => { stopRecordingWatcher(); rmSync(folder.path, { recursive: true, force: true }) })

function wav(name: string): string {
  const path = join(folder.path, name)
  writeFileSync(path, Buffer.concat([wavHeader(4), Buffer.from([1, 0, 2, 0])]))
  return path
}

describe('capture import never starts unsolicited offline transcription', () => {
  it('imports a real captured WAV but does not enqueue it under the global auto-transcribe path', async () => {
    const recorder = new RealtimeRecorder({ recordingsPath: () => folder.path, enabled: () => true,
      folderMoving: () => false, now: () => new Date(2026, 9, 11, 12, 0, 0) })
    expect(recorder.start({ captureSessionId: 'test-capture', automaticTranscription: false, strictStereo: true })).toBeNull()
    recorder.write({ rest: 0, muted: false, data: new Uint8Array(12) })
    const result = recorder.finish()
    expect(result?.status).toBe('saved')
    if (result?.status !== 'saved') throw new Error('Expected saved capture')
    expect(result.filename).toBe('2026Oct11-120000-Capture-Live.wav')
    const path = join(folder.path, result.filename)
    const original = readFileSync(path)
    expect(JSON.parse(readFileSync(liveNotePath(path), 'utf8')).capture.automaticTranscription).toBe(false)
    startRecordingWatcher()
    await vi.waitFor(() => expect(insertRecording).toHaveBeenCalledOnce())
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(original)
  })

  it('fails closed for missing, corrupt, oversized and inconsistent new-capture sidecars', async () => {
    const cases = [undefined, '{broken json', ' '.repeat(65537),
      JSON.stringify({ captureSessionId: 'capture', capture: { schemaVersion: 1, sessionId: 'other', automaticTranscription: true } })]
    for (let index = 0; index < cases.length; index++) {
      const path = wav(`2026Oct11-12000${index}-Capture-Live.wav`)
      if (cases[index] !== undefined) writeFileSync(liveNotePath(path), cases[index]!)
      expect(shouldAutomaticallyTranscribeRecording(path)).toBe(false)
    }
    // Exported source tracks and recovered numbered captures retain the default.
    expect(shouldAutomaticallyTranscribeRecording(wav('2026Oct11-120010-Capture-Live-2.channel-0.wav'))).toBe(false)
    startRecordingWatcher()
    await vi.waitFor(() => expect(insertRecording).toHaveBeenCalledTimes(5))
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
  })

  it('retains existing native/legacy-live automatic transcription policy', async () => {
    wav('2026Oct11-120001-Rec01.wav')
    const legacy = wav('2026Oct11-120002-Live.wav')
    writeFileSync(liveNotePath(legacy), JSON.stringify({ micChannel: 1 }))
    startRecordingWatcher()
    await vi.waitFor(() => expect(insertRecording).toHaveBeenCalledTimes(2))
    expect(queueTranscriptionIfEnabled).toHaveBeenCalledTimes(2)
  })

  it('imports a crash-recovered new capture without silently authorizing offline transcription', async () => {
    const partial = join(folder.path, '2026Oct11-120011-Capture-Live.wav.partial')
    writeFileSync(partial, Buffer.concat([wavHeader(0), Buffer.from([1, 0, 2, 0])]))
    const recovered = recoverPartialLiveRecordings(folder.path)
    expect(recovered).toEqual([partial.replace(/\.partial$/, '')])
    expect(readFileSync(recovered[0]).readUInt32LE(40)).toBe(4)
    startRecordingWatcher()
    await vi.waitFor(() => expect(insertRecording).toHaveBeenCalledOnce())
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
  })

  it('honors session-owned policy after a rename and only accepts explicit consistent opt-in', () => {
    const path = wav('renamed.wav')
    const note = { captureSessionId: 'capture', capture: { schemaVersion: 1, sessionId: 'capture', automaticTranscription: false } }
    writeFileSync(liveNotePath(path), JSON.stringify(note))
    expect(shouldAutomaticallyTranscribeRecording(path)).toBe(false)
    note.capture.automaticTranscription = true
    writeFileSync(liveNotePath(path), JSON.stringify(note))
    expect(shouldAutomaticallyTranscribeRecording(path)).toBe(true)
  })
})
