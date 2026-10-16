/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() }, Notification: vi.fn() }))
vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(() => 'native-id'), addSyncedFile: vi.fn(), getSyncedFile: () => undefined,
  removeSyncedFile: vi.fn(), isFilePurged: () => false, clearPurgeTombstones: vi.fn(), getPurgedFilenames: () => [],
  getRecordingByFilename: () => null, getSyncedFilenames: () => new Set(), queryOne: () => null,
  queryAll: vi.fn(() => []), run: vi.fn(), runInTransaction: (fn: () => void) => fn(),
  upsertRecordingFromDevice: vi.fn(), enrichRecordingScheduleMetadata: vi.fn(), createProcessingRun: vi.fn(),
  completeProcessingRun: vi.fn(), remeasureRecordingDuration: vi.fn()
}))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => env.userData,
  saveRecording: vi.fn(async (name: string, data: Buffer) => { const path = join(env.userData, name.replace(/\.hda$/i, '.mp3')); writeFileSync(path, data); return path }), replaceRecordingFile: vi.fn()
}))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn(async () => undefined) }))
vi.mock('../storage-usage', () => ({ resetStorageLimitCache: vi.fn() }))
vi.mock('../download-transfer-controller', () => ({ cancelAllTransfers: vi.fn(), cancelActiveTransferByName: vi.fn(), hasTransferIntent: () => false, getActiveTransferFilename: () => null }))

import { DownloadService } from '../download-service'
import { queryAll, upsertRecordingFromDevice } from '../database'
import { queueTranscriptionIfEnabled } from '../transcription'
import { markNativeFileManualOnly } from '../device-native-file-policy'

let service: DownloadService
beforeEach(() => { vi.clearAllMocks(); env.userData = mkdtempSync(join(tmpdir(), 'native-download-')); service = new DownloadService({ passive: true }) })
afterEach(() => { service.destroy(); expect(dirname(env.userData)).toBe(resolve(tmpdir())); rmSync(env.userData, { recursive: true, force: true }) })

describe('native verification manual-only download boundary', () => {
  it('excludes the protected exact file from automatic reconciliation/queue, permits manual download without automatic transcription', async () => {
    const name = 'native-protected.hda'
    await markNativeFileManualOnly(name)
    expect(service.getFilesToSync([{ filename: name, size: 4, duration: 10, dateCreated: new Date() }])[0].skipReason).toContain('manual download only')
    expect(upsertRecordingFromDevice).not.toHaveBeenCalled()
    expect(service.queueDownloads([{ filename: name, size: 4 }])).toEqual({ queued: [], skipped: [expect.objectContaining({ skip: 'manual-only' })] })
    expect(service.queueDownloads([{ filename: name, size: 4 }], true).queued).toEqual([name])
    expect(service.beginDownload(name)).toBe(true)
    const result = await service.processDownload(name, Buffer.from([1, 2, 3, 4]))
    expect(result.success).toBe(true)
    expect(queueTranscriptionIfEnabled).not.toHaveBeenCalled()
    expect(service.queueDownloads([{ filename: 'native-neighbor.hda', size: 4 }]).queued).toEqual(['native-neighbor.hda'])
  })

  it('blocks an automatic queue item protected before admission and requires fresh manual authority after restart', async () => {
    const name = 'native-race.hda'
    service.queueDownloads([{ filename: name, size: 4 }])
    await markNativeFileManualOnly(name)
    expect(service.beginDownload(name)).toBe(false)
    expect((await service.processDownload(name, Buffer.from([1, 2, 3, 4]))).success).toBe(false)
    expect(service.queueDownloads([{ filename: name, size: 4 }], true).queued).toEqual([name])
    expect(service.beginDownload(name)).toBe(true)
    vi.mocked(queryAll).mockReturnValueOnce([{ id: name, filename: name, file_size: 4, progress: 0, status: 'pending', created_at: new Date().toISOString() }] as never)
    const restarted = new DownloadService()
    try {
      expect(restarted.getState().queue[0]).toMatchObject({ status: 'cancelled', cancelReason: 'user' })
      expect(restarted.retryFailed(true, true).count).toBe(0)
      expect(restarted.beginDownload(name)).toBe(false)
      expect(restarted.queueDownloads([{ filename: name, size: 4 }], true).queued).toEqual([name])
      expect(restarted.beginDownload(name)).toBe(true)
    } finally { restarted.destroy() }
  })
})
