/**
 * Download Service — stale `synced_files` rows must not shadow the disk.
 *
 * D-022 (2026-09-22): a `synced_files` row whose `file_path` no longer resolves
 * made `isFileAlreadySynced` answer "synced" on the row's mere existence. That
 * single answer blocked BOTH exits for the recording:
 *
 *   - `queueDownloads` skipped the file ("already synced") and still reported
 *     success with an empty queued list, so the caller could not tell the
 *     difference between "nothing to do" and "I refused your file".
 *   - the audio was never fetched, so `recordings.file_path` stayed empty and
 *     `transcribe()` failed with "no local file".
 *
 * The table must never outrank the filesystem: a row is evidence, not proof.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) }
}))

/** Rows the fake `synced_files` table holds, keyed by original_filename. */
const syncedRows = new Map<string, { original_filename: string; local_filename: string; file_path: string }>()
/** Absolute paths the fake filesystem reports as present. */
const filesOnDisk = new Set<string>()

const mockAddSyncedFile = vi.fn((original: string, local: string, path: string) => {
  syncedRows.set(original, { original_filename: original, local_filename: local, file_path: path })
  return 'id'
})
const mockRemoveSyncedFile = vi.fn((original: string) => {
  syncedRows.delete(original)
})

vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(),
  addSyncedFile: (o: string, l: string, p: string) => mockAddSyncedFile(o, l, p),
  removeSyncedFile: (o: string) => mockRemoveSyncedFile(o),
  isFileSynced: (filename: string) => syncedRows.has(filename),
  getSyncedFile: (filename: string) => syncedRows.get(filename),
  isFilePurged: () => false,
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFilenames: vi.fn(() => new Set()),
  queryOne: vi.fn(() => null),
  queryAll: vi.fn(() => []),
  run: vi.fn(),
  runInTransaction: vi.fn((fn: () => void) => fn()),
  getDatabase: vi.fn(() => ({ exec: vi.fn(() => []), run: vi.fn() }))
}))

vi.mock('../file-storage', () => ({
  saveRecording: vi.fn().mockResolvedValue('/mock/recordings/file.wav'),
  getRecordingsPath: vi.fn(() => '/mock/recordings')
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  // path.join() emits the host separator, so compare on a normalized form.
  const existsSync = (p: unknown) => filesOnDisk.has(String(p).split('\\').join('/'))
  return { ...actual, default: { ...actual, existsSync }, existsSync }
})

import { getDownloadService } from '../download-service'

describe('DownloadService — a synced_files row never outranks the disk', () => {
  let service: ReturnType<typeof getDownloadService>

  beforeEach(() => {
    vi.clearAllMocks()
    syncedRows.clear()
    filesOnDisk.clear()
    service = getDownloadService()
  })

  describe('isFileAlreadySynced', () => {
    it('does not report synced when the row points at a file that is gone', () => {
      syncedRows.set('D022a-Rec01.hda', {
        original_filename: 'D022a-Rec01.hda',
        local_filename: 'D022a-Rec01.wav',
        file_path: 'F:\\Old-Location\\D022a-Rec01.wav'
      })
      // Nothing is on disk — not the recorded path, not any canonical variant.

      const result = service.isFileAlreadySynced('D022a-Rec01.hda')

      expect(result.synced).toBe(false)
    })

    it('drops the unbacked row so the file becomes downloadable again', () => {
      syncedRows.set('D022b-Rec02.hda', {
        original_filename: 'D022b-Rec02.hda',
        local_filename: 'D022b-Rec02.wav',
        file_path: 'F:\\Old-Location\\D022b-Rec02.wav'
      })

      service.isFileAlreadySynced('D022b-Rec02.hda')

      expect(mockRemoveSyncedFile).toHaveBeenCalledWith('D022b-Rec02.hda')
      expect(syncedRows.has('D022b-Rec02.hda')).toBe(false)
    })

    it('re-points the row at the real file when the audio moved', () => {
      syncedRows.set('D022c-Rec03.hda', {
        original_filename: 'D022c-Rec03.hda',
        local_filename: 'D022c-Rec03.wav',
        file_path: 'F:\\Old-Location\\D022c-Rec03.wav'
      })
      // The audio is in the CURRENT recordings directory, under the .wav variant.
      filesOnDisk.add('/mock/recordings/D022c-Rec03.wav')

      const result = service.isFileAlreadySynced('D022c-Rec03.hda')

      expect(result.synced).toBe(true)
      expect(result.reason).toContain('reconciled')
      expect(syncedRows.get('D022c-Rec03.hda')?.file_path.split('\\').join('/')).toBe(
        '/mock/recordings/D022c-Rec03.wav'
      )
    })

    it('still trusts a row whose file is exactly where it says', () => {
      syncedRows.set('D022d-Rec04.hda', {
        original_filename: 'D022d-Rec04.hda',
        local_filename: 'D022d-Rec04.wav',
        file_path: '/mock/recordings/D022d-Rec04.wav'
      })
      filesOnDisk.add('/mock/recordings/D022d-Rec04.wav')

      const result = service.isFileAlreadySynced('D022d-Rec04.hda')

      expect(result.synced).toBe(true)
      expect(mockRemoveSyncedFile).not.toHaveBeenCalled()
    })
  })

  describe('queueDownloads', () => {
    it('queues a file whose synced row is not backed by any audio', () => {
      syncedRows.set('D022e-Rec05.hda', {
        original_filename: 'D022e-Rec05.hda',
        local_filename: 'D022e-Rec05.wav',
        file_path: 'F:\\Old-Location\\D022e-Rec05.wav'
      })

      const result = service.queueDownloads([{ filename: 'D022e-Rec05.hda', size: 1024 }], true)

      expect(result.queued).toEqual(['D022e-Rec05.hda'])
      expect(result.skipped).toHaveLength(0)
    })

    it('reports what it skipped and why instead of an empty success', () => {
      syncedRows.set('D022f-Rec06.hda', {
        original_filename: 'D022f-Rec06.hda',
        local_filename: 'D022f-Rec06.wav',
        file_path: '/mock/recordings/D022f-Rec06.wav'
      })
      filesOnDisk.add('/mock/recordings/D022f-Rec06.wav')

      const result = service.queueDownloads([{ filename: 'D022f-Rec06.hda', size: 1024 }], true)

      expect(result.queued).toHaveLength(0)
      expect(result.skipped).toEqual([
        expect.objectContaining({ filename: 'D022f-Rec06.hda', skip: 'already-synced' })
      ])
      expect(result.skipped[0].reason).toBeTruthy()
    })
  })
})
