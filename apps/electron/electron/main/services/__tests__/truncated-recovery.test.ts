// @vitest-environment node

/**
 * Truncated-download recovery (2026-09-22), against a real better-sqlite3
 * database, real audio files on disk, and the real download queue.
 *
 * The backfill found 47 recordings in the owner's library whose transcript
 * runs past the end of the local file. These tests pin down which of them get
 * fetched again and, above all, that a failed fetch never costs the owner the
 * short file they still have.
 *
 * Every audio fixture is built here as MPEG-2 Layer III, which is what the
 * device writes even under a .wav or .hda name. The length is read from the
 * bytes by readAudioDuration, never from a WAV header.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '', dir: '' }))
paths.dir = mkdtempSync(join(tmpdir(), 'hidock-truncated-recovery-'))
paths.db = join(paths.dir, 'hidock.db')

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => paths.dir), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
}))

// file-storage is used for real (saveRecording, replaceRecordingFile); only
// where it looks for its folders comes from the test.
vi.mock('../config', () => ({
  getConfig: () => ({ storage: { recordingsPath: join(paths.dir, 'recordings') } }),
  getDataPath: () => paths.dir,
}))
vi.mock('../file-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../file-storage')>()),
  getDatabasePath: () => paths.db,
}))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryOne,
  runWithMassDeleteAllowed,
  backfillRecordingDurations,
  findTruncatedRecordings,
} from '../database'
import { planTruncatedRecovery, queueTruncatedRecovery } from '../truncated-recovery'
import { getDownloadService } from '../download-service'

// ---------------------------------------------------------------------------
// MPEG fixtures
// ---------------------------------------------------------------------------

/** MPEG-2 Layer III, 64 kbps, 16 kHz: the device's format. 288-byte frames, 8,000 bytes/s. */
const FRAME_64K = Buffer.from([0xff, 0xf3, 0x88, 0xc4])
const FRAME_64K_BYTES = 288

/** MPEG-2 Layer III, 128 kbps, 16 kHz. 576-byte frames, 16,000 bytes/s: more bytes, less time. */
const FRAME_128K = Buffer.from([0xff, 0xf3, 0xc8, 0xc4])
const FRAME_128K_BYTES = 576

function mpeg(frames: number, header = FRAME_64K, frameBytes = FRAME_64K_BYTES): Buffer {
  const out = Buffer.alloc(frames * frameBytes)
  for (let i = 0; i < frames; i++) header.copy(out, i * frameBytes)
  return out
}

/** The whole recording as the device holds it: 1,000 frames, 288,000 bytes, 36 s. */
const COMPLETE = mpeg(1000)
/** What the owner has on disk: the first 300 frames, 86,400 bytes, 10.8 s. */
const SHORT = COMPLETE.subarray(0, 300 * FRAME_64K_BYTES)

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const recordingsDir = join(paths.dir, 'recordings')

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
}

function ensureDeviceCacheTable(): void {
  // Created lazily by deviceCache:saveAll in the app; same DDL here.
  run(`CREATE TABLE IF NOT EXISTS device_file_cache (
         filename TEXT PRIMARY KEY, size INTEGER, duration REAL, dateCreated TEXT)`)
}

function wipe(): void {
  runWithMassDeleteAllowed(() => {
    for (const table of ['transcripts', 'download_queue', 'synced_files', 'device_file_cache', 'recordings']) {
      try {
        run(`DELETE FROM ${table}`)
      } catch {
        /* ignore */
      }
    }
  })
  // A fresh folder per test, so a leftover from one cannot pass the next.
  rmSync(recordingsDir, { recursive: true, force: true })
  mkdirSync(recordingsDir, { recursive: true })
}

/**
 * A downloaded recording whose file is the short copy and whose transcript
 * runs to 30 s, past the 10.8 s the file holds.
 */
function seedTruncated(id: string, base: string, date = '2026-01-01T10:00:00.000Z'): string {
  const filePath = join(recordingsDir, `${base}.wav`)
  writeFileSync(filePath, SHORT)
  run(
    `INSERT INTO recordings
       (id, filename, file_path, file_size, date_recorded, duration_seconds, status, location,
        transcription_status, on_device, on_local, source, is_imported, personal)
     VALUES (?, ?, ?, ?, ?, 30, 'none', 'both', 'complete', 1, 1, 'hidock', 0, 0)`,
    [id, `${base}.wav`, filePath, SHORT.length, date]
  )
  run(
    `INSERT INTO transcripts (id, recording_id, full_text, speakers, word_count) VALUES (?, ?, 'text', ?, 60)`,
    [`t-${id}`, id, JSON.stringify([{ start: 0, end: 12 }, { start: 12, end: 30 }])]
  )
  return filePath
}

