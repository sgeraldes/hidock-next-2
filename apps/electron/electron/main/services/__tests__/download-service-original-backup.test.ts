/**
 * Wiring of original-backup receipts in DownloadService.
 *
 * LABEL: the transfers below hold a genuine main-owned resume lease (downloadWithResume, real staged
 * file IO, real host SHA-256) produced from a clearly SYNTHETIC in-memory ResumeAdapter. That proves the
 * host-side ordering and ownership rules. It is NOT real device provenance and no physical download happened.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') }, BrowserWindow: { getAllWindows: vi.fn(() => []) }, ipcMain: { handle: vi.fn() },
  Notification: class { static isSupported() { return false } show() { /* none */ } }
}))
const order: string[] = []
vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(() => { order.push('row'); return 'resolved-recording-id' }),
  addSyncedFile: vi.fn(), isFileSynced: vi.fn(() => false), getSyncedFile: vi.fn(() => undefined), removeSyncedFile: vi.fn(),
  isFilePurged: () => false, getPurgedFilenames: () => [], getRecordingByFilename: vi.fn(() => null), getSyncedFilenames: vi.fn(() => new Set()),
  queryOne: vi.fn(() => null), queryAll: vi.fn(() => []), run: vi.fn(), remeasureRecordingDuration: vi.fn(() => null),
  runInTransaction: vi.fn((fn: () => void) => fn()), getDatabase: vi.fn(() => ({ exec: vi.fn(() => []), run: vi.fn() }))
}))
let recordingsDir = ''
vi.mock('../file-storage', () => ({
  saveRecording: vi.fn(async () => { order.push('publish'); return '/mock/recordings/published.wav' }),
  replaceRecordingFile: vi.fn(async (_path: string, data: { length: number }) => { order.push('publish'); return { filePath: '/mock/recordings/published.wav', previousBytes: 1, bytes: data.length, seconds: 1 } }),
  getRecordingsPath: vi.fn(() => recordingsDir)
}))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn(async () => undefined) }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  const overrides = { existsSync: vi.fn((path: unknown) => String(path) === recordingsDir) }
  return { ...actual, default: { ...actual, ...overrides }, ...overrides }
})

import { DownloadService } from '../download-service'
import { downloadWithResume, releaseResumedDownload } from '../download-resume'
import type { ResumeSource } from '../download-resume'
import { registerHostDownloadTransfer } from '../original-recording-backups'
import type { OriginalRecordingBackupStore } from '../original-recording-backups'
import { saveRecording } from '../file-storage'

