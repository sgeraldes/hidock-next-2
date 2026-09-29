/**
 * Jev names anonymous speakers from the roster, only when it is sure.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { buildSpeakerNameRequest, jevRoster, parseSpeakerNames, MAX_ROSTER } from '../jev-speaker-names'
import type { JevResponse } from '../jev-client'

const context = { meetingSubject: 'Avianca weekly', title: null, summary: null, named: ['SPEAKER_02: Ana'], addresses: ['SPEAKER_02: gracias Pedro'] }
const speakers = [
  { label: 'SPEAKER_00', samples: ['buenas, arranco yo'] },
  { label: 'SPEAKER_01', samples: ['sí, lo reviso'] }
]

function answer(probabilities: Record<string, number>) {
  return { type: 'choice' as const, choice: '', probabilities, confidence: 1 }
}

describe('Jev speaker names', () => {
  it('asks one choice per speaker over the roster, plus none', () => {
    const req = buildSpeakerNameRequest(speakers, ['Pedro Gómez', 'María Ruiz', 'Pedro Gómez'], context)!
    expect([...req.labels.values()]).toEqual(['SPEAKER_00', 'SPEAKER_01'])
    expect([...req.people.values()]).toEqual(['Pedro Gómez', 'María Ruiz'])
    const q = req.questions.s1
    expect(q.type).toBe('choice')
    expect(Object.keys((q as { criteria: Record<string, unknown> }).criteria)).toEqual(['p1', 'p2', 'none'])
    expect(buildSpeakerNameRequest(speakers, [], context)).toBeNull()
  })

  it('offers each person once and nobody already named', () => {
    expect(jevRoster(['Pedro', 'María Ruiz', 'Pedro Gómez', 'Ana López', 'maria'], ['Ana'])).toEqual(['Pedro Gómez', 'María Ruiz'])
    // a name that only shares a first word with another person stays
    expect(jevRoster(['Pedro Gómez', 'Pedro Ruiz'], [])).toEqual(['Pedro Gómez', 'Pedro Ruiz'])
    expect(jevRoster(['José Pérez'], ['Jose Perez'])).toEqual([])
  })

  it('caps the roster', () => {
    const many = Array.from({ length: MAX_ROSTER + 5 }, (_, i) => `Person ${i}`)
    expect(buildSpeakerNameRequest(speakers, many, context)!.people.size).toBe(MAX_ROSTER)
  })

  it('takes only sure answers, and never one person for two speakers', () => {
    const req = buildSpeakerNameRequest(speakers, ['Pedro Gómez', 'María Ruiz'], context)!
    const res = (answers: Record<string, ReturnType<typeof answer>>): JevResponse => ({ model: 'jev', answers, usage: { input_tokens: 1, output_tokens: 1 } })

    expect(parseSpeakerNames(res({ s1: answer({ p1: 0.9, p2: 0.05, none: 0.05 }), s2: answer({ p2: 0.85, p1: 0.1, none: 0.05 }) }), req)).toEqual([
      expect.objectContaining({ label: 'SPEAKER_00', name: 'Pedro Gómez' }),
      expect.objectContaining({ label: 'SPEAKER_01', name: 'María Ruiz' })
    ])
    // unsure, close second, or none: nobody named
    expect(parseSpeakerNames(res({ s1: answer({ p1: 0.7, none: 0.3 }), s2: answer({ p2: 0.55, p1: 0.45 }) }), req)).toEqual([])
    expect(parseSpeakerNames(res({ s1: answer({ none: 0.95, p1: 0.05 }) }), req)).toEqual([])
    // both pick Pedro: the surer keeps him
    expect(parseSpeakerNames(res({ s1: answer({ p1: 0.85, none: 0.05 }), s2: answer({ p1: 0.95, none: 0.05 }) }), req)).toEqual([
      expect.objectContaining({ label: 'SPEAKER_01', name: 'Pedro Gómez' })
    ])
  })
})
