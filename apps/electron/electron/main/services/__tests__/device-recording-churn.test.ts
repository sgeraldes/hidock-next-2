// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

let sequence = 0
let dbPath: string
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath, getRecordingsPath: () => tmpdir() }))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  Notification: vi.fn()
}))

import {
  closeDatabase, getRecordingByFilename, initializeDatabase, markRecordingsNotOnDevice,
  queryAll, queryOne, run, upsertRecordingFromDevice
} from '../database'
import { mergeDuplicateRecordings, mergeDuplicateRecordingsYielding } from '../org-reconciler'
import { getIntegrityService } from '../integrity-service'
import { setDeviceConnectionReader } from '../device-snapshot'
import { getDownloadService } from '../download-service'

const names = ['2026May28-103745-Rec24', '2026Jun01-115550-Rec39', '2026Oct01-100436-Rec02']
const snapshot = (filename: string) => ({ filename, size: 1234, duration: 60, dateCreated: new Date('2026-05-28T10:37:45Z') })
const rows = () => queryAll<{ id: string; filename: string; on_device: number; location: string }>('SELECT * FROM recordings ORDER BY id')

beforeEach(async () => {
  setDeviceConnectionReader(() => false)
  dbPath = join(tmpdir(), `hidock-device-churn-${process.pid}-${++sequence}.sqlite`)
  await initializeDatabase()
})
afterEach(() => { getDownloadService().destroy(); closeDatabase() })

