/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

const env = vi.hoisted(() => ({ root: '', db: null as InstanceType<typeof Database> | null, intents: new Set<string>() }))
vi.mock('electron', () => ({ app: { getPath: () => env.root }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() }, Notification: vi.fn() }))
// The queue queries and mutations below execute against an actual on-disk SQLite
// file. Unrelated ingestion/provider functions are deliberately outside this test.
vi.mock('../database', () => ({
  queryOne: (sql: string, params: unknown[] = []) => env.db!.prepare(sql).get(...params),
  queryAll: (sql: string, params: unknown[] = []) => env.db!.prepare(sql).all(...params),
  run: (sql: string, params: unknown[] = []) => env.db!.prepare(sql).run(...params),
  runInTransaction: (fn: () => void) => env.db!.transaction(fn)(),
  getSyncedFile: () => undefined, getRecordingByFilename: () => undefined,
  getSyncedFilenames: () => new Set(), getPurgedFilenames: () => [],
  isFilePurged: () => false, removeSyncedFile: vi.fn(), addSyncedFile: vi.fn(),
  markRecordingDownloaded: vi.fn(), clearPurgeTombstones: vi.fn(), upsertRecordingFromDevice: vi.fn(),
  enrichRecordingScheduleMetadata: vi.fn(), createProcessingRun: vi.fn(), completeProcessingRun: vi.fn(), remeasureRecordingDuration: vi.fn()
}))
vi.mock('../file-storage', () => ({ getRecordingsPath: () => env.root, saveRecording: vi.fn(), replaceRecordingFile: vi.fn() }))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../transcription', () => ({ queueTranscriptionIfEnabled: vi.fn() }))
vi.mock('../audio-profile-store', () => ({ profileNewRecording: vi.fn() }))
vi.mock('../storage-usage', () => ({ resetStorageLimitCache: vi.fn() }))
vi.mock('../download-transfer-controller', () => ({
  hasTransferIntent: (name: string) => env.intents.has(name), getActiveTransferFilename: () => null,
  cancelActiveTransferByName: vi.fn(), cancelAllTransfers: vi.fn()
}))
import { DownloadService } from '../download-service'

