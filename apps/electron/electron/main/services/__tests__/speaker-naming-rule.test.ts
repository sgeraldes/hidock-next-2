// @vitest-environment node

/**
 * Per-speaker naming (owner decision A, 29-sep-2026): the recording only has to
 * be grounded in the audio, each speaker is judged on its own turns, and shaky
 * turns are never evidence.
 */
import { describe, it, expect } from 'vitest'
import { isSolidTurn, nameableSpeakers, namingAllowed, namingEvidence, NAMING_MIN_SOLID_TURNS } from '../diarization-quality'

const turn = (speaker: string, speakerAttribution?: string, text = 'hola') => ({ speaker, text, speakerAttribution })
const many = (speaker: string, n: number, attribution?: string) => Array.from({ length: n }, () => turn(speaker, attribution))

describe('speaker naming rule', () => {
  it('treats shaky, unattributed and empty turns as no evidence, and old turns as solid', () => {
    expect(isSolidTurn(turn('A', 'acoustic'))).toBe(true)
    expect(isSolidTurn(turn('A'))).toBe(true)
    expect(isSolidTurn(turn('A', 'acoustic-weak'))).toBe(false)
    expect(isSolidTurn(turn('A', 'unresolved'))).toBe(false)
    expect(isSolidTurn(turn('', 'acoustic'))).toBe(false)
    expect(isSolidTurn(turn('A', 'acoustic', '  '))).toBe(false)
  })

  it('names a speaker with enough solid turns and few shaky ones, and no other', () => {
    const turns = [
      ...many('solid', NAMING_MIN_SOLID_TURNS),
      ...many('few', NAMING_MIN_SOLID_TURNS - 1),
      ...many('shaky', 6), ...many('shaky', 4, 'acoustic-weak'), // 40% shaky
      ...many('edge', 8), ...many('edge', 2, 'acoustic-weak'), // exactly 20%
      ...many('ghost', 9, 'unresolved')
    ]
    expect([...nameableSpeakers(turns)].sort()).toEqual(['edge', 'solid'])
  })

  it('uses the per-speaker minimum only on a degraded recording, and never a shaky turn', () => {
    const turns = [...many('long', 6), turn('short', 'acoustic', 'soy Ana'), turn('long', 'acoustic-weak', 'guess')]
    const speakers = (q: string | null) => namingEvidence(turns, q).map((t) => t.speaker)
    expect(new Set(speakers(JSON.stringify({ status: 'degraded' })))).toEqual(new Set(['long']))
    expect(new Set(speakers(JSON.stringify({ status: 'high' })))).toEqual(new Set(['long', 'short']))
    expect(new Set(speakers(null))).toEqual(new Set(['long', 'short']))
    expect(namingEvidence(turns, null).some((t) => t.text === 'guess')).toBe(false)
  })

  it('allows naming on a grounded recording even with some shaky segments', () => {
    const base = { coverageRatio: 1, groundingRatio: 1, mixedLabelSchemes: false }
    expect(namingAllowed({ status: 'high', ...base })).toBe(true)
    // the 2 h 27 min meeting: 11 unattributed and 31 shaky of 933, fully grounded
    expect(namingAllowed({ status: 'degraded', ...base })).toBe(true)
    expect(namingAllowed({ status: 'degraded', ...base, coverageRatio: 0.4 })).toBe(false)
    expect(namingAllowed({ status: 'degraded', ...base, groundingRatio: 0.7 })).toBe(false)
    expect(namingAllowed({ status: 'degraded', ...base, mixedLabelSchemes: true })).toBe(false)
    expect(namingAllowed({ status: 'failed', ...base })).toBe(false)
    expect(namingAllowed({ status: 'unavailable', ...base })).toBe(false)
    expect(namingAllowed(null)).toBe(true) // older transcripts without a report
  })
})
