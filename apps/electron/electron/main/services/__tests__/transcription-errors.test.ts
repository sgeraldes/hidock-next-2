/**
 * Every message here was seen in the transcription queue or the app log
 * between 13 and 15 Oct 2026. The class decides whether the queue waits and
 * repeats, moves to the next engine, or stops.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { classifyTranscriptionError, DEFAULT_RETRY_POLICY, nextRetry } from '../transcription-errors'

const seen: Array<[string, string]> = [
  ['429 Rate limit exceeded for model gemini-3.5-transcribe (limit: 10000 input tokens per minute on Free Tier). Please retry in 39s or upgrade your tier at https://ai.dev/rate-limit', 'quota'],
  ['Provider response retained: covers 2% of the 426s recording; automatic audio retry disabled', 'incomplete'],
  ['Provider response retained: output truncated; automatic audio retry disabled', 'incomplete'],
  ['Gemini could not produce a complete, reliable transcript for 01:00:00-01:00:45 (interaction incomplete)', 'incomplete'],
  ['The worker has not advertised the selected ASR engine', 'unavailable'],
  ['Local ASR runner not found: not configured', 'unavailable'],
  ['Remote worker awaiting-upload; automatic retry disabled', 'transient'],
  ['Remote worker failed; automatic retry disabled', 'transient'],
  ['Remote worker timeout; retained job identity for resume', 'transient'],
  ['[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent: fetch failed', 'transient'],
  ['Gemini API key not configured', 'credentials'],
  ['Recording not found or no local file: ef166712-34ec-4816-a249-4641ef4b4df4', 'recording'],
  ['VibeVoice returned an empty transcript', 'input'],
  ['Provider timestamps failed local audio grounding: All diarization segments have invalid timestamps', 'input'],
  ['Cohere transcription requires an explicit language. Choose a language before uploading audio.', 'input'],
]

describe('classifyTranscriptionError', () => {
  it.each(seen)('%s', (message, expected) => {
    expect(classifyTranscriptionError(new Error(message)).class).toBe(expected)
  })

  it('reads the wait the provider asks for', () => {
    expect(classifyTranscriptionError(seen[0][0]).retryAfterSeconds).toBe(39)
  })

  it('only a missing recording or a cancellation rules out the next engine', () => {
    expect(classifyTranscriptionError('Recording not found or no local file: x').nextEngineMayHelp).toBe(false)
    expect(classifyTranscriptionError('Transcription cancelled').nextEngineMayHelp).toBe(false)
    expect(classifyTranscriptionError('something nobody has seen').nextEngineMayHelp).toBe(true)
    expect(classifyTranscriptionError('something nobody has seen').class).toBe('unknown')
  })
})

describe('nextRetry with the default policy', () => {
  it('waits what a quota answer asks, plus a margin, and repeats up to three times', () => {
    const quota = classifyTranscriptionError(seen[0][0])
    expect(nextRetry(quota, 1)).toEqual({ retry: true, waitSeconds: 41 })
    expect(nextRetry(quota, 3).retry).toBe(true)
    expect(nextRetry(quota, 4).retry).toBe(false)
  })

  it('backs off on transient failures and gives up after two repeats', () => {
    const transient = classifyTranscriptionError('fetch failed')
    expect(nextRetry(transient, 1)).toEqual({ retry: true, waitSeconds: 30 })
    expect(nextRetry(transient, 2)).toEqual({ retry: true, waitSeconds: 60 })
    expect(nextRetry(transient, 3).retry).toBe(false)
  })

  it('never repeats an incomplete answer, a missing key or a bad input on the same engine', () => {
    for (const message of [seen[1][0], 'Gemini API key not configured', 'VibeVoice returned an empty transcript']) {
      expect(nextRetry(classifyTranscriptionError(message), 1).retry).toBe(false)
    }
  })

  it('caps a long requested wait', () => {
    expect(nextRetry(classifyTranscriptionError('429 Please retry in 900s'), 1, DEFAULT_RETRY_POLICY).waitSeconds).toBe(180)
  })
})
