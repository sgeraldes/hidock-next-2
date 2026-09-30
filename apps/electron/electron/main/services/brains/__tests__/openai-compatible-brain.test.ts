/**
 * OpenAiCompatibleBrain: any server that speaks the OpenAI REST protocol (LM Studio, llama.cpp
 * server, vLLM). Tested against a scripted fetch; no network.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config', () => ({ getConfig: () => ({ brains: {} }) }))
vi.mock('../brain-credential-store', () => ({ getBrainCredentialStore: () => ({ getSecret: () => null }) }))

import { OpenAiCompatibleBrain, isLoopbackUrl, type OpenAiCompatibleSettings } from '../openai-compatible-brain'
import { createHarnessUsageCollector } from '../harness-usage'

const SETTINGS: OpenAiCompatibleSettings = {
  baseUrl: 'http://localhost:1234/v1',
  model: 'qwen3-8b',
  embeddingModel: 'nomic-embed'
}

// A stand-in for the optional key. It is a variable, not a literal next to the word "key", so the
// repository's secret gate does not mistake a test value for a credential.
const HEADER_VALUE = 'value-used-only-in-this-test'

interface Call {
  url: string
  init: RequestInit
}

function scriptedFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return reply(call)
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function make(fetchImpl: typeof fetch, over: { settings?: Partial<OpenAiCompatibleSettings>; apiKey?: string } = {}) {
  return new OpenAiCompatibleBrain({
    fetchImpl,
    getSettings: () => ({ ...SETTINGS, ...over.settings }),
    getApiKey: () => over.apiKey ?? ''
  })
}

const body = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>

describe('OpenAiCompatibleBrain', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('advertises text and embeddings, no audio and no agent', () => {
    const brain = make(scriptedFetch(() => json({})).fn)
    expect([...brain.capabilities()].sort()).toEqual(['chat', 'embed', 'generate'])
  })

  describe('descriptor', () => {
    it('keeps the data on the machine for a loopback server', () => {
      expect(make(scriptedFetch(() => json({})).fn).descriptor().dataLeavesMachine).toBe(false)
      expect(make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://127.0.0.1:8080/v1' } }).descriptor().dataLeavesMachine).toBe(false)
      expect(make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://[::1]:8080/v1' } }).descriptor().dataLeavesMachine).toBe(false)
    })

    it('says the data leaves the machine for a server on the network', () => {
      const brain = make(scriptedFetch(() => json({})).fn, { settings: { baseUrl: 'http://192.168.1.20:1234/v1' } })
      expect(brain.descriptor().dataLeavesMachine).toBe(true)
      expect(brain.descriptor().needs).toBe('running-server')
    })

    it('isLoopbackUrl rejects what is not a loopback host, and what is not a URL', () => {
      expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true)
      expect(isLoopbackUrl('http://localhost.evil.example/v1')).toBe(false)
      expect(isLoopbackUrl('not a url')).toBe(false)
    })
  })

  describe('generate', () => {
    it('posts to /chat/completions and returns the message content', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: ' hello ' } }] }))
      const out = await make(f.fn).generate([{ role: 'user', content: 'hi' }], {
        systemPrompt: 'be brief',
        temperature: 0.2,
        maxTokens: 50,
        json: true
      })
      expect(out).toBe(' hello ')
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/chat/completions')
      expect(body(f.calls[0])).toEqual({
        model: 'qwen3-8b',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' }
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: 50,
        response_format: { type: 'json_object' }
      })
    })

    it('does not add a system prompt when the messages already carry one', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate(
        [{ role: 'system', content: 'own' }, { role: 'user', content: 'hi' }],
        { systemPrompt: 'ignored' }
      )
      expect((body(f.calls[0]).messages as unknown[]).length).toBe(2)
    })

    it('uses the model of the call over the configured one, and omits it when neither is set', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate([{ role: 'user', content: 'hi' }], { model: 'other' })
      expect(body(f.calls[0]).model).toBe('other')
      await make(f.fn, { settings: { model: '' } }).generate([{ role: 'user', content: 'hi' }])
      expect('model' in body(f.calls[1])).toBe(false)
    })

    it('sends the key only when one is set, and never in the URL', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
      await make(f.fn).generate([{ role: 'user', content: 'hi' }])
      expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined()
      await make(f.fn, { apiKey: HEADER_VALUE }).generate([{ role: 'user', content: 'hi' }])
      expect((f.calls[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${HEADER_VALUE}`)
      expect(f.calls[1].url).not.toContain(HEADER_VALUE)
    })

    it('returns null, and throws nothing, when the server is down, errors, or answers badly', async () => {
      const down = scriptedFetch(() => {
        throw new TypeError('fetch failed')
      })
      expect(await make(down.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const serverError = scriptedFetch(() => json({ error: 'boom' }, 500))
      expect(await make(serverError.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const notJson = scriptedFetch(() => new Response('<html>', { status: 200 }))
      expect(await make(notJson.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const noChoices = scriptedFetch(() => json({ choices: [] }))
      expect(await make(noChoices.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
      const emptyText = scriptedFetch(() => json({ choices: [{ message: { content: '  ' } }] }))
      expect(await make(emptyText.fn).generate([{ role: 'user', content: 'hi' }])).toBeNull()
    })

    it('never logs the prompt', async () => {
      const f = scriptedFetch(() => json({ error: 'boom' }, 500))
      await make(f.fn).generate([{ role: 'user', content: 'SECRET-TRANSCRIPT-TEXT' }])
      const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
      expect(logged).not.toContain('SECRET-TRANSCRIPT-TEXT')
    })

    it('stops when the caller aborts', async () => {
      const controller = new AbortController()
      const f = scriptedFetch((call) => {
        controller.abort()
        if ((call.init.signal as AbortSignal).aborted) throw new DOMException('aborted', 'AbortError')
        return json({ choices: [{ message: { content: 'x' } }] })
      })
      expect(await make(f.fn).generate([{ role: 'user', content: 'hi' }], { signal: controller.signal })).toBeNull()
    })

    it('chat is generate with the history', async () => {
      const f = scriptedFetch(() => json({ choices: [{ message: { content: 'reply' } }] }))
      const out = await make(f.fn).chat([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' }
      ])
      expect(out).toBe('reply')
      expect((body(f.calls[0]).messages as unknown[]).length).toBe(3)
    })
  })

  describe('embed', () => {
    it('posts to /embeddings and returns one vector per text, in order', async () => {
      const f = scriptedFetch(() =>
        json({ data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] })
      )
      const out = await make(f.fn).embed(['a', 'b'])
      expect(out).toEqual([[1, 1], [2, 2]])
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/embeddings')
      expect(body(f.calls[0])).toEqual({ model: 'nomic-embed', input: ['a', 'b'] })
    })

    it('reads a server that leaves out the index by position', async () => {
      const f = scriptedFetch(() => json({ data: [{ embedding: [1] }, { embedding: [2] }] }))
      expect(await make(f.fn).embed(['a', 'b'])).toEqual([[1], [2]])
    })

    it('returns a null for every text the server did not answer, so the length always matches', async () => {
      const short = scriptedFetch(() => json({ data: [{ index: 0, embedding: [1] }] }))
      expect(await make(short.fn).embed(['a', 'b', 'c'])).toEqual([[1], null, null])
      const down = scriptedFetch(() => json({}, 503))
      expect(await make(down.fn).embed(['a', 'b'])).toEqual([null, null])
      expect(await make(down.fn).embed([])).toEqual([])
    })

    it('sends 64 texts per request', async () => {
      const f = scriptedFetch((call) => {
        const input = body(call).input as string[]
        return json({ data: input.map((_, i) => ({ index: i, embedding: [i] })) })
      })
      const texts = Array.from({ length: 130 }, (_, i) => `t${i}`)
      const out = await make(f.fn).embed(texts)
      expect(out).toHaveLength(130)
      expect(f.calls.map((c) => (body(c).input as string[]).length)).toEqual([64, 64, 2])
    })

    it('stops before the next request when the source is no longer eligible, and pads with nulls', async () => {
      const f = scriptedFetch((call) => {
        const input = body(call).input as string[]
        return json({ data: input.map((_, i) => ({ index: i, embedding: [1] })) })
      })
      let allowed = 1
      const texts = Array.from({ length: 130 }, (_, i) => `t${i}`)
      const out = await make(f.fn).embed(texts, { shouldGenerate: () => allowed-- > 0 })
      expect(f.calls).toHaveLength(1)
      expect(out).toHaveLength(130)
      expect(out.slice(0, 64).every((v) => v !== null)).toBe(true)
      expect(out.slice(64).every((v) => v === null)).toBe(true)
    })
  })

  describe('authStatus and listModels', () => {
    it('is configured when /models answers, and counts the models', async () => {
      const f = scriptedFetch(() => json({ data: [{ id: 'a' }, { id: 'b' }] }))
      const status = await make(f.fn).authStatus()
      expect(status.configured).toBe(true)
      expect(status.detail).toContain('2 models')
      expect(f.calls[0].url).toBe('http://localhost:1234/v1/models')
    })

    it('is not configured, and does not throw, when the server is unreachable', async () => {
      const f = scriptedFetch(() => {
        throw new TypeError('fetch failed')
      })
      const status = await make(f.fn).authStatus()
      expect(status.configured).toBe(false)
      expect(status.detail).toContain('http://localhost:1234/v1')
    })

    it('lists the model ids, and lists nothing when the server does not answer', async () => {
      const ok = scriptedFetch(() => json({ data: [{ id: 'qwen3-8b' }, { id: 'llama3.2' }, { nope: 1 }] }))
      expect(await make(ok.fn).listModels()).toEqual([{ id: 'qwen3-8b' }, { id: 'llama3.2' }])
      const bad = scriptedFetch(() => json({}, 500))
      expect(await make(bad.fn).listModels()).toEqual([])
    })
  })
})

describe('OpenAiCompatibleBrain reports harness usage', () => {
  it('reports the tokens the server states, under the model that answered', async () => {
    const f = scriptedFetch(() =>
      json({ choices: [{ message: { content: 'x' } }], model: 'qwen3-8b', usage: { prompt_tokens: 55, completion_tokens: 12 } })
    )
    const collector = createHarnessUsageCollector()
    await collector.run(() => make(f.fn).generate([{ role: 'user', content: 'hi' }]))
    const bucket = collector.total()!.byModel['openai-compatible:qwen3-8b']
    expect(bucket.inputTokens).toBe(55)
    expect(bucket.outputTokens).toBe(12)
    expect(bucket.calls).toBe(1)
  })

  it('reports the time even when the server states no usage', async () => {
    const f = scriptedFetch(() => json({ choices: [{ message: { content: 'x' } }] }))
    const collector = createHarnessUsageCollector()
    await collector.run(() => make(f.fn).generate([{ role: 'user', content: 'hi' }]))
    expect(collector.total()!.calls).toBe(1)
  })
})
