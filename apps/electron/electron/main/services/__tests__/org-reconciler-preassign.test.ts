/**
 * Org Reconciler — recording pre-assignment consumption (v31).
 *
 * autoLinkRecordingsToMeetings normally links an unlinked recording to the
 * meeting it overlaps in time. A user pre-assignment (attribution chosen IN
 * ADVANCE while the device was recording) overrides that:
 *   - an explicit meeting_id wins over any time-overlap match
 *   - an explicit NULL forces the recording standalone (blocks auto-link)
 * In both cases the preassignment row is consumed (deleted) after it is applied.
 *
 * The DB module is mocked so the logic runs offline; queryAll branches on the SQL
 * text (recordings vs meetings) and `run` is a spy we assert against.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RecordingPreassignment } from '../database'

interface RecRow {
  id: string
  filename?: string
  date_recorded: string
  duration_seconds?: number
  meeting_id?: string | null
}
interface MtgRow {
  id: string
  subject: string
  start_time: string
  end_time: string
}

let recordingRows: RecRow[] = []
let meetingRows: MtgRow[] = []
let preassignRows: RecordingPreassignment[] = []
const runSpy = vi.fn()

vi.mock('../database', () => ({
  queryAll: vi.fn((sql: string) => {
    if (/FROM recordings/i.test(sql)) return recordingRows
    if (/FROM meetings/i.test(sql)) return meetingRows
    return []
  }),
  queryOne: vi.fn(() => undefined),
  run: (...args: unknown[]) => runSpy(...args),
  runInTransaction: (fn: () => unknown) => fn(),
  mergeContacts: vi.fn(),
  insertIdentitySuggestion: vi.fn(),
  getActiveCalendarSyncToken: vi.fn(() => null),
  getAllRecordingPreassignments: () => preassignRows
}))

import { autoLinkRecordingsToMeetings } from '../org-reconciler'

/** run() calls whose SQL contains `substr`. */
function runCalls(substr: string): unknown[][] {
  return runSpy.mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes(substr))
}

function recordingRunCalls(substr: string): unknown[][] {
  return runCalls(substr).filter((c) => /UPDATE recordings/i.test(c[0] as string))
}

beforeEach(() => {
  recordingRows = []
  meetingRows = []
  preassignRows = []
  runSpy.mockClear()
})

describe('autoLinkRecordingsToMeetings — pre-assignment consumption', () => {
  it('explicit meeting wins over a time-overlapping meeting', () => {
    // Recording overlaps m-overlap in time, but the user pre-assigned it to
    // m-explicit (which it does NOT overlap). The explicit choice must win.
    recordingRows = [
      { id: 'rec-A', filename: 'RecA.wav', date_recorded: '2026-07-08T10:00:00Z', duration_seconds: 1800 }
    ]
    meetingRows = [
      { id: 'm-overlap', subject: 'Standup', start_time: '2026-07-08T10:00:00Z', end_time: '2026-07-08T11:00:00Z' },
      { id: 'm-explicit', subject: 'Client call', start_time: '2026-07-08T15:00:00Z', end_time: '2026-07-08T16:00:00Z' }
    ]
    // Preassignment keyed by the DEVICE filename (.hda) must still match the .wav row.
    preassignRows = [{ filename: 'RecA.hda', meeting_id: 'm-explicit' }]

    const linked = autoLinkRecordingsToMeetings()

    expect(linked).toBe(1)
    const preassignLinks = recordingRunCalls("correlation_method = 'user_preassign'")
    expect(preassignLinks).toHaveLength(1)
    expect(preassignLinks[0][1]).toEqual(['m-explicit', 'rec-A'])
    // The overlap link must NOT have fired for this recording.
    expect(recordingRunCalls("correlation_method = 'time_overlap'")).toHaveLength(0)
    // The preassignment row is consumed by its original (device) filename.
    const deletes = runCalls('DELETE FROM recording_preassignments')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][1]).toEqual(['RecA.hda'])
  })

  it('explicit NULL forces standalone and blocks time-overlap linking', () => {
    recordingRows = [
      { id: 'rec-B', filename: 'RecB.wav', date_recorded: '2026-07-08T10:00:00Z', duration_seconds: 1800 }
    ]
    meetingRows = [
      { id: 'm-overlap', subject: 'Standup', start_time: '2026-07-08T10:00:00Z', end_time: '2026-07-08T11:00:00Z' }
    ]
    preassignRows = [{ filename: 'RecB.hda', meeting_id: null }]

    const linked = autoLinkRecordingsToMeetings()

    expect(linked).toBe(0)
    // Marked standalone, not linked to any meeting.
    const standalone = recordingRunCalls("correlation_method = 'user_preassign_standalone'")
    expect(standalone).toHaveLength(1)
    expect(standalone[0][1]).toEqual(['rec-B'])
    expect(recordingRunCalls("correlation_method = 'time_overlap'")).toHaveLength(0)
    expect(recordingRunCalls("correlation_method = 'user_preassign'")).toHaveLength(0)
    // Preassignment consumed.
    const deletes = runCalls('DELETE FROM recording_preassignments')
    expect(deletes[0][1]).toEqual(['RecB.hda'])
  })

  it('falls back to time-overlap when there is no pre-assignment', () => {
    recordingRows = [
      { id: 'rec-C', filename: 'RecC.wav', date_recorded: '2026-07-08T10:00:00Z', duration_seconds: 1800 }
    ]
    meetingRows = [
      { id: 'm-overlap', subject: 'Standup', start_time: '2026-07-08T10:00:00Z', end_time: '2026-07-08T11:00:00Z' }
    ]
    preassignRows = []

    const linked = autoLinkRecordingsToMeetings()

    expect(linked).toBe(1)
    const overlap = recordingRunCalls("correlation_method = 'time_overlap'")
    expect(overlap).toHaveLength(1)
    expect(overlap[0][1]).toEqual(['m-overlap', 'rec-C'])
    const captureOverlap = runCalls('UPDATE knowledge_captures').filter((call) =>
      (call[0] as string).includes("correlation_method = 'time_overlap'")
    )
    expect(captureOverlap).toHaveLength(1)
    expect(captureOverlap[0][1]).toEqual(['m-overlap', 'rec-C'])
    expect(runCalls('DELETE FROM recording_preassignments')).toHaveLength(0)
  })
})

