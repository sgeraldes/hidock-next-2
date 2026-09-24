// @vitest-environment node

/**
 * The Speaker setup asks once per hardware change, recommends an engine for
 * the hardware, and turns voice recognition off only behind a second
 * confirmation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = {
  transcription: {
    speakerEngine: 'auto',
    speakerLinkingEnabled: true,
    speakerSetupFingerprint: '',
    speakerSetupAt: '',
    modelHostUrl: '',
    modelHostToken: '',
  } as Record<string, unknown>,
}
const updateConfig = vi.fn(async (_section: string, patch: Record<string, unknown>) => {
  Object.assign(config.transcription, patch)
})
let runs: { started_at: string; completed_at: string; duration_seconds: number; quality_json: string | null }[] = []
let gpus: { name: string; vendor: string; driver: string | null; cuda: boolean }[] = []
let detectionFailed = false

vi.mock('../config', () => ({ getConfig: () => config, updateConfig: (s: string, p: Record<string, unknown>) => updateConfig(s, p) }))
vi.mock('../database', () => ({ queryAll: () => runs }))
vi.mock('../speaker-linking', () => ({
  libraryVoiceSpace: () => null,
  pinnedVoiceModel: () => 'pyannote/speaker-diarization-3.1'
}))
vi.mock('../hardware-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hardware-profile')>()
  return {
    ...actual,
    detectHardware: async () => ({
      gpus: detectionFailed ? [] : gpus,
      cpu: { model: 'Ryzen', logicalCores: 24 },
      platform: 'win32',
      ...(detectionFailed ? { detectionFailed: true } : {})
    }),
  }
})

import {
  applySpeakerSetup,
  dismissSpeakerSetup,
  getSpeakerSetup,
  measuredLocalSpeedRatio,
  resetSpeakerSetupCache,
  SpeakerSetupError,
} from '../speaker-setup'

const AMD = [
  { name: 'AMD Radeon(TM) Graphics', vendor: 'amd', driver: '1', cuda: false },
  { name: 'AMD Radeon RX 6600 XT', vendor: 'amd', driver: '1', cuda: false },
]
const RTX = { name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', driver: '1', cuda: true }

function run(minutes: number, audioSeconds: number, device: string | null) {
  const start = Date.parse('2026-09-20T10:00:00Z')
  return {
    started_at: new Date(start).toISOString(),
    completed_at: new Date(start + minutes * 60_000).toISOString(),
    duration_seconds: audioSeconds,
    quality_json: device ? JSON.stringify({ device }) : null,
  }
}

beforeEach(() => {
  Object.assign(config.transcription, {
    speakerEngine: 'auto',
    speakerLinkingEnabled: true,
    speakerSetupFingerprint: '',
    speakerSetupAt: '',
    speakerSetupDismissedFingerprint: '',
    modelHostUrl: '',
    modelHostToken: '',
  })
  detectionFailed = false
  updateConfig.mockClear()
  runs = []
  gpus = AMD
  resetSpeakerSetupCache()
})

describe('when the setup asks', () => {
  it('asks on the first launch with the feature', async () => {
    const setup = await getSpeakerSetup()
    expect(setup.needsConfirmation).toBe(true)
    expect(setup.lastConfirmedAt).toBeNull()
  })

  it('does not ask again on the same hardware once confirmed', async () => {
    const first = await getSpeakerSetup()
    await applySpeakerSetup({ engine: 'pyannote-local', fingerprint: first.fingerprint })
    const again = await getSpeakerSetup()
    expect(again.needsConfirmation).toBe(false)
    expect(again.configuredEngine).toBe('pyannote-local')
  })

  it('asks again when a GPU is added', async () => {
    const first = await getSpeakerSetup()
    await applySpeakerSetup({ engine: 'pyannote-local', fingerprint: first.fingerprint })
    gpus = [...AMD, RTX]
    const after = await getSpeakerSetup({ refresh: true })
    expect(after.needsConfirmation).toBe(true)
    expect(after.profile).toBe('nvidia-cuda')
  })

  it('asks again instead of saving when the GPUs changed while the setup was open', async () => {
    const first = await getSpeakerSetup()
    gpus = [...AMD, RTX]
    await getSpeakerSetup({ refresh: true })
    await expect(applySpeakerSetup({ engine: 'pyannote-local', fingerprint: first.fingerprint })).rejects.toThrow(
      /GPUs changed/
    )
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('stays closed on hardware the owner answered "Decide later" on, and opens on new hardware', async () => {
    await getSpeakerSetup()
    await dismissSpeakerSetup()
    expect((await getSpeakerSetup()).needsConfirmation).toBe(false)
    gpus = [...AMD, RTX]
    expect((await getSpeakerSetup({ refresh: true })).needsConfirmation).toBe(true)
  })

  it('does not open on a failed GPU query, and refuses to save a choice made on it', async () => {
    detectionFailed = true
    const setup = await getSpeakerSetup({ refresh: true })
    expect(setup.detectionFailed).toBe(true)
    expect(setup.needsConfirmation).toBe(false)
    expect(setup.profileSummary).toMatch(/Could not read the GPUs/)
    await expect(applySpeakerSetup({ engine: 'pyannote-local', fingerprint: setup.fingerprint })).rejects.toThrow(
      /Could not read the GPUs/
    )
    await dismissSpeakerSetup()
    expect(updateConfig).not.toHaveBeenCalled()
  })
})

describe('what can be chosen', () => {
  it('turns voice recognition off only with the second confirmation', async () => {
    const { fingerprint } = await getSpeakerSetup()
    await expect(applySpeakerSetup({ engine: 'off', fingerprint })).rejects.toBeInstanceOf(SpeakerSetupError)
    expect(updateConfig).not.toHaveBeenCalled()
    const after = await applySpeakerSetup({ engine: 'off', fingerprint, confirmOff: true })
    expect(config.transcription.speakerLinkingEnabled).toBe(false)
    expect(after.effectiveEngine).toBe('off')
  })

  it('refuses an engine that is not built yet, or a Model Host that is not paired', async () => {
    const { fingerprint } = await getSpeakerSetup()
    await expect(applySpeakerSetup({ engine: 'pyannoteai', fingerprint })).rejects.toThrow(/not available yet/)
    await expect(applySpeakerSetup({ engine: 'model-host', fingerprint })).rejects.toThrow(/Pair a Model Host/)
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('turns voice recognition back on when an engine is chosen after off', async () => {
    const { fingerprint } = await getSpeakerSetup()
    await applySpeakerSetup({ engine: 'off', fingerprint, confirmOff: true })
    await applySpeakerSetup({ engine: 'pyannote-local', fingerprint })
    expect(config.transcription.speakerLinkingEnabled).toBe(true)
  })
})

describe('measured speed', () => {
  it('is the median of runs on the same device, and needs at least three', () => {
    runs = [run(20, 3600, 'cpu'), run(25, 3600, 'cpu'), run(1, 3600, 'cuda')]
    const model = 'pyannote/speaker-diarization-3.1'
    expect(measuredLocalSpeedRatio('cpu', model)).toBeNull()
    runs.push(run(30, 3600, 'cpu'), run(5, 3600, null))
    expect(measuredLocalSpeedRatio('cpu', model)).toBeCloseTo(25 / 60)
    expect(measuredLocalSpeedRatio('cuda', model)).toBeNull()
  })

  it('shows on the pyannote option', async () => {
    runs = [run(20, 3600, 'cpu'), run(20, 3600, 'cpu'), run(20, 3600, 'cpu')]
    const setup = await getSpeakerSetup()
    expect(setup.options.find((o) => o.engine === 'pyannote-local')?.measuredSpeedRatio).toBeCloseTo(1 / 3)
  })
})
