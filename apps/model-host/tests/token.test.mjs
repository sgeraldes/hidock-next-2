import { describe, it, expect, beforeEach } from 'vitest'
import { createHandler } from '../src/server.mjs'
import { HostState } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { HostSetup, makeTestClip } from '../src/host-setup.mjs'
import { request, response } from './helpers.mjs'

// Made-up tokens: the shape of a Hugging Face token, the value of nothing.
const FAKE_TOKEN = 'hf_abcdefghijklmnopqrstuvwxyz' // pragma: allowlist secret
const FAKE_A = 'hf_aaaaaaaaaaaaaaaaaaaa' // pragma: allowlist secret
const FAKE_B = 'hf_bbbbbbbbbbbbbbbbbbbb' // pragma: allowlist secret

const GOOD = { model: 'pyannote/speaker-diarization-3.1', modelVersion: '4.0.7', device: 'cuda', segments: [], speakers: [] }
const flush = () => new Promise((r) => setTimeout(r, 0))

function makeSetup(overrides = {}) {
  const saved = { secrets: [], config: [] }
  const calls = []
  const setup = new HostSetup({
    validated: overrides.validated ?? false,
    hfToken: overrides.hfToken ?? '',
    diarize:
      overrides.diarize ||
      (async (audio, options) => {
        calls.push({ audio, options })
        return GOOD
      }),
    jobOptions: () => ({ pythonPath: 'py', workerPath: 'w.py', model: 'x', fallbackModel: 'x', minSpeechSeconds: 1.5, cpuPercent: 50, timeoutMs: 1000 }),
    saveToken: (token) => saved.secrets.push(token),
    saveValidated: (patch) => saved.config.push(patch),
  })
  return { setup, saved, calls }
}

describe('the host learns its token from HiDock, never from the person', () => {
  it('starts waiting for the token when setup gave it none', () => {
    const { setup } = makeSetup()
    expect(setup.report()).toMatchObject({ status: 'needs-token' })
    expect(setup.canDiarize()).toBe(false)
  })

  it('a received token is kept, then the model is proven on this machine', async () => {
    const { setup, saved, calls } = makeSetup()
    await setup.receiveToken(FAKE_TOKEN)
    expect(saved.secrets).toEqual([FAKE_TOKEN])
    await setup.idle()
    expect(calls[0].options).toMatchObject({
      hfToken: FAKE_TOKEN,
      model: 'pyannote/speaker-diarization-3.1',
      fallbackModel: 'pyannote/speaker-diarization-3.1',
      extension: '.wav',
    })
    expect(setup.report()).toMatchObject({ status: 'ready', device: 'cuda' })
    expect(saved.config).toEqual([{ validated: true, validatedDevice: 'cuda' }])
    expect(setup.canDiarize()).toBe(true)
    expect(setup.token()).toBe(FAKE_TOKEN)
  })

  it('says why when the model does not run, and stays unable to diarize', async () => {
    const { setup } = makeSetup({
      diarize: async () => {
        throw new Error('401 Client Error: gated repo pyannote/segmentation-3.0')
      },
    })
    await setup.receiveToken(FAKE_TOKEN)
    await setup.idle()
    expect(setup.report()).toMatchObject({ status: 'failed' })
    expect(setup.report().reason).toMatch(/gated repo/)
    expect(setup.canDiarize()).toBe(false)
  })

  it('does not run the model twice for the same token once it is proven', async () => {
    const { setup, calls } = makeSetup()
    await setup.receiveToken(FAKE_TOKEN)
    await setup.idle()
    await setup.receiveToken(FAKE_TOKEN)
    await setup.idle()
    expect(calls.length).toBe(1)
  })

  it('a host that has a token but was never proven proves itself at start', async () => {
    const { setup, calls } = makeSetup({ hfToken: FAKE_TOKEN })
    setup.start()
    await setup.idle()
    expect(calls.length).toBe(1)
    expect(setup.report().status).toBe('ready')
  })

  it('a different token arriving while the model is being tested is tested too, so disk and status agree', async () => {
    let release
    const calls = []
    const { setup } = makeSetup({
      diarize: async (_audio, options) => {
        calls.push(options.hfToken)
        if (calls.length === 1) await new Promise((r) => (release = r))
        return GOOD
      },
    })
    await setup.receiveToken(FAKE_A)
    await setup.receiveToken(FAKE_B)
    release()
    await setup.idle()
    expect(calls).toEqual([FAKE_A, FAKE_B])
    expect(setup.token()).toBe(FAKE_B)
    expect(setup.report().status).toBe('ready')
  })

  it('refuses something that is not a token', async () => {
    const { setup } = makeSetup()
    await expect(setup.receiveToken('')).rejects.toThrow(/token/)
    await expect(setup.receiveToken('hf_ with spaces')).rejects.toThrow(/token/)
    await expect(setup.receiveToken('x'.repeat(500))).rejects.toThrow(/token/)
  })

  it('the test clip is a real 16 kHz mono WAV of a few seconds', () => {
    const clip = makeTestClip()
    expect(clip.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(clip.readUInt32LE(24)).toBe(16000)
    expect(clip.readUInt16LE(22)).toBe(1)
    expect(clip.length).toBeGreaterThan(16000 * 2 * 5)
  })
})

describe('PUT /secrets/hf-token', () => {
  let deps
  let token
  let setup
  beforeEach(() => {
    ;({ setup } = makeSetup())
    const pairing = new PairingStore()
    token = pairing.redeem(pairing.openPairing()).token
    deps = {
      state: new HostState(),
      pairing,
      setup,
      capabilities: () => ({ capabilities: setup.canDiarize() ? ['diarize'] : [], gpu: null, acceleration: 'cuda', paired: 1 }),
      jobOptions: () => ({}),
    }
  })

  it('takes the token from a paired client and starts proving the model', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'PUT', url: '/secrets/hf-token', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ token: FAKE_TOKEN }), local: false }),
      res
    )
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body).setup.status).toBe('validating')
    await setup.idle()
    expect(setup.report().status).toBe('ready')
  })

  it('never takes a token from a stranger', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'PUT', url: '/secrets/hf-token', body: JSON.stringify({ token: FAKE_TOKEN }), local: false }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(setup.report().status).toBe('needs-token')
  })

  it('answers 400, not 500, to a body that is not JSON', async () => {
    for (const [method, url] of [['PUT', '/secrets/hf-token'], ['PUT', '/settings/step-aside'], ['POST', '/pair']]) {
      const res = response()
      await createHandler(deps)(
        request({ method, url, headers: { authorization: `Bearer ${token}` }, body: '{not json', local: false }),
        res
      )
      expect(res.statusCode, url).toBe(400)
    }
  })

  it('refuses a body that is not a token', async () => {
    const res = response()
    await createHandler(deps)(
      request({ method: 'PUT', url: '/secrets/hf-token', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ token: 'not a token' }), local: false }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('tells a paired client how setup is going, and never echoes the token', async () => {
    await setup.receiveToken(FAKE_TOKEN)
    await setup.idle()
    const res = response()
    await createHandler(deps)(request({ url: '/health', headers: { authorization: `Bearer ${token}` }, local: false }), res)
    const body = JSON.parse(res.body)
    expect(body.setup).toMatchObject({ status: 'ready', device: 'cuda' })
    expect(res.body).not.toMatch(/hf_abcdefghij/)
  })
})
