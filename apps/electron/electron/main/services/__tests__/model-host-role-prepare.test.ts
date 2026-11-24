// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const config = vi.hoisted(() => ({ transcription: { modelHostCertificatePem: '' } }))
vi.mock('../config', () => ({ getConfig: () => config }))
import { prepareModelHostRole } from '../model-host-client'
let server: Server, directory: string, base: string
const requests: string[] = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'hidock-role-tls-'))
  execFileSync('python', [resolve('../model-host/src/provision_tls.py'), directory], { windowsHide: true })
  const cert = readFileSync(join(directory, 'host-certificate.pem'), 'utf8')
  config.transcription.modelHostCertificatePem = cert
  server = createServer({ cert, key: readFileSync(join(directory, 'host-private-key.pem')) }, (req, res) => {
    expect(req.headers.authorization).toBe('Bearer test-only')
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true }))
  })
  await new Promise<void>(r => server.listen(0, r))
  base = `https://localhost:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(directory, { recursive: true, force: true }) })
it('sends authenticated fixed preparation actions over actual certificate-verified HTTPS', async () => {
  for (const role of ['semantic', 'realtime', 'generation'] as const)
    await prepareModelHostRole({ url: base, token: 'test-only' }, role)
  expect(requests).toEqual(['POST /runtime/prepare-semantic', 'POST /runtime/prepare-realtime', 'POST /runtime/prepare-generation'])
})
it('rejects HTTP, arbitrary roles and missing pairing before sending a request', async () => {
  const count = requests.length
  await expect(prepareModelHostRole({ url: 'http://127.0.0.1', token: 'test-only' }, 'semantic')).rejects.toThrow('HTTPS')
  await expect(prepareModelHostRole({ url: base, token: '' }, 'realtime')).rejects.toThrow('Pair')
  await expect(prepareModelHostRole({ url: base, token: 'test-only' }, '../arbitrary' as never)).rejects.toThrow('supported')
  expect(requests).toHaveLength(count)
})
