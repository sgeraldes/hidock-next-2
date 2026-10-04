import { describe, expect, it } from 'vitest'
import { describeModelHost, type ModelHostStatus } from '../model-host-status'

const base: ModelHostStatus = {
  configured: true,
  paired: true,
  usedForSpeakers: true,
  hasHfToken: true,
  address: 'gamestation:8765',
  health: {
    version: '0.3.0',
    state: 'ready',
    capabilities: ['diarize'],
    acceleration: 'cuda',
    setup: { status: 'ready', device: 'cuda' }
  }
}

const at = (overrides: Partial<ModelHostStatus>) => describeModelHost({ ...base, ...overrides })
const withSetup = (setup: NonNullable<ModelHostStatus['health']>['setup'], capabilities: string[] = []) =>
  at({ health: { ...base.health!, capabilities, setup } })

describe('the model host in words', () => {
  it('says nothing is there when no host is set', () => {
    expect(at({ configured: false, health: null })).toEqual({
      tone: 'none',
      text: 'No model host. Speaker work runs on this computer.'
    })
  })

  it('working', () => {
    expect(at({})).toMatchObject({ tone: 'working', text: 'gamestation:8765 is working: speaker work goes there.' })
    expect(at({ health: { ...base.health!, state: 'busy' } }).text).toBe('gamestation:8765 is working on a recording.')
  })

  it('working, but on its CPU although it has a GPU: says so and points at Repair', () => {
    const result = at({
      health: {
        ...base.health!,
        gpu: { name: 'NVIDIA GeForce RTX 4090', vramMiB: 23028, driver: '616.56' },
        setup: { status: 'ready', device: 'cpu' }
      }
    })
    expect(result).toEqual({
      tone: 'paused',
      text: 'gamestation:8765 works, but on its CPU: its runtime does not see the NVIDIA GeForce RTX 4090. Press Repair to reinstall it.'
    })
  })

  it('repairing its runtime', () => {
    expect(withSetup({ status: 'repairing' }).text).toBe(
      'gamestation:8765 is reinstalling its GPU runtime (a few minutes). Speaker work runs here meanwhile.'
    )
  })

  it('not answering: paused from its tray, in use, or off', () => {
    expect(at({ health: null })).toEqual({
      tone: 'off',
      text: 'gamestation:8765 is not answering: paused, in use or off. Speaker work runs on this computer.'
    })
  })

  it('testing the voice model it just received', () => {
    expect(withSetup({ status: 'validating' })).toEqual({
      tone: 'paused',
      text: 'gamestation:8765 is testing the voice model with the token from this computer. Speaker work runs here meanwhile.'
    })
  })

  it('could not run the voice model, and why', () => {
    expect(withSetup({ status: 'failed', reason: '401 gated repo pyannote/segmentation-3.0' }).text).toBe(
      'gamestation:8765 could not run the voice model: 401 gated repo pyannote/segmentation-3.0. Speaker work runs on this computer.'
    )
  })

  it('waiting for the token, which this computer sends', () => {
    expect(withSetup({ status: 'needs-token' }).text).toBe(
      'gamestation:8765 is waiting for the Hugging Face token from this computer. Press Check to send it.'
    )
  })

  it('waiting for a token this computer does not have', () => {
    expect(at({ hasHfToken: false, health: { ...base.health!, capabilities: [], setup: { status: 'needs-token' } } }).text).toBe(
      'gamestation:8765 needs a Hugging Face token and this computer has none. Add it in Settings > Secrets.'
    )
  })

  it('a host from before 0.3 with its setup unfinished', () => {
    expect(at({ health: { ...base.health!, capabilities: [], setup: undefined } })).toMatchObject({
      tone: 'off',
      text: 'gamestation:8765 answers, but its setup has not finished. Speaker work runs on this computer.'
    })
  })

  it('a state this version does not know still gets a sentence', () => {
    expect(at({ health: { ...base.health!, state: 'warming-up' as never } })).toEqual({
      tone: 'off',
      text: 'gamestation:8765 answers, but in a state this version does not know (warming-up). Speaker work runs on this computer.'
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
