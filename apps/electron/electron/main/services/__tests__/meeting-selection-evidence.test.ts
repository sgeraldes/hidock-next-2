// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hasVerifiedMeetingSelectionEvidence as verifies } from '../meeting-selection-evidence'

describe('calendar event selection evidence', () => {
  const practice = { subject: 'DFX5 AM3 practice meeting', description: null }
  const adHoc = 'Ana: revisemos arquitectura, fondos y proyectos de Minera Norte y Envíos Sur. Luis: sí.'

  it('rejects the reported ad-hoc call even if the model explains a 95% topic match', () => {
    expect(verifies(adHoc, practice, undefined)).toBe(false)
    expect(verifies(adHoc, practice, {
      kind: 'explicit-event-reference', transcript_quote: adHoc, calendar_quote: practice.subject
    })).toBe(false)
  })

  it('rejects fabricated transcript quotes and unsupported agenda claims', () => {
    expect(verifies(adHoc, practice, {
      kind: 'explicit-event-reference', transcript_quote: practice.subject, calendar_quote: practice.subject
    })).toBe(false)
    expect(verifies(adHoc, practice, {
      kind: 'specific-agenda', transcript_quote: adHoc, calendar_quote: 'arquitectura fondos y proyectos de Minera Norte'
    })).toBe(false)
  })

  it('accepts an actual spoken event reference with case/punctuation normalization', () => {
    expect(verifies('Comencemos: DFX5 AM3 practice meeting.', practice, {
      kind: 'explicit-event-reference', transcript_quote: 'DFX5 AM3 practice meeting',
      calendar_quote: practice.subject
    })).toBe(true)
  })

  it('accepts a concrete calendar agenda phrase independently present in the transcript', () => {
    const phrase = 'revisar la migración del catálogo de productos'
    expect(verifies(`Hoy toca ${phrase}.`, { subject: 'Architecture review', description: phrase }, {
      kind: 'specific-agenda', transcript_quote: `Hoy toca ${phrase}`, calendar_quote: phrase
    })).toBe(true)
  })

  it('rejects a shared client name as a concrete agenda', () => {
    expect(verifies(adHoc, { subject: 'Practice', description: 'Minera Norte' }, {
      kind: 'specific-agenda', transcript_quote: adHoc, calendar_quote: 'Minera Norte'
    })).toBe(false)
  })

  it.each(['This is not DFX5 AM3 practice meeting.', 'La DFX5 AM3 practice meeting ya terminó.'])(
    'rejects an event name mentioned to distinguish an earlier or different call: %s', (transcript) => {
      expect(verifies(transcript, practice, {
        kind: 'explicit-event-reference', transcript_quote: practice.subject, calendar_quote: practice.subject
      })).toBe(false)
    }
  )

  it('rejects generic agenda boilerplate even when copied exactly into both sources', () => {
    const phrase = 'discuss project status and next steps'
    expect(verifies(phrase, { subject: 'Practice', description: phrase }, {
      kind: 'specific-agenda', transcript_quote: phrase, calendar_quote: phrase
    })).toBe(false)
  })

  it('does not treat an unrelated unfinished task as denial of the meeting', () => {
    expect(verifies('Welcome to DFX5 AM3 practice meeting. We have not finished the migration.', practice, {
      kind: 'explicit-event-reference', transcript_quote: 'Welcome to DFX5 AM3 practice meeting',
      calendar_quote: practice.subject
    })).toBe(true)
  })

  it('checks the quoted occurrence when a previous call and the current event are both mentioned', () => {
    const opening = 'Welcome to DFX5 AM3 practice meeting'
    expect(verifies(`Earlier DFX5 AM3 practice meeting ended. ${opening}.`, practice, {
      kind: 'explicit-event-reference', transcript_quote: opening, calendar_quote: practice.subject
    })).toBe(true)
  })
})
