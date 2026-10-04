import { describe, expect, it } from 'vitest'
import { describeModelHost, type ModelHostStatus } from '../model-host-status'

const base: ModelHostStatus = {
  configured: true,
  paired: true,
  usedForSpeakers: true,
  address: 'gamestation:8765',
  health: { version: '0.2.0', state: 'ready', capabilities: ['diarize'], acceleration: 'cuda' }
}

const at = (overrides: Partial<ModelHostStatus>) => describeModelHost({ ...base, ...overrides })

describe('the model host in words', () => {
  it('says nothing is there when no host is set', () => {
    expect(at({ configured: false, health: null })).toEqual({
      tone: 'none',
      text: 'No model host. Speaker work runs on this computer.'
    })
  })

  it('working', () => {
    expect(at({})).toMatchObject({ tone: 'working', text: 'gamestation:8765 is working: speaker work goes there.' })
    expect(at({ health: { ...base.health!, state: 'busy' } }).text).toBe(
      'gamestation:8765 is working on a recording.'
    )
  })

  it('paused for a game, which one, and when it comes back', () => {
    const resumesAt = new Date(2026, 9, 3, 23, 40).getTime()
    const result = at({
      health: { ...base.health!, state: 'paused', pause: { by: 'game', detail: 'eldenring.exe is running', resumesAt } }
    })
    expect(result.tone).toBe('paused')
    expect(result.text).toMatch(/^gamestation:8765 is paused for a game \(eldenring\.exe is running\)\. /)
    expect(result.text).toMatch(/Back at .*23.*40/)
    expect(result.text).toMatch(/runs on this computer meanwhile\.$/)
  })

  it('paused for a game that is still running', () => {
    const result = at({ health: { ...base.health!, state: 'paused', pause: { by: 'game', detail: 'A full-screen app is running', resumesAt: null } } })
    expect(result.text).toMatch(/Back a few minutes after the game closes\./)
  })

  it('paused by the person at that machine', () => {
    expect(at({ health: { ...base.health!, state: 'paused', pause: { by: 'you' } } })).toEqual({
      tone: 'paused',
      text: 'gamestation:8765 is paused by hand. Speaker work runs on this computer until it is resumed there.'
    })
  })

  it('paused, by an older host that does not say why', () => {
    expect(at({ health: { ...base.health!, state: 'paused', reason: 'The host is paused.' } }).text).toBe(
      'gamestation:8765 is paused. Speaker work runs on this computer meanwhile.'
    )
  })

  it('off or not answering', () => {
    expect(at({ health: null })).toEqual({
      tone: 'off',
      text: 'gamestation:8765 is off or not answering. Speaker work runs on this computer.'
    })
  })

  it('stopped on that machine', () => {
    expect(at({ health: { ...base.health!, state: 'stopped' } }).text).toBe(
      'gamestation:8765 is stopped. Speaker work runs on this computer until someone presses Start there.'
    )
  })

  it('set up but not finished', () => {
    expect(at({ health: { ...base.health!, capabilities: [] } })).toMatchObject({
      tone: 'off',
      text: 'gamestation:8765 answers, but its setup has not finished. Speaker work runs on this computer.'
    })
  })

  it('not paired yet', () => {
    expect(at({ paired: false }).text).toBe(
      'gamestation:8765 is not paired with this computer yet. Speaker work runs on this computer.'
    )
  })

  it('paired, but the chosen speaker engine never asks it', () => {
    expect(at({ usedForSpeakers: false })).toMatchObject({
      tone: 'none',
      text: 'gamestation:8765 is paired, but the speaker engine chosen in Speakers & voices runs on this computer, so nothing goes there.'
    })
  })
})
