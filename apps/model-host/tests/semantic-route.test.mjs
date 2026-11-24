import { afterEach, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createHostServer } from '../src/server.mjs'
import { HostState, READY } from '../src/state.mjs'

const owned = []
afterEach(async () => { for (const close of owned.splice(0).reverse()) await close() })
const spaceId = 'nemotron-import-sha256:' + 'a'.repeat(64)
const body = { texts: ['Synthetic route test'], purpose: 'query', expectedSpaceId: spaceId }
const result = { model: 'local/nemotron-3-embed-1b', modelVersion: spaceId, spaceId,
  dimensions: 2048, purpose: 'query', device: 'cpu', vectors: [[1, ...Array(2047).fill(0)]] }
async function fixture({ ready = true, run = vi.fn(async () => result) } = {}) {
  const state = new HostState({ initial: READY })
  const server = createHostServer({ state, pairing: { accepts: value => value === 'Bearer fixture' },
    capabilities: () => ({ capabilities: [] }), semantic: { profile: () => ({ ready, spaceId }), run } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  owned.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (value = body, token = 'Bearer fixture') => fetch(base + '/v1/embeddings', {
    method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify(value) })
  return { state, server, base, post, run }
}

it('rejects unauthenticated, unready, changed-space and busy requests before inference', async () => {
  const f = await fixture()
  expect((await f.post(body, 'Bearer wrong')).status).toBe(401)
  expect((await f.post({ ...body, expectedSpaceId: 'old-space' })).status).toBe(409)
  f.state.activeJob = new AbortController()
  expect((await f.post()).status).toBe(409)
  expect(f.run).not.toHaveBeenCalled()
  const unready = await fixture({ ready: false })
  expect((await unready.post()).status).toBe(503)
  expect(unready.run).not.toHaveBeenCalled()
})

it('returns valid vectors and releases its lane after the worker completes', async () => {
  const f = await fixture()
  const response = await f.post()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(result)
  expect(f.run).toHaveBeenCalledWith({ purpose: 'query', texts: body.texts }, { signal: expect.any(AbortSignal) })
  expect(f.state.activeJob).toBeNull()
})

it('aborts on client socket loss but holds the lane until worker teardown settles', async () => {
  let workerSignal, finishTeardown
  const run = vi.fn((_body, { signal }) => {
    workerSignal = signal
    return new Promise((_resolve, reject) => { finishTeardown = () => reject(new Error('worker stopped')) })
  })
  const f = await fixture({ run })
  const request = httpRequest(f.base + '/v1/embeddings', { method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } })
  request.on('error', () => {})
  request.end(JSON.stringify(body))
  await expect.poll(() => run.mock.calls.length).toBe(1)
  expect(f.state.canAdmit()).toBe(false)
  request.destroy()
  await expect.poll(() => workerSignal.aborted).toBe(true)
  expect(f.state.canAdmit()).toBe(false)
  expect((await f.post()).status).toBe(409)
  finishTeardown()
  await expect.poll(() => f.state.activeJob).toBeNull()
  expect(f.state.canAdmit()).toBe(true)
})
