// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { domainOfReasonCode, routeReasonCodes, routeValidityRepair } from '../quality-repair-routing'

const json = (...codes: string[]) => JSON.stringify({ reasons: codes.map((code) => ({ code, detail: code })) })

describe('routeValidityRepair', () => {
  it('keeps a speaker-only doubt away from ASR and from full retranscription', () => {
    expect(routeValidityRepair(json('more_speakers_than_invited'))).toEqual({
      kind: 'speaker-only',
      domains: ['speaker'],
      allowsAsrSampling: false,
      fullRetranscribeIsDefault: false,
      needsSpeakerReview: true
    })
  })

  it.each([
    ['timing', 'timestamps_consistently_wrong'],
    ['text', 'much_text_without_audio'],
    ['coverage', 'clock_compressed']
  ])('keeps ASR sampling for a speaker doubt mixed with %s evidence', (_domain, code) => {
    const routing = routeValidityRepair(json('more_speakers_than_invited', code))
    expect(routing).toMatchObject({ kind: 'mixed', allowsAsrSampling: true, needsSpeakerReview: true })
  })

  it('treats an unchecked-audio reason next to the speaker reason as mixed, not speaker-only', () => {
    expect(routeValidityRepair(json('more_speakers_than_invited', 'audio_not_checked')).allowsAsrSampling).toBe(true)
  })

  it('keeps today\'s behavior when there is no speaker reason, or nothing readable', () => {
    expect(routeValidityRepair(json('no_times'))).toMatchObject({ kind: 'non-speaker', allowsAsrSampling: true, needsSpeakerReview: false })
    for (const stored of [null, undefined, '', 'not json', '{}', '{"reasons":"x"}', '{"reasons":[]}']) {
      expect(routeValidityRepair(stored)).toMatchObject({ kind: 'none', allowsAsrSampling: true, fullRetranscribeIsDefault: true })
    }
  })

  it('does not let an unknown code or a malformed reason make a speaker-only doubt look speaker-only', () => {
    expect(routeReasonCodes(['more_speakers_than_invited', 'brand_new_code']).kind).toBe('mixed')
    expect(routeReasonCodes(['more_speakers_than_invited', undefined]).allowsAsrSampling).toBe(true)
    expect(domainOfReasonCode('__proto__')).toBe('unknown')
    expect(domainOfReasonCode('toString')).toBe('unknown')
  })
})
