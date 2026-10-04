// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

vi.mock('../database', () => ({}))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {} }) }))
const decisionStatus = vi.hoisted(() => ({ available: true }))
vi.mock('../pipeline/decision-engines', () => ({ hasDecisionEngine: async () => decisionStatus.available }))

import { collapseMeetingCopies, jevMeetingMatchDeps, meetingCopyKey } from '../meeting-candidate-list'

it('permits meeting decisions without a Jev key when another engine is available', async () => {
  expect(await jevMeetingMatchDeps()).toMatchObject({ apiKey: '' })
  decisionStatus.available = false
  expect(await jevMeetingMatchDeps()).toBeNull()
  decisionStatus.available = true
})

function row(meetingId: string, subject: string, startTime: string, over: Record<string, unknown> = {}) {
  return {
    id: `c-${meetingId}`,
    recordingId: 'r',
    meetingId,
    subject,
    startTime,
    endTime: startTime,
    confidenceScore: 0.72,
    matchReason: null,
    isAiSelected: false,
    isUserConfirmed: false,
    isAllDay: false,
    ...over
  }
}

describe('collapseMeetingCopies', () => {
  const ics = row('ics-1', 'Daily Cloud', '2026-09-24T15:00:00.000Z')
  const m365 = row('m365:AAMk1', 'daily cloud ', '2026-09-24T15:00:00Z')
  const lunch = row('ics-2', 'Almuerzo', '2026-09-24T15:00:00.000Z')

  it('keeps one candidate per meeting, the Microsoft 365 copy by default', () => {
    expect(collapseMeetingCopies([ics, m365, lunch], null).map((c) => c.meetingId)).toEqual(['m365:AAMk1', 'ics-2'])
  })

  it('keeps the copy the recording is linked to, and a confirmed one above all', () => {
    expect(collapseMeetingCopies([ics, m365], 'ics-1').map((c) => c.meetingId)).toEqual(['ics-1'])
    const confirmed = { ...ics, isUserConfirmed: true }
    expect(collapseMeetingCopies([confirmed, m365], 'm365:AAMk1').map((c) => c.meetingId)).toEqual(['ics-1'])
  })

  it('keeps two meetings from the same source with the same subject and start', () => {
    const other = row('m365:AAMk2', 'Daily Cloud', '2026-09-24T15:00:00Z')
    expect(collapseMeetingCopies([m365, other], null).map((c) => c.meetingId)).toEqual(['m365:AAMk1', 'm365:AAMk2'])
    // With one feed copy, it pairs with one of them and the other stays.
    expect(collapseMeetingCopies([ics, m365, other], null).map((c) => c.meetingId)).toEqual(['m365:AAMk1', 'm365:AAMk2'])
  })

  it('treats the same subject at another time as another meeting', () => {
    expect(meetingCopyKey('Daily', '2026-09-24T15:00:00Z')).not.toBe(meetingCopyKey('Daily', '2026-09-25T15:00:00Z'))
  })
})
