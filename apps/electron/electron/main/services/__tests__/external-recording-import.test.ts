/** @vitest-environment node */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importExternalRecording } from '../external-recording-import'
import { getRecordingById, getRecordingByFilename, insertRecording } from '../database'
import { getRecordingsPath } from '../file-storage'
import { queueTranscriptionIfEnabled } from '../transcription'

vi.mock('../database', () => ({ getRecordingById: vi.fn(), getRecordingByFilename: vi.fn(), insertRecording: vi.fn() }))
vi.mock('../file-storage', () => ({ getRecordingsPath: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
const folders: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const path of folders.splice(0)) rmSync(path, { recursive: true }) })
describe('shared external-file import', () => {
  it('copies a stopped PC recording and inserts an imported Library row, with stable recovery identity', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pc-import-test-')); folders.push(folder)
    const library = join(folder, 'library'); mkdirSync(library)
    vi.mocked(getRecordingsPath).mockReturnValue(library)
    const source = join(folder, 'Recording 2026-10-04 18-40 id.webm')
    writeFileSync(source, Buffer.from([1, 2, 3]))
    vi.mocked(getRecordingById).mockReturnValue({ id: 'saved' } as never)
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    expect(readFileSync(join(library, 'Recording 2026-10-04 18-40 id.webm'))).toEqual(Buffer.from([1, 2, 3]))
    expect(insertRecording).toHaveBeenCalledWith(expect.objectContaining({ is_imported: 1, source: 'external', location: 'local-only', transcription_status: 'none' }))
    expect(queueTranscriptionIfEnabled).toHaveBeenCalledWith('saved')
    const inserted = vi.mocked(insertRecording).mock.calls[0][0]
    expect(Math.abs(Date.parse(inserted.date_recorded) - Date.now())).toBeLessThan(10000)
    vi.mocked(getRecordingByFilename).mockReturnValue({ id: 'saved' } as never)
    expect(importExternalRecording(source, { preserveFilename: true }).recording?.id).toBe('saved')
    expect(insertRecording).toHaveBeenCalledOnce()
  })
  it('retries queueing after an interrupted import, without requeueing completed work', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pc-import-test-')); folders.push(folder)
    const source = join(folder, 'recording.webm'); writeFileSync(source, 'audio')
    vi.mocked(getRecordingByFilename).mockReturnValue({ id: 'retry', transcription_status: 'none' } as never)
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    expect(queueTranscriptionIfEnabled).toHaveBeenCalledWith('retry')
    vi.mocked(queueTranscriptionIfEnabled).mockClear()
    vi.mocked(getRecordingByFilename).mockReturnValue({ id: 'retry', transcription_status: 'complete' } as never)
    expect(importExternalRecording(source, { preserveFilename: true }).success).toBe(true)
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
  })
})
