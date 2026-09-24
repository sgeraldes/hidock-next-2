import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { createHandler, readBody, MAX_AUDIO_BYTES } from '../src/server.mjs'
import { HostState, READY, PAUSED, STOPPED } from '../src/state.mjs'
import { PairingStore, secretsMatch, PAIRING_CODE_TTL_MS } from '../src/auth.mjs'
import { threadEnv, parseWorkerOutput, runDiarization } from '../src/diarize.mjs'

/** A request that looks enough like http.IncomingMessage for the handler. */
function request({ method = 'GET', url = '/', headers = {}, body = '', local = true, host = 'localhost:8765' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  // Every real request carries a Host header, and the control page now checks
  // it, so the fake has to carry one too.
  req.headers = { host, ...headers }
  req.socket = { remoteAddress: local ? '127.0.0.1' : '192.168.1.40' }
  req.destroy = () => req.emit('error', new Error('destroyed'))
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function response() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk) this.body += chunk
      this.done = true
    },
  }
  return res
}

const WORKER_RESULT = {
  model: 'pyannote/speaker-diarization-community-1',
  modelVersion: '1.0',
  device: 'cuda:0',
  segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }],
  speakers: [{ label: 'SPEAKER_00', embedding: [0.1, 0.2], speechSeconds: 4 }],
}

function makeDeps(overrides = {}) {
  const state = overrides.state || new HostState()
  const pairing = overrides.pairing || new PairingStore()
  return {
    state,
    pairing,
    capabilities: () => ({ capabilities: ['diarize'], gpu: null, acceleration: 'cpu', paired: pairing.tokens.size }),
    jobOptions: () => ({ pythonPath: 'py', workerPath: 'w.py', model: 'm', fallbackModel: 'f', minSpeechSeconds: 1, cpuPercent: 50, timeoutMs: 1000 }),
    diarize: overrides.diarize || (async () => WORKER_RESULT),
  }
}

describe('host state', () => {
  it('starts stopped and refuses work until someone presses Start', async () => {
    const state = new HostState()
    expect(state.publicState()).toBe(STOPPED)
    expect(state.canAdmit()).toBe(false)
    await state.apply('start')
    expect(state.canAdmit()).toBe(true)
  })

  it('reports busy while one job holds the lane, and admits nothing else', async () => {
    const state = new HostState()
    await state.apply('start')
    state.activeJob = new AbortController()
    expect(state.publicState()).toBe('busy')
    expect(state.canAdmit()).toBe(false)
  })

  it('pause and stop ask a running job to stop', async () => {
    const stopped = []
    const state = new HostState({ onLeaveReady: async () => stopped.push('asked') })
    await state.apply('start')
    await state.apply('pause')
    expect(state.publicState()).toBe(PAUSED)
    expect(stopped).toEqual(['asked'])
  })

  it('refuses to resume from a state it did not pause from', async () => {
    const state = new HostState()
    await state.apply('start')
    await expect(state.apply('start')).rejects.toThrow(/cannot start while ready/)
  })
})

