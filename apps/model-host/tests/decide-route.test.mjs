import { describe, it, expect, beforeEach } from 'vitest'
import { createHandler } from '../src/server.mjs'
import { HostState } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { DecisionError } from '../src/decide.mjs'
import { request, response } from './helpers.mjs'

const BODY = { model: 'clef-flash', state: 'orders are blocked', questions: { outage: { type: 'noul' } } }

async function makeDeps(stateName = 'start') {
  const pairing = new PairingStore()
  const token = pairing.redeem(pairing.openPairing()).token
  const calls = []
  const state = new HostState()
  if (stateName) await state.apply(stateName)
  const deps = {
    state,
    pairing,
    capabilities: () => ({ capabilities: ['diarize', 'decide'], gpu: null, acceleration: 'cuda', paired: 1 }),
    jobOptions: () => ({}),
    decide: {
      report: () => ({ 'clef-flash': { state: 'loaded', totalBytes: 1 }, clef: { state: 'absent', totalBytes: 2 } }),
      decide: async (body) => {
        calls.push(body)
        if (body.state === 'downloading') {
          throw new DecisionError('clef-flash is downloading to this host', 503, { decide: { 'clef-flash': { state: 'downloading' } } })
        }
        return { model: body.model, answers: { outage: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 9, output_tokens: 0 } }
      },
    },
  }
  return { deps, token, calls }
}

const post = (body, headers = {}) =>
  request({ method: 'POST', url: '/v1/systemone', headers, body: JSON.stringify(body), local: false })

describe('decisions from a paired HiDock', () => {
  let deps, token, calls
  beforeEach(async () => ({ deps, token, calls } = await makeDeps()))
  const auth = () => ({ authorization: `Bearer ${token}` })

  it('answers a SystemOne body with the model it names', async () => {
    const res = response()
    await createHandler(deps)(post(BODY, auth()), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).answers.outage.noul).toBe(0.9)
    expect(calls).toEqual([BODY])
  })

  it('never answers a stranger', async () => {
    const res = response()
    await createHandler(deps)(post(BODY), res)
    expect(res.statusCode).toBe(401)
    expect(calls).toEqual([])
  })

  it('refuses a body it cannot answer, before it reaches the model', async () => {
    const res = response()
    await createHandler(deps)(post({ ...BODY, model: 'jev-latest' }, auth()), res)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/clef-flash or clef/)
    expect(calls).toEqual([])
  })

  it('takes a body larger than the small control limit', async () => {
    const res = response()
    await createHandler(deps)(post({ ...BODY, state: 'x'.repeat(200_000) }, auth()), res)
    expect(res.statusCode).toBe(200)
  })

  it('says a model is still downloading, with the progress', async () => {
    const res = response()
    await createHandler(deps)(post({ ...BODY, state: 'downloading' }, auth()), res)
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/downloading/)
    expect(body.decide['clef-flash'].state).toBe('downloading')
  })

  it('does not take decisions while the host has stepped aside', async () => {
    ;({ deps, token, calls } = await makeDeps('pause'))
    const res = response()
    await createHandler(deps)(post(BODY, auth()), res)
    expect(res.statusCode).toBe(503)
    expect(calls).toEqual([])
  })

  it('tells a paired HiDock where each model is, and a stranger nothing about them', async () => {
    const paired = response()
    await createHandler(deps)(request({ url: '/health', headers: auth(), local: false }), paired)
    expect(JSON.parse(paired.body).decide['clef-flash'].state).toBe('loaded')
    const stranger = response()
    await createHandler(deps)(request({ url: '/health', local: false }), stranger)
    expect(JSON.parse(stranger.body).decide).toBeUndefined()
  })

  it('answers 404 on a host without decision models', async () => {
    delete deps.decide
    const res = response()
    await createHandler(deps)(post(BODY, auth()), res)
    expect(res.statusCode).toBe(404)
  })
})
