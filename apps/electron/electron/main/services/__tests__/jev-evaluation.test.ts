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
  starLevelFor,
  evidenceCap,
  rulesEvaluation,
  withEvidence,
  RULES_MODEL,
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
    for (const id of ['has_action_items', 'sensitive', 'personal_family']) {
      expect(q[id].type).toBe('noul')
    }
  })

  // Owner, 4-oct-2026: an LLM cannot tell invented text. Validity is decided
  // before this call (transcript-validity.ts), so Jev is never asked it.
  it('asks nothing about whether the transcript is real', () => {
    const q = buildEvaluationQuestions()
    expect(q.transcript_invented).toBeUndefined()
    expect(q.transcript_overfull).toBeUndefined()
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
    expect(audioTranscriptWarning(audio({ audio_category: 'noise', sound_seconds: 4, transcript_words: 2357 }))).toBe(
      'possible_invented_transcript'
    )
    expect(audioTranscriptWarning(audio({ audio_category: 'silent', sound_seconds: 0, transcript_words: 140 }))).toBe(
      'possible_invented_transcript'
    )
  })

  it('never reads the stars: a categorization cannot feed a validation', () => {
    expect(audioTranscriptWarning(audio({ audio_category: 'silent', sound_seconds: 0, transcript_words: 40 }))).toBeNull()
  })

  it('flags text faster than anyone talks over the whole recording', () => {
    // 18 minutes, 7,466 words: 415 words per minute (Rec58, 28-sep).
    expect(audioTranscriptWarning(audio({ duration_seconds: 1080, sound_seconds: 716, transcript_words: 7466 }))).toBe(
      'possible_invented_transcript'
    )
  })

  it('does not flag real recordings the first rule caught (28-sep pass)', () => {
    // A 33-second clip with 24 seconds of sound and 72 words (Rec78).
    expect(
      audioTranscriptWarning(audio({ duration_seconds: 33, sound_seconds: 24, sound_share: 0.75, transcript_words: 72 }))
    ).toBeNull()
    // A 105-minute workshop, 56% sound, 18,743 words: fast on "seconds of sound", normal on the recording (Rec71).
    expect(
      audioTranscriptWarning(
        audio({ duration_seconds: 6290, sound_seconds: 3497, sound_share: 0.556, transcript_words: 18743, words_per_minute_of_sound: 322 })
      )
    ).toBeNull()
  })

  it('flags a long file that is almost all quiet even when the audio check calls it speech', () => {
    // 3 minutes, 7 seconds of sound, 589 words (Rec11).
    expect(
      audioTranscriptWarning(audio({ duration_seconds: 185, sound_seconds: 7, sound_share: 0.035, transcript_words: 589 }))
    ).toBe('possible_invented_transcript')
  })

  it('flags lots of sound with almost no words as a possibly missed transcription', () => {
    expect(
      audioTranscriptWarning(audio({ sound_seconds: 1800, transcript_words: 60, words_per_minute_of_sound: 2 }))
    ).toBe('possible_missed_transcription')
  })

  it('stays quiet for an ordinary recording, and when there is nothing to judge', () => {
    expect(audioTranscriptWarning(audio())).toBeNull()
    expect(audioTranscriptWarning(audio({ audio_category: 'silent', sound_seconds: 0, transcript_words: 3 }))).toBeNull()
    expect(audioTranscriptWarning(null)).toBeNull()
  })
})

