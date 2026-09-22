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
  isDurationContradictedByFileSize,
  DURATION_GARBAGE_MAX_SECONDS,
  DURATION_LOW_VALUE_MAX_SECONDS,
  IMPOSSIBLE_WORDS_PER_SECOND,
  MAX_PLAUSIBLE_BYTES_PER_SECOND
} from '../value-thresholds'

/** A file small enough that no duration is contradicted by it. */
const TINY = 1000

describe('classifyByDuration', () => {
  it('calls anything under 10 seconds none/garbage at full confidence', () => {
    for (const seconds of [0.5, 1, 5, 7, 9.9]) {
      expect(classifyByDuration(seconds, TINY)).toEqual({
        value: 'none',
        reasons: ['no_substance'],
        confidence: 1
      })
    }
  })

  it('calls 10 to just under 30 seconds low', () => {
    for (const seconds of [10, 13, 20, 29.9]) {
      expect(classifyByDuration(seconds, TINY)).toEqual({
        value: 'low',
        reasons: ['no_substance'],
        confidence: 0.95
      })
    }
  })

  it('pins both boundaries exactly', () => {
    expect(classifyByDuration(DURATION_GARBAGE_MAX_SECONDS - 0.01, TINY)?.value).toBe('none')
    expect(classifyByDuration(DURATION_GARBAGE_MAX_SECONDS, TINY)?.value).toBe('low')
    expect(classifyByDuration(DURATION_LOW_VALUE_MAX_SECONDS - 0.01, TINY)?.value).toBe('low')
    expect(classifyByDuration(DURATION_LOW_VALUE_MAX_SECONDS, TINY)).toBeNull()
  })

  it('leaves 30 seconds and above to the content judgement', () => {
    for (const seconds of [30, 45, 60, 600, 3600]) {
      expect(classifyByDuration(seconds, TINY)).toBeNull()
    }
  })

  it('declines to judge an unknown or nonsensical duration', () => {
    expect(classifyByDuration(null, TINY)).toBeNull()
    expect(classifyByDuration(undefined, TINY)).toBeNull()
    expect(classifyByDuration(0, TINY)).toBeNull()
    expect(classifyByDuration(-30, TINY)).toBeNull()
    expect(classifyByDuration(Number.NaN, TINY)).toBeNull()
    expect(classifyByDuration(Number.POSITIVE_INFINITY, TINY)).toBeNull()
  })

  it('refuses to judge when the file is too big to hold that many seconds', () => {
    // The real row that exposed this: 13 seconds stored, 2.24 MB on disk,
    // which is 280 seconds of device audio. The duration is wrong, so the
    // recording must not be called garbage.
    expect(classifyByDuration(13, 2239256)).toBeNull()
    // A four-minute .hda whose transcription stopped after the first
    // utterance: duration_seconds becomes the last segment end, 8s.
    expect(classifyByDuration(8, 240 * 8000)).toBeNull()
  })

  it('still judges a short clip whose file size matches its duration', () => {
    // 15 seconds of device audio at 8,000 B/s is 120 KB - nothing to explain.
    expect(classifyByDuration(15, 120000)?.value).toBe('low')
    expect(classifyByDuration(6, 48000)?.value).toBe('none')
  })

  it('judges on duration alone when the file size is unknown', () => {
    expect(classifyByDuration(6, null)?.value).toBe('none')
    expect(classifyByDuration(6, 0)?.value).toBe('none')
    expect(classifyByDuration(20, undefined)?.value).toBe('low')
  })
})

describe('isDurationContradictedByFileSize', () => {
  it('flags a file that cannot fit in its stored duration', () => {
    expect(isDurationContradictedByFileSize(2239256, 13)).toBe(true)
    expect(isDurationContradictedByFileSize(4562796, 15)).toBe(true)
    expect(isDurationContradictedByFileSize(240 * 8000, 8)).toBe(true)
  })

  it('accepts ordinary rates, including the fastest format in the DB', () => {
    expect(isDurationContradictedByFileSize(15 * 8000, 15)).toBe(false) // device .hda
    expect(isDurationContradictedByFileSize(15 * 60655, 15)).toBe(false) // fastest .wav seen
    expect(isDurationContradictedByFileSize(3600 * 8000, 3600)).toBe(false)
  })

  it('pins the boundary at the constant', () => {
    expect(isDurationContradictedByFileSize(10 * MAX_PLAUSIBLE_BYTES_PER_SECOND, 10)).toBe(false)
    expect(isDurationContradictedByFileSize(10 * MAX_PLAUSIBLE_BYTES_PER_SECOND + 1, 10)).toBe(true)
  })

  it('accuses nothing when either number is missing or non-positive', () => {
    expect(isDurationContradictedByFileSize(null, 10)).toBe(false)
    expect(isDurationContradictedByFileSize(0, 10)).toBe(false)
    expect(isDurationContradictedByFileSize(5000000, null)).toBe(false)
    expect(isDurationContradictedByFileSize(5000000, 0)).toBe(false)
    expect(isDurationContradictedByFileSize(undefined, undefined)).toBe(false)
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