let service: DownloadService
const recorded = '2026-09-01T12:34:56.000Z'
const created = '2026-09-01T12:35:00.000Z'
function seed(filename: string, status = 'pending', id = `saved-${filename}`): void {
  env.db!.prepare('INSERT INTO download_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, filename, 2239500, 47, status, 'Old interrupted diagnostic', recorded, null, recorded, status === 'cancelled' ? 'user' : null, created)
}
function rows(): unknown[] { return env.db!.prepare('SELECT * FROM download_queue ORDER BY id').all() }
beforeEach(() => {
  env.root = mkdtempSync(join(tmpdir(), 'passive-download-restart-'))
  env.db = new Database(join(env.root, 'queue.sqlite'))
  env.db.exec(`CREATE TABLE download_queue (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, file_size INTEGER, progress REAL, status TEXT,
    error TEXT, started_at TEXT, completed_at TEXT, recording_date TEXT, cancel_reason TEXT, created_at TEXT)`)
  env.intents.clear()
  seed('unrelated-pending.hda'); seed('unrelated-downloading.hda', 'downloading');
  seed('unrelated-cancelled.hda', 'cancelled'); seed('unrelated-failed.hda', 'failed')
  service = new DownloadService({ passive: true })
})
afterEach(() => {
  service.destroy(); env.db!.close(); env.db = null
  expect(dirname(env.root)).toBe(resolve(tmpdir()))
  rmSync(env.root, { recursive: true, force: true })
})

describe('passive restart: only explicitly requested queue rows recover', () => {
  it.each(['pending', 'downloading'])('recovers the selected %s row, preserving identity/date and all unrelated rows', status => {
    seed('selected.hda', status, 'prior-session-row-id')
    const before = rows()
    expect(service.getState().queue).toEqual([])
    env.db!.close()
    env.db = new Database(join(env.root, 'queue.sqlite')) // Durable readback after reopening.
    const restarted = new DownloadService({ passive: true })
    service.destroy(); service = restarted
    expect(rows()).toEqual(before) // No load/reset/prune, even for old rows.
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true)).toEqual({ queued: ['selected.hda'], skipped: [] })
    expect(service.getState().queue).toHaveLength(1)
    expect(service.getState().queue[0]).toMatchObject({ id: 'prior-session-row-id', filename: 'selected.hda', status: 'pending', progress: 0, explicitDownload: true, fromPreviousSession: true, recordingDate: new Date(recorded), createdAt: new Date(created) })
    expect(service.getState().queue[0].error).toBeUndefined()
    expect(service.beginDownload('selected.hda')).toBe(true)
    const selected = env.db!.prepare('SELECT * FROM download_queue WHERE id = ?').get('prior-session-row-id')
    expect(selected).toMatchObject({ status: 'downloading', recording_date: recorded, created_at: created, error: null, cancel_reason: null })
    expect(rows().filter(row => (row as { id: string }).id !== 'prior-session-row-id')).toEqual(before.filter(row => (row as { id: string }).id !== 'prior-session-row-id'))
  })
  it('keeps an automatic request deferred without recovering any persisted backlog', () => {
    seed('selected.hda', 'downloading')
    const before = rows()
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }]).skipped[0].skip).toBe('already-queued')
    expect(service.getState().queue).toEqual([])
    expect(service.beginDownload('selected.hda')).toBe(false)
    expect(rows()).toEqual(before)
  })
  it('does not recover a row with an actual transfer intent owned elsewhere', () => {
    seed('selected.hda', 'downloading'); env.intents.add('selected.hda')
    const before = rows()
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true).skipped[0].skip).toBe('already-queued')
    expect(service.getState().queue).toEqual([])
    expect(rows()).toEqual(before)
  })
  it('never resets a live in-memory download on a duplicate explicit request', () => {
    seed('selected.hda')
    service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true)
    service.beginDownload('selected.hda'); service.updateProgress('selected.hda', 1120000)
    const before = rows(), progress = service.getState().queue[0].progress
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true).skipped[0].skip).toBe('already-queued')
    expect(service.getState().queue[0].progress).toBe(progress)
    expect(rows()).toEqual(before)
  })
  it('checks actual local publication before recovering a stale pending row', () => {
    seed('selected.hda'); writeFileSync(join(env.root, 'selected.mp3'), Buffer.from('local published file'))
    const before = rows()
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true).skipped[0].skip).toBe('already-synced')
    expect(service.getState().queue).toEqual([])
    expect(rows()).toEqual(before)
  })
  it('reuses a normalized legacy row ID while downloading the actual requested device name', () => {
    seed('selected.mp3', 'downloading', 'legacy-row-id')
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true).queued).toEqual(['selected.hda'])
    expect(service.getState().queue[0]).toMatchObject({ id: 'legacy-row-id', filename: 'selected.hda', recordingDate: new Date(recorded) })
    expect(env.db!.prepare('SELECT filename FROM download_queue WHERE id = ?').get('legacy-row-id')).toEqual({ filename: 'selected.hda' })
    expect(service.beginDownload('selected.hda')).toBe(true)
  })
  it('preserves normal cancellation suppression after a requested restart recovery', async () => {
    seed('selected.hda', 'downloading', 'prior-session-row-id')
    service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true)
    expect(await service.cancelDownload('selected.hda')).toEqual({ success: true })
    expect(env.db!.prepare('SELECT status, cancel_reason FROM download_queue WHERE id = ?').get('prior-session-row-id')).toEqual({ status: 'cancelled', cancel_reason: 'user' })
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }]).skipped[0].skip).toBe('user-cancelled')
    expect(service.beginDownload('selected.hda')).toBe(false)
    expect(service.queueDownloads([{ filename: 'selected.hda', size: 2239500 }], true).queued).toEqual(['selected.hda'])
    expect(service.beginDownload('selected.hda')).toBe(true)
  })
})
