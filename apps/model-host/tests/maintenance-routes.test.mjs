import { describe, it, expect, beforeEach } from 'vitest'
import { createHandler } from '../src/server.mjs'
import { HostState } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { request, response } from './helpers.mjs'

function makeDeps() {
  const pairing = new PairingStore()
  const token = pairing.redeem(pairing.openPairing()).token
  const calls = { updates: [], repairs: 0 }
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
