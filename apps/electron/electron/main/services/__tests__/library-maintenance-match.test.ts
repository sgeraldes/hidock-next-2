// @vitest-environment node

/**
 * "Match meetings with Jev": links clear answers, moves a wrong time-based
 * link, leaves links a person set, and stops when Jev rejects the key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Rec {
  id: string
  meeting_id: string | null
  correlation_method: string | null
  date_recorded: string
  duration_seconds: number
}

const recordings = new Map<string, Rec>()
const meetings = new Map<string, { subject: string; start_time: string }>([
  ['lunch', { subject: 'Almuerzo', start_time: '2026-09-24T15:00:00Z' }],
  ['daily', { subject: 'Daily Cloud', start_time: '2026-09-24T15:00:00Z' }],
  ['ics-daily', { subject: 'Daily Cloud', start_time: '2026-09-24T15:00:00Z' }]
])
const linkRecordingToMeeting = vi.fn()

vi.mock('../database', () => ({
  queryAll: vi.fn(() => [...recordings.keys()].map((id) => ({ id }))),
  queryOne: vi.fn(() => ({ n: 0 })),
  run: vi.fn(),
  getRecordingById: (id: string) => recordings.get(id) ?? null,
  getRecordingMeetingMatch: () => null,
  getMeetingById: (id: string) => meetings.get(id) ?? null,
  linkRecordingToMeeting: (...args: unknown[]) => linkRecordingToMeeting(...args)
}))
vi.mock('../audio-profile-store', () => ({ envelopePath: (id: string) => id }))
vi.mock('../waveform-cache', () => ({ getWaveformCache: () => null, setWaveformCache: () => true }))
vi.mock('../value-classification', () => ({ recomputeAudioWarnings: async () => 0 }))
vi.mock('../recording-eligibility', () => ({
  filterEligibleRecordingIds: (ids: string[]) => ({ eligible: new Set(ids), failClosed: false })
}))
vi.mock('../value-backfill', () => ({ isClassifierAuthError: (e: { status?: number }) => e?.status === 401 }))

const candidates = [
  { meetingId: 'lunch', subject: 'Almuerzo', startTime: 'a', endTime: 'b', hasOverlap: true, timeScore: 0.72, attendees: [] },
  { meetingId: 'daily', subject: 'Daily Cloud', startTime: 'a', endTime: 'b', hasOverlap: true, timeScore: 0.72, attendees: [] }
]
vi.mock('../meeting-candidate-list', () => ({
  jevMeetingMatchDeps: () => ({ apiKey: 'k', load: () => null, save: () => undefined }),
  listMeetingCandidates: () => ({}),
  toMatchCandidates: () => candidates,
  toMatchContext: () => ({ title: 't', summary: 's', transcriptText: 'x', recordingStart: 'a', durationSeconds: 60 })
}))

const askJev = vi.fn()
vi.mock('../jev-client', () => ({ askJev: (...args: unknown[]) => askJev(...args), JEV_MODEL: 'jev-latest' }))

import { matchMeetingsWithJev } from '../library-maintenance'

function reply(m1: number, m2: number, none: number) {
  return { model: 'jev', answers: { meeting: { type: 'choice', choice: 'm2', probabilities: { m1, m2, none }, confidence: 0.9 } }, usage: { input_tokens: 10 } }
}

beforeEach(() => {
  recordings.clear()
  vi.clearAllMocks()
})

describe('matchMeetingsWithJev', () => {
  it('links a clear answer, moves a wrong time link, and leaves a link the person set', async () => {
    recordings.set('unlinked', { id: 'unlinked', meeting_id: null, correlation_method: null, date_recorded: 'a', duration_seconds: 60 })
    recordings.set('wrong', { id: 'wrong', meeting_id: 'lunch', correlation_method: 'time_overlap', date_recorded: 'a', duration_seconds: 60 })
    recordings.set('manual', { id: 'manual', meeting_id: 'lunch', correlation_method: 'manual', date_recorded: 'a', duration_seconds: 60 })
    askJev.mockResolvedValue(reply(0.03, 0.9, 0.07))

    const result = await matchMeetingsWithJev()

    expect(result).toMatchObject({ checked: 3, asked: 2, linked: 1, relinked: 1, skipped: 1, stoppedOnAuth: false })
    const linked = linkRecordingToMeeting.mock.calls.map((c) => [c[0], c[1], c[3]])
    expect(linked).toEqual(
      expect.arrayContaining([
        ['unlinked', 'daily', 'jev_content_match'],
        ['wrong', 'daily', 'jev_content_match']
      ])
    )
    expect(linked.find((c) => c[0] === 'manual')).toBeUndefined()
  })

  it('does not link a close call or a "none" answer', async () => {
    recordings.set('r1', { id: 'r1', meeting_id: null, correlation_method: null, date_recorded: 'a', duration_seconds: 60 })
    askJev.mockResolvedValue(reply(0.1, 0.1, 0.8))
    const result = await matchMeetingsWithJev()
    expect(result).toMatchObject({ noMatch: 1, linked: 0 })
    expect(linkRecordingToMeeting).not.toHaveBeenCalled()
  })

  it('stops when Jev rejects the key', async () => {
    for (let i = 0; i < 20; i++) {
      recordings.set(`r${i}`, { id: `r${i}`, meeting_id: null, correlation_method: null, date_recorded: 'a', duration_seconds: 60 })
    }
    askJev.mockRejectedValue(Object.assign(new Error('Jev returned HTTP 401'), { status: 401 }))
    const result = await matchMeetingsWithJev()
    expect(result).toMatchObject({ stoppedOnAuth: true })
    expect(askJev.mock.calls.length).toBeLessThan(20)
  })

  it('with dryRun lists the links it would make and changes nothing', async () => {
    recordings.set('wrong', { id: 'wrong', meeting_id: 'lunch', correlation_method: 'time_overlap', date_recorded: 'a', duration_seconds: 60 })
    askJev.mockResolvedValue(reply(0.03, 0.9, 0.07))
    const result = await matchMeetingsWithJev({ dryRun: true })
    expect(linkRecordingToMeeting).not.toHaveBeenCalled()
    expect(result).toMatchObject({ relinked: 1, planned: [{ recordingId: 'wrong', from: 'lunch', to: 'daily' }] })
  })

  it('does not move a recording between two copies of the same meeting', async () => {
    recordings.set('copy', { id: 'copy', meeting_id: 'ics-daily', correlation_method: 'time_overlap', date_recorded: 'a', duration_seconds: 60 })
    askJev.mockResolvedValue(reply(0.03, 0.9, 0.07))
    const result = await matchMeetingsWithJev()
    expect(linkRecordingToMeeting).not.toHaveBeenCalled()
    expect(result).toMatchObject({ relinked: 0, linked: 0 })
  })
})
