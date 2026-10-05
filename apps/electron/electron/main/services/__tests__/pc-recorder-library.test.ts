/** @vitest-environment node */
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegPath from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ db: '', recordings: '' }))
const settings = vi.hoisted(() => ({ autoTranscribe: true, enabled: true }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: { autoTranscribe: settings.autoTranscribe, provider: 'gemini' } }) }))
vi.mock('../feature-gate', () => ({ isFeatureEnabled: () => settings.enabled }))
vi.mock('../brains', () => ({ getBrainRegistry: vi.fn(), resolveGeminiApiKey: () => undefined }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../database', async (importOriginal) => ({
  ...await importOriginal<typeof import('../database')>(),
  // Observe real persisted queue state without draining it into a provider.
  acquireTranscriptionLock: vi.fn(() => false)
}))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getRecordingsPath: () => paths.recordings }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => tmpdir() } }))
import { initializeDatabase, closeDatabase, getRecordings, getQueueItems, getRecordingByFilename, acquireTranscriptionLock } from '../database'
import { importExternalRecording } from '../external-recording-import'
import { PcRecorder } from '../pc-recorder'

let folder: string
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'pc-library-test-'))
  paths.db = join(folder, 'test.db')
  paths.recordings = join(folder, 'library')
  mkdirSync(paths.recordings)
  initializeDatabase()
})
afterAll(() => { closeDatabase(); rmSync(folder, { recursive: true }) })
describe('PC recordings at the filesystem and SQLite boundary', () => {
  it('imports a synthetic stereo WebM and recovers an interrupted stream into the actual Library query', async () => {
    expect(ffmpegPath).toBeTruthy()
    // Generated tones only: no device or media API is opened.
    const audio = execFileSync(ffmpegPath!, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-filter_complex', '[0:a][1:a]amerge=inputs=2',
      '-ac', '2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    const staging = join(folder, 'staging')
    const importer = async (path: string) => importExternalRecording(path, { preserveFilename: true })
    const recorder = new PcRecorder(staging, importer)
    const id = recorder.start()
    const middle = Math.floor(audio.length / 2)
    recorder.append(id, 0, audio.subarray(0, middle))
    recorder.append(id, 1, audio.subarray(middle))
    expect(getQueueItems()).toHaveLength(0)
    expect(await recorder.finish(id)).toMatchObject({ success: true })
    const saved = getRecordings().find((row) => row.is_imported === 1)!
    expect(saved).toMatchObject({ on_local: 1, on_device: 0, transcription_status: 'pending', source: 'external' })
    expect(getQueueItems()).toMatchObject([{ recording_id: saved.id, status: 'pending' }])
    expect(readFileSync(saved.file_path!)).toEqual(audio)
    const pcm = execFileSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-i', saved.file_path!, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    expect(pcm.length).toBeGreaterThan(48000 * 2 * 2)
    // Distinct synthetic sources survive on separate sides in the persisted media.
    let difference = 0
    for (let offset = 0; offset + 3 < pcm.length; offset += 4) difference += Math.abs(pcm.readInt16LE(offset) - pcm.readInt16LE(offset + 2))
    expect(difference).toBeGreaterThan(100000)

    const interrupted = recorder.start()
    recorder.append(interrupted, 0, audio.subarray(0, Math.floor(audio.length * 0.75)))
    recorder.close()
    await new PcRecorder(staging, importer).recover()
    const library = getRecordings()
    expect(library).toHaveLength(2)
    expect(getQueueItems()).toHaveLength(2)
    const partial = library.find((row) => row.id !== saved.id)!
    const recovered = execFileSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-i', partial.file_path!, '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    expect(recovered.length).toBeGreaterThan(0)
    await recorder.recover()
    expect(getRecordings()).toHaveLength(2)
    expect(getQueueItems()).toHaveLength(2)
  })
  it('respects automatic transcription and feature settings on stop and recovery', async () => {
    const staging = join(folder, 'settings-staging')
    const importer = async (path: string) => importExternalRecording(path, { preserveFilename: true })
    const recorder = new PcRecorder(staging, importer)
    const before = getQueueItems().length
    settings.autoTranscribe = false
    const id = recorder.start(); recorder.append(id, 0, new Uint8Array([1]))
    await recorder.finish(id)
    expect(getQueueItems()).toHaveLength(before)
    settings.autoTranscribe = true; settings.enabled = false
    const crashed = recorder.start(); recorder.append(crashed, 0, new Uint8Array([1])); recorder.close()
    await recorder.recover()
    expect(getQueueItems()).toHaveLength(before)
    settings.enabled = true
  })
  it('retries an interrupted post-insert queue and deduplicates recovery queue rows', async () => {
    const source = join(folder, 'Recording 2026-10-04 18-40 11111111-1111-1111-1111-111111111111.webm')
    writeFileSync(source, 'audio')
    settings.autoTranscribe = false
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    const saved = getRecordingByFilename(source.split(/[\\/]/).pop()!)!
    const before = getQueueItems().length
    settings.autoTranscribe = true
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    expect(getQueueItems()).toHaveLength(before + 1)
    expect(getQueueItems().filter((item) => item.recording_id === saved.id)).toHaveLength(1)
  })
  it('persists a quit-time queue row without starting provider processing', () => {
    const source = join(folder, 'Recording 2026-10-04 18-40 22222222-2222-2222-2222-222222222222.webm')
    writeFileSync(source, 'audio')
    vi.mocked(acquireTranscriptionLock).mockClear()
    const imported = importExternalRecording(source, { preserveFilename: true, deferProcessing: true })
    expect(imported.success).toBe(true)
    expect(getQueueItems().find((item) => item.recording_id === imported.recording!.id)).toMatchObject({ status: 'pending' })
    expect(acquireTranscriptionLock).not.toHaveBeenCalled()
  })
})
