// @vitest-environment node
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'https'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
const state = vi.hoisted(() => ({ config: { transcription: { modelHostUrl: '', modelHostToken: 'test-only', modelHostCertificatePem: '' },
  brains: { enabled: { 'model-host-embed': true }, taskRouting: { embed: 'model-host-embed' }, modelHostEmbedding: { spaceId: '' } } } }))
vi.mock('../../config', () => ({ getConfig: () => state.config }))
import { ModelHostEmbedBrain, HOST_EMBED_MODEL } from '../model-host-embed-brain'
const spaceId = 'nemotron-import-sha256:' + 'a'.repeat(64)
let server: Server, directory: string, requests: string[], returnedSpace: string, invalid = false, exclude = false, mutateSelection = false
const brain = new ModelHostEmbedBrain()
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hidock-embed-tls-'))
  execFileSync('python', [resolve('../model-host/src/provision_tls.py'), directory], { windowsHide: true })
  const cert = readFileSync(join(directory, 'host-certificate.pem'), 'utf8')
  state.config.transcription.modelHostCertificatePem = cert
  server = createServer({ cert, key: readFileSync(join(directory, 'host-private-key.pem')) }, async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer test-only')
    requests.push(req.method + ' ' + req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/capabilities') {
      exclude = true
      res.end(JSON.stringify({ protocolVersion: 1, semanticEmbedding: { ready: true, spaceId: returnedSpace, dimensions: 2048, model: HOST_EMBED_MODEL } }))
      return
    }
    let body = ''; for await (const chunk of req) body += chunk.toString()
    const input = JSON.parse(body)
    expect(input.expectedSpaceId).toBe(spaceId)
    // Prefixes belong on the host: the client must preserve the user's text.
    expect(input.texts).toEqual(['safe fixture'])
    const vector = Array(2048).fill(0); vector[0] = invalid ? 2 : 1
    if (mutateSelection) state.config.brains.modelHostEmbedding.spaceId = 'nemotron-import-sha256:' + 'b'.repeat(64)
    res.end(JSON.stringify({ model: HOST_EMBED_MODEL, modelVersion: returnedSpace, spaceId: returnedSpace, dimensions: 2048, purpose: input.purpose, vectors: [vector] }))
  })
  await new Promise<void>(r => server.listen(0, r))
  state.config.transcription.modelHostUrl = `https://localhost:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(directory, { recursive: true, force: true }) })
beforeEach(() => { requests = []; returnedSpace = spaceId; invalid = false; exclude = false; mutateSelection = false; state.config.brains.modelHostEmbedding.spaceId = spaceId })
it('uses authenticated TLS, preserves purpose/raw text and validates normalized 2048 vectors', async () => {
  const result = await brain.embed(['safe fixture'], { purpose: 'query' })
  expect(result[0]?.length).toBe(2048)
  expect(requests).toEqual(['GET /v1/capabilities', 'POST /v1/embeddings'])
})
it('refuses changed model space before sending text', async () => {
  returnedSpace = 'nemotron-import-sha256:' + 'b'.repeat(64)
  await expect(brain.embed(['safe fixture'])).rejects.toThrow('space changed')
  expect(requests).toEqual(['GET /v1/capabilities'])
})
it('rechecks eligibility after metadata and sends no text once excluded', async () => {
  expect(await brain.embed(['safe fixture'], { shouldGenerate: () => !exclude })).toEqual([null])
  expect(requests).toEqual(['GET /v1/capabilities'])
})
it('does no networking when already ineligible', async () => {
  expect(await brain.embed(['safe fixture'], { shouldGenerate: () => false })).toEqual([null])
  expect(requests).toEqual([])
})
it('rejects vectors with invalid normalization', async () => {
  invalid = true
  await expect(brain.embed(['safe fixture'])).rejects.toThrow('vector validation')
})
it('rejects a captured old partition before metadata or text transmission', async () => {
  await expect(brain.embed(['safe fixture'], { expectedProviderId: 'model-host-embed:old-space' })).rejects.toThrow('Captured embedding partition')
  expect(requests).toEqual([])
})

it('discards an otherwise valid in-flight response after the selected semantic space changes', async () => {
  mutateSelection = true
  await expect(brain.embed(['safe fixture'])).rejects.toThrow('selection changed during inference')
  expect(requests).toEqual(['GET /v1/capabilities', 'POST /v1/embeddings'])
})
