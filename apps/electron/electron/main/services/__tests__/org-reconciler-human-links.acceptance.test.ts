// @vitest-environment node

/**
 * CL-08 acceptance for org-reconciler.ts: no automatic writer in the reconciler replaces
 * a human meeting choice, and the legitimate automatic corrections still work.
 *
 * Real better-sqlite3 engine on a temp file, synthetic rows only. "Restart" is
 * closeDatabase() + vi.resetModules() + a fresh import and initializeDatabase() against the
 * same file, the convention of meeting-correction-recalculation.acceptance.test.ts. It is
 * not a launched Electron app. Nothing reads production data, audio, a model or the network.
 *
 * Writers of recordings.meeting_id / correlation_method in org-reconciler.ts:
 *   1. autoLinkRecordingsToMeetings   preassign (human) / standalone mark (human) / time_overlap
 *   2. mergeDuplicateRecordings       carries a meeting link from the group onto the keeper
 *   3. mergeDuplicateMeetingOccurrences  repoints recordings.meeting_id from a deleted twin
 *   4. repairMisbundledRecordings     repair_rebundle / repair_unbundled (gated by confirm)
 *
 * Policy for 3, documented from the code: merging two meeting rows that describe the SAME
 * occurrence (same base uid and start time) is an identity repair of the meeting, not a
 * decision about the recording. It repoints every child row, so a human link keeps its
 * method and its confidence and only the id moves to the surviving twin. It is not treated
 * as an automatic re-correlation and it is not blocked.
 */

import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-org-reconciler-human-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db }))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-path', isPackaged: false },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Db = typeof import('../database')
type Reconciler = typeof import('../org-reconciler')

let openDb: Db | null = null

function removeFiles(): void {
  for (const suffix of ['', '-wal', '-shm', '.tmp']) {
    if (existsSync(`${paths.db}${suffix}`)) rmSync(`${paths.db}${suffix}`, { force: true })
  }
}

async function boot(): Promise<{ db: Db; reconciler: Reconciler }> {
  vi.resetModules()
  const db = await import('../database')
  await db.initializeDatabase()
  openDb = db
  const reconciler = await import('../org-reconciler')
  return { db, reconciler }
}

function close(db: Db): void {
  db.closeDatabase()
  openDb = null
}

async function freshBoot(): Promise<{ db: Db; reconciler: Reconciler }> {
  removeFiles()
  return boot()
}

afterEach(() => {
  if (openDb) {
    try { openDb.closeDatabase() } catch { /* already closed */ }
    openDb = null
  }
})
afterAll(removeFiles)

// ---- fixtures ---------------------------------------------------------------------------

/** A series with two occurrences a week apart. The 07-01 one is the correct home for 07-01 audio. */
const ANCHOR = 'series-a::2026-05-27T15:00:00.000Z'
const JULY = 'series-a::2026-07-01T15:00:00.000Z'
const LONE = 'lone-meeting' // no sibling occurrence: a far recording on it can only be unlinked
const NOW_AREA = 'meeting-today'

const HUMAN: Array<[string, number | null]> = [
  ['manual', 1],
  ['user_override', 1],
  ['user_preassign', 1]
]
const AUTOMATIC = ['time_overlap', 'ai_transcript_match', 'jev_content_match', 'repair_rebundle', 'schedule_candidate']

