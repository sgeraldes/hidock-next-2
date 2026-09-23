/**
 * The brain API's door: who gets in, and what each route answers.
 *
 * This replaces a debugging port that let any local process run arbitrary
 * JavaScript in the app, so the refusals matter as much as the answers.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { request } from 'http'
import { startBrainServer, tokensMatch, isLoopbackHost, type BrainQueries, type RunningBrainServer } from '../brain-server'

const TOKEN = 'a'.repeat(64)

function fakeQueries(): BrainQueries & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    meetingsSince: (since) => (calls.push(`meetingsSince:${since}`), [{ id: 'm1' }]),
    pendingActionablesSince: (since) => (calls.push(`pending:${since}`), [{ id: 'a1' }]),
    actionableById: (id) => (calls.push(`actionable:${id}`), id === 'a1' ? { id: 'a1' } : null),
    knowledgeByIds: (ids) => (calls.push(`knowledge:${ids.join(',')}`), ids.map((id) => ({ id }))),
    knowledgeById: (id) => (calls.push(`knowledgeOne:${id}`), id === 'k1' ? { id: 'k1' } : null),
    meetingRecordings: (id) => (calls.push(`recordings:${id}`), [{ id: 'r1' }]),
    transcriptForRecording: (id) => (calls.push(`transcript:${id}`), id === 'r1' ? { recording_id: 'r1' } : null),
    recordingById: (id) => (calls.push(`recording:${id}`), id === 'r1' ? { id: 'r1' } : null),
    recordingsByFilenamePrefix: (prefix) => (calls.push(`prefix:${prefix}`), [{ id: 'p1' }]),
  }
}

let running: RunningBrainServer | null = null
afterEach(async () => {
  if (running) await running.close()
  running = null
})

function call(
  port: number,
  path: string,
  opts: { method?: string; token?: string | null; host?: string } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` }
    const token = opts.token === undefined ? TOKEN : opts.token
    if (token !== null) headers.authorization = `Bearer ${token}`
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let text = ''
      res.setEncoding('utf-8')
      res.on('data', (c: string) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function start(kind: 'app' | 'service', extra: Partial<Parameters<typeof startBrainServer>[0]> = {}) {
  const queries = fakeQueries()
  running = await startBrainServer({ kind, token: TOKEN, instanceId: 'inst-1', queries, ...extra })
  return { port: running.port, queries }
}

describe('who gets in', () => {
  it('refuses a request with no token', async () => {
    const { port, queries } = await start('service')
    expect((await call(port, '/health', { token: null })).status).toBe(401)
    expect(queries.calls).toEqual([])
  })

  it('refuses a wrong token, including one of a different length', async () => {
    const { port } = await start('service')
    expect((await call(port, '/health', { token: 'b'.repeat(64) })).status).toBe(401)
    expect((await call(port, '/health', { token: 'short' })).status).toBe(401)
  })

  it('refuses a Host header that is not this loopback port, even with the right token', async () => {
    // A web page can resolve its own name to 127.0.0.1, but its requests still
    // say its own name. That is the DNS-rebinding case this exists for.
    const { port, queries } = await start('service')
    expect((await call(port, '/health', { host: `evil.example:${port}` })).status).toBe(403)
    expect((await call(port, '/health', { host: `127.0.0.1:${port + 1}` })).status).toBe(403)
    expect(queries.calls).toEqual([])
  })

  it('accepts localhost as well as 127.0.0.1', async () => {
    const { port } = await start('service')
    expect((await call(port, '/health', { host: `localhost:${port}` })).status).toBe(200)
  })

  it('is read-only apart from step-down', async () => {
    const { port } = await start('service')
    expect((await call(port, '/meetings?since=2026-09-01', { method: 'POST' })).status).toBe(405)
    expect((await call(port, '/meetings?since=2026-09-01', { method: 'DELETE' })).status).toBe(405)
  })
})

describe('what it answers', () => {
  it('reports health with the instance id a probe checks against', async () => {
    const { port } = await start('app')
    const { status, body } = await call(port, '/health')
    expect(status).toBe(200)
    expect(body).toMatchObject({ kind: 'app', instanceId: 'inst-1', pid: process.pid })
  })

  it('routes each question to its query with the right argument', async () => {
    const { port, queries } = await start('service')
    expect((await call(port, '/meetings?since=2026-09-15')).body).toEqual([{ id: 'm1' }])
    expect((await call(port, '/actionables?since=2026-09-15&status=pending')).body).toEqual([{ id: 'a1' }])
    expect((await call(port, '/actionables/a1')).body).toEqual({ id: 'a1' })
    expect((await call(port, '/knowledge?ids=k1,k2')).body).toEqual([{ id: 'k1' }, { id: 'k2' }])
    expect((await call(port, '/knowledge/k1')).body).toEqual({ id: 'k1' })
    expect((await call(port, '/meetings/m1/recordings')).body).toEqual([{ id: 'r1' }])
    expect((await call(port, '/transcripts/r1')).body).toEqual({ recording_id: 'r1' })
    expect(queries.calls).toEqual([
      'meetingsSince:2026-09-15',
      'pending:2026-09-15',
      'actionable:a1',
      'knowledge:k1,k2',
      'knowledgeOne:k1',
      'recordings:m1',
      'transcript:r1',
    ])
  })

  it('serves a recording by id and recordings by filename prefix', async () => {
    const { port, queries } = await start('service')
    expect((await call(port, '/recordings/r1')).body).toEqual({ id: 'r1' })
    expect((await call(port, '/recordings/nope')).status).toBe(404)
    expect((await call(port, `/recordings?filenamePrefix=${encodeURIComponent('Rec10 - Part ')}`)).body).toEqual([{ id: 'p1' }])
    expect((await call(port, '/recordings?filenamePrefix=Re')).status).toBe(400)
    expect(queries.calls).toEqual(['recording:r1', 'recording:nope', 'prefix:Rec10 - Part '])
  })

  it('answers 404 for an id that is absent or excluded, without saying which', async () => {
    const { port } = await start('service')
    expect((await call(port, '/actionables/nope')).status).toBe(404)
    expect((await call(port, '/knowledge/nope')).status).toBe(404)
    expect((await call(port, '/transcripts/nope')).status).toBe(404)
  })

  it('rejects a since that is not a date, instead of passing it to SQL', async () => {
    const { port, queries } = await start('service')
    expect((await call(port, `/meetings?since=${encodeURIComponent("2026' OR 1=1--")}`)).status).toBe(400)
    expect((await call(port, '/meetings')).status).toBe(400)
    expect(queries.calls).toEqual([])
  })

  it('answers 400 to a path it cannot decode, and keeps serving', async () => {
    // Review of PR #29: a bad escape threw outside the try, which in the main
    // process is an uncaught exception and Electron's modal error box.
    const { port, queries } = await start('service')
    expect((await call(port, '/transcripts/%E0')).status).toBe(400)
    expect((await call(port, '/health')).status).toBe(200)
    expect(queries.calls).toEqual([])
  })

  it('serves only pending actionables', async () => {
    const { port } = await start('service')
    expect((await call(port, '/actionables?since=2026-09-15&status=done')).status).toBe(400)
  })

  it('lists its routes for an unknown path', async () => {
    const { port } = await start('service')
    const { status, body } = await call(port, '/raw')
    expect(status).toBe(404)
    expect(body.routes).toContain('GET /meetings?since=<iso>')
  })

  it('says recording-now needs the app when it is the headless brain', async () => {
    const { port } = await start('service')
    const { status, body } = await call(port, '/recording-now')
    expect(status).toBe(503)
    expect(body.error).toMatch(/only known while the HiDock app is open/)
  })

  it('answers recording-now from the app', async () => {
    const { port } = await start('app', { recordingNow: () => ({ recording: true, file: 'Rec01.hda' }) })
    expect((await call(port, '/recording-now')).body).toEqual({ recording: true, file: 'Rec01.hda' })
  })

  it('reports every accepted request, which is what keeps the headless brain alive', async () => {
    const onRequest = vi.fn()
    const { port } = await start('service', { onRequest })
    await call(port, '/health')
    await call(port, '/health', { token: null })
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})

describe('stepping down', () => {
  it('lets the headless brain be asked to leave', async () => {
    const onStepDown = vi.fn()
    const { port } = await start('service', { onStepDown })
    expect((await call(port, '/step-down', { method: 'POST' })).status).toBe(202)
    expect(onStepDown).toHaveBeenCalledTimes(1)
  })

  it('never lets anyone ask the app to leave', async () => {
    const { port } = await start('app')
    expect((await call(port, '/step-down', { method: 'POST' })).status).toBe(409)
  })

  it('needs the token to ask', async () => {
    const onStepDown = vi.fn()
    const { port } = await start('service', { onStepDown })
    expect((await call(port, '/step-down', { method: 'POST', token: null })).status).toBe(401)
    expect(onStepDown).not.toHaveBeenCalled()
  })
})

describe('the helpers', () => {
  it('compares tokens exactly', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(TOKEN.slice(1), TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
  })

  it('accepts only this loopback port', () => {
    expect(isLoopbackHost('127.0.0.1:4000', 4000)).toBe(true)
    expect(isLoopbackHost('LOCALHOST:4000', 4000)).toBe(true)
    expect(isLoopbackHost('127.0.0.1', 4000)).toBe(false)
    expect(isLoopbackHost('127.0.0.1:4001', 4000)).toBe(false)
    expect(isLoopbackHost(undefined, 4000)).toBe(false)
  })
})
