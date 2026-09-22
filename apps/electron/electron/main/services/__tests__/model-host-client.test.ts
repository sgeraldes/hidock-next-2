import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkModelHost,
  pairWithModelHost,
  diarizeOnModelHost,
  ModelHostUnavailableError,
} from '../model-host-client'

const HEALTHY = {
  version: '0.1.0',
  state: 'ready',
  capabilities: ['diarize'],
  acceleration: 'cuda',
  gpu: { name: 'NVIDIA GeForce RTX 4090', vramMiB: 24564, driver: '560.94' },
}

const RESULT = {
  model: 'pyannote/speaker-diarization-community-1',
  modelVersion: '1.0',
  device: 'cuda:0',
  segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }],
  speakers: [{ label: 'SPEAKER_00', embedding: [0.1], speechSeconds: 4 }],
}

/** vi.fn() infers an empty tuple for its calls; this says what they really are. */
function calls(fetchFn: unknown): [string, { headers: Record<string, string>; body: string }][] {
  return (fetchFn as { mock: { calls: [string, { headers: Record<string, string>; body: string }][] } }).mock.calls
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let dir: string
let audioPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hidock-mhc-'))
  audioPath = join(dir, 'clip.wav')
  writeFileSync(audioPath, Buffer.from('fake audio'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('checkModelHost', () => {
  it('is null when no host is configured, because that is the ordinary case', async () => {
    const fetchFn = vi.fn()
    expect(await checkModelHost({ url: '   ', token: 't' }, fetchFn as never)).toBe(null)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('adds a scheme to a bare host:port so a typed address works', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(HEALTHY))
    await checkModelHost({ url: 'gamestation:8765/', token: 't' }, fetchFn as never)
    expect(calls(fetchFn)[0][0]).toBe('http://gamestation:8765/health')
  })

  it('is null when the host does not answer, rather than throwing', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await checkModelHost({ url: 'http://x:1', token: 't' }, fetchFn as never)).toBe(null)
  })

  it('is null for an answer that is not a host', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ hello: 'from some other server' }))
    expect(await checkModelHost({ url: 'http://x:1', token: 't' }, fetchFn as never)).toBe(null)
  })
})

describe('pairing from the client', () => {
  it('sends the code and keeps the token', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ token: 'abc123' }))
    const result = await pairWithModelHost('gamestation:8765', ' 12345678 ', fetchFn as never)
    expect(result.token).toBe('abc123')
    expect(JSON.parse(calls(fetchFn)[0][1].body)).toEqual({ code: '12345678' })
  })

  it('surfaces the host’s reason when it refuses', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'That code expired.' }, 403))
    await expect(pairWithModelHost('x:1', '000', fetchFn as never)).rejects.toThrow(/expired/)
  })
})

describe('diarizeOnModelHost', () => {
  it('returns the host result unchanged', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      String(url).endsWith('/health') ? jsonResponse(HEALTHY) : jsonResponse(RESULT)
    )
    const result = await diarizeOnModelHost(
      audioPath,
      { url: 'http://gamestation:8765', token: 'tok' },
      { timeoutMs: 5000 },
      fetchFn as never
    )
    expect(result).toEqual(RESULT)
    const jobCall = calls(fetchFn)[1]
    expect(jobCall[0]).toContain('/jobs/diarize?ext=.wav')
    expect(jobCall[1].headers.authorization).toBe('Bearer tok')
  })

  // Each of these is a reason to diarize locally, never a reason to fail the
  // recording. They are separate cases because each one reaches the user as a
  // different sentence.
  const fallbacks: [string, () => typeof fetch, RegExp][] = [
    [
      'not paired',
      () => vi.fn() as never,
      /not paired/,
    ],
    [
      'host off',
      () => vi.fn(async () => { throw new Error('ECONNREFUSED') }) as never,
      /did not answer/,
    ],
    [
      'setup unfinished',
      () => vi.fn(async () => jsonResponse({ ...HEALTHY, capabilities: [] })) as never,
      /cannot diarize/,
    ],
    [
      'paused',
      () => vi.fn(async () => jsonResponse({ ...HEALTHY, state: 'paused', reason: 'The host is paused.' })) as never,
      /paused/,
    ],
    [
      'busy',
      () => vi.fn(async (url: string) =>
        String(url).endsWith('/health')
          ? jsonResponse({ ...HEALTHY, state: 'busy' })
          : jsonResponse({ error: 'busy' }, 429)
      ) as never,
      /busy/,
    ],
    [
      'token no longer known',
      () => vi.fn(async (url: string) =>
        String(url).endsWith('/health') ? jsonResponse(HEALTHY) : jsonResponse({}, 401)
      ) as never,
      /Pair it again/,
    ],
    [
      'the worker failed over there',
      () => vi.fn(async (url: string) =>
        String(url).endsWith('/health')
          ? jsonResponse(HEALTHY)
          : jsonResponse({ error: 'CUDA out of memory' }, 500)
      ) as never,
      /CUDA out of memory/,
    ],
  ]

  for (const [name, makeFetch, expected] of fallbacks) {
    it(`falls back: ${name}`, async () => {
      const token = name === 'not paired' ? '' : 'tok'
      await expect(
        diarizeOnModelHost(
          audioPath,
          { url: 'http://gamestation:8765', token },
          { timeoutMs: 5000 },
          makeFetch()
        )
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ModelHostUnavailableError && expected.test((error as Error).message)
      )
    })
  }

  it('does NOT fall back on a result that came back malformed', async () => {
    // A host that answers 200 with nonsense is a bug to see, not a network
    // condition to paper over.
    const fetchFn = vi.fn(async (url: string) =>
      String(url).endsWith('/health') ? jsonResponse(HEALTHY) : jsonResponse({ model: 'm' })
    )
    await expect(
      diarizeOnModelHost(audioPath, { url: 'http://x:1', token: 't' }, { timeoutMs: 5000 }, fetchFn as never)
    ).rejects.toThrow(/incomplete diarization result/)
    await expect(
      diarizeOnModelHost(audioPath, { url: 'http://x:1', token: 't' }, { timeoutMs: 5000 }, fetchFn as never)
    ).rejects.not.toBeInstanceOf(ModelHostUnavailableError)
  })

  it('stops the upload when the recording becomes ineligible', async () => {
    let aborted = false
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/health')) return jsonResponse(HEALTHY)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })
    const promise = diarizeOnModelHost(
      audioPath,
      { url: 'http://x:1', token: 't' },
      { timeoutMs: 60_000, shouldContinue: () => false },
      fetchFn as never
    )
    await expect(promise).rejects.toBeInstanceOf(ModelHostUnavailableError)
    expect(aborted).toBe(true)
  })

  it('gives up on its own timeout instead of waiting forever', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/health')) return jsonResponse(HEALTHY)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    })
    await expect(
      diarizeOnModelHost(audioPath, { url: 'http://x:1', token: 't' }, { timeoutMs: 20 }, fetchFn as never)
    ).rejects.toThrow(/took too long/)
  })
})
