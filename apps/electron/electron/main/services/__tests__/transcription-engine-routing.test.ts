// @vitest-environment node

/**
 * What each engine of the chain sends to the audio route, when it is skipped,
 * and how the chain is read from Settings (16-oct-2026).
 */

import { describe, it, expect, vi } from 'vitest'
import { engineRouteInput, engineUnavailableReason, type AvailabilityDeps } from '../transcription-engine-routing'
import {
  chainForRequest,
  chainSettingsFromConfig,
  DEFAULT_FALLBACK_ENGINES,
  formatEngineStep,
  parseEngineStep,
} from '../transcription-engine-chain'
import type { ModelHostHealth } from '../model-host-client'

const health = (state: ModelHostHealth['state'], reason?: string): ModelHostHealth =>
  ({ version: '0.4.0', state, capabilities: [], ...(reason ? { reason } : {}) })

function deps(overrides: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
  return {
    hasGeminiKey: () => true,
    modelHost: () => ({ url: 'https://gamestation:8766', token: 't' }),
    checkHost: async () => health('ready'),
    localAsrPath: () => 'C:/asr',
    fileExists: () => true,
    ...overrides,
  }
}

describe('engineRouteInput', () => {
  it('sends a remote step to the paired host with its own model, whatever Settings selected', () => {
    expect(engineRouteInput({ provider: 'remote', model: 'Qwen/Qwen3-ASR-1.7B' }))
      .toEqual({ provider: 'remote-worker', location: 'remote', remoteAsrModel: 'Qwen/Qwen3-ASR-1.7B' })
  })

  it('keeps local VibeVoice and local Cohere apart', () => {
    expect(engineRouteInput({ provider: 'local', model: 'microsoft/VibeVoice-ASR' })?.provider).toBe('vibevoice')
    expect(engineRouteInput({ provider: 'local', model: 'CohereLabs/cohere-transcribe-03-2026' }))
      .toEqual({ provider: 'local-asr', location: 'local' })
  })

  it('leaves a requested provider to the old path', () => {
    expect(engineRouteInput({ provider: 'gemini' })).toEqual({ provider: 'gemini' })
    expect(engineRouteInput({ provider: 'requested', model: 'local-asr' })).toBeNull()
  })
})

describe('engineUnavailableReason', () => {
  it('skips Gemini without a key and a host that is not paired', async () => {
    expect(await engineUnavailableReason({ provider: 'gemini' }, deps({ hasGeminiKey: () => false })))
      .toBe('Gemini API key not configured')
    expect(await engineUnavailableReason({ provider: 'remote', model: 'm' }, deps({ modelHost: () => ({ url: '', token: '' }) })))
      .toBe('No Model Host is paired')
  })

  it('skips a host that is off or paused, and tries one that is busy', async () => {
    expect(await engineUnavailableReason({ provider: 'remote', model: 'm' }, deps({ checkHost: async () => null })))
      .toMatch(/not answering/)
    expect(await engineUnavailableReason({ provider: 'remote', model: 'm' }, deps({ checkHost: async () => health('paused', 'a game is running') })))
      .toBe('The Model Host is paused: a game is running')
    expect(await engineUnavailableReason({ provider: 'remote', model: 'm' }, deps({ checkHost: async () => health('busy') })))
      .toBeNull()
  })

  it('skips local Cohere when the runner is missing, never asks the host for it', async () => {
    const checkHost = vi.fn()
    expect(await engineUnavailableReason({ provider: 'local', model: 'CohereLabs/cohere-transcribe-03-2026' },
      deps({ fileExists: () => false, checkHost }))).toMatch(/Local ASR runner not found: .*mcp_runner\.py/)
    expect(await engineUnavailableReason({ provider: 'local' }, deps({ localAsrPath: () => undefined })))
      .toBe('Local ASR path not configured')
    expect(checkHost).not.toHaveBeenCalled()
  })
})

describe('chain settings from config', () => {
  it('uses the measured default when nothing is saved', () => {
    const settings = chainSettingsFromConfig({})
    expect(settings.chain).toEqual([{ provider: 'configured', model: 'gemini' }, ...DEFAULT_FALLBACK_ENGINES])
    expect(settings.fallbackEnabled).toBe(true)
    expect(settings.retryPolicy.retries.quota).toBe(3)
  })

  it('reads the saved order, drops unreadable and repeated entries, and clamps retries', () => {
    const settings = chainSettingsFromConfig({
      engineChain: ['remote:Qwen/Qwen3-ASR-1.7B', 'nonsense', 'gemini', 'remote:Qwen/Qwen3-ASR-1.7B', 'local:'],
      engineRetries: { transient: 9, quota: -2, incomplete: 1.7 },
      engineFallbackEnabled: false,
    })
    expect(settings.chain.map(formatEngineStep)).toEqual(['remote:Qwen/Qwen3-ASR-1.7B', 'gemini'])
    expect(settings.retryPolicy.retries).toMatchObject({ transient: 5, quota: 0, incomplete: 1, input: 0 })
    expect(settings.fallbackEnabled).toBe(false)
  })

  it('starts with the engine chosen in Settings and does not repeat it as a fallback', () => {
    const settings = chainSettingsFromConfig({ provider: 'remote-worker', remoteAsrModel: 'moondream/parakeet-ultra' })
    expect(settings.chain).toEqual([
      { provider: 'configured', model: 'remote-worker' },
      { provider: 'remote', model: 'Qwen/Qwen3-ASR-1.7B' },
    ])
    expect(chainSettingsFromConfig({ provider: 'local-asr' }).chain[0]).toEqual({ provider: 'configured', model: 'local-asr' })
  })

  it('takes the default when every saved entry is unreadable', () => {
    expect(chainSettingsFromConfig({ engineChain: ['nonsense', 'remote:'] }).chain.map(formatEngineStep))
      .toEqual(['configured', ...DEFAULT_FALLBACK_ENGINES.map(formatEngineStep)])
  })

  it('round-trips every step form', () => {
    for (const text of ['gemini', 'configured', 'remote:moondream/parakeet-ultra', 'local:microsoft/VibeVoice-ASR']) {
      expect(formatEngineStep(parseEngineStep(text)!)).toBe(text)
    }
  })

  it('a row that named its provider runs only that engine, keeping the retries', () => {
    const settings = chainForRequest(chainSettingsFromConfig({}), 'local-asr')
    expect(settings.chain).toEqual([{ provider: 'requested', model: 'local-asr' }])
    expect(settings.fallbackEnabled).toBe(false)
    expect(settings.retryPolicy.retries.transient).toBe(2)
    expect(chainForRequest(chainSettingsFromConfig({}), null).chain.map(formatEngineStep))
      .toEqual(['configured', ...DEFAULT_FALLBACK_ENGINES.map(formatEngineStep)])
  })
})
