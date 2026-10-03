// @vitest-environment node

/**
 * The Jev identity tiebreak questions (spec 2026-10-03, 3a.4 and 3b): what Jev reads, and when
 * its answer counts.
 */

import { describe, expect, it } from 'vitest'
import type { JevResponse } from '../jev-client'
import {
  buildMentionTiebreakRequest,
  mentionTurns,
  parseMentionTiebreak,
  parseMergeTiebreak,
  MAX_MENTION_WORDS
} from '../jev-identity-tiebreak'

const answer = (probabilities: Record<string, number>): JevResponse => ({
  model: 'jev',
  answers: { who: { type: 'choice', choice: Object.keys(probabilities)[0], probabilities, confidence: 0.9 } },
  usage: { input_tokens: 1, output_tokens: 1 }
})

describe('mentionTurns', () => {
  it('keeps only the turns that say the name as a word, accent and case folded', () => {
    const turns = [
      { speaker: 'S1', text: 'Hola SERGIO, ¿cómo va?' },
      { speaker: 'S2', text: 'Sergiolandia is a place, not a name.' },
      { speaker: 'S3', text: 'Nothing here.' },
      { speaker: 'S1', text: 'Gracias, Sérgio.' }
    ]
    expect(mentionTurns(turns, 'Sergio')).toEqual(['S1: Hola SERGIO, ¿cómo va?', 'S1: Gracias, Sérgio.'])
  })

  it('stops at about 2,000 words', () => {
    const long = Array.from({ length: 900 }, () => 'word').join(' ')
    const turns = Array.from({ length: 5 }, (_, i) => ({ speaker: `S${i}`, text: `Sergio ${long}` }))
    const out = mentionTurns(turns, 'Sergio')
    const words = out.reduce((n, t) => n + t.split(/\s+/).length - 1, 0)
    expect(words).toBe(MAX_MENTION_WORDS)
    expect(out).toHaveLength(3)
  })
})

describe('mention tiebreak', () => {
  const request = buildMentionTiebreakRequest({
    name: 'Sergio',
    meetingSubject: 'Ops',
    attendees: ['Sergio Hurtado', 'Sergio Reyes'],
    turns: ['S1: Sergio, the report'],
    candidates: [
      { id: 'sh', name: 'Sergio Hurtado', support: ['attended the meeting'] },
      { id: 'sr', name: 'Sergio Reyes', support: ['voice in the recording'] }
    ]
  })!

  it('needs two candidates and a turn', () => {
    expect(buildMentionTiebreakRequest({ name: 'S', meetingSubject: null, attendees: [], turns: [], candidates: [] })).toBeNull()
    expect(request.options).toEqual(new Map([['c1', 'sh'], ['c2', 'sr']]))
  })

  it('never offers a candidate without objective support, and needs two that have it', () => {
    const withUnsupported = buildMentionTiebreakRequest({
      name: 'Sergio',
      meetingSubject: null,
      attendees: [],
      turns: ['S1: Sergio, hi'],
      candidates: [
        { id: 'sh', name: 'Sergio Hurtado', support: ['attended the meeting'] },
        { id: 'sr', name: 'Sergio Reyes', support: ['voice in the recording'] },
        { id: 'sx', name: 'Sergio Xu', support: [] }
      ]
    })!
    expect([...withUnsupported.options.values()]).toEqual(['sh', 'sr'])
    expect(JSON.stringify(withUnsupported.questions)).not.toContain('Sergio Xu')
    expect(
      buildMentionTiebreakRequest({
        name: 'Sergio',
        meetingSubject: null,
        attendees: [],
        turns: ['S1: Sergio, hi'],
        candidates: [
          { id: 'sh', name: 'Sergio Hurtado', support: ['attended the meeting'] },
          { id: 'sx', name: 'Sergio Xu', support: [] }
        ]
      })
    ).toBeNull()
  })

  it('counts a choice at 0.8 or more with a margin of 0.3 or more, by contact id', () => {
    expect(parseMentionTiebreak(answer({ c1: 0.8, c2: 0.1, none: 0.1 }), request)).toMatchObject({
      contactId: 'sh',
      probabilities: { sh: 0.8, sr: 0.1, none: 0.1 }
    })
    expect(parseMentionTiebreak(answer({ c1: 0.79, c2: 0.11, none: 0.1 }), request)?.contactId).toBeNull()
    expect(parseMentionTiebreak(answer({ c1: 0.85, c2: 0.6 }), request)?.contactId).toBeNull()
    expect(parseMentionTiebreak(answer({ none: 0.95, c1: 0.05 }), request)?.contactId).toBeNull()
  })
})

describe('merge tiebreak', () => {
  it('says same only for a sure, clear "same"', () => {
    expect(parseMergeTiebreak(answer({ same: 0.9, different: 0.05, none: 0.05 }))?.same).toBe(true)
    expect(parseMergeTiebreak(answer({ same: 0.7, different: 0.2, none: 0.1 }))?.same).toBe(false)
    expect(parseMergeTiebreak(answer({ different: 0.9, same: 0.05, none: 0.05 }))?.same).toBe(false)
  })
})
