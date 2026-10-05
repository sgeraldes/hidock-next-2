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

  it('keeps doubtful and gap-only summaries but withholds invalid and density failures', () => {
    for (const validity_status of ['doubtful', 'incomplete'] as const) {
      const t = { integrity_status: 'ok' as const, validity_status, validity_json: JSON.stringify({ reasons: [{ code: 'speech_after_the_end' }] }), summary: 'Resumen.' }
      expect(isTranscriptTrusted(t)).toBe(true)
      expect(trustedSummary(t, 'speech')).toBe('Resumen.')
      expect(untrustedSummaryNote(t)).not.toMatch(/No summary/)
    }
    expect(trustedSummary({ validity_status: 'invalid', summary: 'Resumen.' }, 'speech')).toBeNull()
    expect(trustedSummary({ validity_status: 'incomplete', validity_json: JSON.stringify({ reasons: [{ code: 'sparse_speech' }] }), summary: 'Resumen.' }, 'speech')).toBeNull()
  })

  it('says why the summary is missing', () => {
    expect(untrustedSummaryNote({ integrity_status: 'broken' })).toBe(UNTRUSTED_SUMMARY_NOTE)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'invalid' })).toBe(UNTRUSTED_SUMMARY_NOTE)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'doubtful' })).toMatch(/in doubt/)
    expect(untrustedSummaryNote({ integrity_status: 'ok', validity_status: 'incomplete' })).toMatch(/No summary/)
  })
})
