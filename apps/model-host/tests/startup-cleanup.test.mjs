import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { start } from '../src/main.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
it('releases the real HTTP control socket when the TLS listener cannot start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hidock-startup-test-'))
  const occupied = createServer()
  const controlProbe = createServer()
  try {
    execFileSync('python', [resolve('src/provision_tls.py'), root], { windowsHide: true })
    const tlsPort = await listen(occupied)
    const port = await listen(controlProbe)
    await close(controlProbe)
    await expect(start({ root, overrides: { port, tlsPort, bindAddress: '127.0.0.1',
      tlsCertPath: join(root, 'host-certificate.pem'), tlsKeyPath: join(root, 'host-private-key.pem')
    } })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await new Promise((resolve, reject) => {
      controlProbe.once('error', reject)
      controlProbe.listen(port, '127.0.0.1', resolve)
    })
    expect(controlProbe.address().port).toBe(port)
  } finally {
    await close(controlProbe); await close(occupied)
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
