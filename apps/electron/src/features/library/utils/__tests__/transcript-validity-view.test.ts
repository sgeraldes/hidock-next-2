/**
 * The Library side of the validity verdict (owner, 4-oct-2026): a transcript
 * that is invalid, in doubt or incomplete shows nothing derived from it, and
 * the note says why in the words of its verdict.
 */

import { describe, it, expect } from 'vitest'
import { isTranscriptTrusted, trustedSummary, untrustedSummaryNote, UNTRUSTED_SUMMARY_NOTE } from '../transcriptIntegrity'

describe('transcript validity in the Library', () => {
  it('trusts a valid transcript, an unchecked one, and one the audio decided', () => {
    expect(isTranscriptTrusted({ integrity_status: 'ok', validity_status: 'valid' })).toBe(true)
    expect(isTranscriptTrusted({ integrity_status: null, validity_status: null })).toBe(true)
    expect(isTranscriptTrusted({ integrity_status: 'ok', validity_status: 'audio' })).toBe(true)
  })

  it('holds back a transcript that is invalid, in doubt or incomplete, though the integrity check passes it', () => {
    for (const validity_status of ['invalid', 'doubtful', 'incomplete'] as const) {
      expect(isTranscriptTrusted({ integrity_status: 'ok', validity_status })).toBe(false)
      expect(trustedSummary({ integrity_status: 'ok', validity_status, summary: 'Resumen.' }, 'speech')).toBeNull()
    }
    expect(trustedSummary({ integrity_status: 'ok', validity_status: 'valid', summary: 'Resumen.' }, 'speech')).toBe('Resumen.')
  })

  it('says why the summary is missing', () => {
    expect(untrustedSummaryNote({ integrity_status: 'broken' })).toBe(UNTRUSTED_SUMMARY_NOTE)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'invalid' })).toBe(UNTRUSTED_SUMMARY_NOTE)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'doubtful' })).toMatch(/in doubt/)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'incomplete' })).toMatch(/stops before/)
  })
})
