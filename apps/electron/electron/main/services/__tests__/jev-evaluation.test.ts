// @vitest-environment node

/**
 * The Jev evaluation question set, its parser and the audio-versus-transcript
 * warning. Pure: no database, no network.
 */

import { describe, it, expect } from 'vitest'
import {
  buildEvaluationQuestions,
  parseEvaluation,
  evaluationToValue,
  audioTranscriptWarning,
  STAR_LEVELS,
  EVALUATION_VERSION,
  type EvaluationAudio
} from '../jev-evaluation'

function reply(answers: Record<string, unknown>) {
  return { model: 'jev-1.13.0', answers: answers as never, usage: { input_tokens: 1200, output_tokens: 60 } }
}

function audio(over: Partial<EvaluationAudio> = {}): EvaluationAudio {
  return {
    duration_seconds: 600,
    sound_seconds: 420,
    sound_share: 0.7,
    audio_category: 'speech',
    transcript_words: 1100,
    words_per_minute_of_sound: 157,
    integrity_status: 'ok',
    ...over
  }
}

describe('buildEvaluationQuestions', () => {
  it('asks every evaluation in one question set', () => {
    const q = buildEvaluationQuestions()
    expect(q.stars).toMatchObject({ type: 'score' })
    expect((q.stars as { criteria: string[] }).criteria).toEqual([...STAR_LEVELS])
    expect(q.kind.type).toBe('choice')
    expect(q.context.type).toBe('choice')
    for (const id of ['transcript_invented', 'transcript_overfull', 'has_action_items', 'sensitive', 'personal_family']) {
      expect(q[id].type).toBe('noul')
    }
  })

  it('fits the API limits (score up to 10 levels, choice up to 255 options)', () => {
    const q = buildEvaluationQuestions()
    expect((q.stars as { criteria: string[] }).criteria.length).toBeLessThanOrEqual(10)
    expect(Object.keys((q.kind as { criteria: object }).criteria).length).toBeLessThanOrEqual(255)
  })
})

describe('parseEvaluation', () => {
  it('turns the answers into typed fields', () => {
    const ev = parseEvaluation(
      reply({
        stars: { type: 'score', score: 3.4, legend: {}, probabilities: { '3': 0.6, '4': 0.4 }, confidence: 0.7 },
        kind: { type: 'choice', choice: 'interview', probabilities: {}, confidence: 0.9 },
        context: { type: 'choice', choice: 'work', probabilities: {}, confidence: 0.95 },
        transcript_invented: { type: 'noul', noul: 0.05 },
        has_action_items: { type: 'noul', noul: 0.8 },
        no_substance: { type: 'noul', noul: 0.7 },
        personal_family: { type: 'noul', noul: 0.2 }
      })
    )
    expect(ev.version).toBe(EVALUATION_VERSION)
    expect(ev.stars).toBeCloseTo(4.4)
    expect(ev.starLevel).toBe(4) // most probable level, index 3
    expect(ev.kind).toBe('interview')
    expect(ev.context).toBe('work')
    expect(ev.hasActionItems).toBe(0.8)
    expect(ev.reasons).toEqual(['no_substance'])
    expect(ev.inputTokens).toBe(1200)
  })

  it('never guesses: unknown options and missing answers become null', () => {
    const ev = parseEvaluation(
      reply({ kind: { type: 'choice', choice: 'podcast-please', probabilities: {}, confidence: 1 } })
    )
    expect(ev.kind).toBeNull()
    expect(ev.stars).toBeNull()
    expect(ev.starLevel).toBeNull()
    expect(evaluationToValue(ev)).toBeNull()
  })
})

describe('evaluationToValue', () => {
  it('maps stars onto the value the rating path uses', () => {
    const base = parseEvaluation(reply({}))
    const at = (starLevel: number) => evaluationToValue({ ...base, starLevel, starsConfidence: 0.8 })?.value
    expect(at(1)).toBe('none')
    expect(at(2)).toBe('low')
    expect(at(3)).toBe('normal')
    expect(at(4)).toBe('high')
    expect(at(5)).toBe('high')
  })
})

describe('audioTranscriptWarning', () => {
  it('flags a meaningful transcript on a silent or noise-only file as possibly invented', () => {
    expect(audioTranscriptWarning(audio({ audio_category: 'noise', sound_seconds: 4, transcript_words: 2357 }), 2)).toBe(
      'possible_invented_transcript'
    )
    expect(audioTranscriptWarning(audio({ audio_category: 'silent', sound_seconds: 0, transcript_words: 40 }), 4)).toBe(
      'possible_invented_transcript'
    )
  })

  it('flags text faster than anyone talks', () => {
    expect(
      audioTranscriptWarning(audio({ sound_seconds: 60, transcript_words: 900, words_per_minute_of_sound: 900 }), 3)
    ).toBe('possible_invented_transcript')
  })

  it('flags lots of sound with almost no words as a possibly missed transcription', () => {
    expect(
      audioTranscriptWarning(audio({ sound_seconds: 1800, transcript_words: 60, words_per_minute_of_sound: 2 }), 1)
    ).toBe('possible_missed_transcription')
  })

  it('stays quiet for an ordinary recording, and when there is nothing to judge', () => {
    expect(audioTranscriptWarning(audio(), 4)).toBeNull()
    expect(audioTranscriptWarning(audio({ audio_category: 'silent', sound_seconds: 0, transcript_words: 3 }), 1)).toBeNull()
    expect(audioTranscriptWarning(null, 5)).toBeNull()
  })
})
