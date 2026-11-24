import { afterEach, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createHostServer } from '../src/server.mjs'
import { HostState, READY } from '../src/state.mjs'
const owned = []
afterEach(async () => { for (const close of owned.splice(0).reverse()) await close() })
const modelVersion = 'fixture-version'
const body = { messages: [{ role: 'user', content: 'Synthetic test' }], maxOutputTokens: 32, expectedModelVersion: modelVersion }
const result = { text: 'Synthetic result', model: 'fixture-model', modelVersion, device: 'cuda', inputTokens: 5, outputTokens: 2 }
async function fixture({ ready = true, run = vi.fn(async () => result), decide } = {}) {
  const state = new HostState({ initial: READY })
  const server = createHostServer({ state, pairing: { accepts: value => value === 'Bearer fixture' },
    capabilities: () => ({ capabilities: [] }), decide, generation: { profile: () => ({ ready, modelVersion, model: result.model }), run } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  owned.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (value = body, token = 'Bearer fixture') => fetch(base + '/v1/generate', {
    method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify(value) })
  return { state, base, post, run }
}
it('rejects unpaired, incompatible and busy requests before native execution', async () => {
  const f = await fixture()
  expect((await f.post(body, 'Bearer wrong')).status).toBe(401)
  expect((await f.post({ ...body, expectedModelVersion: 'old' })).status).toBe(409)
  expect((await f.post({ ...body, maxOutputTokens: 9000 })).status).toBe(400)
  f.state.activeJob = new AbortController()
  expect((await f.post()).status).toBe(409)
  expect(f.run).not.toHaveBeenCalled()
  const unavailable = await fixture({ ready: false })
  expect((await unavailable.post()).status).toBe(503)
})
it('prevents a decision model loading while another heavy worker owns the host', async () => {
  const decide = { decide: vi.fn(), stop: vi.fn() }
  const f = await fixture({ decide })
  f.state.activeJob = new AbortController()
  const response = await fetch(f.base + '/v1/systemone', { method: 'POST', headers: { authorization: 'Bearer fixture' },
    body: JSON.stringify({ model: 'clef-flash', state: 'Synthetic fixture', questions: { relevant: { type: 'noul' } } }) })
  expect(response.status).toBe(409)
  expect(decide.decide).not.toHaveBeenCalled()
})
it('returns measured usage and releases admission only after native cleanup', async () => {
  const f = await fixture()
  const response = await f.post()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(result)
  expect(f.state.activeJob).toBeNull()
})
it('holds admission after client disconnect until owned teardown settles', async () => {
  let workerSignal, finish
  const run = vi.fn((_body, { signal }) => { workerSignal = signal; return new Promise((_resolve, reject) => { finish = () => reject(Error('stopped')) }) })
  const f = await fixture({ run })
  const request = httpRequest(f.base + '/v1/generate', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } })
  request.on('error', () => {})
  request.end(JSON.stringify(body))
  await expect.poll(() => run.mock.calls.length).toBe(1)
  request.destroy()
  await expect.poll(() => workerSignal.aborted).toBe(true)
  expect((await f.post()).status).toBe(409)
  finish()
  await expect.poll(() => f.state.activeJob).toBeNull()
})
