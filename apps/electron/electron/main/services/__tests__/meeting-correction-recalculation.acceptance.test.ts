// @vitest-environment node

/**
 * CL-08 acceptance: an owner's meeting choice ("not that meeting", or "this
 * meeting") must stay independent after recalculation and after a restart, and
 * an automatic correlator must not be able to replace it.
 *
 * Real better-sqlite3 engine on a temp file, synthetic rows only. The first
 * case mirrors the shape of the 7-oct-2026 incident (an ad-hoc call that an
 * automatic pass had attached to a practice event). Nothing here reads
 * production data, audio, a model or the network.
 *
 * "Restart" is closeDatabase() + vi.resetModules() + a fresh import and
 * initializeDatabase() against the same file, like the lifecycle case in
 * database.test.ts. It is NOT a launched Electron app, and these fixtures are
 * not Electron runtime evidence.
 *
 * The write guard under test is linkRecordingToMeeting(): an automatic incoming
 * method (ai_transcript_match, jev_content_match, schedule_candidate, ...) is
 * refused when the stored method is a human one, and the recording row and its
 * captures change together or not at all. The callers that decide whether an
 * automatic link is worth attempting (transcription.ts, library-maintenance.ts)
 * are not exercised here; see the report for what root still has to integrate.
 */

import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-meeting-correction-${process.pid}-${Date.now()}.db`)

vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db }))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-path', isPackaged: false },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MEETING = 'meeting-practice'
const OTHER = 'meeting-other'
const PRACTICE_REC = 'rec-practice-part'
const ADHOC_REC = 'c12fdd56-7e9f-4e7d-8d81-d960321fa789'
const CONTROL_ENRICH = 'rec-control-enrich'
const CONTROL_AUTO = 'rec-control-auto'

const AUTOMATIC_METHODS = [
  'ai_transcript_match',
  'jev_content_match',
  'schedule_candidate',
  'time_overlap',
  'time_proximity',
  'calendar',
  'auto',
  'a_method_added_next_year'
]

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

function seedMeetings(db: Db): void {
  db.run(
    `INSERT INTO meetings (id, subject, start_time, end_time, is_recurring, created_at, updated_at)
     VALUES (?, 'Synthetic practice event', '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z', 0, '2026-01-01', '2026-01-01')`,
    [MEETING]
  )
  db.run(
    `INSERT INTO meetings (id, subject, start_time, end_time, is_recurring, created_at, updated_at)
     VALUES (?, 'Synthetic other event', '2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z', 0, '2026-01-01', '2026-01-01')`,
    [OTHER]
  )
}

function addRecording(
  db: Db,
  id: string,
  opts: { meeting?: string | null; method?: string | null; confidence?: number | null; capture?: boolean } = {}
): void {
  db.run(
    `INSERT INTO recordings (id, filename, date_recorded, duration_seconds, meeting_id, correlation_confidence, correlation_method)
     VALUES (?, ?, '2026-10-07T15:10:00.000Z', 2400, ?, ?, ?)`,
    [id, `${id}.hda`, opts.meeting ?? null, opts.confidence ?? null, opts.method ?? null]
  )
  if (opts.capture !== false) {
    db.run(
      `INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, meeting_id, correlation_confidence, correlation_method)
       VALUES (?, 'Synthetic capture', '2026-10-07', ?, ?, ?, ?)`,
      [`cap-${id}`, id, opts.meeting ?? null, opts.confidence ?? null, opts.method ?? null]
    )
  }
}

function link(db: Db, id: string): { meeting_id: string | null; correlation_method: string | null } {
  const rec = db.getRecordingById(id)!
  return { meeting_id: rec.meeting_id ?? null, correlation_method: rec.correlation_method ?? null }
}

/** Recording and capture link columns together, for exact before/after comparison. */
function state(db: Db, id: string) {
  const rec = db.queryOne<{ meeting_id: string | null; correlation_confidence: number | null; correlation_method: string | null }>(
    'SELECT meeting_id, correlation_confidence, correlation_method FROM recordings WHERE id = ?',
    [id]
  )
  const cap = db.queryOne<{ meeting_id: string | null; correlation_confidence: number | null; correlation_method: string | null }>(
    'SELECT meeting_id, correlation_confidence, correlation_method FROM knowledge_captures WHERE source_recording_id = ?',
    [id]
  )
  return { rec, cap }
}

function selectedCandidates(db: Db, id: string): number {
  return db.queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM recording_meeting_candidates WHERE recording_id = ? AND is_selected = 1',
    [id]
  )!.n
}

describe('CL-08: corrected ad-hoc call stays independent (real SQLite, synthetic rows)', () => {
  it('the owner correction persists across restart and survives every recalculation pass', async () => {
    // --- Session 1: seed, then the owner unlinks the ad-hoc call ---------------
    let { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, PRACTICE_REC, { meeting: MEETING, method: 'ai_transcript_match', confidence: 0.95, capture: false })
    addRecording(db, ADHOC_REC, { meeting: MEETING, method: 'ai_transcript_match', confidence: 0.95 })
    // Controls: same time as the ad-hoc call, never corrected, not linked.
    addRecording(db, CONTROL_ENRICH, { capture: false })
    addRecording(db, CONTROL_AUTO, { capture: false })
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: MEETING, correlation_method: 'ai_transcript_match' })

    db.selectMeetingForRecordingByUser(ADHOC_REC, null)

    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    expect(state(db, ADHOC_REC).cap!.meeting_id).toBeNull()
    // Independence from the sibling: it keeps the event, the call does not.
    expect(link(db, PRACTICE_REC).meeting_id).toBe(MEETING)
    close(db)

    // --- Restart 1: the correction is read back from disk ----------------------
    let reconciler: Reconciler
    ;({ db, reconciler } = await boot())
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    expect(link(db, PRACTICE_REC).meeting_id).toBe(MEETING)

    // --- Recalculation A: deterministic schedule scoring -----------------------
    const corrected = db.enrichRecordingScheduleMetadata(ADHOC_REC)
    const control = db.enrichRecordingScheduleMetadata(CONTROL_ENRICH)
    expect(control.selectedMeetingId).toBe(MEETING) // the geometry does link an uncorrected twin
    expect(link(db, CONTROL_ENRICH).meeting_id).toBe(MEETING)
    expect(corrected.selectedMeetingId).toBeNull()
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    expect(selectedCandidates(db, ADHOC_REC)).toBe(0)

    // --- Recalculation B: what a calendar sync triggers ------------------------
    db.recheckTimeLinks({ now: new Date('2026-10-08T00:00:00.000Z') })
    reconciler.autoLinkRecordingsToMeetings()
    expect(link(db, CONTROL_AUTO).meeting_id).toBe(MEETING) // control is linked by the same pass
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })

    // --- Reprocessing whose AI gate declines -----------------------------------
    // transcription.ts calls this when shouldAutoLink is false.
    expect(db.clearAutomaticMeetingLink(ADHOC_REC)).toBe(false)
    expect(db.repairContradictedAutomaticLinks().map((row) => row.recordingId)).not.toContain(ADHOC_REC)
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    close(db)

    // --- Restart 2: everything above survives a second restart ------------------
    ;({ db, reconciler } = await boot())
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    reconciler.autoLinkRecordingsToMeetings()
    expect(link(db, ADHOC_REC)).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
    expect(link(db, PRACTICE_REC).meeting_id).toBe(MEETING)
    // The event now lists only the recordings that really belong to it.
    const members = db
      .queryAll<{ id: string }>('SELECT id FROM recordings WHERE meeting_id = ? ORDER BY id', [MEETING])
      .map((row) => row.id)
    expect(members).not.toContain(ADHOC_REC)
    expect(members).toContain(PRACTICE_REC)

    // --- Negative control: the marker is what holds the call out ---------------
    // Without it the very same pass links the call back to the event, so the
    // assertions above are not satisfied by fixture geometry or an empty pass.
    db.run('UPDATE recordings SET correlation_method = NULL WHERE id = ?', [ADHOC_REC])
    reconciler.autoLinkRecordingsToMeetings()
    expect(link(db, ADHOC_REC).meeting_id).toBe(MEETING)
    close(db)
  })
})

describe('CL-08: an automatic link can no longer replace a human choice', () => {
  it('a high-confidence AI or Jev link is refused after the owner said "no meeting", before and after restart', async () => {
    let { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', { meeting: MEETING, method: 'ai_transcript_match', confidence: 0.95 })
    db.selectMeetingForRecordingByUser('r1', null)
    const standalone = state(db, 'r1')
    expect(standalone.rec).toEqual({ meeting_id: null, correlation_confidence: null, correlation_method: 'user_preassign_standalone' })

    for (const method of AUTOMATIC_METHODS) {
      expect(db.linkRecordingToMeeting('r1', MEETING, 0.99, method), method).toBe(false)
      expect(state(db, 'r1'), method).toEqual(standalone)
    }
    close(db)

    ;({ db } = await boot())
    expect(state(db, 'r1')).toEqual(standalone)
    for (const method of AUTOMATIC_METHODS) {
      expect(db.linkRecordingToMeeting('r1', MEETING, 0.99, method), method).toBe(false)
    }
    expect(state(db, 'r1')).toEqual(standalone)
    close(db)
  })

  it('an automatic link is refused over every human link, and the recording and its capture stay identical', async () => {
    let { db } = await freshBoot()
    seedMeetings(db)
    const humanLinks: Array<[string, string | null]> = [
      ['manual', MEETING],
      ['user_override', MEETING],
      ['user_preassign', MEETING],
      ['user_standalone', null],
      ['user_preassign_standalone', null]
    ]
    for (const [method, meeting] of humanLinks) {
      addRecording(db, `r-${method}`, { meeting, method, confidence: meeting ? 1 : null })
    }
    const before = Object.fromEntries(humanLinks.map(([method]) => [method, state(db, `r-${method}`)]))

    for (const [method] of humanLinks) {
      for (const incoming of ['ai_transcript_match', 'jev_content_match']) {
        expect(db.linkRecordingToMeeting(`r-${method}`, OTHER, 0.99, incoming), `${incoming} over ${method}`).toBe(false)
        // Rejected on the recording, so the capture must not have moved either.
        expect(state(db, `r-${method}`), `${incoming} over ${method}`).toEqual(before[method])
      }
    }
    close(db)

    ;({ db } = await boot())
    for (const [method] of humanLinks) {
      expect(state(db, `r-${method}`), method).toEqual(before[method])
      expect(db.linkRecordingToMeeting(`r-${method}`, OTHER, 0.99, 'ai_transcript_match')).toBe(false)
      expect(state(db, `r-${method}`), method).toEqual(before[method])
    }
    close(db)
  })

  it('an automatic link still replaces an automatic link and fills an unlinked recording (control)', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r-auto', { meeting: OTHER, method: 'time_overlap', confidence: 0.7 })
    addRecording(db, 'r-unlinked', {})

    expect(db.linkRecordingToMeeting('r-auto', MEETING, 0.9, 'ai_transcript_match')).toBe(true)
    expect(state(db, 'r-auto')).toEqual({
      rec: { meeting_id: MEETING, correlation_confidence: 0.9, correlation_method: 'ai_transcript_match' },
      cap: { meeting_id: MEETING, correlation_confidence: 0.9, correlation_method: 'ai_transcript_match' }
    })
    expect(db.linkRecordingToMeeting('r-auto', OTHER, 0.8, 'jev_content_match')).toBe(true)
    expect(link(db, 'r-auto')).toEqual({ meeting_id: OTHER, correlation_method: 'jev_content_match' })

    expect(db.linkRecordingToMeeting('r-unlinked', MEETING, 0.9, 'jev_content_match')).toBe(true)
    expect(state(db, 'r-unlinked').cap).toEqual({
      meeting_id: MEETING, correlation_confidence: 0.9, correlation_method: 'jev_content_match'
    })
    close(db)
  })

  it('the owner can still change the choice: unlink, link, relink and move, each persisted', async () => {
    let { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', { meeting: MEETING, method: 'ai_transcript_match', confidence: 0.95 })

    db.selectMeetingForRecordingByUser('r1', null)
    expect(link(db, 'r1')).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })

    // From "no meeting" to a meeting, through the owner's picker.
    db.selectMeetingForRecordingByUser('r1', OTHER)
    expect(state(db, 'r1')).toEqual({
      rec: { meeting_id: OTHER, correlation_confidence: 1, correlation_method: 'user_override' },
      cap: { meeting_id: OTHER, correlation_confidence: 1, correlation_method: 'user_override' }
    })
    expect(db.linkRecordingToMeeting('r1', MEETING, 0.99, 'ai_transcript_match')).toBe(false)

    // A different human method replaces a human method, and reports it did.
    expect(db.linkRecordingToMeeting('r1', MEETING, 1.0, 'manual')).toBe(true)
    expect(link(db, 'r1')).toEqual({ meeting_id: MEETING, correlation_method: 'manual' })
    expect(state(db, 'r1').cap!.meeting_id).toBe(MEETING)
    close(db)

    ;({ db } = await boot())
    expect(link(db, 'r1')).toEqual({ meeting_id: MEETING, correlation_method: 'manual' })
    db.selectMeetingForRecording('r1', OTHER) // the older picker path
    expect(link(db, 'r1')).toEqual({ meeting_id: OTHER, correlation_method: 'user_override' })
    db.selectMeetingForRecordingByUser('r1', null)
    expect(db.linkRecordingToMeeting('r1', MEETING, 1.0, 'user_preassign')).toBe(true)
    expect(link(db, 'r1')).toEqual({ meeting_id: MEETING, correlation_method: 'user_preassign' })
    expect(db.linkRecordingToMeeting('r1', OTHER, 0.99, 'jev_content_match')).toBe(false)
    close(db)
  })

  it('a refused or failed write leaves recording and capture unchanged together', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r-atomic', { meeting: OTHER, method: 'time_overlap', confidence: 0.7 })
    const before = state(db, 'r-atomic')

    // The recording update would succeed and the capture update fails: the
    // recording must roll back instead of diverging from its capture.
    db.run(
      `CREATE TRIGGER block_capture_link BEFORE UPDATE ON knowledge_captures
       BEGIN SELECT RAISE(ABORT, 'capture update blocked'); END`
    )
    expect(() => db.linkRecordingToMeeting('r-atomic', MEETING, 0.9, 'ai_transcript_match')).toThrow(/capture update blocked/)
    expect(state(db, 'r-atomic')).toEqual(before)
    db.run('DROP TRIGGER block_capture_link')

    // With the trigger gone the same call goes through, so the rollback above was the trigger and not the fixture.
    expect(db.linkRecordingToMeeting('r-atomic', MEETING, 0.9, 'ai_transcript_match')).toBe(true)
    expect(state(db, 'r-atomic').cap!.meeting_id).toBe(MEETING)

    // A recording that does not exist is reported, not claimed.
    expect(db.linkRecordingToMeeting('no-such-recording', MEETING, 0.9, 'ai_transcript_match')).toBe(false)
    close(db)
  })

  it('schedule scoring does not replace a manual link, while an unlinked twin is still linked', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    // Same time as the practice event; the owner linked it to a different event by hand.
    addRecording(db, 'r-manual', { meeting: OTHER, method: 'manual', confidence: 1 })
    addRecording(db, 'r-twin', { capture: false })
    const before = state(db, 'r-manual')

    const manual = db.enrichRecordingScheduleMetadata('r-manual')
    const twin = db.enrichRecordingScheduleMetadata('r-twin')

    expect(twin.selectedMeetingId).toBe(MEETING) // geometry would link it
    expect(manual.selectedMeetingId).toBeNull()
    expect(state(db, 'r-manual')).toEqual(before)
    close(db)
  })
})

// persistAiMeetingResolution is what transcription.ts calls after the model answers.
// The model answer is computed first and persisted later, so each case below
// computes "the model said MEETING with high confidence" as input, lets the owner
// act in between, and only then persists.
describe('CL-08: the AI resolution cannot leave a selected candidate against the owner', () => {
  const candidates = [{ id: MEETING }, { id: OTHER }]
  const aiPicks = (db: Db, recordingId: string, linkMeetingId: string | null) =>
    db.persistAiMeetingResolution({
      recordingId,
      candidateMeetings: candidates,
      modelPickId: MEETING,
      modelConfidence: 0.95,
      modelReason: 'synthetic evidence',
      linkMeetingId,
      linkConfidence: 0.95
    })

  function selected(db: Db, id: string): string[] {
    return db
      .queryAll<{ meeting_id: string }>(
        'SELECT meeting_id FROM recording_meeting_candidates WHERE recording_id = ? AND is_selected = 1 ORDER BY meeting_id',
        [id]
      )
      .map((row) => row.meeting_id)
  }

  it('control: with no owner choice the link and the selected candidate are written together', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', {})

    expect(aiPicks(db, 'r1', MEETING)).toEqual({ linked: true })

    expect(link(db, 'r1')).toEqual({ meeting_id: MEETING, correlation_method: 'ai_transcript_match' })
    expect(state(db, 'r1').cap!.meeting_id).toBe(MEETING)
    expect(selected(db, 'r1')).toEqual([MEETING])
    close(db)
  })

  it('the owner says "no meeting" after the model answered: nothing is linked and no candidate is selected, also after restart', async () => {
    let { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', { meeting: MEETING, method: 'ai_transcript_match', confidence: 0.9 })
    // The model answered while the recording was still linked automatically.
    expect(aiPicks(db, 'r1', MEETING).linked).toBe(true)
    expect(selected(db, 'r1')).toEqual([MEETING])

    db.selectMeetingForRecordingByUser('r1', null) // the owner acts before the next persist
    const afterOwner = state(db, 'r1')
    expect(selected(db, 'r1')).toEqual([])

    expect(aiPicks(db, 'r1', MEETING)).toEqual({ linked: false })

    expect(state(db, 'r1')).toEqual(afterOwner)
    expect(selected(db, 'r1')).toEqual([])
    // The evidence is still stored for the owner to see, just not selected.
    expect(db.getCandidatesForRecording('r1').map((c) => c.meeting_id).sort()).toEqual([MEETING, OTHER].sort())
    close(db)

    ;({ db } = await boot())
    expect(state(db, 'r1')).toEqual(afterOwner)
    expect(selected(db, 'r1')).toEqual([])
    expect(aiPicks(db, 'r1', MEETING).linked).toBe(false)
    expect(selected(db, 'r1')).toEqual([])
    close(db)
  })

  it('an owner-confirmed candidate stays selected and confirmed when the model prefers another meeting', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', {})
    db.selectMeetingForRecordingByUser('r1', OTHER)
    const afterOwner = state(db, 'r1')

    // The model prefers MEETING, with a passing gate.
    expect(aiPicks(db, 'r1', MEETING)).toEqual({ linked: false })

    expect(state(db, 'r1')).toEqual(afterOwner)
    expect(selected(db, 'r1')).toEqual([OTHER])
    const confirmed = db.getCandidatesForRecording('r1').find((c) => c.meeting_id === OTHER)!
    expect(confirmed.is_user_confirmed).toBe(true)
    close(db)
  })

  it('a declined gate over an owner choice stores the evidence and selects nothing', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', {})
    db.selectMeetingForRecordingByUser('r1', null)
    const afterOwner = state(db, 'r1')

    expect(aiPicks(db, 'r1', null)).toEqual({ linked: false })

    expect(state(db, 'r1')).toEqual(afterOwner)
    expect(selected(db, 'r1')).toEqual([])
    close(db)
  })

  it('the owner can still choose after a refused AI link, and the AI still cannot undo it', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', {})
    db.selectMeetingForRecordingByUser('r1', null)
    expect(aiPicks(db, 'r1', MEETING).linked).toBe(false)

    db.selectMeetingForRecordingByUser('r1', OTHER)
    expect(link(db, 'r1')).toEqual({ meeting_id: OTHER, correlation_method: 'user_override' })
    expect(selected(db, 'r1')).toEqual([OTHER])

    expect(aiPicks(db, 'r1', MEETING).linked).toBe(false)
    expect(link(db, 'r1')).toEqual({ meeting_id: OTHER, correlation_method: 'user_override' })
    expect(selected(db, 'r1')).toEqual([OTHER])
    close(db)
  })

  it('a failure in the candidate writes rolls the link back, so link and candidates never disagree', async () => {
    const { db } = await freshBoot()
    seedMeetings(db)
    addRecording(db, 'r1', {})
    db.run(
      `CREATE TRIGGER block_candidates BEFORE INSERT ON recording_meeting_candidates
       BEGIN SELECT RAISE(ABORT, 'candidate write blocked'); END`
    )

    expect(() => aiPicks(db, 'r1', MEETING)).toThrow(/candidate write blocked/)

    expect(link(db, 'r1')).toEqual({ meeting_id: null, correlation_method: null })
    expect(state(db, 'r1').cap!.meeting_id).toBeNull()
    expect(selected(db, 'r1')).toEqual([])
    db.run('DROP TRIGGER block_candidates')
    expect(aiPicks(db, 'r1', MEETING).linked).toBe(true) // the same call works without the trigger
    close(db)
  })
})
