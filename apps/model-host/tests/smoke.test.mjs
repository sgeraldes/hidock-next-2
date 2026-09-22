/**
 * The host, started for real, answered over a real socket.
 *
 * The unit tests call the handler with a fake request, so they cannot catch a
 * listener that never binds, a header the real server rejects, or a body the
 * real parser reads differently. This one starts the process's own server.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { start } from '../src/main.mjs'

const root = mkdtempSync(join(tmpdir(), 'hidock-host-test-'))
// A python that does not exist: the request has to reach the worker and
// fail THERE, which proves the door opened, without waiting on pyannote.
const host = await start({
  root,
  overrides: { port: 0, pythonPath: join(root, 'no-such-python.exe'), timeoutMs: 5000 },
})
const base = `http://127.0.0.1:${host.port}`

afterAll(async () => {
  await new Promise((resolve) => host.server.close(resolve))
})

describe('the host over a real socket', () => {
  it('starts stopped, because installing is not permission to run', async () => {
    const res = await fetch(`${base}/health`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.state).toBe('stopped')
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('serves a control page with the three controls', async () => {
    const res = await fetch(`${base}/`)
    const html = await res.text()
    expect(res.status).toBe(200)
    for (const action of ['start', 'pause', 'stop']) {
      expect(html).toContain(`value="${action}"`)
    }
  })

  it('starts from the control form and reports it', async () => {
    const res = await fetch(`${base}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=start',
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect((await (await fetch(`${base}/health`)).json()).state).toBe('ready')
  })

  it('turns a pairing code into a token, and refuses work without one', async () => {
    const unauthorized = await fetch(`${base}/jobs/diarize`, { method: 'POST', body: 'audio' })
    expect(unauthorized.status).toBe(401)

    await fetch(`${base}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=pair',
      redirect: 'manual',
    })
    const code = host.pairing.pending.code
    const paired = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(paired.status).toBe(200)
    const { token } = await paired.json()

    // Authorized, and the request reaches the worker: on this machine there is
    // no pyannote, so it fails there rather than at the door.
    const authorized = await fetch(`${base}/jobs/diarize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'not really audio',
    })
    expect(authorized.status).toBe(500)
    expect((await authorized.json()).error).toMatch(/failed to start the diarization worker/)
    // And the lane is free again, so the next client is not told 429 forever.
    expect((await (await fetch(`${base}/health`)).json()).state).toBe('ready')
  })

  it('refuses an empty body with a reason', async () => {
    await fetch(`${base}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'action=pair',
      redirect: 'manual',
    })
    const { token } = await (await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: host.pairing.pending.code }),
    })).json()
    const res = await fetch(`${base}/jobs/diarize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '',
    })
    expect(res.status).toBe(400)
  })

  it('has no route it did not mean to have', async () => {
    expect((await fetch(`${base}/jobs`)).status).toBe(404)
    expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404)
  })
})
