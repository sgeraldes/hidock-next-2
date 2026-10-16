import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'https'
import { once } from 'events'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer } from 'ws'
import { RemoteNemotronLiveTranscription } from '../remote-nemotron-live-transcription'
import { liveStereoToMono } from '../live-pcm'
import type { RealtimeData } from '@hidock/jensen-protocol'

let directory: string, cert: string, key: string, wrongCert: string
const cleanup: Array<() => Promise<void> | void> = []
const wait = async (test: () => boolean) => {
  const end = Date.now() + 3000
  while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 5)) }
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'hidock-live-tls-test-'))
  for (const name of ['server', 'wrong']) {
    execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(directory, `${name}.key`),
        '-out', join(directory, `${name}.pem`)], { windowsHide: true, stdio: 'ignore' })
  }
  cert = readFileSync(join(directory, 'server.pem'), 'utf8'); key = readFileSync(join(directory, 'server.key'), 'utf8')
  wrongCert = readFileSync(join(directory, 'wrong.pem'), 'utf8')
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture(ca = cert, support = true) {
  const server = createServer({ cert, key })
  const ws = new WebSocketServer({ server })
  let auth = '', frames = 0
  ws.on('connection', (socket, request) => {
    auth = request.headers.authorization || ''
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', (data, binary) => {
      if (binary) { frames++; socket.send(JSON.stringify({ type: 'transcription.delta', delta: 'hola' })); return }
      const event = JSON.parse(data.toString())
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      if (event.type === 'input_audio_buffer.commit') {
        socket.send(JSON.stringify({ type: 'transcription.completed', transcript: 'hola' })); socket.close()
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of ws.clients) socket.terminate(); ws.close(); server.close(() => resolve()) }))
  const events: Array<{ channel: string; payload: any }> = []
  const port = (server.address() as { port: number }).port
  const service = new RemoteNemotronLiveTranscription(() => ({ modelHostUrl: `https://127.0.0.1:${port}`,
    modelHostToken: 'paired-test', modelHostCertificatePem: ca, liveTranscriptionLanguage: 'es' }),
    async () => new Response(JSON.stringify({ protocolVersion: 1,
      realtimeAsrModels: support ? ['nvidia/nemotron-3.5-asr-streaming-0.6b'] : [] })))
  cleanup.push(() => service.pause())
  return { service, events, start: () => service.start({ isDestroyed: () => false,
    send: (channel, payload) => { events.push({ channel, payload }) } }), stats: () => ({ auth, frames }) }
}
const packet = (payload = Buffer.alloc(6400)) => ({ data: Buffer.concat([Buffer.alloc(8), payload]), muted: false, rest: 0 }) as RealtimeData
describe('remote live client with real TLS websocket sockets', () => {
  it('checks CA, sends paired authorization, receives partial then final and closes', async () => {
    const f = await fixture(); await f.start()
    await wait(() => f.events.some(e => e.payload.status === 'listening'))
    f.service.acceptDevicePacket(packet())
    await wait(() => f.events.some(e => e.channel.endsWith(':interim')))
    expect(f.events.some(e => e.channel.endsWith(':final'))).toBe(false)
    await f.service.stop()
    expect(f.events.find(e => e.channel.endsWith(':final'))?.payload).toMatchObject({ text: 'hola', speaker: 'speaker', channel: null })
    expect(f.stats()).toEqual({ auth: 'Bearer paired-test', frames: 1 })
  })
  it('refuses a different CA without sending any audio', async () => {
    const f = await fixture(wrongCert); await f.start()
    await wait(() => f.events.some(e => e.channel.endsWith(':error')))
    expect(f.stats().frames).toBe(0); expect(f.stats().auth).toBe('')
  })
  it('rejects missing realtime capability independently of file engines', async () => {
    const f = await fixture(cert, false)
    await expect(f.start()).rejects.toThrow('has not validated')
    expect(f.stats().auth).toBe('')
  })
  it('oversized audio stops ASR instead of replaying or accumulating a queue', async () => {
    const f = await fixture(); await f.start(); await wait(() => f.events.some(e => e.payload.status === 'listening'))
    f.service.acceptDevicePacket(packet(Buffer.alloc(128004)))
    await wait(() => f.events.some(e => e.channel.endsWith(':error')))
    f.service.acceptDevicePacket(packet()); expect(f.stats().frames).toBe(0)
  })
  it('mixes known stereo only, preserves silence and rejects partial frames', () => {
    const payload = Buffer.alloc(4); payload.writeInt16LE(1000, 0); payload.writeInt16LE(-500, 2)
    expect(liveStereoToMono(packet(payload)).readInt16LE(0)).toBe(250)
    expect(liveStereoToMono({ ...packet(payload), muted: true }).readInt16LE(0)).toBe(0)
    expect(() => liveStereoToMono(packet(Buffer.alloc(3)))).toThrow('incomplete')
  })
})
