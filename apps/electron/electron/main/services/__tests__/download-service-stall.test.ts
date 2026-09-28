// @vitest-environment node

/**
 * A download the device stopped sending (28-sep-2026, the 2 h 27 min meeting):
 * the first stall is retried by the reconnect, a second one stays failed.
 *
 * Mocks follow download-service-cancel.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: class {
    static isSupported() { return false }
    show() { /* no-op in tests */ }
  },
}))

vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(),
  addSyncedFile: vi.fn(),
  isFileSynced: vi.fn(() => false),
  getSyncedFile: vi.fn(() => undefined),
  removeSyncedFile: vi.fn(),
  isFilePurged: () => false,
  getPurgedFilenames: () => [],
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFilenames: vi.fn(() => new Set()),
  queryOne: vi.fn(() => null),
  queryAll: vi.fn(() => []),
  run: vi.fn(),
  runInTransaction: vi.fn((fn: () => void) => fn()),
  getDatabase: vi.fn(() => ({ exec: vi.fn(() => []), run: vi.fn() })),
}))

vi.mock('../file-storage', () => ({
  saveRecording: vi.fn().mockResolvedValue('/mock/recordings/file.wav'),
  getRecordingsPath: vi.fn(() => '/mock/recordings'),
}))

vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))

vi.mock('../download-transfer-controller', () => ({
  getActiveTransferFilename: () => null,
  cancelActiveTransferByName: vi.fn(() => Promise.resolve(true)),
  cancelActiveTransfer: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const overrides = { existsSync: vi.fn(() => false), mkdirSync: vi.fn() }
  return { ...actual, default: { ...actual, ...overrides }, ...overrides }
})

import { DownloadService } from '../download-service'

describe('DownloadService — transfer stall', () => {
  let service: DownloadService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new DownloadService()
  })

  afterEach(() => {
    service.destroy()
  })

  function item(name: string) {
    return service.getState().queue.find((i) => i.filename === name)
  }

  it('marks the first stall interrupted so the reconnect retries it, and says what happened', () => {
    service.queueDownloads([{ filename: 'long.hda', size: 70_680_684 }])
    service.updateProgress('long.hda', 3_500_000) // pending -> downloading

    service.noteTransferStall('long.hda', 3_565_000, 70_680_684)

    expect(item('long.hda')?.status).toBe('cancelled')
    expect(item('long.hda')?.cancelReason).toBe('interrupted')
    expect(item('long.hda')?.error).toBe('The device stopped sending at 3.4 of 67.4 MB; retrying after the reconnect')
    // the renderer's generic failure after the stall does not overwrite it
    expect(service.markFailed('long.hda', 'USB transfer failed')).toBe(false)
    expect(item('long.hda')?.status).toBe('cancelled')
    // the reconnect's automatic retry picks it up
    expect(service.retryFailed(true, true).count).toBe(1)
    expect(item('long.hda')?.status).toBe('pending')
  })

  it('leaves a second stall of the same file failed, so a bad file cannot loop', () => {
    service.queueDownloads([{ filename: 'bad.hda', size: 1_000_000 }])
    service.updateProgress('bad.hda', 10)
    service.noteTransferStall('bad.hda', 10, 1_000_000)
    service.retryFailed(true, true)
    service.updateProgress('bad.hda', 10)

    service.noteTransferStall('bad.hda', 10, 1_000_000)

    expect(item('bad.hda')?.status).toBe('failed')
    expect(item('bad.hda')?.error).toContain('a second time; use Retry')
    expect(service.retryFailed(true, true).count).toBe(0)
    // a manual retry still works
    expect(service.retryFailed(true, false).count).toBe(1)
  })

  it('ignores a stall for a file that is not downloading', () => {
    service.queueDownloads([{ filename: 'p.hda', size: 1024 }])
    service.noteTransferStall('p.hda', 0, 1024)
    expect(item('p.hda')?.status).toBe('pending')
    expect(() => service.noteTransferStall('missing.hda', 0, 1024)).not.toThrow()
  })

  it('markFailed reports that it applied for a real failure', () => {
    service.queueDownloads([{ filename: 'f.hda', size: 1024 }])
    service.updateProgress('f.hda', 10)
    expect(service.markFailed('f.hda', 'USB transfer failed')).toBe(true)
    expect(item('f.hda')?.status).toBe('failed')
  })
})
