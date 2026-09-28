import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_MIN_RECORDING_SECONDS,
  DEFAULT_QUALITY_RULES,
  applyQualityRules,
  changedQualityKeys,
  minRecordingSeconds,
  qualityRules,
  resolveQualityRules
} from '../quality-rules'
import { classifyByDuration, DURATION_LOW_VALUE_MAX_SECONDS, lowValueMaxSeconds } from '../value-thresholds'
import { audioTranscriptWarning, reasonsFromAnswers, REASON_THRESHOLD, WARNING_RULES } from '../jev-evaluation'
import { AUTO_LINK_MIN_MARGIN, AUTO_LINK_MIN_PROBABILITY, isClearMatch } from '../jev-meeting-match'

beforeEach(() => applyQualityRules({}))

describe('skip clips shorter than (one setting for the gate, the profile and the rating)', () => {
  it('defaults to 10 s, the value both old constants had', () => {
    expect(DEFAULT_MIN_RECORDING_SECONDS).toBe(10)
    expect(minRecordingSeconds()).toBe(10)
  })

  it('reads the saved value and ignores nonsense', () => {
    applyQualityRules({ transcription: { minRecordingSeconds: 5 } })
    expect(minRecordingSeconds()).toBe(5)
    applyQualityRules({ transcription: { minRecordingSeconds: -3 } })
    expect(minRecordingSeconds()).toBe(10)
  })

  it('value rating follows it', () => {
    applyQualityRules({ transcription: { minRecordingSeconds: 5 } })
    expect(classifyByDuration(7, null)?.value).toBe('low')
    applyQualityRules({ transcription: { minRecordingSeconds: 10 } })
    expect(classifyByDuration(7, null)?.value).toBe('none')
  })
})

describe('qualityRules (Settings > Quality checks)', () => {
  it('holds the old constants as defaults', () => {
    expect(qualityRules()).toEqual(DEFAULT_QUALITY_RULES)
    expect(DEFAULT_QUALITY_RULES).toEqual({
      quietSoundShare: 0.05,
      quietMinDurationSeconds: 60,
      meaningfulWords: 100,
      meaningfulStars: 3,
      maxWordsPerMinuteOfRecording: 250,
      busySoundSeconds: 300,
      minWordsPerMinuteOfSound: 20,
      inventedProbability: 0.8,
      reasonProbability: 0.5,
      lowValueMaxSeconds: 30,
      maxRetries: 3,
      retranscribeScore: 60,
      meetingAutoLinkProbability: 0.7,
      meetingAutoLinkMargin: 0.25,
      liveSilenceRms: 58
    })
    expect(WARNING_RULES.meaningfulWords).toBe(100)
    expect(REASON_THRESHOLD).toBe(0.5)
    expect(DURATION_LOW_VALUE_MAX_SECONDS).toBe(30)
    expect(AUTO_LINK_MIN_PROBABILITY).toBe(0.7)
    expect(AUTO_LINK_MIN_MARGIN).toBe(0.25)
  })

  it('reads saved values and clamps them to their bounds', () => {
    applyQualityRules({ quality: { maxRetries: 5, reasonProbability: 1.7, meaningfulStars: 0, liveSilenceRms: 40.6 } })
    const r = qualityRules()
    expect(r.maxRetries).toBe(5)
    expect(r.reasonProbability).toBe(1)
    expect(r.meaningfulStars).toBe(2) // at least 2: 1 star is every rated recording
    expect(r.liveSilenceRms).toBe(41)
    expect(r.busySoundSeconds).toBe(300)
  })

  it('falls back to the default for anything that is not a finite number', () => {
    applyQualityRules({
      quality: { maxRetries: '7', inventedProbability: Number.NaN, retranscribeScore: null, busySoundSeconds: Infinity }
    })
    expect(qualityRules()).toEqual(DEFAULT_QUALITY_RULES)
    applyQualityRules({ quality: 'nonsense' })
    expect(qualityRules()).toEqual(DEFAULT_QUALITY_RULES)
    expect(resolveQualityRules(undefined)).toEqual(DEFAULT_QUALITY_RULES)
  })

  it('the rules in force are frozen, so a caller cannot change them', () => {
    expect(Object.isFrozen(qualityRules())).toBe(true)
  })

  it('names the keys that changed', () => {
    const prev = resolveQualityRules({})
    expect(changedQualityKeys(prev, resolveQualityRules({ meaningfulWords: 150, maxRetries: 3 }))).toEqual(['meaningfulWords'])
    expect(changedQualityKeys(prev, prev)).toEqual([])
  })
})

describe('the services read the rules in force', () => {
  const audio = {
    duration_seconds: 600,
    sound_seconds: 420,
    sound_share: 0.7,
    audio_category: 'speech',
    transcript_words: 1100,
    words_per_minute_of_sound: 157,
    integrity_status: 'ok'
  }

  it('audio-versus-transcript warning', () => {
    // 1,100 words in 10 minutes: 110 per minute of recording.
    expect(audioTranscriptWarning(audio, 3)).toBeNull()
    applyQualityRules({ quality: { maxWordsPerMinuteOfRecording: 100 } })
    expect(audioTranscriptWarning(audio, 3)).toBe('possible_invented_transcript')
  })

  it('reason tags', () => {
    const answers = { no_substance: { type: 'noul', noul: 0.6 } } as never
    expect(reasonsFromAnswers(answers)).toEqual(['no_substance'])
    applyQualityRules({ quality: { reasonProbability: 0.7 } })
    expect(reasonsFromAnswers(answers)).toEqual([])
  })

  it('low value by duration', () => {
    expect(classifyByDuration(40, null)).toBeNull()
    applyQualityRules({ quality: { lowValueMaxSeconds: 45 } })
    expect(lowValueMaxSeconds()).toBe(45)
    expect(classifyByDuration(40, null)?.value).toBe('low')
  })

  it('meeting auto-link', () => {
    const match = { probabilities: {}, none: 0, topMeetingId: 'm1', topProbability: 0.75, margin: 0.3, candidateKey: 'k', inputTokens: null }
    expect(isClearMatch(match)).toBe(true)
    applyQualityRules({ quality: { meetingAutoLinkProbability: 0.8 } })
    expect(isClearMatch(match)).toBe(false)
  })
})
