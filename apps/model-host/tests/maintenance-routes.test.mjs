import { describe, it, expect, beforeEach } from 'vitest'
import { createHandler } from '../src/server.mjs'
import { HostState } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { request, response } from './helpers.mjs'

function makeDeps() {
  const pairing = new PairingStore()
  const token = pairing.redeem(pairing.openPairing()).token
  const calls = { updates: [], repairs: 0, preparations: [] }
  const deps = {
    state: new HostState(),
    pairing,
    capabilities: () => ({ capabilities: ['diarize'], gpu: null, acceleration: 'cuda', paired: 1 }),
    jobOptions: () => ({}),
    setup: {
      report: () => ({ status: 'ready', device: 'cpu' }),
      canDiarize: () => true,
      repair: async () => {
        calls.repairs++
        return { status: 'repairing' }
      },
    },
    maintenance: {
      prepareAsr: model => calls.preparations.push(model),
      prepareSemantic: () => calls.preparations.push('semantic'),
      prepareRealtime: () => calls.preparations.push('realtime'),
      prepareGeneration: () => calls.preparations.push('generation'),
      diagnostics: async () => ({ setupLog: 'GPU: RTX 4090', serviceLog: '', repairLog: '', torch: { cudaAvailable: false } }),
      stageUpdate: (body) => {
        if (body[0] !== 0x4d) throw Object.assign(new Error('the update is not a Windows program'), { status: 400 })
        calls.updates.push(body.length)
        return 'C:\\x\\update.exe'
      },
      applyUpdate: () => calls.updates.push('applied'),
    },
  }
  return { deps, token, calls }
}

