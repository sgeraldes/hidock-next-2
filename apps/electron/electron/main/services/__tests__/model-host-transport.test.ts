// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'https'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const config = vi.hoisted(() => ({ transcription: { modelHostCertificatePem: '' } }))
vi.mock('../config', () => ({ getConfig: () => config }))
import { modelHostFetch } from '../model-host-transport'

let directory: string
let server: Server
let port: number
let requests = 0
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hidock-tls-test-'))
  execFileSync('python', [resolve('../model-host/src/provision_tls.py'), directory], { windowsHide: true })
  const cert = readFileSync(join(directory, 'host-certificate.pem'), 'utf8')
  const key = readFileSync(join(directory, 'host-private-key.pem'))
  config.transcription.modelHostCertificatePem = cert
  server = createServer({ cert, key }, (req, res) => {
    requests++
    if (req.url === '/redirect') { res.writeHead(307, { location: `http://127.0.0.1:${port}/unsafe` }); res.end(); return }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ encrypted: (req.socket as import('tls').TLSSocket).encrypted }))
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (directory) rmSync(directory, { recursive: true, force: true })
})

it('uses endpoint-only certificate trust for an actual TLS connection', async () => {
  const response = await modelHostFetch(`https://localhost:${port}/health`, {})
  expect(await response.json()).toEqual({ encrypted: true })
})

it('retains hostname verification and refuses redirects before credentials or audio can follow', async () => {
  const before = requests
  await expect(modelHostFetch(`https://127.0.0.1:${port}/health`, {})).rejects.toThrow()
  expect(requests).toBe(before)
  await expect(modelHostFetch(`https://localhost:${port}/redirect`, {
    method: 'POST', body: 'sample-audio', headers: { authorization: 'Bearer test-only' }
  })).rejects.toThrow()
  expect(requests).toBe(before + 1)
})
