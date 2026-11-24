// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { runRemoteWorkerJob, validateChannelResult, type RemoteJobIdentity, type RemoteAudioChannelMap } from '../remote-worker-jobs'

let server: Server | undefined
let directory: string | undefined
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  if (directory) { await rm(directory, { recursive: true, force: true }); directory = undefined }
})
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const mapping: RemoteAudioChannelMap = [
  { sourceChannel: 0, role: 'microphone', evidence: 'user-confirmed' },
  { sourceChannel: 1, role: 'unknown', evidence: 'unverified' }
]
function result(audioHash = 'a'.repeat(64)) {
  return {
    model: 'fixture-asr', modelVersion: 'fixture-v1', text: 'synthetic fixture',
    sourceChannels: 2, channelMode: 'separate', sourceAudioSha256: audioHash,
    audioSeconds: 2, decodedFrames: 32000, decodedSampleRate: 16000, activeChannels: [0],
    channelResults: [{sourceChannel: 0, segmentCount: 1, status: 'completed'},
      {sourceChannel: 1, segmentCount: 0, status: 'no-activity-skip'}],
    segments: [{start: 0, end: 2, speaker: 'channel0:speaker0', text: 'synthetic fixture',
      sourceChannel: 0, channelRole: 'microphone', channelProvenance: 'user-confirmed'}]
  }
}
async function audioFixture() {
  directory = await mkdtemp(join(tmpdir(), 'hidock-channel-http-'))
  const path = join(directory, 'synthetic.wav')
  const bytes = Buffer.alloc(2 * 1024 ** 2, 17)
  await writeFile(path, bytes)
  return { path, bytes, audioHash: digest(bytes) }
}
const capabilities = { protocolVersion: 1, stages: ['transcription'], models: ['fixture-asr'],
  audioChannels: { version: 1, separate: true, maxChannels: 2, activeChannelSelection: true } }

it.each(['legacy', 'no-active-selection'])('rejects %s capability before any POST or upload', async variant => {
  const { path } = await audioFixture()
  const seen: string[] = []
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const cap = variant === 'legacy' ? { ...capabilities, audioChannels: undefined }
      : { ...capabilities, audioChannels: { ...capabilities.audioChannels, activeChannelSelection: false } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(cap))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  await expect(runRemoteWorkerJob({path, base: `http://127.0.0.1:${(server.address() as {port:number}).port}`,
    token: 'synthetic-token', model: 'fixture-asr', stage: 'transcription', timeoutMs: 5000,
    channelMode: 'separate', channelMap: mapping, activeChannels: [0], store: {load: () => undefined, save: () => {}}
  })).rejects.toThrow(/no upload/i)
  expect(seen).toEqual(['GET /v1/capabilities'])
})

it('streams once after a lost PUT acknowledgement and resumes the same channel-qualified job', async () => {
  const { path, bytes, audioHash } = await audioFixture()
  const payload = result(audioHash)
  let status = 'awaiting-upload', uploads = 0, received = 0
  const posts: Record<string, unknown>[] = []
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  server = createServer(async (req, res) => {
    const json = (data: unknown) => {res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data))}
    if (req.url === '/v1/capabilities') return json(capabilities)
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk.toString()
      posts.push(JSON.parse(body)); return json({id, status, audioHash})
    }
    if (req.method === 'PUT') {
      uploads++; for await (const chunk of req) received += chunk.length
      status = 'completed'; req.socket.destroy(); return
    }
    return json({id, status, audioHash, result: payload, resultHash: digest(JSON.stringify(payload))})
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const entries = new Map<string, RemoteJobIdentity>()
  const store = {load: (key: string) => entries.get(key), save: (key: string, identity: RemoteJobIdentity) => { entries.set(key, structuredClone(identity)) }}
  const options = {path, base: `http://127.0.0.1:${(server.address() as {port:number}).port}`, token: 'synthetic-token',
    model: 'fixture-asr', stage: 'transcription' as const, timeoutMs: 5000, channelMode: 'separate' as const,
    channelMap: mapping, activeChannels: [0] as Array<0 | 1>, store}
  expect(await runRemoteWorkerJob(options)).toEqual({...payload, hostJobId: id})
  // Older durable intents omitted the language even though the host used es.
  // Reconnecting must preserve that completed job, not reject it or upload again.
  for (const identity of entries.values()) if (identity.request) delete identity.request.language
  expect(await runRemoteWorkerJob(options)).toEqual({...payload, hostJobId: id})
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({channelMode:'separate', channelMap: mapping, activeChannels:[0], audioHash, language:'es'})
  expect({uploads, received}).toEqual({uploads:1, received:bytes.length})
  expect(entries.size).toBe(1)
  expect([...entries.values()][0]).toMatchObject({id, request:{channelMode:'separate', channelMap:mapping, activeChannels:[0]}})
})

it.each(['mixed', 'hash', 'clock', 'forged-role', 'forged-proof', 'excluded-channel', 'active-selection', 'out-of-range'])(
  'rejects invalid separate-channel result: %s', mutation => {
    const candidate = result()
    if (mutation === 'mixed') candidate.channelMode = 'mixed'
    if (mutation === 'hash') candidate.sourceAudioSha256 = 'b'.repeat(64)
    if (mutation === 'clock') candidate.decodedFrames++
    if (mutation === 'forged-role') candidate.segments[0].channelRole = 'system'
    if (mutation === 'forged-proof') candidate.segments[0].channelProvenance = 'firmware-manifest'
    if (mutation === 'excluded-channel') {candidate.segments[0].sourceChannel = 1; candidate.channelResults[0].segmentCount = 0; candidate.channelResults[1].segmentCount = 1}
    if (mutation === 'active-selection') candidate.activeChannels = [0, 1]
    if (mutation === 'out-of-range') candidate.segments[0].end = 9
    expect(() => validateChannelResult(candidate, 'separate', 'a'.repeat(64), mapping, [0])).toThrow()
  })

it('accepts the exact hash, decoded clock, explicit source map and quiet-channel exclusion', () => {
  expect(() => validateChannelResult(result(), 'separate', 'a'.repeat(64), mapping, [0])).not.toThrow()
})
