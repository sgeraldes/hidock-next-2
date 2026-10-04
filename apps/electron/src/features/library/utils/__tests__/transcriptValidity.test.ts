import { describe, it, expect } from 'vitest'
import { formatTranscriptionCost, heldValidity, transcriptionCostUsd, validityReasons, VALIDITY_LABELS } from '../transcriptValidity'

describe('transcript validity in the Library', () => {
  it('holds a transcript that is invalid, in doubt or incomplete, never an accepted one', () => {
    expect(heldValidity({ validity_status: 'doubtful' })).toBe('doubtful')
    expect(heldValidity({ validity_status: 'invalid' })).toBe('invalid')
    expect(heldValidity({ validity_status: 'incomplete' })).toBe('incomplete')
    expect(heldValidity({ validity_status: 'valid' })).toBeNull()
    expect(heldValidity({ validity_status: 'audio' })).toBeNull()
    expect(heldValidity({ validity_status: 'doubtful', integrity_accepted_at: '2026-10-04T10:00:00Z' })).toBeNull()
    expect(heldValidity(undefined)).toBeNull()
  })

  it('names each verdict the way the owner asked', () => {
    expect(VALIDITY_LABELS.invalid.chip).toBe('Not categorized')
    expect(VALIDITY_LABELS.doubtful.chip).toBe('Transcript in doubt')
    expect(VALIDITY_LABELS.incomplete.chip).toBe('Transcript incomplete')
  })

  it('reads the stored reasons, and nothing from a broken record', () => {
    const json = JSON.stringify({ reasons: [{ code: 'no_times', detail: 'The transcript has no times.' }, { code: 'x' }] })
    expect(validityReasons({ validity_json: json })).toEqual(['The transcript has no times.'])
    expect(validityReasons({ validity_json: '{oops' })).toEqual([])
  })

  it('estimates what transcribing again costs at 0.0034 USD a minute', () => {
    expect(transcriptionCostUsd(3600)).toBeCloseTo(0.204)
    expect(formatTranscriptionCost(3600)).toBe('about 0.20 USD')
    expect(formatTranscriptionCost(30)).toBe('under 0.01 USD')
    expect(formatTranscriptionCost(7312 * 60)).toBe('about 24.86 USD')
  })
})
