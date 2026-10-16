// @vitest-environment node
import { expect, it } from 'vitest'
import { validateRemoteResult } from '../remote-worker-jobs'
import { providerDiarizationOutcome, remoteDiarizationQuality } from '../remote-diarization-quality'

const fixture = () => ({
  model: 'OpenMOSS-Team/MOSS-transcribe-diarize', modelVersion: 'fixture', text: 'A complete transcript.',
  diarizationStatus: 'degraded', diarizationUnavailableSegments: 1, speakerEmbeddingsAvailable: false,
  segments: [{ start: 0, end: 2, text: 'A complete transcript.', speaker: 'Speaker unresolved',
    speakerAttribution: 'unresolved', speakerConfidence: 0,
    speakerAssignment: 'unresolved-no-model-speaker-label', diarizationStatus: 'unavailable' }]
})

it('preserves complete transcript and unavailable speaker metadata at the client result boundary', () => {
  const result = fixture()
  const original = structuredClone(result)
  validateRemoteResult(result, 'transcription', result.model)
  expect(result).toEqual(original)
  expect(remoteDiarizationQuality(result)).toEqual({ diarizationStatus: 'degraded',
    diarizationUnavailableSegments: 1, speakerEmbeddingsAvailable: false })
  const outcome = providerDiarizationOutcome({ status: 'high', reasons: [] }, result)
  expect(outcome).toMatchObject({ status: 'degraded', qualityStatus: 'degraded',
    quality: { diarizationUnavailableSegments: 1, speakerEmbeddingsAvailable: false } })
  expect(outcome.quality.reasons).toContain(
    'Provider did not supply speaker labels for all segments; transcript retained without trusted speaker identity')
})

it.each([0, 2, true, -1])('rejects inconsistent missing-label count %s', count => {
  const result = { ...fixture(), diarizationUnavailableSegments: count }
  expect(() => validateRemoteResult(result, 'transcription', result.model)).toThrow('inconsistent')
})

it('rejects a missing-label segment that claims a model identity', () => {
  const result = fixture()
  Object.assign(result.segments[0], { modelSpeakerLabel: 'speaker_0' })
  expect(() => validateRemoteResult(result, 'transcription', result.model)).toThrow('inconsistent')
})

it('retains separately assessed quality for complete window-scoped clusters', () => {
  expect(providerDiarizationOutcome({ status: 'high' }, {
    diarizationStatus: 'window-scoped-clusters', diarizationUnavailableSegments: 0,
    speakerEmbeddingsAvailable: false
  })).toMatchObject({ status: 'completed', qualityStatus: 'high',
    quality: { diarizationStatus: 'window-scoped-clusters', speakerEmbeddingsAvailable: false } })
})