describe('pairing', () => {
  it('trades a code for a token, once', () => {
    const store = new PairingStore()
    const code = store.openPairing()
    const first = store.redeem(code)
    expect(first.ok).toBe(true)
    expect(store.redeem(code).ok).toBe(false)
  })

  it('a typo does not burn the code', () => {
    const store = new PairingStore()
    const code = store.openPairing()
    expect(store.redeem('00000000').ok).toBe(false)
    expect(store.redeem(code).ok).toBe(true)
  })

  it('a run of wrong codes does burn it', () => {
    // Eight digits is plenty against a person and nothing against a machine on
    // the same network guessing for the five minutes the code is open.
    const store = new PairingStore()
    const code = store.openPairing()
    for (let i = 0; i < 4; i++) expect(store.redeem('00000000').ok).toBe(false)
    const fifth = store.redeem('00000000')
    expect(fifth.ok).toBe(false)
    expect(fifth.reason).toMatch(/Too many wrong codes/)
    // The real code is worthless now, which is the point.
    expect(store.redeem(code).ok).toBe(false)
  })

  it('a code expires', () => {
    let now = 1000
    const store = new PairingStore({ now: () => now })
    const code = store.openPairing()
    now += PAIRING_CODE_TTL_MS + 1
    const result = store.redeem(code)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/expired/)
  })

  it('accepts only the tokens it issued', () => {
    const store = new PairingStore()
    const code = store.openPairing()
    const { token } = store.redeem(code)
    expect(store.accepts(`Bearer ${token}`)).toBe(true)
    expect(store.accepts(`Bearer ${token}x`)).toBe(false)
    expect(store.accepts('Bearer ')).toBe(false)
    expect(store.accepts(undefined)).toBe(false)
  })

  it('persists issued tokens through the injected saver', () => {
    const saved = []
    const store = new PairingStore({ save: (tokens) => saved.push(tokens) })
    store.redeem(store.openPairing())
    expect(saved).toHaveLength(1)
    expect(saved[0]).toHaveLength(1)
  })

  it('compares secrets without leaking a length mismatch as a throw', () => {
    expect(secretsMatch('abc', 'abcd')).toBe(false)
    expect(secretsMatch('abc', 'abc')).toBe(true)
    expect(secretsMatch(null, 'abc')).toBe(false)
  })
})

