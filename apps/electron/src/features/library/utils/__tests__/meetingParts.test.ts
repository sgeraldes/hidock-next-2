import { describe, it, expect } from 'vitest'
import { withMeetingParts } from '../meetingParts'
import type { UnifiedRecording } from '@/types/unified-recording'

/**
 * Recordings linked to the same meeting are numbered by start time, so two
 * rows with one title read as two parts of one meeting (owner chose, 2-oct-2026).
 */

const rec = (id: string, at: string, meetingId?: string): UnifiedRecording =>
  ({
    id,
    filename: `${id}.hda`,
    size: 1,
    duration: 60,
    dateRecorded: new Date(at),
    transcriptionStatus: 'complete',
    location: 'local-only',
    localPath: `/r/${id}.wav`,
    syncStatus: 'synced',
    meetingId
  }) as UnifiedRecording

describe('withMeetingParts', () => {
  it('numbers the recordings of one meeting by start time, newest-first input or not', () => {
    const out = withMeetingParts([
      rec('b', '2026-10-01T15:42:00Z', 'itau'),
      rec('x', '2026-10-01T14:00:00Z', 'delivery'),
      rec('a', '2026-10-01T15:24:00Z', 'itau')
    ])
    const byId = Object.fromEntries(out.map((r) => [r.id, r.meetingPart]))
    expect(byId.a).toEqual({ index: 1, total: 2 })
    expect(byId.b).toEqual({ index: 2, total: 2 })
    expect(byId.x).toBeUndefined()
    // Order is kept.
    expect(out.map((r) => r.id)).toEqual(['b', 'x', 'a'])
  })

  it('leaves recordings with no meeting alone and returns the same objects when nothing changes', () => {
    const input = [rec('n1', '2026-10-01T10:00:00Z'), rec('n2', '2026-10-01T11:00:00Z', 'solo')]
    const out = withMeetingParts(input)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[1])
  })

  it('drops a stale part number when a recording no longer shares its meeting', () => {
    const stale = { ...rec('s', '2026-10-01T10:00:00Z', 'm'), meetingPart: { index: 2, total: 2 } }
    expect(withMeetingParts([stale])[0].meetingPart).toBeUndefined()
  })
})
