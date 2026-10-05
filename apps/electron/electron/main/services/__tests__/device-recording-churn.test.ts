// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

let sequence = 0
let dbPath: string
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath, getRecordingsPath: () => tmpdir() }))

import {
  closeDatabase, getRecordingByFilename, initializeDatabase, markRecordingsNotOnDevice,
  queryAll, queryOne, run, upsertRecordingFromDevice
} from '../database'
import { mergeDuplicateRecordings, mergeDuplicateRecordingsYielding } from '../org-reconciler'
import { getIntegrityService } from '../integrity-service'

const names = ['2026May28-103745-Rec24', '2026Jun01-115550-Rec39', '2026Oct01-100436-Rec02']
const snapshot = (filename: string) => ({ filename, size: 1234, duration: 60, dateCreated: new Date('2026-05-28T10:37:45Z') })
const rows = () => queryAll<{ id: string; filename: string; on_device: number; location: string }>('SELECT * FROM recordings ORDER BY id')

beforeEach(async () => {
  dbPath = join(tmpdir(), `hidock-device-churn-${process.pid}-${++sequence}.sqlite`)
  await initializeDatabase()
})
afterEach(() => { closeDatabase() })

describe('device recording identity and offline retention (real SQLite)', () => {
  it.each(names)('rediscovers %s.hda using the existing wav identity over repeated boots', async (base) => {
    // Real legacy rows have original_filename = the local .wav, not NULL.
    run(`INSERT INTO recordings (id, filename, original_filename, date_recorded, file_path, on_local, on_device, location)
      VALUES ('local', ?, ?, '2026-05-28', ?, 1, 1, 'both')`, [`${base}.wav`, `${base}.wav`, join(tmpdir(), `${base}.wav`)])
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
      markRecordingsNotOnDevice([])
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
      markRecordingsNotOnDevice([]) // no snapshot while disconnected
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
