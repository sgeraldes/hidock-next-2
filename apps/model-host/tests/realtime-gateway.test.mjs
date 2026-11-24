import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { attachRealtimeGateway, REALTIME_PATH } from '../src/realtime-gateway.mjs'
import { HostState } from '../src/state.mjs'

const cleanups = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const wait = async predicate => {
  const end = Date.now() + 3000
  while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 5)) }
}
async function fixture({ available = true } = {}) {
  const native = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(native, 'listening')
  cleanups.push(() => new Promise(resolve => { for (const c of native.clients) c.terminate(); native.close(resolve) }))
  let stopped = 0, started = 0, audio = 0
  native.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'session.created' }))
    ws.on('message', (data, binary) => {
      if (binary) { audio += data.length; ws.send(JSON.stringify({ type: 'transcription.delta', delta: 'test' })); return }
      const e = JSON.parse(data.toString())
      if (e.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }))
      if (e.type === 'input_audio_buffer.commit') ws.send(JSON.stringify({ type: 'transcription.completed', transcript: 'test' }))
      if (e.type === 'response.cancel') ws.send(JSON.stringify({ type: 'input_audio_buffer.cleared' }))
    })
  })
  const state = new HostState({ initial: 'ready' })
  const server = createServer()
  const gateway = attachRealtimeGateway(server, { state, pairing: { accepts: a => a === 'Bearer test' },
    available: () => available, startRuntime: async ({ signal, onMessage }) => {
      started++
      const socket = new WebSocket(`ws://127.0.0.1:${native.address().port}`)
      socket.on('message', onMessage)
      const done = new Promise(resolve => socket.once('close', () => { stopped++; resolve() }))
      socket.on('error', () => {})
      signal.addEventListener('abort', () => socket.close(), { once: true })
      await once(socket, 'open')
      return { socket, done, close: async () => { socket.close(); await done } }
    } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { gateway.close(); await wait(() => state.activeJob === null); await new Promise(r => server.close(r)) })
  const open = (auth = 'Bearer test') => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${REALTIME_PATH}`, { headers: { authorization: auth } })
    ws.on('error', () => {})
    const events = []
    ws.on('message', d => events.push(JSON.parse(d.toString())))
    cleanups.push(() => ws.terminate())
    return { ws, events }
  }
  return { state, open, counts: () => ({ started, stopped, audio }) }
}
const configure = async client => {
  await wait(() => client.events.some(e => e.type === 'session.created'))
  client.ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language: 'es' } }))
  await wait(() => client.events.some(e => e.type === 'session.updated'))
}
describe('authenticated realtime gateway with actual loopback sockets', () => {
  it('rejects unpaired clients before starting native work', async () => {
    const f = await fixture(); const c = f.open('Bearer wrong')
    const [, response] = await once(c.ws, 'unexpected-response'); expect(response.statusCode).toBe(401); response.resume()
    expect(f.counts().started).toBe(0)
  })
  it('does not infer live readiness from file support', async () => {
    const f = await fixture({ available: false }); const c = f.open()
    const [, response] = await once(c.ws, 'unexpected-response'); expect(response.statusCode).toBe(503); response.resume()
    expect(f.counts().started).toBe(0)
  })
  it('delivers partial before commit, final, and releases the single lane', async () => {
    const f = await fixture(); const c = f.open(); await configure(c)
    expect(f.state.canAdmit()).toBe(false)
    const other = f.open(); const [, response] = await once(other.ws, 'unexpected-response')
    expect(response.statusCode).toBe(409); response.resume()
    c.ws.send(Buffer.alloc(3200)); await wait(() => c.events.some(e => e.type.endsWith('.delta')))
    expect(c.events.some(e => e.type.endsWith('.completed'))).toBe(false)
    c.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    await wait(() => f.state.canAdmit())
    expect(c.events.some(e => e.type.endsWith('.completed'))).toBe(true)
    expect(f.counts()).toEqual({ started: 1, stopped: 1, audio: 3200 })
  })
  it('cancel and disconnect stop runtime without replay', async () => {
    const f = await fixture(); const c = f.open(); await configure(c)
    c.ws.send(JSON.stringify({ type: 'response.cancel' })); await wait(() => f.state.canAdmit())
    expect(c.events.some(e => e.type === 'input_audio_buffer.cleared')).toBe(true)
    const next = f.open(); await configure(next); next.ws.terminate(); await wait(() => f.state.canAdmit())
    expect(f.counts()).toEqual({ started: 2, stopped: 2, audio: 0 })
  })
  it('rejects malformed PCM before native audio delivery', async () => {
    const f = await fixture(); const c = f.open(); await configure(c)
    c.ws.send(Buffer.alloc(3)); await wait(() => f.state.canAdmit())
    expect(c.events.some(e => e.type === 'error')).toBe(true); expect(f.counts().audio).toBe(0)
  })
  it('bounds audio pacing and does not buffer a file upload as realtime', async () => {
    const f = await fixture(); const c = f.open(); await configure(c)
    for (let i = 0; i < 4; i++) c.ws.send(Buffer.alloc(32000))
    await wait(() => f.state.canAdmit())
    expect(c.events.some(e => e.error?.message?.includes('paced'))).toBe(true)
    expect(f.counts().audio).toBeLessThanOrEqual(64000)
  })
  it('host pause aborts the stream and releases resources', async () => {
    const f = await fixture(); const c = f.open(); await configure(c)
    f.state.activeJob.abort(); await wait(() => f.state.canAdmit())
    expect(f.counts().stopped).toBe(1)
  })
  it('refuses configuration allowing a different model or speaker attribution', async () => {
    const f = await fixture(); const c = f.open()
    await wait(() => c.events.some(e => e.type === 'session.created'))
    c.ws.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, language: 'es', speaker_diarization: true } }))
    await wait(() => f.state.canAdmit()); expect(f.counts().audio).toBe(0)
    expect(c.events.some(e => e.type === 'error')).toBe(true)
  })
})
