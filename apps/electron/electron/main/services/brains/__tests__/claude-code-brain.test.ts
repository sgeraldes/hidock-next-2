/**
 * ClaudeCodeBrain tests — verifies capabilities, HONEST auth detection via
 * `claude auth status --json` (+ ANTHROPIC_API_KEY), argv construction for
 * `claude -p` with the PROMPT PIPED VIA STDIN (never argv), stdout parsing,
 * timeout/abort → null, and no-throw on spawn error. Fake spawn only.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeCodeBrain, LEAN_CLAUDE_ARGS, parseClaudeOutput, resolveClaudeCommand } from '../claude-code-brain'
import type { SpawnFn } from '../cli-runner'
import { makeFakeSpawn, type FakeSpawnScript } from './fake-spawn'
import { createHarnessUsageCollector } from '../harness-usage'
import { isBrainCoolingDown, _resetBrainCooldownsForTests } from '../brain-cooldown'

const asSpawn = (fn: unknown) => fn as SpawnFn

/** Route `auth status` vs generate to different scripts. */
function scripted(auth: FakeSpawnScript, generate: FakeSpawnScript) {
  return (_cmd: string, args: string[]): FakeSpawnScript => (args[0] === 'auth' ? auth : generate)
}

describe('ClaudeCodeBrain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('advertises generate/chat/agentic only (no audio, no embed)', () => {
    const brain = new ClaudeCodeBrain()
    expect([...brain.capabilities()].sort()).toEqual(['agentic', 'chat', 'generate'])
  })

  describe('authStatus', () => {
    it('configured=cli-login when `claude auth status --json` reports loggedIn', async () => {
      const spawn = makeFakeSpawn({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.com' }), code: 0 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const status = await brain.authStatus()
      expect(status.configured).toBe(true)
      expect(status.method).toBe('cli-login')
      expect(spawn.calls[0]).toMatchObject({ command: 'claude', args: ['auth', 'status', '--json'] })
    })

    it('NOT configured when installed but not logged in (loggedIn:false, no key)', async () => {
      const spawn = makeFakeSpawn({ stdout: JSON.stringify({ loggedIn: false }), code: 0 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const status = await brain.authStatus()
      expect(status.configured).toBe(false)
      expect(status.method).toBe('none')
      // Honest: never labels a not-logged-in CLI as usable.
      expect(status.detail).toMatch(/not logged in/i)
    })

    it('surfaces the authMethod in the detail (e.g. "Logged in (claude.ai)")', async () => {
      const spawn = makeFakeSpawn({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.com' }),
        code: 0,
      })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const status = await brain.authStatus()
      expect(status.configured).toBe(true)
      expect(status.method).toBe('cli-login')
      expect(status.detail).toBe('Logged in (claude.ai)')
    })

    it('reports api-key when ANTHROPIC_API_KEY is set', async () => {
      const spawn = makeFakeSpawn({ stdout: JSON.stringify({ loggedIn: true }), code: 0 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: { ANTHROPIC_API_KEY: 'sk-x' } })
      const status = await brain.authStatus()
      expect(status.configured).toBe(true)
      expect(status.method).toBe('api-key')
    })

    it('not configured when the CLI is absent and no API key', async () => {
      const spawn = makeFakeSpawn({ emitError: true })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const status = await brain.authStatus()
      expect(status.configured).toBe(false)
      expect(status.method).toBe('none')
    })

    it('still configured (api-key) when the CLI is absent but a key is present', async () => {
      const spawn = makeFakeSpawn({ emitError: true })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: { ANTHROPIC_API_KEY: 'sk-x' } })
      expect((await brain.authStatus()).configured).toBe(true)
    })
  })

  describe('generate', () => {
    it('builds `claude -p` with the prompt on STDIN (not argv) and returns trimmed stdout', async () => {
      const spawn = makeFakeSpawn(scripted({ stdout: '{}', code: 0 }, { stdout: '  the answer  ', code: 0 }))
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const out = await brain.generate([{ role: 'user', content: 'q' }])
      expect(out).toBe('the answer')
      const genCall = spawn.calls.find((c) => c.args[0] === '-p')
      expect(genCall?.args).toEqual(['-p', ...LEAN_CLAUDE_ARGS]) // prompt is NOT in argv
      expect(spawn.lastChild?.stdin.write).toHaveBeenCalledWith('User: q') // prompt on stdin
    })

    it('appends --model when opts.model is set (prompt still on stdin)', async () => {
      const spawn = makeFakeSpawn({ stdout: 'ok', code: 0 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      await brain.generate([{ role: 'user', content: 'q' }], { model: 'opus' })
      expect(spawn.calls[0].args).toEqual(['-p', ...LEAN_CLAUDE_ARGS, '--model', 'opus'])
      expect(spawn.lastChild?.stdin.write).toHaveBeenCalledWith('User: q')
    })

    it('returns null on non-zero exit (no throw)', async () => {
      const spawn = makeFakeSpawn({ stderr: 'auth error', code: 1 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    })

    it('returns null on spawn error (CLI missing)', async () => {
      const spawn = makeFakeSpawn({ emitError: true })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    })

    it('returns null and kills the child when aborted', async () => {
      const spawn = makeFakeSpawn({ never: true })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      const controller = new AbortController()
      const p = brain.generate([{ role: 'user', content: 'q' }], { signal: controller.signal })
      // Command resolution is async now — let the child actually spawn first so
      // the abort exercises the kill path (an abort BEFORE spawn also nulls, but
      // then there is no child to kill).
      await new Promise((r) => setTimeout(r, 0))
      controller.abort()
      expect(await p).toBeNull()
      expect(spawn.lastChild?.kill).toHaveBeenCalled()
    })

    it('returns null on empty prompt without spawning', async () => {
      const spawn = makeFakeSpawn({ stdout: 'x', code: 0 })
      const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
      expect(await brain.generate([])).toBeNull()
      expect(spawn.calls).toHaveLength(0)
    })
  })

  it('chat folds history into the STDIN prompt (system + turns)', async () => {
    const spawn = makeFakeSpawn({ stdout: 'reply', code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
    const out = await brain.chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(out).toBe('reply')
    expect(spawn.calls[0].args).toEqual(['-p', ...LEAN_CLAUDE_ARGS])
    expect(spawn.lastChild?.stdin.write).toHaveBeenCalledWith('System: sys\n\nUser: hi')
  })
})

describe('a text run is stripped down (30-sep-2026: 15.8 s with the defaults, about 5 s lean)', () => {
  const run = async (opts: Parameters<ClaudeCodeBrain['generate']>[1] = {}) => {
    const spawn = makeFakeSpawn({ stdout: 'ok', code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {} })
    await brain.generate([{ role: 'user', content: 'q' }], opts)
    return spawn.calls[0] as { args: string[]; options?: { cwd?: string } }
  }

  it('loads no MCP server, skill, tool, session file or settings source, and no coding-agent system prompt', async () => {
    const call = await run()
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--tools=', '--no-session-persistence', '--setting-sources=']) {
      expect(call.args, flag).toContain(flag)
    }
    const at = call.args.indexOf('--system-prompt')
    expect(at).toBeGreaterThan(-1)
    expect(call.args[at + 1]).toMatch(/text-processing function/)
  })

  it('runs in an empty folder, so no project file is found from it', async () => {
    const call = await run()
    expect(call.options?.cwd).toMatch(/hidock-harness$/)
  })

  it('passes the model and the effort it is given, and leaves them out when it is not given any', async () => {
    const withBoth = await run({ model: 'haiku', effort: 'low' })
    expect(withBoth.args.slice(-4)).toEqual(['--model', 'haiku', '--effort', 'low'])
    const bare = await run()
    expect(bare.args).not.toContain('--model')
    expect(bare.args).not.toContain('--effort')
  })

  it('keeps the full configuration for a run that works in a repository', async () => {
    const call = await run({ cwd: 'C:\\target\\repo', agentic: true, model: 'sonnet' })
    expect(call.args).toEqual(['-p', '--model', 'sonnet'])
    expect(call.options?.cwd).toBe('C:\\target\\repo')
  })

  it('a cwd alone does not turn a text run into an agent: it stays lean, in that folder', async () => {
    const call = await run({ cwd: 'C:\\somewhere' })
    expect(call.args).toEqual(['-p', ...LEAN_CLAUDE_ARGS])
    expect(call.options?.cwd).toBe('C:\\somewhere')
  })
})

describe('resolveClaudeCommand (trusted-root, identity-verified resolution)', () => {
  // PATH deliberately contains an "evil" dir that is NOT a trusted root — the
  // resolver must never even look there.
  const env = { PATH: 'C:\\evil;C:\\trusted' } as NodeJS.ProcessEnv
  const TRUSTED = 'C:\\trusted'
  const REAL = 'C:\\trusted\\claude.exe'
  const noOverride = () => ''

  it('NEVER probes/executes an exe from an arbitrary PATH directory (untrusted discovery banned)', async () => {
    // A malicious claude.exe sits on an arbitrary PATH dir — identity-probing it
    // would BE the code execution, so it must never be discovered at all.
    const checked: string[] = []
    const fileExists = (p: string) => {
      checked.push(p)
      return p === 'C:\\evil\\claude.exe'
    }
    const verify = vi.fn(async () => true)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: noOverride,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe('claude') // bare fallback — Windows' normal selection
    expect(verify).not.toHaveBeenCalled() // the evil exe was never executed
    expect(checked.some((p) => p.startsWith('C:\\evil'))).toBe(false) // never even looked there
  })

  it('uses a trusted-root exe only after it passes identity verification', async () => {
    const fileExists = (p: string) => p === REAL
    const verify = vi.fn(async (p: string) => p === REAL)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: noOverride,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe(REAL)
    expect(verify).toHaveBeenCalledWith(REAL)
  })

  it('REJECTS a trusted-root exe that fails identity verification', async () => {
    const fileExists = (p: string) => p === REAL
    const verify = vi.fn(async () => false)
    expect(
      await resolveClaudeCommand(env, {
        platform: 'win32',
        fileExists,
        verify,
        getConfiguredPath: noOverride,
        trustedRoots: [TRUSTED],
      })
    ).toBe('claude')
  })

  it('a VALID config override is identity-VERIFIED first, then wins over trusted roots', async () => {
    const CUSTOM = 'D:\\my-tools\\claude-custom.exe'
    const fileExists = (p: string) => p === CUSTOM || p === REAL
    const verify = vi.fn(async (p: string) => p === CUSTOM || p === REAL)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => CUSTOM,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe(CUSTOM) // beats the trusted-root candidate…
    expect(verify).toHaveBeenCalledWith(CUSTOM) // …but only AFTER identity verification
  })

  it('an override pointing at a NON-Claude exe is rejected (verify called, never selected)', async () => {
    // The renderer-exposed setCredential channel can store any path — the
    // signature check is the trust boundary, not "user consent".
    const EVIL = 'D:\\payload\\claude.exe'
    const fileExists = (p: string) => p === EVIL || p === REAL
    const verify = vi.fn(async (p: string) => p === REAL) // EVIL fails the signature
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => EVIL,
      trustedRoots: [TRUSTED],
    })
    expect(verify).toHaveBeenCalledWith(EVIL) // bounded identity probe ran…
    expect(out).toBe(REAL) // …failed → fell through to the trusted root
  })

  it('rejects a RELATIVE override without any filesystem or execution contact', async () => {
    const fileExists = vi.fn((p: string) => p === REAL)
    const verify = vi.fn(async (p: string) => p === REAL)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => 'tools\\claude.exe',
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe(REAL) // fell through to trusted roots
    expect(verify).not.toHaveBeenCalledWith('tools\\claude.exe')
    expect(fileExists).not.toHaveBeenCalledWith('tools\\claude.exe')
  })

  it('rejects a UNC/network override without any filesystem or execution contact', async () => {
    const UNC = '\\\\evil-server\\share\\claude.exe'
    const fileExists = vi.fn(() => false)
    const verify = vi.fn(async () => true)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => UNC,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe('claude')
    expect(verify).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalledWith(UNC)
  })

  it('rejects a non-.exe/.com override on win32 (wrapper shims can smuggle anything)', async () => {
    const SHIM = 'C:\\tools\\claude.cmd'
    const fileExists = vi.fn(() => false)
    const verify = vi.fn(async () => true)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => SHIM,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe('claude')
    expect(verify).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalledWith(SHIM)
  })

  it('generate never spawns a rejected override (end-to-end through the brain)', async () => {
    const EVIL = 'D:\\payload\\claude.exe'
    // Wire the brain to the REAL resolver with a failing-override scenario.
    const resolveCommand = () =>
      resolveClaudeCommand(env, {
        platform: 'win32',
        fileExists: (p: string) => p === EVIL,
        verify: async () => false, // the payload fails the signature
        getConfiguredPath: () => EVIL,
        trustedRoots: [TRUSTED],
      })
    const spawn = makeFakeSpawn({ stdout: 'answer', code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBe('answer')
    expect(spawn.calls.length).toBeGreaterThan(0)
    expect(spawn.calls.every((c) => c.command === 'claude')).toBe(true)
    expect(spawn.calls.some((c) => c.command === EVIL)).toBe(false)
  })

  it('ignores a configured override whose file does not exist (falls through to trusted roots)', async () => {
    const fileExists = (p: string) => p === REAL
    const verify = vi.fn(async () => true)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: () => 'D:\\gone\\claude.exe',
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe(REAL)
  })

  it('falls back to the bare command when trusted roots hold no native exe', async () => {
    const fileExists = () => false
    const verify = vi.fn(async () => true)
    const out = await resolveClaudeCommand(env, {
      platform: 'win32',
      fileExists,
      verify,
      getConfiguredPath: noOverride,
      trustedRoots: [TRUSTED],
    })
    expect(out).toBe('claude')
    expect(verify).not.toHaveBeenCalled()
  })

  it('treats a throwing verifier as unverified (never throws, falls back)', async () => {
    const fileExists = (p: string) => p === REAL
    const verify = vi.fn(async () => {
      throw new Error('probe exploded')
    })
    expect(
      await resolveClaudeCommand(env, {
        platform: 'win32',
        fileExists,
        verify,
        getConfiguredPath: noOverride,
        trustedRoots: [TRUSTED],
      })
    ).toBe('claude')
  })

  it('is a no-op off win32 (POSIX resolves natively) — a VERIFIED override still wins', async () => {
    const fileExists = () => true
    const verify = vi.fn(async () => true)
    expect(
      await resolveClaudeCommand(env, {
        platform: 'linux',
        fileExists,
        verify,
        getConfiguredPath: noOverride,
        trustedRoots: [TRUSTED],
      })
    ).toBe('claude')
    expect(verify).not.toHaveBeenCalled()
    // The explicit user override applies on any platform — after verification.
    expect(
      await resolveClaudeCommand(env, {
        platform: 'linux',
        fileExists,
        verify,
        getConfiguredPath: () => '/opt/claude/claude',
        trustedRoots: [TRUSTED],
      })
    ).toBe('/opt/claude/claude')
    expect(verify).toHaveBeenCalledWith('/opt/claude/claude')
  })
})

describe('stale resolution cache (invalidate + single re-resolve)', () => {
  const DEAD = 'C:\\dead\\claude.exe'
  const REAL = 'C:\\trusted\\claude.exe'

  it('uninstall-mid-session: a dead cached path recovers on the next call', async () => {
    let call = 0
    const resolveCommand = vi.fn(async () => (++call === 1 ? DEAD : 'claude'))
    const spawn = makeFakeSpawn((cmd) =>
      cmd === DEAD
        ? ({ emitError: true } as FakeSpawnScript)
        : ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), code: 0 } as FakeSpawnScript)
    )
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    const status = await brain.authStatus()
    expect(status.configured).toBe(true)
    expect(status.detail).toBe('Logged in (claude.ai)')
    expect(resolveCommand).toHaveBeenCalledTimes(2) // initial + one re-resolve
    expect(spawn.calls.map((c) => c.command)).toEqual([DEAD, 'claude'])
  })

  it('install-after-fallback: a broken bare fallback picks up the newly installed native exe', async () => {
    let call = 0
    const resolveCommand = vi.fn(async () => (++call === 1 ? 'claude' : REAL))
    const spawn = makeFakeSpawn((cmd) =>
      cmd === 'claude'
        ? ({ stdout: '', stderr: 'claude: command not found', code: 127 } as FakeSpawnScript)
        : ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), code: 0 } as FakeSpawnScript)
    )
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    const status = await brain.authStatus()
    expect(status.configured).toBe(true)
    expect(spawn.calls.map((c) => c.command)).toEqual(['claude', REAL])
  })

  it('no infinite re-resolve loop: exactly one retry per operation', async () => {
    const resolveCommand = vi.fn(async () => DEAD)
    const spawn = makeFakeSpawn({ emitError: true })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    const status = await brain.authStatus()
    expect(status.configured).toBe(false)
    expect(spawn.calls).toHaveLength(2) // initial + single retry, then stop
    expect(resolveCommand).toHaveBeenCalledTimes(2)
  })

  it('a clean "not logged in" (code 0 + parsed JSON) is NOT retried', async () => {
    const resolveCommand = vi.fn(async () => 'claude')
    const spawn = makeFakeSpawn({ stdout: JSON.stringify({ loggedIn: false }), code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    const status = await brain.authStatus()
    expect(status.configured).toBe(false)
    expect(spawn.calls).toHaveLength(1) // legitimate answer — no re-resolution
    expect(resolveCommand).toHaveBeenCalledTimes(1)
  })

  it('generate retries once after a spawn error with a fresh resolution', async () => {
    let call = 0
    const resolveCommand = vi.fn(async () => (++call === 1 ? DEAD : 'claude'))
    const spawn = makeFakeSpawn((cmd) =>
      cmd === DEAD ? ({ emitError: true } as FakeSpawnScript) : ({ stdout: 'answer', code: 0 } as FakeSpawnScript)
    )
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand })
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBe('answer')
    expect(spawn.calls.map((c) => c.command)).toEqual([DEAD, 'claude'])
  })
})

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'OK',
  duration_ms: 2094,
  total_cost_usd: 0.002085,
  usage: {
    input_tokens: 1860,
    output_tokens: 45,
    cache_read_input_tokens: 12,
    output_tokens_details: { thinking_tokens: 38 }
  },
  modelUsage: { 'claude-haiku-4-5-20251001': {} }
}
const EVENTS = [
  { type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' },
  { type: 'assistant', message: {} },
  RESULT_EVENT
]

describe('parseClaudeOutput', () => {
  it('reads the answer, tokens, cost and model from the result event of a JSON array', () => {
    expect(parseClaudeOutput(JSON.stringify(EVENTS))).toEqual({
      text: 'OK',
      isError: false,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1860,
      outputTokens: 7, // 45 output tokens, 38 of them thinking
      thinkingTokens: 38,
      cachedTokens: 12,
      costUsd: 0.002085
    })
  })

  it('reads a single result object', () => {
    expect(parseClaudeOutput(JSON.stringify(RESULT_EVENT)).text).toBe('OK')
  })

  it('keeps plain text as the answer (an older CLI, or a test double)', () => {
    expect(parseClaudeOutput('  plain answer \n')).toEqual({ text: 'plain answer', isError: false })
  })

  it('does not mistake an answer that is itself valid JSON for the CLI envelope', () => {
    expect(parseClaudeOutput('42').text).toBe('42')
    expect(parseClaudeOutput('{"summary":"x"}').text).toBe('{"summary":"x"}')
    expect(parseClaudeOutput('[1,2,3]').text).toBe('[1,2,3]')
  })

  it('gives no answer for events without a result, and none for empty output', () => {
    expect(parseClaudeOutput(JSON.stringify(EVENTS.slice(0, 2)))).toEqual({ text: null, isError: false })
    expect(parseClaudeOutput('')).toEqual({ text: null, isError: false })
  })

  it('marks an error result as an error and keeps its message', () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, subtype: 'error_during_execution', result: 'Claude usage limit reached|1759000000' }
    const parsed = parseClaudeOutput(JSON.stringify([errorEvent]))
    expect(parsed.isError).toBe(true)
    expect(parsed.text).toBe('Claude usage limit reached|1759000000')
  })
})