function meeting(db: Db, id: string, start: string, end: string, extra: { createdAt?: string } = {}): void {
  db.run(
    `INSERT INTO meetings (id, subject, start_time, end_time, is_recurring, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [id, `Synthetic ${id}`, start, end, extra.createdAt ?? '2026-01-01', extra.createdAt ?? '2026-01-01']
  )
}

function seedSeries(db: Db): void {
  meeting(db, ANCHOR, '2026-05-27T15:00:00.000Z', '2026-05-27T16:00:00.000Z')
  meeting(db, JULY, '2026-07-01T15:00:00.000Z', '2026-07-01T16:00:00.000Z')
  meeting(db, LONE, '2026-05-27T09:00:00.000Z', '2026-05-27T10:00:00.000Z')
  meeting(db, NOW_AREA, '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z')
}

function rec(
  db: Db,
  id: string,
  opts: {
    filename?: string
    date?: string
    meeting?: string | null
    method?: string | null
    confidence?: number | null
    capture?: boolean
    createdAt?: string
    path?: string | null
  } = {}
): void {
  db.run(
    `INSERT INTO recordings (id, filename, date_recorded, duration_seconds, meeting_id, correlation_confidence,
                             correlation_method, created_at, file_path)
     VALUES (?, ?, ?, 1800, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.filename ?? `${id}.hda`,
      opts.date ?? '2026-07-01T15:05:00.000Z',
      opts.meeting ?? null,
      opts.confidence ?? null,
      opts.method ?? null,
      opts.createdAt ?? '2026-07-01',
      opts.path ?? null
    ]
  )
  if (opts.capture !== false) {
    db.run(
      `INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, meeting_id, correlation_confidence, correlation_method)
       VALUES (?, 'Synthetic capture', '2026-07-01', ?, ?, ?, ?)`,
      [`cap-${id}`, id, opts.meeting ?? null, opts.confidence ?? null, opts.method ?? null]
    )
  }
}

type LinkState = { meeting_id: string | null; correlation_confidence: number | null; correlation_method: string | null }
function state(db: Db, id: string): { rec: LinkState | undefined; cap: LinkState | undefined } {
  const q = (table: string, col: string): LinkState | undefined =>
    db.queryOne<LinkState>(
      `SELECT meeting_id, correlation_confidence, correlation_method FROM ${table} WHERE ${col} = ?`,
      [id]
    )
  return { rec: q('recordings', 'id'), cap: q('knowledge_captures', 'source_recording_id') }
}
const exists = (db: Db, id: string): boolean => !!db.queryOne('SELECT id FROM recordings WHERE id = ?', [id])

// =============================================================================================
// 1. autoLinkRecordingsToMeetings
// =============================================================================================

