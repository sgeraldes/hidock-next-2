import { afterEach, describe, expect, it } from 'vitest'
import { addActiveTranscription, getActiveTranscriptionCount, getActiveTranscriptions, removeActiveTranscription } from '../transcription-activity'

describe('transcription activity ownership counts', () => {
  const recordingId = 'activity-count-test'

  afterEach(() => {
    while (getActiveTranscriptionCount(recordingId) > 0) removeActiveTranscription(recordingId)
  })

  it('reports each owner reference and preserves the recording until the last owner releases it', () => {
    expect(getActiveTranscriptionCount(recordingId)).toBe(0)
    addActiveTranscription(recordingId)
    addActiveTranscription(recordingId)

    expect(getActiveTranscriptionCount(recordingId)).toBe(2)
    expect(getActiveTranscriptions()).toContain(recordingId)

    removeActiveTranscription(recordingId)
    expect(getActiveTranscriptionCount(recordingId)).toBe(1)
    expect(getActiveTranscriptions()).toContain(recordingId)

    removeActiveTranscription(recordingId)
    expect(getActiveTranscriptionCount(recordingId)).toBe(0)
    expect(getActiveTranscriptions()).not.toContain(recordingId)
  })
})
