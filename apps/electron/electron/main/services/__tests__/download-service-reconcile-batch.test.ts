/**
 * Device file-list reconcile — batching and transaction tests
 *
 * A full device reconcile hands getFilesToSync 2,000+ files at once. It used
 * to run the whole loop as per-statement auto-commits with 4 purge SELECTs
 * per file, all synchronously on the Electron main thread — the app froze for
 * the whole reconcile (owner report, 27-sep-2026, 2,139 device files).
 *
 * These tests pin the fix:
 * - the sync entry point wraps the whole snapshot in ONE transaction;
 * - the IPC entry point (getFilesToSyncBatched) works in chunks of batchSize
 *   with a setImmediate yield between chunks, one transaction per chunk;
 * - both variants return identical results;
 * - purge tombstones are loaded ONCE per reconcile (getPurgedFilenames),
 *   never per file (isFilePurged).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  send: vi.fn(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (...args: unknown[]) => void } }>
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => electronMocks.windows) },
  ipcMain: { handle: vi.fn() },
  Notification: vi.fn(() => ({ show: vi.fn() }))
}))

const mockRunInTransaction = vi.fn((fn: () => void) => fn())
const mockGetPurgedFilenames = vi.fn((): string[] => [])
const mockIsFilePurged = vi.fn((_filename: string) => false)
const mockExistsSync = vi.fn((_p: string) => false)

vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(),
  addSyncedFile: vi.fn(),
  isFileSynced: () => false,
  getSyncedFile: () => undefined,
  removeSyncedFile: vi.fn(),
  isFilePurged: (filename: string) => mockIsFilePurged(filename),
  getPurgedFilenames: () => mockGetPurgedFilenames(),
  getRecordingByFilename: vi.fn(() => null),
  upsertRecordingFromDevice: vi.fn((file: DeviceFile) => ({
    id: `id:${file.filename}`,
    filename: file.filename,
    original_filename: file.filename,
    file_path: null,
    file_size: file.size,
    duration_seconds: file.duration,
    date_recorded: file.dateCreated.toISOString(),
    status: 'none',
    location: 'device-only',
    transcription_status: 'none',
    on_device: 1,
    on_local: 0,
    source: 'hidock',
    is_imported: 0,
    created_at: file.dateCreated.toISOString()
  })),
  enrichRecordingScheduleMetadata: vi.fn(),
  createProcessingRun: vi.fn(() => ({ id: 'metadata-run' })),
  completeProcessingRun: vi.fn(),
  getSyncedFilenames: vi.fn(() => new Set()),
  queryOne: vi.fn(() => null),
  queryAll: vi.fn(() => []),
  run: vi.fn(),
  runInTransaction: (fn: () => void) => mockRunInTransaction(fn),
  getDatabase: vi.fn(() => ({ exec: vi.fn(() => []), run: vi.fn() }))
}))

vi.mock('../file-storage', () => ({
  saveRecording: vi.fn().mockResolvedValue('/mock/path/file.wav'),
  getRecordingsPath: vi.fn(() => '/mock/recordings')
}))

vi.mock('../activity-log', () => ({
  emitActivityLog: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: (p: string) => mockExistsSync(p) },
    existsSync: (p: string) => mockExistsSync(p)
  }
})

import { getDownloadService } from '../download-service'

type DeviceFile = { filename: string; size: number; duration: number; dateCreated: Date }

function makeFiles(n: number): DeviceFile[] {
  return Array.from({ length: n }, (_, i) => ({
    filename: `rec_${String(i).padStart(4, '0')}.hda`,
    size: 1024,
    duration: 10,
    dateCreated: new Date(0)
  }))
}

describe('device file-list reconcile: one transaction, batched yields, hoisted tombstones', () => {
  let service: ReturnType<typeof getDownloadService>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockGetPurgedFilenames.mockReturnValue([])
    electronMocks.windows = []
    service = getDownloadService()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('getFilesToSync wraps the whole snapshot in exactly ONE transaction', () => {
    const results = service.getFilesToSync(makeFiles(250))

    expect(results).toHaveLength(250)
    expect(mockRunInTransaction).toHaveBeenCalledTimes(1)
  })

  it('getFilesToSyncBatched commits once per chunk and yields between chunks', async () => {
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')

    const results = await service.getFilesToSyncBatched(makeFiles(250), 100)

    expect(results).toHaveLength(250)
    // 250 files / 100 per chunk = 3 chunks => 3 transactions, 2 yields.
    expect(mockRunInTransaction).toHaveBeenCalledTimes(3)
    expect(immediateSpy).toHaveBeenCalledTimes(2)

    immediateSpy.mockRestore()
  })

  it('getFilesToSyncBatched with a single chunk does not yield at all', async () => {
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')

    const results = await service.getFilesToSyncBatched(makeFiles(100), 100)

    expect(results).toHaveLength(100)
    expect(mockRunInTransaction).toHaveBeenCalledTimes(1)
    expect(immediateSpy).not.toHaveBeenCalled()

    immediateSpy.mockRestore()
  })

  it('batched and sync variants return identical results in the same order', async () => {
    const files = makeFiles(2139)

    const syncResults = service.getFilesToSync(files)
    vi.clearAllMocks()
    const batchedResults = await service.getFilesToSyncBatched(files, 100)

    expect(batchedResults).toHaveLength(syncResults.length)
    expect(batchedResults.map((r) => r.filename)).toEqual(syncResults.map((r) => r.filename))
    expect(batchedResults.map((r) => r.skipReason)).toEqual(syncResults.map((r) => r.skipReason))
    // One summary line per reconcile, same counters for both variants.
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('loads purge tombstones once per reconcile, never per file', () => {
    mockGetPurgedFilenames.mockReturnValue(['rec_0001.wav'])

    const results = service.getFilesToSync(makeFiles(200))

    expect(mockGetPurgedFilenames).toHaveBeenCalledTimes(1)
    expect(mockIsFilePurged).not.toHaveBeenCalled()
    // rec_0001.hda has a .wav tombstone — variant matching still applies.
    const tombstoned = results.find((r) => r.filename === 'rec_0001.hda')
    expect(tombstoned?.skipReason).toContain('Permanently deleted')
    expect(results.filter((r) => !r.skipReason)).toHaveLength(199)
  })

  it('batched reconcile still emits one coalesced recording:new per snapshot', async () => {
    electronMocks.windows = [{
      isDestroyed: () => false,
      webContents: { send: electronMocks.send }
    }]

    await service.getFilesToSyncBatched(makeFiles(500), 100)

    expect(electronMocks.send).toHaveBeenCalledTimes(1)
    expect(electronMocks.send).toHaveBeenCalledWith(
      'recording:new',
      expect.objectContaining({ count: 500 })
    )
  })
})
