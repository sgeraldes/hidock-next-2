// @vitest-environment node

/**
 * Jev meeting match: the request it builds, how it reads the answer, when an
 * answer is clear enough to link, and that a stored answer is reused.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildMeetingMatchRequest,
  candidateKey,
  isClearMatch,
  matchMeetingWithJev,
  parseMeetingMatch,
  pickMatchCandidates,
  MAX_MATCH_CANDIDATES,
  type MatchCandidate,
  type MeetingMatch
} from '../jev-meeting-match'

const context = {
  title: 'Configuración de certificados y coordinación ALB',
  summary: 'The team set up TLS certificates on the load balancer for Antamina.',
  transcriptText: 'Vamos a configurar los certificados en el ALB para Antamina. '.repeat(10),
  recordingStart: '2026-09-24T15:09:46.000Z',
  durationSeconds: 2220
}

function candidate(id: string, subject: string, over: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    meetingId: id,
    subject,
    startTime: '2026-09-24T15:00:00.000Z',
    endTime: '2026-09-24T16:00:00.000Z',
    organizer: 'Sebastián Geraldes',
    attendees: ['Carlos', 'Sergio Reyes'],
    hasOverlap: true,
    timeScore: 0.72,
    ...over
  }
}

const lunch = candidate('ics-lunch', 'Almuerzo', { attendees: [] })
const daily = candidate('m365:daily', 'Daily Cloud: DFX5 + Antamina')

function reply(probabilities: Record<string, number>) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
  return {
    model: 'jev-1.13.0',
    answers: { meeting: { type: 'choice' as const, choice, probabilities, confidence: 0.9 } },
    usage: { input_tokens: 1800, output_tokens: 20 }
  }
}

describe('buildMeetingMatchRequest', () => {
  it('asks one choice with each meeting described and a "none" option', () => {
    const { state, questions, keys } = buildMeetingMatchRequest(context, [lunch, daily])
    const q = questions.meeting as { type: string; criteria: Record<string, string> }
    expect(q.type).toBe('choice')
    expect(Object.keys(q.criteria)).toEqual(['m1', 'm2', 'none'])
    expect(q.criteria.m2).toContain('"Daily Cloud: DFX5 + Antamina"')
    expect(q.criteria.m2).toContain('attendees: Carlos, Sergio Reyes')
    expect(keys.get('m1')).toBe('ics-lunch')
    expect((state as { recording: { transcript_excerpt: string } }).recording.transcript_excerpt).toContain('certificados')
  })
})

describe('parseMeetingMatch', () => {
  it('maps the answer back to meeting ids and measures the margin', () => {
    const { keys } = buildMeetingMatchRequest(context, [lunch, daily])
    const match = parseMeetingMatch(reply({ m1: 0.03, m2: 0.9, none: 0.07 }), keys, 'k')!
    expect(match.probabilities).toEqual({ 'ics-lunch': 0.03, 'm365:daily': 0.9 })
    expect(match.topMeetingId).toBe('m365:daily')
    expect(match.margin).toBeCloseTo(0.83)
    expect(isClearMatch(match)).toBe(true)
  })

  it('reports "none" as no meeting, and a close call as not clear', () => {
    const { keys } = buildMeetingMatchRequest(context, [lunch, daily])
    const none = parseMeetingMatch(reply({ m1: 0.05, m2: 0.1, none: 0.85 }), keys, 'k')!
    expect(none.topMeetingId).toBeNull()
    expect(isClearMatch(none)).toBe(false)
    const close = parseMeetingMatch(reply({ m1: 0.45, m2: 0.5, none: 0.05 }), keys, 'k')!
    expect(isClearMatch(close)).toBe(false)
  })
})

describe('pickMatchCandidates', () => {
  it('sends overlapping meetings first and at most the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`n${i}`, `Nearby ${i}`, { hasOverlap: false, timeScore: i / 100 }))
    const picked = pickMatchCandidates([...many, daily])
    expect(picked).toHaveLength(MAX_MATCH_CANDIDATES)
    expect(picked[0].meetingId).toBe('m365:daily')
  })
})

describe('matchMeetingWithJev', () => {
  it('asks Jev once, then reuses the stored answer for the same candidates', async () => {
    let stored: MeetingMatch | null = null
    const ask = vi.fn(async () => reply({ m1: 0.02, m2: 0.93, none: 0.05 }))
    const deps = { apiKey: 'k', load: () => stored, save: (_id: string, m: MeetingMatch) => (stored = m), ask }
    const first = await matchMeetingWithJev('rec-1', context, [lunch, daily], deps)
    expect(first?.topMeetingId).toBe('m365:daily')
    await matchMeetingWithJev('rec-1', context, [lunch, daily], deps)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(stored!.candidateKey).toBe(candidateKey(pickMatchCandidates([lunch, daily])))
  })

  it('does not ask with fewer than two candidates, without a key, or without text', async () => {
    const ask = vi.fn()
    const deps = { apiKey: 'k', load: () => null, save: vi.fn(), ask }
    expect(await matchMeetingWithJev('r', context, [daily], deps)).toBeNull()
    expect(await matchMeetingWithJev('r', context, [lunch, daily], { ...deps, apiKey: ' ' })).toBeNull()
    expect(await matchMeetingWithJev('r', { ...context, transcriptText: null, summary: null }, [lunch, daily], deps)).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })
})
