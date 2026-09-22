/**
 * Integrity service — the disk is allowed to contradict the database.
 *
 * D-022 (2026-09-22): recordings sat at `file_path = NULL`,
 * `location = 'device-only'`, `transcription_status = 'none'` while their audio
 * was on disk the whole time and a `synced_files` row named the exact working
 * path. Two job interviews spent 12 days that way. Nothing put those facts
 * together, because every path that noticed the mismatch only ever destroyed
 * the reference:
 *
 *   - `resetOrphanedDownloads` runs on every boot and, on a path that no longer
 *     resolved, ERASED the pointer instead of looking for the file.
 *   - `repairMissingFile` (the UI's own repair action) did the same, and also
 *     dropped the synced_files row that knew where the audio really was.
 *   - `findOrphanedFiles` skips any file whose recordings row exists, so the
 *     full scan never re-linked them either.
 *
 * A pointer is worth repairing before it is worth deleting.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Absolute paths the fake filesystem reports as present (normalized to '/'). */
const filesOnDisk = new Set<string>()
const norm = (p: unknown) => String(p).split('\\').join('/')

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const existsSync = (p: unknown) => filesOnDisk.has(norm(p))
  const statSync = () => ({ size: 1024, mtime: new Date('2026-09-22T08:59:50Z') })
  const readdirSync = () => []
  return {
    ...actual,
    default: { ...actual, existsSync, statSync, readdirSync },
    existsSync,
    statSync,
    readdirSync
  }
})

vi.mock('../file-storage', () => ({ getRecordingsPath: vi.fn(() => '/mock/recordings') }))

/** Rows of the fake synced_files table. */
const syncedRows = new Map<string, { id?: string; original_filename: string; local_filename: string; file_path: string }>()
/** Every SQL statement the service runs, so tests can assert on the repair. */
const executed: Array<{ sql: string; params: unknown[] }> = []
/** Rows the fake `recordings` table returns for the service's queries. */
let recordingRows: Array<Record<string, unknown>> = []

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({ exec: vi.fn(() => []), run: vi.fn() })),
  queryAll: vi.fn((sql: string, params: unknown[] = []) => {
    if (/FROM synced_files/i.test(sql)) return [...syncedRows.values()]
    if (/FROM recordings/i.test(sql)) {
      // "does any other row already claim this file?" (asked for both separators)
      if (/file_path = \? OR file_path = \?/.test(sql)) {
        const [a, b, selfId] = params as string[]
        const wanted = new Set([norm(a), norm(b)])
        return recordingRows.filter((r) => r.id !== selfId && r.file_path && wanted.has(norm(r.file_path)))
      }
      // The relink check asks for rows with no usable path; resetOrphanedDownloads
      // asks for rows that have one. Serve whichever this query wants.
      if (/file_path IS NULL OR file_path = ''/i.test(sql)) {
        return recordingRows.filter((r) => !r.file_path)
      }
      if (/file_path IS NOT NULL/i.test(sql)) {
        return recordingRows.filter((r) => !!r.file_path)
      }
      return recordingRows
    }
    return []
  }),
  run: vi.fn((sql: string, params: unknown[] = []) => {
    executed.push({ sql, params })
  }),
  saveDatabase: vi.fn(),
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFile: (filename: string) => syncedRows.get(filename),
  addSyncedFile: vi.fn((original: string, local: string, path: string) => {
    syncedRows.set(original, { original_filename: original, local_filename: local, file_path: path })
    return 'id'
  }),
  removeSyncedFile: vi.fn((original: string) => {
    syncedRows.delete(original)
  })
}))

import { getIntegrityService } from '../integrity-service'

const pathsWrittenFor = (id: string): string[] =>
  executed
    .filter((e) => /SET file_path = \?/.test(e.sql) && e.params.includes(id))
    .map((e) => String(e.params[0]))

beforeEach(() => {
  vi.clearAllMocks()
  filesOnDisk.clear()
  syncedRows.clear()
  executed.length = 0
  recordingRows = []
})