describe('routes', () => {
  let deps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('health says what the host can actually do', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/health' }), res)
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.state).toBe('stopped')
    expect(body.capabilities).toEqual(['diarize'])
    expect(body.acceleration).toBe('cpu')
  })

  it('refuses a diarization with no token', async () => {
    await deps.state.apply('start')
    const res = response()
    await createHandler(deps)(request({ method: 'POST', url: '/jobs/diarize', body: 'x' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('refuses a token this host never issued', async () => {
    await deps.state.apply('start')
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: 'Bearer nope' }, body: 'x' }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('refuses work while paused, and says why', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    await deps.state.apply('pause')
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'x' }),
      res
    )
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body).error).toMatch(/paused/i)
  })

  it('runs one job and returns the worker result unchanged', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(WORKER_RESULT)
    // The lane is free again for the next one.
    expect(deps.state.canAdmit()).toBe(true)
  })

  it('answers 429 to a second heavy job instead of queueing it invisibly', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let release
    deps.diarize = () => new Promise((resolve) => { release = () => resolve(WORKER_RESULT) })
    const handler = createHandler(deps)
    const firstRes = response()
    const first = handler(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      firstRes
    )
    // Let the first one reach the worker before the second arrives.
    await new Promise((r) => setTimeout(r, 10))
    const secondRes = response()
    await handler(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      secondRes
    )
    expect(secondRes.statusCode).toBe(429)
    release()
    await first
    expect(firstRes.statusCode).toBe(200)
  })

  it('admits ONE job even when both arrive while the first is still uploading', async () => {
    // The lane used to be taken after `await readBody`, so a second request
    // reaching the admission check while the first was still reading its body
    // found the lane free and was admitted too. Two pyannote workers then
    // fought over the same GPU. This request never emits 'end', so it stays in
    // readBody exactly the way a real upload does.
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let started = 0
    deps.diarize = async () => {
      started += 1
      return WORKER_RESULT
    }
    const handler = createHandler(deps)

    const stalled = new EventEmitter()
    stalled.method = 'POST'
    stalled.url = '/jobs/diarize'
    stalled.headers = { host: 'localhost:8765', authorization: `Bearer ${token}` }
    stalled.socket = { remoteAddress: '127.0.0.1' }
    stalled.destroy = () => {}
    const firstRes = response()
    const first = handler(stalled, firstRes)
    await new Promise((r) => setTimeout(r, 10))

    const secondRes = response()
    await handler(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      secondRes
    )
    expect(secondRes.statusCode).toBe(429)

    stalled.emit('data', Buffer.from('audio'))
    stalled.emit('end')
    await first
    expect(started).toBe(1)
  })

  it('frees the lane when the job fails', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    deps.diarize = async () => { throw new Error('the worker died') }
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      res
    )
    expect(res.statusCode).toBe(500)
    expect(deps.state.activeJob).toBe(null)
    expect(deps.state.canAdmit()).toBe(true)
  })

  it('keeps the control page off the network', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/', local: false }), res)
    expect(res.statusCode).toBe(403)
  })

  it('keeps the control page away from a rebound name that resolves here', async () => {
    // DNS rebinding: a page in a browser ON this machine is pointed at an
    // attacker domain that resolves to 127.0.0.1, so its POST arrives from
    // loopback like any other. The Host header is what it cannot forge.
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/control', body: 'action=stop', host: 'evil.example.com' }),
      res
    )
    expect(res.statusCode).toBe(403)
    expect(deps.state.state).toBe('stopped')
  })

  it('refuses a container extension that would escape the temp directory', async () => {
    // The body is whatever the caller sent and `ext` reaches a filename, so an
    // unchecked value writes those bytes wherever the host can write. The
    // cleanup would not even remove it: it deletes the temp directory, and the
    // file would be outside it.
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let seenExtension = null
    deps.diarize = async (_audio, options) => {
      seenExtension = options.extension
      return WORKER_RESULT
    }
    const res = response()
    await createHandler(deps)(
      request({
        method: 'POST',
        url: '/jobs/diarize?ext=' + encodeURIComponent('../../../Startup/run.cmd'),
        headers: { authorization: `Bearer ${token}` },
        body: 'audio',
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(seenExtension).toBe('')
  })

  it('keeps a real extension', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let seenExtension = null
    deps.diarize = async (_audio, options) => {
      seenExtension = options.extension
      return WORKER_RESULT
    }
    await createHandler(deps)(
      request({
        method: 'POST',
        url: '/jobs/diarize?ext=.flac',
        headers: { authorization: `Bearer ${token}` },
        body: 'audio',
      }),
      response()
    )
    expect(seenExtension).toBe('.flac')
  })

  it('runs the voice model the client pins, with no fallback to another one', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let seen = null
    deps.diarize = async (_audio, options) => {
      seen = options
      return WORKER_RESULT
    }
    await createHandler(deps)(
      request({
        method: 'POST',
        url: '/jobs/diarize?model=' + encodeURIComponent('pyannote/speaker-diarization-3.1'),
        headers: { authorization: `Bearer ${token}` },
        body: 'audio',
      }),
      response()
    )
    expect(seen.model).toBe('pyannote/speaker-diarization-3.1')
    expect(seen.fallbackModel).toBe('pyannote/speaker-diarization-3.1')
  })

  it('keeps its own model when the client pins none (older clients)', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    let seen = null
    deps.diarize = async (_audio, options) => {
      seen = options
      return WORKER_RESULT
    }
    await createHandler(deps)(
      request({ method: 'POST', url: '/jobs/diarize', headers: { authorization: `Bearer ${token}` }, body: 'audio' }),
      response()
    )
    expect(seen.model).toBe('m')
    expect(seen.fallbackModel).toBe('f')
  })

  it('refuses a model outside the allow-list without taking the lane', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    await deps.state.apply('start')
    const diarize = vi.fn(async () => WORKER_RESULT)
    deps.diarize = diarize
    const res = response()
    await createHandler(deps)(
      request({
        method: 'POST',
        url: '/jobs/diarize?model=' + encodeURIComponent('evil/remote-code'),
        headers: { authorization: `Bearer ${token}` },
        body: 'audio',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect(diarize).not.toHaveBeenCalled()
    expect(deps.state.canAdmit()).toBe(true)
  })

  it('does not hand the GPU and the client count to a stranger', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/health', local: false, host: 'gamestation:8765' }), res)
    const body = JSON.parse(res.body)
    expect(body.state).toBe('stopped')
    expect(body.gpu).toBeUndefined()
    expect(body.paired).toBeUndefined()
  })

  it('tells a paired client everything', async () => {
    const { token } = deps.pairing.redeem(deps.pairing.openPairing())
    const res = response()
    await createHandler(deps)(
      request({ url: '/health', local: false, host: 'gamestation:8765', headers: { authorization: `Bearer ${token}` } }),
      res
    )
    const body = JSON.parse(res.body)
    expect(body.acceleration).toBe('cpu')
    expect(body.paired).toBe(1)
  })

  it('serves the control page on this machine', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('HiDock Model Host')
    expect(res.body).toContain('value="start"')
  })

  it('the control form starts the host', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/control', body: 'action=start' }),
      res
    )
    expect(res.statusCode).toBe(303)
    expect(deps.state.state).toBe(READY)
  })

  it('pairs over the network with a code shown on the host', async () => {
    const code = deps.pairing.openPairing()
    const res = response()
    await createHandler(deps)(
      request({ method: 'POST', url: '/pair', body: JSON.stringify({ code }), local: false }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).token).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('request body limit', () => {
  it('refuses a declared size over the limit before reading anything', async () => {
    const req = request({ headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) } })
    await expect(readBody(req)).rejects.toMatchObject({ status: 413 })
  })

  it('refuses a body that lies about its size', async () => {
    await expect(readBody(request({ body: 'abcdef' }), 3)).rejects.toMatchObject({ status: 413 })
  })
})