function seedDeviceFile(filename: string, size: number, dateCreated = '2026-01-01T10:00:00.000Z'): void {
  run('INSERT INTO device_file_cache (filename, size, duration, dateCreated) VALUES (?, ?, 0, ?)', [
    filename,
    size,
    dateCreated,
  ])
}

function partialsIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.partial'))
}

// ---------------------------------------------------------------------------

describe('truncated-download recovery', () => {
  beforeAll(async () => {
    cleanupDbFiles()
    await initializeDatabase()
    ensureDeviceCacheTable()
  })

  afterAll(() => {
    getDownloadService().destroy()
    try {
      closeDatabase()
    } catch {
      /* ignore */
    }
    rmSync(paths.dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Drop whatever the singleton queue holds from the previous test.
    await getDownloadService().cancelAll().catch(() => undefined)
    getDownloadService().clearCompleted()
    for (const item of getDownloadService().getState().queue) getDownloadService().dismissTerminal(item.filename)
    wipe()
  })

  it('uses the backfill rule: the fixture is truncated to both of them', () => {
    seedTruncated('rec-rule', '2026Jan01-100000-Rec01')

    expect(findTruncatedRecordings().map((r) => r.id)).toEqual(['rec-rule'])
    expect(backfillRecordingDurations().truncated).toBe(1)
  })

  it('queues a truncated recording whose device copy is larger', () => {
    seedTruncated('rec-larger', '2026Jan01-100000-Rec02')
    seedDeviceFile('2026Jan01-100000-Rec02.hda', COMPLETE.length)

    const result = queueTruncatedRecovery(null)

    expect(result.queued).toEqual(['2026Jan01-100000-Rec02.hda'])
    expect(result.plan.recoverable).toHaveLength(1)
    const item = getDownloadService().getState().queue.find((q) => q.filename === '2026Jan01-100000-Rec02.hda')
    expect(item?.status).toBe('pending')
    expect(item?.fileSize).toBe(COMPLETE.length)
  })

  it('does not queue a truncated recording whose device copy is the same size', () => {
    seedTruncated('rec-same', '2026Jan01-100000-Rec03')
    seedDeviceFile('2026Jan01-100000-Rec03.hda', SHORT.length)

    const result = queueTruncatedRecovery(null)

    expect(result.queued).toEqual([])
    expect(result.plan.deviceNotLarger).toBe(1)
    expect(getDownloadService().getState().queue).toHaveLength(0)
  })

  it('does not queue a truncated recording whose device copy is smaller', () => {
    seedTruncated('rec-smaller', '2026Jan01-100000-Rec04')
    seedDeviceFile('2026Jan01-100000-Rec04.hda', SHORT.length - 1000)

    const result = queueTruncatedRecovery(null)

    expect(result.queued).toEqual([])
    expect(result.plan.deviceNotLarger).toBe(1)
  })

  it('counts a truncated recording the device no longer has as unrecoverable, and queues nothing', () => {
    const filePath = seedTruncated('rec-gone', '2026Jan01-100000-Rec05')
    seedDeviceFile('2026Jan01-110000-Rec06.hda', COMPLETE.length) // some other file

    const result = queueTruncatedRecovery(null)

    expect(result.queued).toEqual([])
    expect(result.plan.notOnDevice).toBe(1)
    expect(result.plan.deviceListKnown).toBe(true)
    // Honest, and nothing destructive: the file and its stored length stay.
    expect(readFileSync(filePath).equals(SHORT)).toBe(true)
    expect(queryOne<{ duration_seconds: number }>('SELECT duration_seconds FROM recordings WHERE id = ?', ['rec-gone'])?.duration_seconds).toBe(30)
  })

  it('never queues the file the device is recording right now', () => {
    seedTruncated('rec-live', '2026Jan01-100000-Rec07')
    seedDeviceFile('2026Jan01-100000-Rec07.hda', COMPLETE.length)

    const result = queueTruncatedRecovery('2026Jan01-100000-Rec07.hda')

    expect(result.queued).toEqual([])
    expect(result.plan.heldBack).toBe(1)
  })

  it('holds back the newest device file while the recording state is unknown', () => {
    seedTruncated('rec-old', '2026Jan01-100000-Rec08')
    seedTruncated('rec-newest', '2026Jan02-100000-Rec09', '2026-01-02T10:00:00.000Z')
    seedDeviceFile('2026Jan01-100000-Rec08.hda', COMPLETE.length, '2026-01-01T10:00:00.000Z')
    seedDeviceFile('2026Jan02-100000-Rec09.hda', COMPLETE.length, '2026-01-02T10:00:00.000Z')

    const plan = planTruncatedRecovery(undefined)

    expect(plan.recoverable.map((r) => r.deviceFilename)).toEqual(['2026Jan01-100000-Rec08.hda'])
    expect(plan.heldBack).toBe(1)
  })

  describe('a failed re-download leaves the local file alone', () => {
    it('when the transfer comes back the wrong size', async () => {
      const filePath = seedTruncated('rec-cut', '2026Jan01-100000-Rec10')
      seedDeviceFile('2026Jan01-100000-Rec10.hda', COMPLETE.length)
      queueTruncatedRecovery(null)

      const result = await getDownloadService().processDownload(
        '2026Jan01-100000-Rec10.hda',
        COMPLETE.subarray(0, 500 * FRAME_64K_BYTES)
      )

      expect(result.success).toBe(false)
      expect(readFileSync(filePath).equals(SHORT)).toBe(true)
      expect(partialsIn(recordingsDir)).toEqual([])
      expect(findTruncatedRecordings().map((r) => r.id)).toEqual(['rec-cut'])
    })

    it('when the new copy is larger but holds less audio', async () => {
      const filePath = seedTruncated('rec-worse', '2026Jan01-100000-Rec11')
      // 200 frames at 128 kbps: 115,200 bytes (more than the 86,400 on disk) but 7.2 s.
      const worse = mpeg(200, FRAME_128K, FRAME_128K_BYTES)
      seedDeviceFile('2026Jan01-100000-Rec11.hda', worse.length)
      queueTruncatedRecovery(null)

      const result = await getDownloadService().processDownload('2026Jan01-100000-Rec11.hda', worse)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/no more than/)
      expect(readFileSync(filePath).equals(SHORT)).toBe(true)
      expect(partialsIn(recordingsDir)).toEqual([])
      const item = getDownloadService().getState().queue.find((q) => q.filename === '2026Jan01-100000-Rec11.hda')
      expect(item?.status).toBe('failed')
    })

    it('when the download is cancelled after the bytes arrive', async () => {
      const filePath = seedTruncated('rec-cancel', '2026Jan01-100000-Rec12')
      seedDeviceFile('2026Jan01-100000-Rec12.hda', COMPLETE.length)
      queueTruncatedRecovery(null)
      await getDownloadService().cancelDownload('2026Jan01-100000-Rec12.hda')

      const result = await getDownloadService().processDownload('2026Jan01-100000-Rec12.hda', COMPLETE)

      expect(result.success).toBe(false)
      expect(readFileSync(filePath).equals(SHORT)).toBe(true)
      expect(partialsIn(recordingsDir)).toEqual([])
    })
  })

  it('replaces the file in place on success and lets the backfill rule settle the row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const filePath = seedTruncated('rec-ok', '2026Jan01-100000-Rec13')
      seedDeviceFile('2026Jan01-100000-Rec13.hda', COMPLETE.length)
      queueTruncatedRecovery(null)

      const result = await getDownloadService().processDownload('2026Jan01-100000-Rec13.hda', COMPLETE)

      expect(result).toEqual({ success: true, filePath })
      // Same path, complete bytes, no suffixed duplicate, no leftovers.
      expect(readFileSync(filePath).equals(COMPLETE)).toBe(true)
      expect(readdirSync(recordingsDir).sort()).toEqual(['2026Jan01-100000-Rec13.wav'])
      const row = queryOne<{ duration_seconds: number; duration_source: string; file_size: number }>(
        'SELECT duration_seconds, duration_source, file_size FROM recordings WHERE id = ?',
        ['rec-ok']
      )
      expect(row).toEqual({ duration_seconds: 36, duration_source: 'file', file_size: COMPLETE.length })
      expect(findTruncatedRecordings()).toEqual([])
      vi.runAllTimers()
    } finally {
      vi.useRealTimers()
    }
  })
})
