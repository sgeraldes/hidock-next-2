/**
 * A brain that is out of quota rests until its stated reset (29-sep-2026: the
 * Codex plan was at its limit until 4-oct and every note waited for `codex exec`
 * to fail before the next brain answered), and a failed CLI run never puts the
 * prompt it echoed into the log.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AIBrain, BrainCapability, BrainId, BrainRegistry } from '../index'

let mockBrainsConfig: unknown
vi.mock('../../config', () => ({ getConfig: () => ({ brains: mockBrainsConfig }) }))

import {
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
  _resetBrainCooldownsForTests,
  isBrainCoolingDown,
  isUsageLimitMessage,
  noteBrainFailure,
  parseUsageLimitReset
} from '../brain-cooldown'
import { CLI_FAILURE_LOG_MAX_CHARS, summarizeCliFailure, type SpawnFn } from '../cli-runner'
import { CodexBrain } from '../codex-brain'
import { BrainRouter } from '../brain-router'
import { makeFakeSpawn } from './fake-spawn'

const LIMIT_LINE =
  'ERROR: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 4th, 2026 1:38 AM.'
const NOTE = 'Enviar lista de gente con mas de una asignación a yaraví'
// What `codex exec` writes to stderr: the banner, the prompt it was given, then the error twice.
const CODEX_STDERR = [
  'Reading prompt from stdin...',
  'OpenAI Codex v0.158.0',
  '--------',
  'workdir: G:\\Code\\hidock-next-2\\apps\\electron',
  '--------',
  'user',
  'System: You organise short hand-written notes.',
  `User: ${NOTE}`,
  '',
  LIMIT_LINE,
  LIMIT_LINE
].join('\n')

beforeEach(() => {
  _resetBrainCooldownsForTests()
  mockBrainsConfig = undefined
})
afterEach(() => vi.restoreAllMocks())

describe('summarizeCliFailure', () => {
  it('keeps the error lines once and drops the prompt the CLI echoed', () => {
    const summary = summarizeCliFailure(CODEX_STDERR, 1)
    expect(summary).toBe(LIMIT_LINE)
    expect(summary).not.toContain(NOTE)
    expect(summary).not.toContain('System: You organise')
  })

  it('falls back to the last line when nothing states an error', () => {
    expect(summarizeCliFailure('starting\nsomething broke', 2)).toBe('something broke')
  })

  it('falls back to the exit code on empty stderr', () => {
    expect(summarizeCliFailure('  \n', 7)).toBe('exit 7')
  })

  it('cuts a long line', () => {
    const summary = summarizeCliFailure(`ERROR: ${'x'.repeat(2000)}`, 1)
    expect(summary.length).toBe(CLI_FAILURE_LOG_MAX_CHARS + 1)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('parseUsageLimitReset', () => {
  it('reads the Codex date in words as local time', () => {
    expect(parseUsageLimitReset(LIMIT_LINE)).toBe(new Date(2026, 9, 4, 1, 38).getTime())
  })

  it('reads a PM time and a day without an ordinal suffix', () => {
    expect(parseUsageLimitReset('try again at Nov 12, 2026 9:05 PM')).toBe(new Date(2026, 10, 12, 21, 5).getTime())
  })

  it('reads the epoch seconds Claude Code prints', () => {
    expect(parseUsageLimitReset('Claude AI usage limit reached|1791000000')).toBe(1791000000 * 1000)
  })

  it('returns null when no time is stated', () => {
    expect(parseUsageLimitReset('You have hit your usage limit')).toBeNull()
  })
})

describe('noteBrainFailure', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0)

  it('ignores a failure that is not about quota', () => {
    expect(noteBrainFailure('codex', 'ERROR: network unreachable', now)).toBe(false)
    expect(isBrainCoolingDown('codex', now)).toBe(false)
  })

  it('rests the brain until the stated reset, then lets it through', () => {
    const failedAt = new Date(2026, 8, 30, 12, 0).getTime()
    expect(noteBrainFailure('codex', LIMIT_LINE, failedAt)).toBe(true)
    expect(isBrainCoolingDown('codex', new Date(2026, 9, 3, 12, 0).getTime())).toBe(true)
    expect(isBrainCoolingDown('codex', new Date(2026, 9, 4, 1, 39).getTime())).toBe(false)
  })

  it('rests for an hour when the CLI states no reset', () => {
    noteBrainFailure('claude-code', 'usage limit reached', now)
    expect(isBrainCoolingDown('claude-code', now + DEFAULT_COOLDOWN_MS - 1)).toBe(true)
    expect(isBrainCoolingDown('claude-code', now + DEFAULT_COOLDOWN_MS + 1)).toBe(false)
  })

  it('does not trust a reset months away', () => {
    noteBrainFailure('codex', 'usage limit. try again at Jan 1st, 2030 1:00 AM', now)
    expect(isBrainCoolingDown('codex', now + MAX_COOLDOWN_MS - 1)).toBe(true)
    expect(isBrainCoolingDown('codex', now + MAX_COOLDOWN_MS + 1)).toBe(false)
  })

  it('rests at least a minute when the stated reset is already past', () => {
    noteBrainFailure('codex', 'usage limit. try again at Jan 1st, 2020 1:00 AM', now)
    expect(isBrainCoolingDown('codex', now + MIN_COOLDOWN_MS - 1)).toBe(true)
    expect(isBrainCoolingDown('codex', now + MIN_COOLDOWN_MS + 1)).toBe(false)
  })

  it('says so in the log once, not on every failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    noteBrainFailure('codex', LIMIT_LINE, new Date(2026, 8, 30, 12, 0).getTime())
    noteBrainFailure('codex', LIMIT_LINE, new Date(2026, 8, 30, 12, 5).getTime())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[Brains] codex is out of quota; skipping it until')
  })

  it('recognises the usual quota messages', () => {
    for (const text of ['You’ve hit your usage limit', 'Claude AI usage limit reached|1791000000', 'out of credits', 'RESOURCE_EXHAUSTED', 'Quota exceeded']) {
      expect(isUsageLimitMessage(text), text).toBe(true)
    }
    expect(isUsageLimitMessage('connection reset')).toBe(false)
  })
})

describe('CodexBrain when the plan is out of quota', () => {
  it('returns null, logs the error line without the note, and rests', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 30, 12, 0).getTime())
    const spawn = makeFakeSpawn({ stderr: CODEX_STDERR, code: 1 })
    const brain = new CodexBrain({ spawn: spawn.fn as unknown as SpawnFn, env: {} })

    const answer = await brain.generate([{ role: 'user', content: NOTE }])

    expect(answer).toBeNull()
    const logged = error.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain('You’ve hit your usage limit')
    expect(logged).not.toContain(NOTE)
    expect(isBrainCoolingDown('codex', new Date(2026, 9, 3).getTime())).toBe(true)
  })
})

describe('CodexBrain when the prompt it echoes mentions a usage limit', () => {
  it('does not rest: the failure is about something else', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const echoed = ['user', 'User: the vendor said we may hit the usage limit next month', 'ERROR: connection reset by peer'].join('\n')
    const spawn = makeFakeSpawn({ stderr: echoed, code: 1 })
    const brain = new CodexBrain({ spawn: spawn.fn as unknown as SpawnFn, env: {} })

    expect(await brain.generate([{ role: 'user', content: 'x' }])).toBeNull()

    expect(isBrainCoolingDown('codex')).toBe(false)
  })
})

describe('BrainRouter with a resting brain', () => {
  function makeBrain(id: BrainId): AIBrain {
    const caps = new Set<BrainCapability>(['generate', 'chat'])
    return {
      id,
      label: id,
      capabilities: () => caps,
      authStatus: async () => ({ configured: true, method: 'api-key' }),
      generate: vi.fn(async () => `${id}:gen`),
      chat: vi.fn(async () => `${id}:chat`)
    }
  }

  const registry = (brains: AIBrain[]) =>
    ({
      get: (id: BrainId) => brains.find((b) => b.id === id) ?? null,
      list: () => brains,
      has: (id: BrainId) => brains.some((b) => b.id === id)
    }) as unknown as BrainRegistry

  it('goes straight to the next brain and never calls the one that is out of quota', async () => {
    const codex = makeBrain('codex')
    const gemini = makeBrain('gemini-api')
    mockBrainsConfig = { defaultBrain: 'codex', enabled: { codex: true, 'gemini-api': true } }
    const router = new BrainRouter(registry([codex, gemini]))

    // Before: the configured default answers.
    expect(await router.chat('chat', [{ role: 'user', content: 'hi' }])).toBe('codex:chat')

    noteBrainFailure('codex', LIMIT_LINE, new Date(2026, 8, 30, 12, 0).getTime() - 1)
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 30, 12, 0).getTime())
    vi.mocked(codex.chat).mockClear()

    expect(await router.chat('chat', [{ role: 'user', content: 'hi' }])).toBe('gemini-api:chat')
    expect(codex.chat).not.toHaveBeenCalled()
    expect(await router.resolve('chat', 'chat')).toBe(gemini)
  })

  it('uses the brain again after the reset', async () => {
    const codex = makeBrain('codex')
    const gemini = makeBrain('gemini-api')
    mockBrainsConfig = { defaultBrain: 'codex', enabled: { codex: true, 'gemini-api': true } }
    const router = new BrainRouter(registry([codex, gemini]))
    noteBrainFailure('codex', LIMIT_LINE, new Date(2026, 8, 30, 12, 0).getTime())

    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 4, 2, 0).getTime())

    expect(await router.chat('chat', [{ role: 'user', content: 'hi' }])).toBe('codex:chat')
  })
})