describe('looking after the host from HiDock', () => {
  let deps, token, calls
  beforeEach(() => ({ deps, token, calls } = makeDeps()))
  const auth = () => ({ authorization: `Bearer ${token}` })

  it.each(['semantic', 'realtime', 'generation'])('admits only a fixed paired TLS %s operation while idle', async role => {
    await deps.state.apply('start')
    const handler = createHandler(deps)
    const make = (headers, body = '{}', encrypted = true) => {
      const req = request({ method: 'POST', url: `/runtime/prepare-${role}`, headers, body, local: false })
      req.socket.encrypted = encrypted
      return req
    }
    for (const [headers, body, encrypted, status] of [[{}, '{}', true, 401],
      [auth(), '{}', false, 426], [auth(), '{"command":"anything"}', true, 400]]) {
      const res = response()
      await handler(make(headers, body, encrypted), res)
      expect(res.statusCode).toBe(status)
    }
    deps.state.activeJob = new AbortController()
    const busy = response()
    await handler(make(auth()), busy)
    expect(busy.statusCode).toBe(409)
    deps.state.activeJob = null
    const accepted = response()
    await handler(make(auth()), accepted)
    expect(accepted.statusCode).toBe(202)
    expect(deps.state.canAdmit()).toBe(false)
    const duplicate = response()
    await handler(make(auth()), duplicate)
    expect(duplicate.statusCode).toBe(409)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.preparations).toEqual([role])
  })

  const asrRequest = (headers, model = 'microsoft/VibeVoice-ASR', encrypted = true) => {
    const req = request({ method: 'POST', url: '/runtime/prepare-asr', headers,
      body: JSON.stringify({ model }), local: false })
    req.socket.encrypted = encrypted
    return req
  }

  it('requires pairing and TLS before reserving ASR preparation', async () => {
    await deps.state.apply('start')
    for (const [headers, encrypted, status] of [[{}, true, 401], [auth(), false, 426]]) {
      const res = response()
      await createHandler(deps)(asrRequest(headers, undefined, encrypted), res)
      expect(res.statusCode).toBe(status)
    }
    expect(deps.state.canAdmit()).toBe(true)
    expect(calls.preparations).toEqual([])
  })

  it('rejects unsupported models and busy workers without initiating preparation', async () => {
    await deps.state.apply('start')
    const unsupported = response()
    await createHandler(deps)(asrRequest(auth(), 'arbitrary/model'), unsupported)
    expect(unsupported.statusCode).toBe(400)
    deps.state.activeJob = new AbortController()
    const busy = response()
    await createHandler(deps)(asrRequest(auth()), busy)
    expect(busy.statusCode).toBe(409)
    expect(calls.preparations).toEqual([])
  })

  it('reserves admission before acknowledging preparation and refuses a duplicate', async () => {
    await deps.state.apply('start')
    const handler = createHandler(deps)
    const first = response()
    await handler(asrRequest(auth()), first)
    expect(first.statusCode).toBe(202)
    expect(deps.state.canAdmit()).toBe(false)
    const second = response()
    await handler(asrRequest(auth()), second)
    expect(second.statusCode).toBe(409)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.preparations).toEqual(['microsoft/VibeVoice-ASR'])
  })

  it('prepares once after the acknowledged connection closes prematurely', async () => {
    await deps.state.apply('start')
    const res = Object.assign(response(), { writableFinished: false })
    await createHandler(deps)(asrRequest(auth()), res)
    expect(calls.preparations).toEqual([])
    res.emit('close')
    res.emit('close')
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(calls.preparations).toEqual(['microsoft/VibeVoice-ASR'])
  })

  it('blocks mutation races while pausing before the preparation acknowledgement', async () => {
    let entered, release
    const paused = new Promise(resolve => { entered = resolve })
    deps.state = new HostState({ onLeaveReady: () => {
      entered()
      return new Promise(resolve => { release = resolve })
    } })
    await deps.state.apply('start')
    const handler = createHandler(deps)
    const first = response()
    const preparing = handler(asrRequest(auth()), first)
    await paused
    try {
      for (const url of ['/runtime/repair', '/runtime/prepare-asr', '/control']) {
        const res = response()
        const req = request({ method: 'POST', url, headers: auth(), body: 'action=start' })
        await handler(req, res)
        expect(res.statusCode).toBe(409)
      }
      expect(calls.repairs).toBe(0)
      expect(deps.state.canAdmit()).toBe(false)
    } finally { release(); await preparing }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.preparations).toEqual(['microsoft/VibeVoice-ASR'])
  })

  it('hands a paired HiDock the diagnostics', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/diagnostics', headers: auth(), local: false }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).torch.cudaAvailable).toBe(false)
  })

  it('never hands them to a stranger', async () => {
    const res = response()
    await createHandler(deps)(request({ url: '/diagnostics', local: false }), res)
    expect(res.statusCode).toBe(401)
  })

  it('repairs the runtime when HiDock asks, and answers at once', async () => {
    const res = response()
    await createHandler(deps)(request({ method: 'POST', url: '/runtime/repair', headers: auth(), local: false }), res)
    expect(res.statusCode).toBe(202)
    expect(calls.repairs).toBe(1)
  })

  it('does not repair while an audio worker owns admission', async () => {
    await deps.state.apply('start')
    deps.state.activeJob = new AbortController()
    const res = response()
    await createHandler(deps)(request({ method: 'POST', url: '/runtime/repair', headers: auth() }), res)
    expect(res.statusCode).toBe(409)
    expect(calls.repairs).toBe(0)
  })

  it.each(['/runtime/repair', '/update'])('waits for model teardown and blocks decisions before %s', async endpoint => {
    let release, entered
    const pausing = new Promise(resolve => { entered = resolve })
    deps.state = new HostState({ onLeaveReady: () => {
      entered()
      return new Promise(resolve => { release = resolve })
    } })
    await deps.state.apply('start')
    const handler = createHandler(deps)
    const res = response()
    const pending = handler(request({ method: endpoint === '/update' ? 'PUT' : 'POST', url: endpoint,
      headers: auth(), body: endpoint === '/update' ? 'MZpayload' : '' }), res)
    await pausing
    try {
      expect(calls.repairs).toBe(0)
      expect(calls.updates).toEqual([])
      const decision = response()
      await handler(request({ method: 'POST', url: '/v1/systemone', headers: auth(), body: '{}' }), decision)
      expect(decision.statusCode).toBe(409)
    } finally { release(); await pending }
    expect(res.statusCode).toBe(202)
    expect(deps.state.state).toBe('paused')
    await new Promise(resolve => setTimeout(resolve, 40))
  })

  it('takes an update from a paired HiDock, answers, and only then applies it', async () => {
    const res = response()
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048)])
    await createHandler(deps)(request({ method: 'PUT', url: '/update', headers: auth(), body: exe, local: false }), res)
    expect(res.statusCode).toBe(202)
    expect(calls.updates[0]).toBe(exe.length)
    // Applying ends this process, so it waits until the answer is out.
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.updates).toContain('applied')
  })

  it('still applies the update when HiDock hangs up before the answer is out', async () => {
    const res = Object.assign(response(), { writableFinished: false })
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048)])
    await createHandler(deps)(request({ method: 'PUT', url: '/update', headers: auth(), body: exe, local: false }), res)
    // A dropped connection never emits 'finish'; it always emits 'close'.
    res.emit('close')
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.updates).toContain('applied')
  })

  it('refuses an update that is not a Windows program, and one from a stranger', async () => {
    const bad = response()
    await createHandler(deps)(request({ method: 'PUT', url: '/update', headers: auth(), body: 'echo hi', local: false }), bad)
    expect(bad.statusCode).toBe(400)
    const stranger = response()
    await createHandler(deps)(request({ method: 'PUT', url: '/update', body: 'MZ', local: false }), stranger)
    expect(stranger.statusCode).toBe(401)
    expect(calls.updates).toEqual([])
  })
})
