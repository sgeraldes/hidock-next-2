/**
 * installPipeline puts the ledger and the plan source in place, and the main process calls it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const config = vi.hoisted(() => ({ pipeline: undefined as unknown }))
vi.mock('../../config', () => ({ getConfig: () => ({ brains: {}, pipeline: config.pipeline }) }))
vi.mock('../../ollama', () => ({ getOllamaService: () => ({ isAvailable: async () => false }) }))
const reporter = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock('@hidock/ai-providers', () => ({ setCompletionUsageReporter: reporter.set }))

import { installPipeline } from '../install'
import { installCallStore, writeCall } from '../call-store'
import { resolvePlan, setPlanSource } from '../plans'
import { DEFAULT_PLANS } from '../steps'

afterEach(() => {
  installCallStore(null)
  setPlanSource(null)
  config.pipeline = undefined
})

describe('installPipeline', () => {
  it('sends calls to the database it was given', () => {
    const run = vi.fn()
    installPipeline({ run, queryAll: vi.fn(() => []) })
    writeCall({
      step: 'notes', recordingId: null, route: 'r', provider: null, model: null, status: 'completed',
      startedAt: 'a', completedAt: 'b', durationMs: 1, parentCallId: null, usage: null,
      estimatedCostAmount: null, estimatedCostCurrency: null, costMethod: null, errorMessage: null
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('makes the configuration the plan source: Automatic until the owner chooses', () => {
    installPipeline({ run: vi.fn(), queryAll: vi.fn(() => []) })
    expect(resolvePlan('notes')).toBe(DEFAULT_PLANS.notes)
    config.pipeline = {
      version: 1,
      profiles: { 'ollama-qwen3-8b': { harness: 'ollama', model: 'qwen3:8b' } },
      steps: { notes: { passes: [{ calls: [{ profile: 'ollama-qwen3-8b', tasks: '*', role: 'produce' }] }] } }
    }
    expect(resolvePlan('notes').calls[0].profile).toMatchObject({ kind: 'direct', harness: 'ollama', model: 'qwen3:8b' })
  })

  it('registers the reporter that puts the completions of the AI providers package in the ledger', () => {
    installPipeline({ run: vi.fn(), queryAll: vi.fn(() => []) })
    expect(reporter.set).toHaveBeenCalledWith(expect.any(Function))
  })

  it('is called by the main process right after the database opens', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'index.ts'), 'utf-8')
    expect(source).toMatch(/installPipeline\(\{ run, queryAll \}\)/)
    expect(source.indexOf('installPipeline(')).toBeGreaterThan(source.indexOf('initializeDatabase('))
  })
})
