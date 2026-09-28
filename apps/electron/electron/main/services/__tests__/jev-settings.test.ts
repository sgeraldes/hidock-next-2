// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const config: { transcription: { jevApiKey?: string }; decisions?: Record<string, boolean> } = { transcription: {} }
vi.mock('../config', () => ({ getConfig: () => config }))

import { jevKeyFor } from '../jev-settings'

beforeEach(() => {
  config.transcription = { jevApiKey: 'ts-key' } // pragma: allowlist secret
  config.decisions = undefined
})

describe('jevKeyFor', () => {
  it('gives the key when Jev and the job are on (and when the switches were never set)', () => {
    expect(jevKeyFor('value')).toBe('ts-key') // pragma: allowlist secret
    config.decisions = { jevEnabled: true, jevValue: true, jevMeetingMatch: true }
    expect(jevKeyFor('meetingMatch')).toBe('ts-key') // pragma: allowlist secret
  })

  it('gives nothing without a key, with Jev off, or with the job off', () => {
    config.transcription = { jevApiKey: ' ' }
    expect(jevKeyFor('value')).toBeNull()
    config.transcription = { jevApiKey: 'ts-key' } // pragma: allowlist secret
    config.decisions = { jevEnabled: false, jevValue: true, jevMeetingMatch: true }
    expect(jevKeyFor('value')).toBeNull()
    config.decisions = { jevEnabled: true, jevValue: false, jevMeetingMatch: true }
    expect(jevKeyFor('value')).toBeNull()
    expect(jevKeyFor('meetingMatch')).toBe('ts-key') // pragma: allowlist secret
  })
})