describe('ClaudeCodeBrain reports usage and reads the JSON result', () => {
  afterEach(() => _resetBrainCooldownsForTests())

  it('asks for JSON on a text run and answers with the result text', async () => {
    const spawn = makeFakeSpawn({ stdout: JSON.stringify(EVENTS), code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand: async () => 'claude' })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => brain.generate([{ role: 'user', content: 'q' }], { model: 'haiku' }))
    expect(out).toBe('OK')
    expect(spawn.calls[0].args).toContain('--output-format')
    expect(spawn.calls[0].args[spawn.calls[0].args.indexOf('--output-format') + 1]).toBe('json')
    const bucket = collector.total()!.byModel['claude-code:claude-haiku-4-5-20251001']
    expect(bucket).toMatchObject({ calls: 1, inputTokens: 1860, outputTokens: 7, thinkingTokens: 38, cachedTokens: 12, reportedCostUsd: 0.002085 })
    expect(Number.isFinite(bucket.durationMs)).toBe(true)
  })

  it('does not ask for JSON on an agentic run, and takes stdout as the answer', async () => {
    const spawn = makeFakeSpawn({ stdout: 'plain', code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand: async () => 'claude' })
    const collector = createHarnessUsageCollector()
    const out = await collector.run(() => brain.generate([{ role: 'user', content: 'q' }], { agentic: true, cwd: 'C:\\repo' }))
    expect(out).toBe('plain')
    expect(spawn.calls[0].args).not.toContain('--output-format')
    expect(collector.total()!.calls).toBe(1) // time only
  })

  it('treats an error result as a failure, not as an answer, and rests the brain when it is out of quota', async () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, result: 'Claude usage limit reached|1759000000' }
    const spawn = makeFakeSpawn({ stdout: JSON.stringify([errorEvent]), code: 0 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand: async () => 'claude' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    expect(isBrainCoolingDown('claude-code')).toBe(true)
  })

  it('finds the out-of-quota message in the JSON of a failed run too', async () => {
    const errorEvent = { ...RESULT_EVENT, is_error: true, result: 'Claude usage limit reached|1759000000' }
    const spawn = makeFakeSpawn({ stdout: JSON.stringify([errorEvent]), stderr: '', code: 1 })
    const brain = new ClaudeCodeBrain({ spawn: asSpawn(spawn.fn), env: {}, resolveCommand: async () => 'claude' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await brain.generate([{ role: 'user', content: 'q' }])).toBeNull()
    expect(isBrainCoolingDown('claude-code')).toBe(true)
  })
})
