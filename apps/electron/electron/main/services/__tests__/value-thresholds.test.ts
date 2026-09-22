// @vitest-environment node

/**
 * Duration gate — pure arithmetic, no DB, no network (2026-09-22).
 *
 * The thresholds were chosen against the owner's real database (122 live
 * recordings under 60 seconds, 111 of them never rated at all), so the cases
 * below pin the exact boundaries rather than a vague "short is bad": a change
 * to either constant has to change this file too.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyByDuration,
  isImpossibleTranscriptDensity,
  DURATION_GARBAGE_MAX_SECONDS,
  DURATION_LOW_VALUE_MAX_SECONDS,
  IMPOSSIBLE_WORDS_PER_SECOND
} from '../value-thresholds'

describe('classifyByDuration', () => {
  it('calls anything under 10 seconds none/garbage at full confidence', () => {
    for (const seconds of [0.5, 1, 5, 7, 9.9]) {
      expect(classifyByDuration(seconds)).toEqual({ value: 'none', reasons: ['no_substance'], confidence: 1 })
    }
  })

  it('calls 10 to just under 30 seconds low', () => {
    for (const seconds of [10, 13, 20, 29.9]) {
      expect(classifyByDuration(seconds)).toEqual({ value: 'low', reasons: ['no_substance'], confidence: 0.95 })
    }
  })

  it('pins both boundaries exactly', () => {
    expect(classifyByDuration(DURATION_GARBAGE_MAX_SECONDS - 0.01)?.value).toBe('none')
    expect(classifyByDuration(DURATION_GARBAGE_MAX_SECONDS)?.value).toBe('low')
    expect(classifyByDuration(DURATION_LOW_VALUE_MAX_SECONDS - 0.01)?.value).toBe('low')
    expect(classifyByDuration(DURATION_LOW_VALUE_MAX_SECONDS)).toBeNull()
  })

  it('leaves 30 seconds and above to the content judgement', () => {
    for (const seconds of [30, 45, 60, 600, 3600]) {
      expect(classifyByDuration(seconds)).toBeNull()
    }
  })

  it('declines to judge an unknown or nonsensical duration', () => {
    expect(classifyByDuration(null)).toBeNull()
    expect(classifyByDuration(undefined)).toBeNull()
    expect(classifyByDuration(0)).toBeNull()
    expect(classifyByDuration(-30)).toBeNull()
    expect(classifyByDuration(Number.NaN)).toBeNull()
    expect(classifyByDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('clears the confidence floor that applyCaptureValueClassification enforces', () => {
    expect(classifyByDuration(5)!.confidence).toBeGreaterThanOrEqual(0.6)
    expect(classifyByDuration(20)!.confidence).toBeGreaterThanOrEqual(0.6)
  })
})

describe('isImpossibleTranscriptDensity', () => {
  it('flags the real 13-second, 508-word transcript from the owner DB', () => {
    expect(isImpossibleTranscriptDensity(508, 13)).toBe(true)
  })

  it('accepts ordinary and even fast speech', () => {
    expect(isImpossibleTranscriptDensity(30, 13)).toBe(false) // 2.3 wps, the median
    expect(isImpossibleTranscriptDensity(70, 13)).toBe(false) // 5.4 wps, p95
    expect(isImpossibleTranscriptDensity(1500, 600)).toBe(false)
  })

  it('pins the boundary at the constant', () => {
    expect(isImpossibleTranscriptDensity(IMPOSSIBLE_WORDS_PER_SECOND * 10, 10)).toBe(false)
    expect(isImpossibleTranscriptDensity(IMPOSSIBLE_WORDS_PER_SECOND * 10 + 1, 10)).toBe(true)
  })

  it('accuses nothing when either number is missing or non-positive', () => {
    expect(isImpossibleTranscriptDensity(null, 10)).toBe(false)
    expect(isImpossibleTranscriptDensity(500, null)).toBe(false)
    expect(isImpossibleTranscriptDensity(undefined, undefined)).toBe(false)
    expect(isImpossibleTranscriptDensity(500, 0)).toBe(false)
    expect(isImpossibleTranscriptDensity(0, 10)).toBe(false)
  })
})
