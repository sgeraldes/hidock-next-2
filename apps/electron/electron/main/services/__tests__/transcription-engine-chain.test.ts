/**
 * The engine chain: repeat when the class allows it, move to the next
 * available engine, stop only when nothing can help, and log every attempt.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CHAIN_SETTINGS,
  EngineChainExhaustedError,
  runEngineChain,
  type ChainSettings,
  type EngineStep,
} from '../transcription-engine-chain'

const gemini: EngineStep = { provider: 'gemini' }
const parakeet: EngineStep = { provider: 'remote', model: 'nvidia/parakeet-tdt-0.6b-v3' }
const local: EngineStep = { provider: 'local', model: 'nvidia/parakeet-tdt-0.6b-v3' }
const settings = (over: Partial<ChainSettings> = {}): ChainSettings => ({ ...DEFAULT_CHAIN_SETTINGS, chain: [gemini, parakeet, local], ...over })

function deps(script: Record<string, Array<'ok' | string>>, unavailable: Record<string, string> = {}) {
  const calls: string[] = []
  const sleeps: number[] = []
  const record = vi.fn()
  return {
    calls, sleeps, record,
    d: {
      run: async (step: EngineStep, attempt: number) => {
        const key = step.provider === 'gemini' ? 'gemini' : `${step.provider}:${step.model}`
        calls.push(`${key}#${attempt}`)
        const outcome = (script[key] ?? [])[attempt - 1] ?? 'unscripted failure'
        if (outcome === 'ok') return `text from ${key}`
        throw new Error(outcome)
      },
      unavailableReason: async (step: EngineStep) => unavailable[step.provider === 'gemini' ? 'gemini' : `${step.provider}:${step.model}`] ?? null,
      sleep: async (s: number) => { sleeps.push(s) },
      record,
      shouldContinue: () => true,
    },
  }
}

describe('runEngineChain', () => {
  it('waits out a free-tier 429 and succeeds on Gemini without falling back', async () => {
    const t = deps({ gemini: ['429 Rate limit exceeded ... Please retry in 39s', 'ok'] })
    const out = await runEngineChain(settings(), t.d)
    expect(out.result).toBe('text from gemini')
    expect(t.calls).toEqual(['gemini#1', 'gemini#2'])
    expect(t.sleeps).toEqual([41])
  })

  it('moves to the gamestation when Gemini answers short, without repeating Gemini (Rec12, 13-oct)', async () => {
    const t = deps({
      gemini: ['Provider response retained: covers 2% of the 426s recording; automatic audio retry disabled'],
      'remote:nvidia/parakeet-tdt-0.6b-v3': ['ok'],
    })
    const out = await runEngineChain(settings(), t.d)
    expect(out.engine).toEqual(parakeet)
    expect(t.calls).toEqual(['gemini#1', 'remote:nvidia/parakeet-tdt-0.6b-v3#1'])
    expect(out.attempts.map((a) => a.outcome)).toEqual(['failed', 'succeeded'])
    expect(out.attempts[0].errorClass).toBe('incomplete')
  })

  it('skips an engine that is not available right now and says why (Rec09, 15-oct)', async () => {
    const t = deps({ gemini: ['Gemini API key not configured'], 'local:nvidia/parakeet-tdt-0.6b-v3': ['ok'] },
      { 'remote:nvidia/parakeet-tdt-0.6b-v3': 'The worker has not advertised the selected ASR engine' })
    const out = await runEngineChain(settings(), t.d)
    expect(out.engine).toEqual(local)
    expect(out.attempts.map((a) => `${a.engine}:${a.outcome}`)).toEqual([
      'gemini:failed', 'remote:nvidia/parakeet-tdt-0.6b-v3:skipped-unavailable', 'local:nvidia/parakeet-tdt-0.6b-v3:succeeded',
    ])
    expect(t.record).toHaveBeenCalledTimes(3)
  })

  it('stops at once when the recording itself is missing', async () => {
    const t = deps({ gemini: ['Recording not found or no local file: x'] })
    await expect(runEngineChain(settings(), t.d)).rejects.toThrow(/Recording not found/)
    expect(t.calls).toEqual(['gemini#1'])
  })

  it('with fallback off, only the first engine runs, with its retries', async () => {
    const t = deps({ gemini: ['fetch failed', 'fetch failed', 'fetch failed'], 'remote:nvidia/parakeet-tdt-0.6b-v3': ['ok'] })
    const error = await runEngineChain(settings({ fallbackEnabled: false }), t.d).catch((e) => e)
    expect(error).toBeInstanceOf(EngineChainExhaustedError)
    expect(t.calls).toEqual(['gemini#1', 'gemini#2', 'gemini#3'])
    expect(t.sleeps).toEqual([30, 60])
  })

  it('when every engine fails, the error lists each attempt', async () => {
    const t = deps({ gemini: ['Gemini API key not configured'], 'remote:nvidia/parakeet-tdt-0.6b-v3': ['VibeVoice returned an empty transcript'], 'local:nvidia/parakeet-tdt-0.6b-v3': ['AudioLoadError'] })
    const error = await runEngineChain(settings(), t.d).catch((e) => e)
    expect(error).toBeInstanceOf(EngineChainExhaustedError)
    expect(error.message).toMatch(/gemini #1 failed \(credentials\); remote:nvidia\/parakeet-tdt-0.6b-v3 #1 failed \(input\); local:nvidia\/parakeet-tdt-0.6b-v3 #1 failed \(input\)/)
  })

  it('stops between attempts when the owner cancels, surfacing the failure it had', async () => {
    let go = true
    const t = deps({ gemini: ['fetch failed', 'ok'] })
    t.d.sleep = async () => { go = false }
    t.d.shouldContinue = () => go
    await expect(runEngineChain(settings(), t.d)).rejects.toThrow('fetch failed')
    expect(t.calls).toEqual(['gemini#1'])
  })

  it('always makes the first attempt: the run applies its own eligibility gates', async () => {
    const t = deps({ gemini: ['ok'] })
    t.d.shouldContinue = () => false
    await expect(runEngineChain(settings(), t.d)).resolves.toMatchObject({ engine: { provider: 'gemini' } })
    expect(t.calls).toEqual(['gemini#1'])
  })

  it('records which engine really produced the text on a success (27-oct-2026)', async () => {
    // Rec16 retried on the configured engine reused Parakeet's stored transcript;
    // the log said "gemini succeeded".
    const t = deps({ gemini: ['ok'] })
    const describe = vi.fn((result: string) => result + ' (reused)')
    await runEngineChain(settings(), { ...t.d, describeSuccess: describe })
    expect(t.record.mock.calls.at(-1)?.[0]).toMatchObject({ engine: 'gemini', outcome: 'succeeded', message: 'text from gemini (reused)' })
  })
})
