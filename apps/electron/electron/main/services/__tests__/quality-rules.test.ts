import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_MIN_RECORDING_SECONDS, applyQualityRules, minRecordingSeconds } from '../quality-rules'
import { classifyByDuration } from '../value-thresholds'

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