const folders: string[] = []
let service: DownloadService
const recorded = vi.fn((_input: unknown) => { order.push('receipt'); return {} })
const store = { recordHostDownload: recorded } as unknown as OriginalRecordingBackupStore
const NAME = '2026Oct12-111955-Rec83.hda'
beforeEach(() => {
  vi.clearAllMocks(); order.length = 0
  const folder = mkdtempSync(join(tmpdir(), 'hidock-dl-backup-')); folders.push(folder); recordingsDir = join(folder, 'Recordings'); mkdirSync(recordingsDir)
  service = new DownloadService(); service.useOriginalBackupStore(store)
})
afterEach(() => {
  service.destroy()
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('hidock-dl-backup-')) throw Error('Unsafe fixture cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
async function ownedTransfer(bytes: Buffer, register = true) {
  const expected: ResumeSource = { deviceId: 'd'.repeat(64), sessionId: 's', model: 'hidock-h1e', firmware: '393988:6.3.4', filename: NAME, size: bytes.length,
    signature: 'c'.repeat(32), listingComplete: true, completed: true }
  const staged = await downloadWithResume({ directory: recordingsDir, expected, adapter: { snapshot: async () => expected,
    readRange: async (_n, _s, offset, count, onChunk) => { onChunk(bytes.subarray(offset, offset + count)); return { status: 'complete', offset, count, received: count, reason: null } } } })
  if (register) expect(registerHostDownloadTransfer(staged, expected)).toBe(true)
  return staged
}

describe('DownloadService original-backup receipts (synthetic transport, real host IO)', () => {
  it('stores the receipt only after publication and row resolution, with the received-stream evidence', async () => {
    const bytes = Buffer.from('synthetic-transfer-bytes'), staged = await ownedTransfer(bytes)
    try {
      service.queueDownloads([{ filename: NAME, size: bytes.length }], true)
      expect((await service.processDownload(NAME, staged)).success).toBe(true)
      expect(order).toEqual(['publish', 'row', 'receipt'])
      expect(recorded).toHaveBeenCalledTimes(1)
      expect(recorded.mock.calls[0][0]).toMatchObject({ recordingId: 'resolved-recording-id', publishedPath: '/mock/recordings/published.wav',
        transfer: { originalFilename: NAME, totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })
    } finally { releaseResumedDownload(staged) }
  })

  it('an owned transfer that was never registered publishes without a receipt', async () => {
    const bytes = Buffer.from('owned-but-unregistered-1'), staged = await ownedTransfer(bytes, false)
    try {
      service.queueDownloads([{ filename: NAME, size: bytes.length }], true)
      expect((await service.processDownload(NAME, staged)).success).toBe(true)
      expect(recorded).not.toHaveBeenCalled(); expect(saveRecording).toHaveBeenCalledTimes(1)
    } finally { releaseResumedDownload(staged) }
  })

  it('the legacy renderer Buffer route is explicitly unreceipted and never promoted', async () => {
    service.queueDownloads([{ filename: NAME, size: 3 }], true)
    expect((await service.processDownload(NAME, Buffer.from('abc'))).success).toBe(true)
    expect(recorded).not.toHaveBeenCalled()
  })

  it('a cancelled save writes no receipt', async () => {
    const bytes = Buffer.from('cancelled-save-bytes-001'), staged = await ownedTransfer(bytes)
    try {
      service.queueDownloads([{ filename: NAME, size: bytes.length }], true)
      vi.mocked(saveRecording).mockResolvedValueOnce(null as unknown as string)
      expect((await service.processDownload(NAME, staged)).success).toBe(false)
      expect(recorded).not.toHaveBeenCalled()
    } finally { releaseResumedDownload(staged) }
  })

  it('a receipt write failure never fails the download that is already published', async () => {
    const bytes = Buffer.from('receipt-write-fails-0001'), staged = await ownedTransfer(bytes)
    try {
      service.queueDownloads([{ filename: NAME, size: bytes.length }], true)
      recorded.mockImplementationOnce(() => { throw new Error('disk full') })
      expect((await service.processDownload(NAME, staged)).success).toBe(true)
    } finally { releaseResumedDownload(staged) }
  })

  it('a replacement with transfer proof publishes a receipt for the replaced recording; a Buffer replacement does not', async () => {
    const bytes = Buffer.from('replacement-transfer-bytes'), staged = await ownedTransfer(bytes)
    try {
      service.queueDownloads([{ filename: NAME, size: bytes.length, replaces: { path: '/mock/recordings/old.wav', recordingId: 'existing-recording' } }], true)
      expect((await service.processDownload(NAME, staged)).success).toBe(true)
      expect(recorded).toHaveBeenCalledTimes(1)
      expect(recorded.mock.calls[0][0]).toMatchObject({ recordingId: 'existing-recording', publishedPath: '/mock/recordings/published.wav' })
    } finally { releaseResumedDownload(staged) }
    recorded.mockClear()
    service.queueDownloads([{ filename: 'Other-Rec01.hda', size: 3, replaces: { path: '/mock/recordings/old2.wav', recordingId: 'existing-2' } }], true)
    expect((await service.processDownload('Other-Rec01.hda', Buffer.from('abc'))).success).toBe(true)
    expect(recorded).not.toHaveBeenCalled()
  })
})
