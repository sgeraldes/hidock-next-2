import { describe, it, expect } from 'vitest'
import {
  integrityFilterLabel,
  integrityIssues,
  integrityLabel,
  isIntegrityFilter,
  matchesIntegrityFilter,
} from '../transcriptIntegrity'

const json = (codes: string[]) =>
  JSON.stringify({ issues: codes.map((code) => ({ code, count: 2, detail: `${code} detail` })) })

const ok = { integrity_status: 'ok' as const, integrity_json: json([]), integrity_accepted_at: null }
const suspect = { integrity_status: 'suspect' as const, integrity_json: json(['cramped_lines', 'repeated_start']), integrity_accepted_at: null }
const broken = { integrity_status: 'broken' as const, integrity_json: json(['too_many_words']), integrity_accepted_at: null }
const accepted = { ...suspect, integrity_accepted_at: '2026-09-23T10:00:00.000Z' }

describe('integrityLabel', () => {
  it('maps the stored verdict and acceptance to what the Library shows', () => {
    expect(integrityLabel(undefined)).toBe('unchecked')
    expect(integrityLabel({ integrity_status: null, integrity_json: null, integrity_accepted_at: null })).toBe('unchecked')
    expect(integrityLabel(ok)).toBe('ok')
    expect(integrityLabel(suspect)).toBe('suspect')
    expect(integrityLabel(broken)).toBe('broken')
    expect(integrityLabel(accepted)).toBe('accepted')
  })
})

describe('integrityIssues', () => {
  it('reads findings in a fixed order, most serious first, and drops unknown codes', () => {
    const t = { ...suspect, integrity_json: JSON.stringify({ issues: [{ code: 'cramped_lines' }, { code: 'mystery' }, { code: 'too_many_words' }] }) }
    expect(integrityIssues(t).map((i) => i.code)).toEqual(['too_many_words', 'cramped_lines'])
  })

  it('survives a broken or missing value', () => {
    expect(integrityIssues({ ...suspect, integrity_json: '{nope' })).toEqual([])
    expect(integrityIssues(undefined)).toEqual([])
  })
})

describe('matchesIntegrityFilter', () => {
  it('matches every transcript when off', () => {
    expect(matchesIntegrityFilter(ok, null)).toBe(true)
  })

  it('flagged means not green: suspect or broken, never accepted', () => {
    expect(matchesIntegrityFilter(suspect, 'flagged')).toBe(true)
    expect(matchesIntegrityFilter(broken, 'flagged')).toBe(true)
    expect(matchesIntegrityFilter(accepted, 'flagged')).toBe(false)
    expect(matchesIntegrityFilter(ok, 'flagged')).toBe(false)
    expect(matchesIntegrityFilter(undefined, 'flagged')).toBe(false)
  })

  it('filters by one finding among flagged transcripts', () => {
    expect(matchesIntegrityFilter(suspect, 'issue:repeated_start')).toBe(true)
    expect(matchesIntegrityFilter(suspect, 'issue:too_many_words')).toBe(false)
    expect(matchesIntegrityFilter(accepted, 'issue:repeated_start')).toBe(false)
  })

  it('has its own values for broken and accepted', () => {
    expect(matchesIntegrityFilter(broken, 'broken')).toBe(true)
    expect(matchesIntegrityFilter(suspect, 'broken')).toBe(false)
    expect(matchesIntegrityFilter(accepted, 'accepted')).toBe(true)
  })
})

describe('filter values', () => {
  it('recognises valid values and names them', () => {
    expect(isIntegrityFilter('flagged')).toBe(true)
    expect(isIntegrityFilter('issue:past_audio_end')).toBe(true)
    expect(isIntegrityFilter('issue:mystery')).toBe(false)
    expect(isIntegrityFilter('all')).toBe(false)
    expect(integrityFilterLabel('issue:past_audio_end')).toBe('Runs past the audio')
    expect(integrityFilterLabel('flagged')).toBe('Transcript problems')
  })
})