describe('autoLinkRecordingsToMeetings — connector meetings', () => {
  it('reads Microsoft 365 meetings next to the active ICS snapshot', async () => {
    const db = await import('../database')
    vi.mocked(db.getActiveCalendarSyncToken).mockReturnValueOnce('ics-token')
    recordingRows = [{ id: 'rec-M', filename: 'RecM.wav', date_recorded: '2026-08-07T17:00:00Z', duration_seconds: 1800 }]
    meetingRows = [{ id: 'm365:AAMk1', subject: 'DevOps weekly', start_time: '2026-08-07T17:00:00Z', end_time: '2026-08-07T18:00:00Z' }]
    autoLinkRecordingsToMeetings()
    const meetingQuery = vi.mocked(db.queryAll).mock.calls.map((c) => String(c[0])).filter((sql) => /FROM meetings/i.test(sql))
      .at(-1)
    expect(meetingQuery).toContain("id LIKE 'm365%:%'")
    expect(recordingRunCalls('time_overlap')).toHaveLength(1)
  })
})

describe('autoLinkRecordingsToMeetings — duplicate meetings and nearby windows', () => {
  it('orders meetings with the connector copy first, so it wins an equal fit', async () => {
    const db = await import('../database')
    vi.mocked(db.getActiveCalendarSyncToken).mockReturnValueOnce('ics-token')
    recordingRows = [{ id: 'rec-D', filename: 'RecD.wav', date_recorded: '2026-08-07T10:05:00Z', duration_seconds: 1800 }]
    // The mocked DB returns rows in the order the SQL asks for: connector first.
    meetingRows = [
      { id: 'm365:AAMk9', subject: 'Weekly', start_time: '2026-08-07T10:00:00Z', end_time: '2026-08-07T11:00:00Z' },
      { id: 'ics-uid-9', subject: 'Weekly', start_time: '2026-08-07T10:00:00Z', end_time: '2026-08-07T11:00:00Z' }
    ]
    autoLinkRecordingsToMeetings()
    const sql = vi.mocked(db.queryAll).mock.calls.map((c) => String(c[0])).filter((s) => /FROM meetings/i.test(s)).at(-1)
    expect(sql).toMatch(/ORDER BY CASE WHEN/)
    const link = recordingRunCalls('time_overlap')[0]
    expect(link[1]).toEqual(['m365:AAMk9', 'rec-D'])
  })
})

describe('windowsNear', () => {
  it('keeps every meeting that can overlap the recording and drops the ones that cannot', async () => {
    const { windowsNear } = await import('../org-reconciler')
    const h = 3600_000
    const sorted = [
      { id: 'old', start: 0, end: h, isAllDay: false },
      { id: 'allday', start: 9 * h, end: 33 * h, isAllDay: true },
      { id: 'near', start: 10 * h, end: 11 * h, isAllDay: false },
      { id: 'later', start: 40 * h, end: 41 * h, isAllDay: false }
    ]
    const starts = sorted.map((w) => w.start)
    const ids = windowsNear(sorted, starts, 24 * h, 10.5 * h, 10.9 * h).map((w) => w.id)
    // A superset bounded by the longest meeting: the selector still checks overlap.
    expect(ids).toEqual(expect.arrayContaining(['allday', 'near']))
    expect(ids).not.toContain('later')
    expect(windowsNear(sorted, starts, 2 * h, 10.5 * h, 10.9 * h).map((w) => w.id)).toEqual(['allday', 'near'])
  })
})