describe('diarization worker', () => {
  it('budgets threads against the share of the machine, never zero', () => {
    expect(threadEnv(50, 16).OMP_NUM_THREADS).toBe('8')
    expect(threadEnv(1, 16).OMP_NUM_THREADS).toBe('1')
    expect(threadEnv(0, 16).OMP_NUM_THREADS).toBe('8')
    expect(threadEnv(500, 16).OMP_NUM_THREADS).toBe('16')
    // All six, because each one is read by a different layer.
    expect(Object.keys(threadEnv(50, 8))).toHaveLength(6)
  })

  it('refuses a result missing the parts the client needs', () => {
    expect(() => parseWorkerOutput('{"model":"m"}')).toThrow(/incomplete/)
    expect(parseWorkerOutput(JSON.stringify(WORKER_RESULT))).toEqual(WORKER_RESULT)
  })

  it('deletes the audio it was sent, even when the worker fails', async () => {
    const seen = []
    const spawnFn = (_python, args) => {
      seen.push(args[args.indexOf('--audio') + 1])
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr = new EventEmitter()
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      queueMicrotask(() => {
        child.stderr.emit('data', 'CUDA out of memory')
        child.emit('close', 1)
      })
      return child
    }
    await expect(runDiarization(Buffer.from('audio'), {
      pythonPath: 'py', workerPath: 'w.py', model: 'm', fallbackModel: 'f',
      minSpeechSeconds: 1, cpuPercent: 50, timeoutMs: 5000, spawnFn,
    })).rejects.toThrow(/CUDA out of memory/)
    const { existsSync } = await import('fs')
    expect(seen).toHaveLength(1)
    expect(existsSync(seen[0])).toBe(false)
  })

  it('stops the worker when the job is cancelled, and still cleans up', async () => {
    const killed = []
    let written = ''
    const spawnFn = (_python, args) => {
      written = args[args.indexOf('--audio') + 1]
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr = new EventEmitter()
      child.stderr.setEncoding = () => {}
      child.kill = () => killed.push(true)
      return child
    }
    const controller = new AbortController()
    const promise = runDiarization(Buffer.from('audio'), {
      pythonPath: 'py', workerPath: 'w.py', model: 'm', fallbackModel: 'f',
      minSpeechSeconds: 1, cpuPercent: 50, timeoutMs: 60000, spawnFn, signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    await expect(promise).rejects.toThrow(/cancelled/)
    expect(killed).toEqual([true])
    const { existsSync } = await import('fs')
    expect(existsSync(written)).toBe(false)
  })
})
