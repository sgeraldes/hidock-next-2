import { describe, it, expect } from 'vitest'
import { withMeetingParts } from '../meetingParts'
import type { UnifiedRecording } from '@/types/unified-recording'

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
  it('does not number distinct recordings merely because they share a calendar event', () => {
    const input = [
      rec('slack-call', '2026-10-07T15:56:12Z', 'practice'),
      rec('practice-call', '2026-10-07T15:08:00Z', 'practice')
    ]
    const out = withMeetingParts(input)

    expect(out).toBe(input)
    expect(out.map((recording) => recording.meetingPart)).toEqual([undefined, undefined])
    expect(out.map((recording) => recording.id)).toEqual(['slack-call', 'practice-call'])
  })

  it('leaves recordings with no meeting alone and returns the same objects when nothing changes', () => {
    const input = [rec('n1', '2026-10-01T10:00:00Z'), rec('n2', '2026-10-01T11:00:00Z', 'solo')]
    const out = withMeetingParts(input)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[1])
  })

  it('clears cached part labels while preserving split filenames and custom titles', () => {
    const part2 = {
      ...rec('part2', '2026-10-01T11:00:00Z', 'same-event'),
      filename: 'Capture - Part 2.hda',
      meetingPart: { index: 2, total: 2 },
      userTitle: 'Slack ad hoc'
    }
    const part1 = {
      ...rec('part1', '2026-10-01T10:00:00Z', 'same-event'),
      filename: 'Capture - Part 1.hda',
      meetingPart: { index: 1, total: 2 }
    }
    const input = [part2, part1]
    const out = withMeetingParts(input)

    expect(out).not.toBe(input)
    expect(out.map((recording) => recording.meetingPart)).toEqual([undefined, undefined])
    expect(out.map((recording) => recording.filename)).toEqual(['Capture - Part 2.hda', 'Capture - Part 1.hda'])
    expect(out[0].userTitle).toBe('Slack ad hoc')
    expect(out.map((recording) => recording.id)).toEqual(['part2', 'part1'])
  })
})