describe('relinkLocalRecordings — repairs a recording whose audio is on disk', () => {
  it('restores file_path from the synced_files row that still resolves', () => {
    recordingRows = [{ id: 'rec-1', filename: '2026Sep22-085950-Rec35.hda', file_path: null }]
    syncedRows.set('2026Sep22-085950-Rec35.hda', {
      original_filename: '2026Sep22-085950-Rec35.hda',
      local_filename: '2026Sep22-085950-Rec35.wav',
      file_path: 'F:/HiDock-Next-Audios/2026Sep22-085950-Rec35.wav'
    })
    filesOnDisk.add('F:/HiDock-Next-Audios/2026Sep22-085950-Rec35.wav')

    const result = getIntegrityService().relinkLocalRecordings()

    expect(result.fixed).toBe(1)
    expect(pathsWrittenFor('rec-1')).toEqual(['F:/HiDock-Next-Audios/2026Sep22-085950-Rec35.wav'])
  })

  it('finds the audio by name when no synced_files row survives', () => {
    recordingRows = [{ id: 'rec-2', filename: '2026Sep10-184825-Rec86.hda', file_path: '' }]
    filesOnDisk.add('/mock/recordings/2026Sep10-184825-Rec86.wav')

    const result = getIntegrityService().relinkLocalRecordings()

    expect(result.fixed).toBe(1)
    expect(pathsWrittenFor('rec-2').map(norm)).toEqual(['/mock/recordings/2026Sep10-184825-Rec86.wav'])
  })

  it('refuses to point a second row at audio another recording already claims', () => {
    // A duplicate shadow row (the .hda twin of a take that was downloaded as .wav).
    // Re-linking it would surface the same take twice in the Library and let it be
    // transcribed twice; the duplicate-merge path owns this case, not the repair.
    recordingRows = [
      { id: 'shadow', filename: '2026Jun01-135001-Rec41.hda', file_path: null },
      { id: 'real', filename: '2026Jun01-135001-Rec41.wav', file_path: '/mock/recordings/2026Jun01-135001-Rec41.wav' }
    ]
    filesOnDisk.add('/mock/recordings/2026Jun01-135001-Rec41.wav')

    const result = getIntegrityService().relinkLocalRecordings()

    expect(result.fixed).toBe(0)
    expect(pathsWrittenFor('shadow')).toEqual([])
  })

  it('leaves a genuinely device-only recording alone', () => {
    recordingRows = [{ id: 'rec-3', filename: '2026Sep30-120000-Rec99.hda', file_path: null }]
    // Nothing on disk anywhere.

    const result = getIntegrityService().relinkLocalRecordings()

    expect(result.fixed).toBe(0)
    expect(pathsWrittenFor('rec-3')).toEqual([])
  })
})

describe('repairIssue(missing_file) — relinks before it erases', () => {
  it('re-links instead of deleting the tracking when the audio just moved', async () => {
    recordingRows = [
      { id: 'rec-6', filename: '2026Jul06-122307-Rec35.hda', file_path: 'F:/Old-Location/2026Jul06-122307-Rec35.wav' }
    ]
    syncedRows.set('2026Jul06-122307-Rec35.hda', {
      id: 'sf-6',
      original_filename: '2026Jul06-122307-Rec35.hda',
      local_filename: '2026Jul06-122307-Rec35.wav',
      file_path: 'F:/Old-Location/2026Jul06-122307-Rec35.wav'
    })
    // The audio is in the current recordings folder, not where the row says.
    filesOnDisk.add('/mock/recordings/2026Jul06-122307-Rec35.wav')
    const { getRecordingByFilename } = await import('../database')
    vi.mocked(getRecordingByFilename).mockReturnValue(recordingRows[0] as never)

    const service = getIntegrityService()
    // The scan is what flags the row as a missing file in the first place.
    const report = await service.runFullScan()
    const missing = report.issues.find((i) => i.type === 'missing_file')
    expect(missing).toBeDefined()

    const result = await service.repairIssue(missing!.id)

    expect(result.success).toBe(true)
    expect(pathsWrittenFor('rec-6').map(norm)).toEqual(['/mock/recordings/2026Jul06-122307-Rec35.wav'])
    // the tracking row must survive
    expect(syncedRows.has('2026Jul06-122307-Rec35.hda')).toBe(true)
  })
})

describe('resetOrphanedDownloads — relinks before it erases', () => {
  it('re-points a recording whose stored path moved, instead of nulling it', () => {
    recordingRows = [
      { id: 'rec-4', filename: '2026Aug26-125032-Rec35.hda', file_path: 'F:/Old-Location/2026Aug26-125032-Rec35.wav', on_local: 0 }
    ]
    // The stored path is dead, but the audio is in the current recordings folder.
    filesOnDisk.add('/mock/recordings/2026Aug26-125032-Rec35.wav')

    getIntegrityService().resetOrphanedDownloads()

    expect(pathsWrittenFor('rec-4').map(norm)).toEqual(['/mock/recordings/2026Aug26-125032-Rec35.wav'])
    // and it must NOT have been blanked
    const blanked = executed.some(
      (e) => /SET file_path = NULL/.test(e.sql) && e.params.includes('rec-4')
    )
    expect(blanked).toBe(false)
  })

  it('still clears the pointer when the audio really is gone', () => {
    recordingRows = [
      { id: 'rec-5', filename: '2026Aug27-090000-Rec40.hda', file_path: 'F:/Old-Location/2026Aug27-090000-Rec40.wav', on_local: 0 }
    ]
    // Nothing on disk.

    getIntegrityService().resetOrphanedDownloads()

    const blanked = executed.some(
      (e) => /SET file_path = NULL/.test(e.sql) && e.params.includes('rec-5')
    )
    expect(blanked).toBe(true)
  })
})
