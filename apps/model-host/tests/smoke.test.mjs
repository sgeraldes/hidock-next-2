/**
 * The service, started for real, answered over a real socket.
 *
 * The unit tests call the handler with a fake request, so they cannot catch a
 * listener that never binds, a header the real server rejects, or a body the
 * real parser reads differently. This one starts the process's own server, the
 * way the tray icon does (--ready).
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { start } from '../src/main.mjs'

const root = mkdtempSync(join(tmpdir(), 'hidock-host-test-'))
// A python that does not exist: a job has to reach the worker and fail THERE,
// which proves the door opened, without waiting on pyannote.
const host = await start({
  root,
  startReady: true,
  overrides: { port: 0, pythonPath: join(root, 'no-such-python.exe'), timeoutMs: 5000, validated: true },
})
const base = `http://127.0.0.1:${host.port}`

// A second service that has never run the model, for the token path.
const freshRoot = mkdtempSync(join(tmpdir(), 'hidock-host-fresh-'))
const fresh = await start({
  root: freshRoot,
  startReady: true,
  overrides: { port: 0 },
  diarize: async () => ({ model: 'pyannote/speaker-diarization-3.1', modelVersion: '4.0.7', device: 'cuda', segments: [], speakers: [] }),
})
const freshBase = `http://127.0.0.1:${fresh.port}`

afterAll(async () => {
  await new Promise((resolve) => host.server.close(resolve))
  await new Promise((resolve) => fresh.server.close(resolve))
  rmSync(root, { recursive: true, force: true })
  rmSync(freshRoot, { recursive: true, force: true })
})

const control = (b, action) =>
  fetch(`${b}/control?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `action=${action}`,
  }).then((r) => r.json())

describe('the service over a real socket', () => {
  it('runs ready, as the tray icon starts it', async () => {
    const res = await fetch(`${base}/health`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.state).toBe('ready')
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('has no page', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404)
  })

  it('pairs the first HiDock with no code while automatic pairing is open, then refuses work without a token', async () => {
    expect((await control(base, 'status')).pairing.automatic).toBe(true)
    const unauthorized = await fetch(`${base}/jobs/diarize`, { method: 'POST', body: 'audio' })
    expect(unauthorized.status).toBe(401)

    const paired = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '' }),
    })
    expect(paired.status).toBe(200)
    const { token } = await paired.json()
    expect((await control(base, 'status')).pairing).toMatchObject({ automatic: false, paired: 1 })

    // Authorized, and the request reaches the worker: on this machine there is
    // no pyannote, so it fails there rather than at the door.
    const authorized = await fetch(`${base}/jobs/diarize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'not really audio',
    })
    expect(authorized.status).toBe(500)
    expect((await authorized.json()).error).toMatch(/failed to start the diarization worker/)
    expect((await (await fetch(`${base}/health`)).json()).state).toBe('ready')
  })

  it('refuses an empty body with a reason', async () => {
    const { code } = await control(base, 'pair-code')
    const { token } = await (await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json()
    const res = await fetch(`${base}/jobs/diarize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '',
    })
    expect(res.status).toBe(400)
  })

  it('takes the Hugging Face token from HiDock, proves the model, and only then offers to diarize', async () => {
    const { token } = await (await fetch(`${freshBase}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '' }),
    })).json()
    const auth = { authorization: `Bearer ${token}` }
    const before = await (await fetch(`${freshBase}/health`, { headers: auth })).json()
    expect(before.setup.status).toBe('needs-token')
    expect(before.capabilities).toEqual([])

    const put = await fetch(`${freshBase}/secrets/hf-token`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'hf_abcdefghijklmnopqrstuvwxyz' }),
    })
    expect(put.status).toBe(202)
    await fresh.setup.idle()
    const after = await (await fetch(`${freshBase}/health`, { headers: auth })).json()
    expect(after.setup).toMatchObject({ status: 'ready', device: 'cuda' })
    expect(after.capabilities).toEqual(['diarize'])
    // Kept for the next start, in secrets.json, never in config.json.
    expect(JSON.parse(readFileSync(join(freshRoot, 'secrets.json'), 'utf8')).hfToken).toBe('hf_abcdefghijklmnopqrstuvwxyz')
    const config = readFileSync(join(freshRoot, 'config.json'), 'utf8')
    expect(JSON.parse(config).validated).toBe(true)
    expect(config).not.toMatch(/hf_/)
  })

  it('has no route it did not mean to have', async () => {
    expect((await fetch(`${base}/jobs`)).status).toBe(404)
    expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404)
  })
})