// Owner, 3-oct-2026: Rec02 (noise only) showed "5★ Media playing". Jev's
// answer was 20% one star and 50% five stars with confidence 0.
describe('star level and the evidence', () => {
  const rec02 = { '0': 0.2, '1': 0.16, '2': 0.05, '3': 0.09, '4': 0.5 }

  it('never turns an answer with no confidence into four or five stars', () => {
    expect(starLevelFor(3.51, rec02, 0)).toBe(3)
    expect(starLevelFor(4.6, { '4': 0.6, '3': 0.4 }, 0.3)).toBe(3)
    expect(starLevelFor(1.4, { '0': 0.6, '1': 0.4 }, 0.1)).toBe(1)
  })

  it('keeps the most probable level when Jev is confident', () => {
    expect(starLevelFor(4.4, { '3': 0.6, '4': 0.4 }, 0.7)).toBe(4)
    expect(starLevelFor(4.9, rec02, 0.5)).toBe(5)
  })

  it('parses Rec02 as three stars, not five', () => {
    const ev = parseEvaluation(reply({ stars: { type: 'score', score: 2.51, confidence: 0, legend: {}, probabilities: rec02 } }))
    expect(ev.stars).toBeCloseTo(3.51)
    expect(ev.starLevel).toBe(3)
  })

  it('lets the audio alone decide silent, noise-only and too-short recordings', () => {
    expect(evidenceCap({ audioCategory: 'noise', transcriptValidity: 'valid' })).toBe('audio_noise')
    expect(evidenceCap({ audioCategory: 'silent', transcriptValidity: null })).toBe('audio_silent')
    expect(evidenceCap({ audioCategory: 'too_short', transcriptValidity: null })).toBe('audio_too_short')
    expect(evidenceCap({ audioCategory: 'speech', transcriptValidity: 'invalid' })).toBeNull()
    expect(evidenceCap({ audioCategory: null, transcriptValidity: null })).toBeNull()
  })

  it('makes the rules evaluation one star, noise or accidental, context unclear, with no Jev answers', () => {
    const ev = rulesEvaluation('audio_noise')
    expect(ev).toMatchObject({ model: RULES_MODEL, stars: 1, starLevel: 1, kind: 'noise_accidental', context: 'unclear', inputTokens: 0 })
    expect(ev.answers).toEqual({})
    expect(evaluationToValue(ev)?.value).toBe('none')
  })

  const jev = parseEvaluation(reply({
    stars: { type: 'score', score: 2.51, confidence: 0, legend: {}, probabilities: rec02 },
    kind: { type: 'choice', choice: 'media_playback', probabilities: {}, confidence: 0.47 },
    context: { type: 'choice', choice: 'personal', probabilities: {}, confidence: 0.95 }
  }))

  it('caps a Jev evaluation by the audio and keeps its answers', () => {
    const capped = withEvidence(jev, { audioCategory: 'noise', transcriptValidity: 'invalid' })
    expect(capped).toMatchObject({ starLevel: 1, stars: 1, kind: 'noise_accidental', context: 'unclear', model: 'jev-1.13.0' })
    expect(capped.answers).toBe(jev.answers)
    expect(withEvidence(jev, { audioCategory: 'speech', transcriptValidity: 'valid' })).toBe(jev)
    expect(withEvidence(jev, { audioCategory: 'speech', transcriptValidity: null })).toBe(jev)
  })

  // Owner, 4-oct-2026: categorizations are valid only if the transcript is.
  it('leaves a transcript that is invalid, in doubt or incomplete uncategorized, keeping Jev answers', () => {
    for (const status of ['invalid', 'doubtful', 'incomplete'] as const) {
      const held = withEvidence(jev, { audioCategory: 'speech', transcriptValidity: status })
      expect(held).toMatchObject({ stars: null, starLevel: null, starsConfidence: null, kind: null, context: null })
      expect(held.answers).toBe(jev.answers)
      expect(evaluationToValue(held)).toBeNull()
    }
  })

  it('no longer lets Jev reading the text as invented move the stars', () => {
    const believed = parseEvaluation(reply({
      stars: { type: 'score', score: 3.1, confidence: 0.68, legend: {}, probabilities: { '3': 0.7, '4': 0.3 } },
      transcript_invented: { type: 'noul', noul: 0.91 }
    }))
    expect(withEvidence(believed, { audioCategory: 'speech', transcriptValidity: 'valid' }).starLevel).toBe(4)
  })
})
