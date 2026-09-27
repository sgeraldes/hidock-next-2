// @vitest-environment node

/**
 * Download queue pause/resume — DownloadService state tests.
 *
 * The queue-level pause mirrors the transcription queue's pauseQueue: pause()
 * stops NEW downloads from starting (the in-flight one finishes), resume()
 * re-arms the drain. Covers:
 *  - pause/resume flip the durable getState().isPaused flag and are idempotent
 *  - cancelAll does NOT leave the queue paused (cancel empties the queue; that
 *    already stops the loop — pausing here would block all future downloads)
 *  - only a MANUAL retry (interruptedOnly=false) unpauses; the automatic
 *    reconnect retry must leave a deliberate pause alone
 *  - the pause/resume IPC channels are registered and drive the singleton
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockEmitActivityLog = vi.fn()
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  },
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

vi.mock('../activity-log', () => ({ emitActivityLog: (...args: unknown[]) => mockEmitActivityLog(...args) }))

vi.mock('../download-transfer-controller', () => ({
  getActiveTransferFilename: () => null,
  cancelActiveTransferByName: vi.fn(() => Promise.resolve(true)),
  cancelActiveTransfer: vi.fn(() => Promise.resolve(true)),
}))

// existsSync → false so isFileAlreadySynced never treats a queued file as synced.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const overrides = { existsSync: vi.fn(() => false), mkdirSync: vi.fn() }
  return { ...actual, default: { ...actual, ...overrides }, ...overrides }
})

import { DownloadService, registerDownloadServiceHandlers, getDownloadService } from '../download-service'

describe('DownloadService — queue pause/resume', () => {
  let service: DownloadService

  beforeEach(() => {
    vi.clearAllMocks()
    // Fresh instance per test (simulates a clean process) — avoids singleton bleed.
    service = new DownloadService()
  })

  afterEach(() => {
    service.destroy() // stop the periodic timers so they don't leak across tests
  })

  it('starts unpaused; pause() flips the flag and logs once', () => {
    expect(service.getState().isPaused).toBe(false)

    service.pause()
    expect(service.getState().isPaused).toBe(true)

    service.pause() // idempotent: no second activity entry
    expect(service.getState().isPaused).toBe(true)
    expect(mockEmitActivityLog.mock.calls.filter((c) => c[1] === 'Downloads paused')).toHaveLength(1)
  })

  it('resume() clears the flag and logs once', () => {
    service.pause()
    mockEmitActivityLog.mockClear()

    service.resume()
    expect(service.getState().isPaused).toBe(false)

    service.resume() // idempotent
    expect(mockEmitActivityLog.mock.calls.filter((c) => c[1] === 'Downloads resumed')).toHaveLength(1)
  })

  it('cancelAll does NOT leave the queue paused (cancel stops the loop by emptying it)', async () => {
    service.queueDownloads([{ filename: 'a.hda', size: 1024 }])

    await service.cancelAll()

    expect(service.getState().isPaused).toBe(false)
  })

  it('a MANUAL retryFailed unpauses the queue when it re-queues work', () => {
    service.queueDownloads([{ filename: 'a.hda', size: 1024 }])
    service.markFailed('a.hda', 'USB transfer failed')
    service.pause()

    const result = service.retryFailed(true, false)

    expect(result.count).toBe(1)
    expect(service.getState().isPaused).toBe(false)
    expect(service.getState().queue.find((i) => i.filename === 'a.hda')?.status).toBe('pending')
  })

  it('the AUTOMATIC reconnect retry (interruptedOnly) keeps a deliberate pause', () => {
    service.queueDownloads([{ filename: 'a.hda', size: 1024 }])
    service.updateProgress('a.hda', 100) // pending → downloading
    service.cancelActiveDownloads('Device disconnected', 'interrupted')
    service.pause()

    const result = service.retryFailed(true, true)

    expect(result.count).toBe(1) // the interrupted item IS re-queued…
    expect(service.getState().queue.find((i) => i.filename === 'a.hda')?.status).toBe('pending')
    expect(service.getState().isPaused).toBe(true) // …but the queue stays paused
  })

  it('registers download-service:pause / resume IPC handlers that drive the singleton', () => {
    registerDownloadServiceHandlers()

    const pauseHandler = ipcHandlers.get('download-service:pause')
    const resumeHandler = ipcHandlers.get('download-service:resume')
    expect(pauseHandler).toBeTypeOf('function')
    expect(resumeHandler).toBeTypeOf('function')

    const singleton = getDownloadService()
    try {
      pauseHandler!(null)
      expect(singleton.getState().isPaused).toBe(true)
      resumeHandler!(null)
      expect(singleton.getState().isPaused).toBe(false)
    } finally {
      singleton.destroy()
    }
  })
})