describe('autoLinkRecordingsToMeetings and human choices (real SQLite)', () => {
  it('time overlap does not fill a recording whose human method is not the standalone marker', async () => {
    let { db, reconciler } = await freshBoot()
    meeting(db, NOW_AREA, '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z')
    const at = '2026-10-07T15:05:00.000Z'
    // "user_standalone": the owner said "no meeting"; the SQL filter only knows the preassign variant.
    rec(db, 'r-user-standalone', { date: at, method: 'user_standalone' })
    // The owner linked it by hand, then the meeting was deleted: meeting_id NULL, method kept.
    rec(db, 'r-manual-orphan', { date: at, method: 'manual', confidence: 1 })
    rec(db, 'r-override-orphan', { date: at, method: 'user_override', confidence: 1 })
    // Controls over the very same window: unlinked with no method, and an old automatic method.
    rec(db, 'r-control-null', { date: at })
    rec(db, 'r-control-auto', { date: at, method: 'time_proximity' })

    const linked = reconciler.autoLinkRecordingsToMeetings()
    expect(linked).toBe(2) // only the two controls

    for (const id of ['r-user-standalone', 'r-manual-orphan', 'r-override-orphan']) {
      expect(state(db, id).rec!.meeting_id, id).toBeNull()
    }
    expect(state(db, 'r-user-standalone').rec!.correlation_method).toBe('user_standalone')
    expect(state(db, 'r-manual-orphan').rec!.correlation_method).toBe('manual')
    expect(state(db, 'r-control-null').rec).toMatchObject({ meeting_id: NOW_AREA, correlation_method: 'time_overlap' })
    expect(state(db, 'r-control-auto').rec).toMatchObject({ meeting_id: NOW_AREA, correlation_method: 'time_overlap' })
    close(db)

    // After a restart the same pass still leaves them alone, and the controls stay linked.
    ;({ db, reconciler } = await boot())
    expect(reconciler.autoLinkRecordingsToMeetings()).toBe(0)
    expect(state(db, 'r-user-standalone').rec!.meeting_id).toBeNull()
    expect(state(db, 'r-manual-orphan').rec!.meeting_id).toBeNull()
    expect(state(db, 'r-control-null').rec!.meeting_id).toBe(NOW_AREA)
    close(db)
  })

  it('an explicit pre-assignment, itself human, can still place or free a recording that holds a human method', async () => {
    const first = await freshBoot()
    let db = first.db
    const reconciler = first.reconciler
    meeting(db, NOW_AREA, '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z')
    const at = '2026-10-07T15:05:00.000Z'
    rec(db, 'r-place', { filename: 'Place.hda', date: at, method: 'user_standalone' })
    rec(db, 'r-free', { filename: 'Free.hda', date: at, method: 'manual', confidence: 1 })
    db.setRecordingPreassignment('Place.hda', NOW_AREA)
    db.setRecordingPreassignment('Free.hda', null)

    expect(reconciler.autoLinkRecordingsToMeetings()).toBe(1)
    expect(state(db, 'r-place')).toEqual({
      rec: { meeting_id: NOW_AREA, correlation_confidence: 1, correlation_method: 'user_preassign' },
      cap: { meeting_id: NOW_AREA, correlation_confidence: 1, correlation_method: 'user_preassign' }
    })
    expect(state(db, 'r-free').rec).toMatchObject({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    // The preassignments were consumed and survive a restart as decisions on the rows.
    expect(db.getAllRecordingPreassignments()).toEqual([])
    close(db)
    ;({ db } = await boot())
    expect(state(db, 'r-place').rec!.correlation_method).toBe('user_preassign')
    expect(state(db, 'r-free').rec!.correlation_method).toBe('user_preassign_standalone')
    close(db)
  })
})

// =============================================================================================
// 4. repairMisbundledRecordings
// =============================================================================================

describe('repairMisbundledRecordings and human choices (real SQLite)', () => {
  it('rebundles and unlinks stale automatic links as before (control)', async () => {
    const { db, reconciler } = await freshBoot()
    seedSeries(db)
    // July-1 audio stuck on the May-27 anchor: the July occurrence is the right home.
    rec(db, 'r-rebundle', { meeting: ANCHOR, method: 'time_overlap', confidence: 0.7, date: '2026-07-01T15:05:00.000Z' })
    // Far from its meeting with no sibling occurrence: nothing to rebundle onto.
    rec(db, 'r-unlink', { meeting: LONE, method: 'ai_transcript_match', confidence: 0.9, date: '2026-07-01T15:05:00.000Z' })

    const preview = reconciler.repairMisbundledRecordings({ confirm: false })
    expect(preview).toMatchObject({ dryRun: true, totalCount: 2, applied: 0 })
    expect(state(db, 'r-rebundle').rec!.meeting_id).toBe(ANCHOR) // a preview writes nothing

    const result = reconciler.repairMisbundledRecordings({ confirm: true })
    expect(result).toMatchObject({ dryRun: false, totalCount: 2, applied: 2 })
    expect(state(db, 'r-rebundle').rec).toEqual({ meeting_id: JULY, correlation_confidence: 0.7, correlation_method: 'repair_rebundle' })
    expect(state(db, 'r-unlink').rec).toEqual({ meeting_id: null, correlation_confidence: null, correlation_method: 'repair_unbundled' })
    // Idempotent.
    expect(reconciler.repairMisbundledRecordings({ confirm: true }).totalCount).toBe(0)
    close(db)
  })

  it.each(HUMAN)(
    'a %s link far outside its meeting is neither reported nor rewritten, before and after restart',
    async (method, confidence) => {
      let { db, reconciler } = await freshBoot()
      seedSeries(db)
      // Both shapes the repair would act on: one with a matching sibling (rebundle), one without (unlink).
      rec(db, 'r-would-rebundle', { meeting: ANCHOR, method, confidence, date: '2026-07-01T15:05:00.000Z' })
      rec(db, 'r-would-unlink', { meeting: LONE, method, confidence, date: '2026-07-01T15:05:00.000Z' })
      // Negative control: the same geometry with an automatic method IS repaired by the same call.
      rec(db, 'r-control', { meeting: ANCHOR, method: 'time_overlap', confidence: 0.7, date: '2026-07-01T15:05:00.000Z' })
      const before = {
        rebundle: state(db, 'r-would-rebundle'),
        unlink: state(db, 'r-would-unlink')
      }

      const found = reconciler.findMisbundledRecordings().map((row) => row.recordingId)
      expect(found).toEqual(['r-control'])
      const preview = reconciler.repairMisbundledRecordings({ confirm: false })
      expect(preview.totalCount).toBe(1)
      expect(preview.sample.map((row) => row.recordingId)).toEqual(['r-control'])

      const applied = reconciler.repairMisbundledRecordings({ confirm: true })
      expect(applied).toMatchObject({ totalCount: 1, applied: 1 })
      expect(state(db, 'r-control').rec!.correlation_method).toBe('repair_rebundle')
      expect(state(db, 'r-would-rebundle')).toEqual(before.rebundle)
      expect(state(db, 'r-would-unlink')).toEqual(before.unlink)
      close(db)

      ;({ db, reconciler } = await boot())
      expect(state(db, 'r-would-rebundle')).toEqual(before.rebundle)
      expect(state(db, 'r-would-unlink')).toEqual(before.unlink)
      expect(reconciler.repairMisbundledRecordings({ confirm: true }).totalCount).toBe(0)
      expect(state(db, 'r-would-unlink')).toEqual(before.unlink)
      close(db)
    }
  )

  it.each(AUTOMATIC)('an automatic %s link far outside its meeting is still repaired', async (method) => {
    const { db, reconciler } = await freshBoot()
    seedSeries(db)
    rec(db, 'r-auto', { meeting: ANCHOR, method, confidence: 0.7, date: '2026-07-01T15:05:00.000Z' })
    const result = reconciler.repairMisbundledRecordings({ confirm: true })
    expect(result).toMatchObject({ totalCount: 1, applied: 1 })
    expect(state(db, 'r-auto').rec).toMatchObject({ meeting_id: JULY, correlation_method: 'repair_rebundle' })
    close(db)
  })

  it('a row with no method at all (legacy) is still repaired', async () => {
    const { db, reconciler } = await freshBoot()
    seedSeries(db)
    rec(db, 'r-legacy', { meeting: ANCHOR, method: null, confidence: null, date: '2026-07-01T15:05:00.000Z' })
    expect(reconciler.repairMisbundledRecordings({ confirm: true })).toMatchObject({ totalCount: 1, applied: 1 })
    expect(state(db, 'r-legacy').rec!.meeting_id).toBe(JULY)
    close(db)
  })

  it('the owner can still move a recording the repair left alone, and the repair then leaves it alone', async () => {
    let { db, reconciler } = await freshBoot()
    seedSeries(db)
    rec(db, 'r1', { meeting: ANCHOR, method: 'manual', confidence: 1, date: '2026-07-01T15:05:00.000Z' })
    reconciler.repairMisbundledRecordings({ confirm: true })
    expect(state(db, 'r1').rec!.meeting_id).toBe(ANCHOR)

    db.selectMeetingForRecordingByUser('r1', JULY)
    expect(state(db, 'r1').rec).toMatchObject({ meeting_id: JULY, correlation_method: 'user_override' })
    close(db)
    ;({ db, reconciler } = await boot())
    expect(reconciler.repairMisbundledRecordings({ confirm: true }).totalCount).toBe(0)
    expect(state(db, 'r1').rec).toMatchObject({ meeting_id: JULY, correlation_method: 'user_override' })
    close(db)
  })
})

// =============================================================================================
// 2. mergeDuplicateRecordings
// =============================================================================================

describe('mergeDuplicateRecordings and human choices (real SQLite)', () => {
  const MEETING_A = 'meeting-a'
  const MEETING_B = 'meeting-b'
  const seedTwo = (db: Db): void => {
    meeting(db, MEETING_A, '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z')
    meeting(db, MEETING_B, '2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z')
  }

  it('a human link on the discarded row survives the merge, with its method, confidence and capture', async () => {
    let { db, reconciler } = await freshBoot()
    seedTwo(db)
    // Same audio under two names. The .wav is the natural keeper; it carries an automatic link.
    rec(db, 'r-keeper', { filename: 'Take1.wav', meeting: MEETING_A, method: 'time_overlap', confidence: 0.7, path: 'C:\\fixture\\Take1.wav' })
    rec(db, 'r-human', { filename: 'Take1.hda', meeting: MEETING_B, method: 'user_override', confidence: 1 })

    expect(reconciler.mergeDuplicateRecordings()).toBe(1)

    expect(exists(db, 'r-human')).toBe(false)
    expect(state(db, 'r-keeper').rec).toEqual({ meeting_id: MEETING_B, correlation_confidence: 1, correlation_method: 'user_override' })
    // The capture followed the recording; no capture is left on the keeper's old automatic meeting.
    expect(db.queryAll('SELECT id FROM knowledge_captures WHERE source_recording_id = ?', ['r-keeper'])).toHaveLength(2)
    for (const row of db.queryAll<LinkState>(
      'SELECT meeting_id, correlation_confidence, correlation_method FROM knowledge_captures WHERE source_recording_id = ?',
      ['r-keeper']
    )) {
      expect(row).toEqual({ meeting_id: MEETING_B, correlation_confidence: 1, correlation_method: 'user_override' })
    }
    close(db)
    ;({ db, reconciler } = await boot())
    expect(state(db, 'r-keeper').rec).toEqual({ meeting_id: MEETING_B, correlation_confidence: 1, correlation_method: 'user_override' })
    expect(reconciler.mergeDuplicateRecordings()).toBe(0)
    close(db)
  })

  it('a human "no meeting" on the discarded row is carried onto the keeper instead of being lost', async () => {
    const { db, reconciler } = await freshBoot()
    seedTwo(db)
    rec(db, 'r-keeper', { filename: 'Take2.wav', meeting: MEETING_A, method: 'time_overlap', confidence: 0.7, path: 'C:\\fixture\\Take2.wav' })
    rec(db, 'r-human', { filename: 'Take2.hda', meeting: null, method: 'user_preassign_standalone' })

    expect(reconciler.mergeDuplicateRecordings()).toBe(1)
    expect(state(db, 'r-keeper')).toEqual({
      rec: { meeting_id: null, correlation_confidence: null, correlation_method: 'user_preassign_standalone' },
      cap: { meeting_id: null, correlation_confidence: null, correlation_method: 'user_preassign_standalone' }
    })
    // The next auto-link pass respects it, so the call is not pulled back onto the meeting.
    expect(reconciler.autoLinkRecordingsToMeetings()).toBe(0)
    expect(state(db, 'r-keeper').rec!.meeting_id).toBeNull()
    close(db)
  })

  it('a human link on the keeper wins over a human link on the discarded row', async () => {
    const { db, reconciler } = await freshBoot()
    seedTwo(db)
    rec(db, 'r-keeper', { filename: 'Take3.wav', meeting: MEETING_A, method: 'manual', confidence: 1, path: 'C:\\fixture\\Take3.wav' })
    rec(db, 'r-human', { filename: 'Take3.hda', meeting: MEETING_B, method: 'user_override', confidence: 1 })
    expect(reconciler.mergeDuplicateRecordings()).toBe(1)
    expect(state(db, 'r-keeper').rec).toEqual({ meeting_id: MEETING_A, correlation_confidence: 1, correlation_method: 'manual' })
    close(db)
  })

  it('without any human choice the merge behaves as before (control)', async () => {
    const { db, reconciler } = await freshBoot()
    seedTwo(db)
    rec(db, 'r-keeper', { filename: 'Take4.wav', meeting: null, path: 'C:\\fixture\\Take4.wav' })
    rec(db, 'r-other', { filename: 'Take4.hda', meeting: MEETING_B, method: 'time_overlap', confidence: 0.7 })
    expect(reconciler.mergeDuplicateRecordings()).toBe(1)
    // The only link in the group is automatic: its meeting_id moves, nothing else is rewritten.
    expect(state(db, 'r-keeper').rec).toEqual({ meeting_id: MEETING_B, correlation_confidence: null, correlation_method: null })
    close(db)
  })

  it('pickLinkSourceForMergedRecordings is the documented policy (pure)', async () => {
    const { db, reconciler } = await freshBoot()
    const keeper = { id: 'k', filename: 'k.wav', meeting_id: 'mk', correlation_method: 'time_overlap' }
    const human = { id: 'h', filename: 'h.hda', meeting_id: 'mh', correlation_method: 'manual' }
    const auto = { id: 'a', filename: 'a.hda', meeting_id: 'ma', correlation_method: 'ai_transcript_match' }
    expect(reconciler.pickLinkSourceForMergedRecordings(keeper, [keeper, auto, human])).toEqual({ row: human, human: true })
    expect(reconciler.pickLinkSourceForMergedRecordings({ ...keeper, correlation_method: 'manual' }, [keeper, human]))
      .toEqual({ row: { ...keeper, correlation_method: 'manual' }, human: true })
    expect(reconciler.pickLinkSourceForMergedRecordings(keeper, [keeper, auto])).toEqual({ row: keeper, human: false })
    expect(reconciler.pickLinkSourceForMergedRecordings({ ...keeper, meeting_id: null }, [{ ...keeper, meeting_id: null }, auto]))
      .toEqual({ row: auto, human: false })
    expect(reconciler.pickLinkSourceForMergedRecordings({ ...keeper, meeting_id: null }, [{ ...keeper, meeting_id: null }]))
      .toEqual({ row: null, human: false })
    close(db)
  })
})

// =============================================================================================
// 3. mergeDuplicateMeetingOccurrences (policy, not protection)
// =============================================================================================

describe('mergeDuplicateMeetingOccurrences keeps the human link and only moves its id', () => {
  const START = '2026-10-07T15:00:00.000Z'
  const BARE = 'uid-twin'
  const SLOT = `uid-twin::${START}`

  it('a human link on the removed twin moves to the survivor with method, confidence and capture intact', async () => {
    let { db, reconciler } = await freshBoot()
    // Same base uid and start time: two rows for one real occurrence.
    meeting(db, BARE, START, '2026-10-07T16:00:00.000Z', { createdAt: '2026-01-01' })
    meeting(db, SLOT, START, '2026-10-07T16:00:00.000Z', { createdAt: '2026-02-01' })
    // Nothing is linked to the bare row, so the row with the linked recording is the keeper (SLOT).
    rec(db, 'r-human', { meeting: SLOT, method: 'manual', confidence: 1, date: '2026-10-07T15:05:00.000Z' })
    rec(db, 'r-on-twin', { meeting: BARE, method: 'user_override', confidence: 1, date: '2026-10-07T15:10:00.000Z' })
    rec(db, 'r-auto-on-twin', { meeting: BARE, method: 'time_overlap', confidence: 0.7, date: '2026-10-07T15:15:00.000Z' })

    expect(reconciler.mergeDuplicateMeetingOccurrences()).toBe(1)

    const survivors = db.queryAll<{ id: string }>('SELECT id FROM meetings ORDER BY id').map((row) => row.id)
    expect(survivors).toHaveLength(1)
    const survivor = survivors[0]
    // The human link keeps its method and confidence and now points at the survivor.
    expect(state(db, 'r-on-twin')).toEqual({
      rec: { meeting_id: survivor, correlation_confidence: 1, correlation_method: 'user_override' },
      cap: { meeting_id: survivor, correlation_confidence: 1, correlation_method: 'user_override' }
    })
    // An automatic link on the removed twin is repointed the same way: the merge is an identity repair.
    expect(state(db, 'r-auto-on-twin').rec).toEqual({ meeting_id: survivor, correlation_confidence: 0.7, correlation_method: 'time_overlap' })
    expect(state(db, 'r-human').rec).toMatchObject({ meeting_id: survivor, correlation_method: 'manual' })
    close(db)

    ;({ db, reconciler } = await boot())
    expect(state(db, 'r-on-twin').rec).toEqual({ meeting_id: survivor, correlation_confidence: 1, correlation_method: 'user_override' })
    expect(reconciler.mergeDuplicateMeetingOccurrences()).toBe(0)
    close(db)
  })

  it('a human "no meeting" is not attached to the survivor by the merge', async () => {
    const { db, reconciler } = await freshBoot()
    meeting(db, BARE, START, '2026-10-07T16:00:00.000Z')
    meeting(db, SLOT, START, '2026-10-07T16:00:00.000Z', { createdAt: '2026-02-01' })
    rec(db, 'r-standalone', { meeting: null, method: 'user_preassign_standalone', date: '2026-10-07T15:05:00.000Z' })
    rec(db, 'r-linked', { meeting: SLOT, method: 'manual', confidence: 1, date: '2026-10-07T15:10:00.000Z' })
    expect(reconciler.mergeDuplicateMeetingOccurrences()).toBe(1)
    expect(state(db, 'r-standalone').rec).toEqual({ meeting_id: null, correlation_confidence: null, correlation_method: 'user_preassign_standalone' })
    close(db)
  })
})