describe('device recording identity and offline retention (real SQLite)', () => {
  it('persists absence only after complete current reconciliation including deletion of the final device file', async () => {
    const rec = upsertRecordingFromDevice(snapshot(`${names[0]}.hda`))
    const service = getDownloadService()
    await service.getFilesToSyncBatched([], 100, { isCurrent: () => true, complete: false })
    expect(rows()[0].on_device).toBe(1)
    await expect(service.getFilesToSyncBatched([], 100, { isCurrent: () => false, complete: true })).rejects.toThrow('snapshot')
    expect(rows()[0].on_device).toBe(1)
    await service.getFilesToSyncBatched([], 100, { isCurrent: () => true, complete: true })
    closeDatabase()
    await initializeDatabase()
    expect(rows()).toEqual([expect.objectContaining({ id: rec.id, on_device: 0, location: 'deleted' })])
  })
  it('never adopts an external full-stem import over the exact device identity', () => {
    const base = names[1]
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, on_local, on_device, source, is_imported, duration_seconds)
      VALUES ('external', ?, ?, '2026-10-01', 1, 0, 'external', 1, 300),
             ('exact', ?, ?, '2026-06-01', 0, 1, 'hidock', 0, 60)`,
    [`${base}.wav`, `${base}.wav`, `${base}.hda`, `${base}.hda`])
    expect(upsertRecordingFromDevice(snapshot(`${base}.hda`)).id).toBe('exact')
    expect(queryOne('SELECT original_filename, duration_seconds, on_device FROM recordings WHERE id = ?', ['external']))
      .toEqual({ original_filename: `${base}.wav`, duration_seconds: 300, on_device: 0 })
  })

  it('rejects an external Rec01 import without an exact device row', () => {
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, on_local, source, is_imported)
      VALUES ('external', 'Rec01.wav', 'Rec01.wav', '2026-10-01', 1, 'external', 1)`)
    expect(upsertRecordingFromDevice(snapshot('Rec01.hda')).id).not.toBe('external')
  })

  it('rejects ambiguous trusted variants and variants recorded on another date', () => {
    const base = names[1]
    run(`INSERT INTO recordings (id, filename, date_recorded, on_local)
      VALUES ('wav', ?, '2026-06-01', 1), ('mp3', ?, '2026-06-01', 1)`, [`${base}.wav`, `${base}.mp3`])
    expect(getRecordingByFilename(`${base}.hda`)).toBeUndefined()
    run("DELETE FROM recordings WHERE id = 'mp3'")
    run("UPDATE recordings SET date_recorded = '2026-10-01' WHERE id = 'wav'")
    expect(getRecordingByFilename(`${base}.hda`)).toBeUndefined()
  })

  it('does not merge local-only duplicate stems across dates or move their captures at boot', async () => {
    setDeviceConnectionReader(() => true)
    run(`INSERT INTO recordings (id, filename, date_recorded, on_device, on_local)
      VALUES ('wav', 'Rec01.wav', '2026-10-01', 0, 1), ('mp3', 'Rec01.mp3', '2026-10-05', 0, 1)`)
    run(`INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id)
      VALUES ('capture', 'My take', '2026-10-05', 'mp3')`)
    expect(mergeDuplicateRecordings()).toBe(0)
    expect(await mergeDuplicateRecordingsYielding()).toBe(0)
    expect(rows()).toHaveLength(2)
    expect(queryOne('SELECT source_recording_id FROM knowledge_captures WHERE id = ?', ['capture']))
      .toEqual({ source_recording_id: 'mp3' })
  })

  it('applies a confirmed empty snapshot without removing durable rows', () => {
    const rec = upsertRecordingFromDevice(snapshot(`${names[0]}.hda`))
    markRecordingsNotOnDevice([])
    expect(rows()).toEqual([expect.objectContaining({ id: rec.id, on_device: 0, location: 'deleted' })])
  })

  it('resolves the verified local canonical row while retaining the exact HDA shadow', () => {
    const base = names[1]
    run(`INSERT INTO recordings (id, filename, date_recorded, on_local, on_device)
      VALUES ('local', ?, '2026-06-01', 1, 1), ('shadow', ?, '2026-06-01', 0, 1)`, [`${base}.wav`, `${base}.hda`])
    run(`INSERT INTO knowledge_captures (id, title, user_title, captured_at, source_recording_id, quality_rating)
      VALUES ('capture', 'Title', 'Annotated take', '2026-06-01', 'local', 'valuable')`)
    expect(upsertRecordingFromDevice(snapshot(`${base}.hda`)).id).toBe('local')
    expect(rows()).toHaveLength(2)
    expect(queryOne('SELECT user_title, quality_rating, source_recording_id FROM knowledge_captures WHERE id = ?', ['capture']))
      .toEqual({ user_title: 'Annotated take', quality_rating: 'valuable', source_recording_id: 'local' })
  })

  it('does not merge known local-only rows while disconnected even on the same date', async () => {
    run(`INSERT INTO recordings (id, filename, date_recorded, on_device, on_local)
      VALUES ('wav', 'Rec01.wav', '2026-10-01', 0, 1), ('mp3', 'Rec01.mp3', '2026-10-01', 0, 1)`)
    expect(mergeDuplicateRecordings()).toBe(0)
    expect(await mergeDuplicateRecordingsYielding()).toBe(0)
    expect(rows()).toHaveLength(2)
  })
  it.each(names)('rediscovers %s.hda using the existing wav identity over repeated boots', async (base) => {
    const day = base.includes('May') ? '2026-05-28' : base.includes('Jun') ? '2026-06-01' : '2026-10-01'
    // Real legacy rows have original_filename = the local .wav, not NULL.
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, file_path, on_local, on_device, location)
      VALUES ('local', ?, ?, ?, ?, 1, 1, 'both')`, [`${base}.wav`, `${base}.wav`, day, join(tmpdir(), `${base}.wav`)])
    for (let pass = 0; pass < 3; pass++) {
      expect(getRecordingByFilename(`${base}.hda`)?.id).toBe('local')
      expect(upsertRecordingFromDevice(snapshot(`${base}.hda`)).id).toBe('local')
      expect(await mergeDuplicateRecordingsYielding()).toBe(0)
      closeDatabase()
      await initializeDatabase()
      expect(rows().map((r) => r.id)).toEqual(['local'])
    }
  })

  it('matches extension and case variants and authoritative original names, without date-only matching', () => {
    const base = names[0]
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, on_local)
      VALUES ('local', ?, ?, '2026-05-28', 1)`, [`${base}.WAV`, `${base}.WAV`])
    expect(upsertRecordingFromDevice(snapshot(`${base.toLowerCase()}.HDA`)).id).toBe('local')
    expect(getRecordingByFilename(`${base}.hda`)?.id).toBe('local')
    run("UPDATE recordings SET filename = 'renamed.wav', original_filename = ? WHERE id = 'local'", [`${base}.hda`])
    expect(upsertRecordingFromDevice(snapshot(`${base}.hda`)).id).toBe('local')
    expect(upsertRecordingFromDevice(snapshot('2026May28-103746-Rec25.hda')).id).not.toBe('local')
    expect(rows()).toHaveLength(2)
  })

  it('uses an original device name for a legacy saved date format and keeps distinct takes distinct', () => {
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, on_local)
      VALUES ('legacy', '2026-05-28_1037.wav', '2026May28-103745-Rec24.hda', '2026-05-28', 1)`)
    expect(upsertRecordingFromDevice(snapshot('2026May28-103745-Rec24.hda')).id).toBe('legacy')
    expect(upsertRecordingFromDevice(snapshot('2026May28-103746-Rec25.hda')).id).not.toBe('legacy')
    expect(upsertRecordingFromDevice(snapshot('HDA_20260528_103745.hda')).id).not.toBe('legacy')
    expect(rows()).toHaveLength(3)
  })

  it('retains a genuine device-only identity across repeated discovery and offline startup checks', async () => {
    const file = snapshot(`${names[1]}.hda`)
    const original = upsertRecordingFromDevice(file)
    for (let pass = 0; pass < 3; pass++) {
      await getIntegrityService().runStartupChecks()
      expect(await mergeDuplicateRecordingsYielding()).toBe(0)
      // Offline startup has no authoritative device snapshot.
      closeDatabase()
      await initializeDatabase()
      expect(upsertRecordingFromDevice(file).id).toBe(original.id)
      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toMatchObject({ id: original.id, on_device: 1, location: 'device-only' })
    }
  })

  it('keeps a legacy device-only shadow and its user data during sync and yielding boot merges', async () => {
    const base = names[0]
    run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('meeting', 'User link', '2026-05-28', '2026-05-29')`)
    run(`INSERT INTO recordings (id, filename, date_recorded, on_local, file_path)
      VALUES ('local', ?, '2026-05-28', 1, ?)`, [`${base}.wav`, join(tmpdir(), `${base}.wav`)])
    run(`INSERT INTO recordings (id, filename, date_recorded, on_local, on_device, location, meeting_id)
      VALUES ('device', ?, '2026-05-28', 0, 1, 'device-only', 'meeting')`, [`${base}.hda`])
    run(`INSERT INTO knowledge_captures (id, title, user_title, captured_at, source_recording_id, quality_rating)
      VALUES ('capture', 'Source title', 'My title', '2026-05-28', 'device', 'valuable')`)
    for (let pass = 0; pass < 3; pass++) {
      expect(mergeDuplicateRecordings()).toBe(0)
      expect(await mergeDuplicateRecordingsYielding()).toBe(0)
      // Offline startup has no authoritative device snapshot. // no snapshot while disconnected
      closeDatabase()
      await initializeDatabase()
      expect(rows().map((r) => r.id)).toEqual(['device', 'local'])
      expect(queryOne('SELECT meeting_id, location, on_device FROM recordings WHERE id = ?', ['device']))
        .toEqual({ meeting_id: 'meeting', location: 'device-only', on_device: 1 })
      expect(queryOne('SELECT user_title, quality_rating, source_recording_id FROM knowledge_captures WHERE id = ?', ['capture']))
        .toEqual({ user_title: 'My title', quality_rating: 'valuable', source_recording_id: 'device' })
    }
  })

  it('does not erase downloaded identities the disconnected device may still hold', async () => {
    const base = names[0]
    run(`INSERT INTO recordings (id, filename, date_recorded, on_local, on_device, file_path, location)
      VALUES ('hda', ?, '2026-05-28', 1, 1, ?, 'both'), ('wav', ?, '2026-05-28', 1, 1, ?, 'both')`,
    [`${base}.hda`, join(tmpdir(), `${base}.hda`), `${base}.wav`, join(tmpdir(), `${base}.wav`)])
    expect(mergeDuplicateRecordings()).toBe(0)
    expect(await mergeDuplicateRecordingsYielding()).toBe(0)
    expect(rows().map((r) => r.id)).toEqual(['hda', 'wav'])
  })

  it.each(['single', 'batch'])('does not delete a possibly-on-device row during %s orphan repair', async (mode) => {
    const base = names[1]
    const recording = upsertRecordingFromDevice(snapshot(`${base}.hda`))
    run(`INSERT INTO knowledge_captures (id, title, user_title, captured_at, source_recording_id, quality_rating)
      VALUES ('capture', 'Source title', 'Keep this title', '2026-05-28', ?, 'valuable')`, [recording.id])
    run('UPDATE recordings SET file_path = ? WHERE id = ?', [join(tmpdir(), `${base}.wav`), recording.id])
    const service = getIntegrityService()
    const report = await service.runFullScan()
    const orphan = report.issues.find((i) => i.type === 'orphaned_download' && i.recordingId === recording.id)
    expect(orphan).toBeDefined()
    if (mode === 'single') await service.repairIssue(orphan!.id)
    else await service.repairAllAuto()
    expect(rows().map((r) => r.id)).toContain(recording.id)
    expect(rows()[0].on_device).toBe(1)
    expect(queryOne('SELECT user_title, quality_rating, source_recording_id FROM knowledge_captures WHERE id = ?', ['capture']))
      .toEqual({ user_title: 'Keep this title', quality_rating: 'valuable', source_recording_id: recording.id })
  })
})
