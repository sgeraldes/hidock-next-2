// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pcmWavDuration, transcribeMaiTranscribe2, transcribeMuseVoice } from '../file-transcription'

function wav(): Uint8Array {
  const b = Buffer.alloc(32044)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40)
  return b
}
const muse = { audioDurationMs: 1000, transcript: 'Hola', turns: [
  { turnId: 1, startMs: 0, endMs: 900, transcript: 'Hola', speaker: 'A' }
] }
describe('cloud file adapters against a local HTTP fixture, not live providers', () => {
  let server: Server
  let origin: string
  let response: unknown
  let status: number
  let delay: number
  let calls: { url: string; body: string; authorization?: string; key?: string }[]
  let outboundUrl: string
  beforeEach(async () => {
    response = structuredClone(muse); status = 200; delay = 0; calls = []; outboundUrl = ''
    server = createServer(async (req, res) => {
      const parts: Buffer[] = []
      for await (const chunk of req) parts.push(Buffer.from(chunk))
      calls.push({ url: req.url!, body: Buffer.concat(parts).toString(),
        authorization: req.headers.authorization, key: req.headers['ocp-apim-subscription-key'] as string })
      const send = () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response)) }
      if (delay) setTimeout(send, delay).unref(); else send()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address missing')
    origin = `http://127.0.0.1:${address.port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const transport = () => ((input: URL | RequestInfo, init?: RequestInit) => {
    outboundUrl = String(input)
    const url = new URL(outboundUrl)
    return fetch(origin + url.pathname + url.search, init)
  }) as typeof fetch
  const options = () => ({ audio: wav(), apiKey: 'fixture-key', fetchFn: transport() })

  it('sends Meta multipart contract and converts turns to scoped seconds', async () => {
    const result = await transcribeMuseVoice(options())
    expect(outboundUrl).toMatch(/^https:\/\/api.meta.ai\/v1\/asr\/transcribe\?sessionId=/)
    expect(calls[0].authorization).toBe('Bearer fixture-key')
    expect(calls[0].body).toContain('name="request"')
    expect(calls[0].body).toContain('"mode":"DIARIZATION"')
    expect(calls[0].body).toContain('name="audio"; filename="audio.wav"')
    expect(result.segments[0]).toMatchObject({ start: 0, end: 0.9, speaker: `${result.requestId}:A` })
    expect(result.segments[0]).not.toHaveProperty('words')
    expect(calls).toHaveLength(1)
  })
  it('does not merge labels across calls', async () => {
    const a = await transcribeMuseVoice(options())
    const b = await transcribeMuseVoice(options())
    expect(a.segments[0].speaker).not.toBe(b.segments[0].speaker)
  })
  it('rejects partial duration and omitted transcript turns', async () => {
    response = { ...muse, audioDurationMs: 700 }
    await expect(transcribeMuseVoice(options())).rejects.toThrow('coverage')
    response = { ...muse, turns: [] }
    await expect(transcribeMuseVoice(options())).rejects.toThrow('turns')
  })
  it('rejects duplicate turns and ranges beyond source audio', async () => {
    response = { ...muse, turns: [muse.turns[0], muse.turns[0]] }
    await expect(transcribeMuseVoice(options())).rejects.toThrow('turn ID')
    response = { ...muse, turns: [{ ...muse.turns[0], endMs: 1100 }] }
    await expect(transcribeMuseVoice(options())).rejects.toThrow('outside source')
  })
  it('redacts provider errors and never retries', async () => {
    status = 500; response = { error: 'fixture-key private transcript signed-url' }
    await expect(transcribeMuseVoice(options())).rejects.toThrow('HTTP 500; request was not retried')
    expect(calls).toHaveLength(1)
  })
  it('enforces deadline and pre-aborted requests', async () => {
    delay = 300
    await expect(transcribeMuseVoice({ ...options(), timeoutMs: 30 })).rejects.toThrow('outcome unknown')
    expect(calls).toHaveLength(1)
    await expect(transcribeMuseVoice({ ...options(), signal: AbortSignal.abort() })).rejects.toThrow('cancelled')
    expect(calls).toHaveLength(1)
  })
  it('sends the Azure Speech contract and preserves word timestamps', async () => {
    response = { durationMilliseconds: 1000, combinedPhrases: [{ text: 'Hola' }], phrases: [
      { text: 'Hola', offsetMilliseconds: 100, durationMilliseconds: 800, speaker: 1,
        words: [{ text: 'Hola', offsetMilliseconds: 100, durationMilliseconds: 800 }] }
    ] }
    const result = await transcribeMaiTranscribe2({ ...options(), endpoint: 'https://fixture.cognitiveservices.azure.com' })
    expect(outboundUrl).toBe('https://fixture.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15')
    expect(calls[0].key).toBe('fixture-key')
    expect(calls[0].body).toContain('name="definition"')
    expect(calls[0].body).toContain('"model":"MAI-Transcribe-2"')
    expect(result.segments[0].words).toEqual([{ word: 'Hola', start: 0.1, end: 0.9 }])
  })
  it('rejects credential redirection/custom endpoint before upload', async () => {
    await expect(transcribeMaiTranscribe2({ ...options(), endpoint: 'https://attacker.example' })).rejects.toThrow('HTTPS origin')
    expect(calls).toHaveLength(0)
  })
  it('rejects MAI missing requested word times rather than fabricating alignment', async () => {
    response = { durationMilliseconds: 1000, combinedPhrases: [{ text: 'Hola' }], phrases: [
      { text: 'Hola', offsetMilliseconds: 100, durationMilliseconds: 800, speaker: 1 }
    ] }
    await expect(transcribeMaiTranscribe2({ ...options(), endpoint: 'https://fixture.cognitiveservices.azure.com' }))
      .rejects.toThrow('Incomplete')
  })
  it('validates RIFF duration and truncated input before uploading', async () => {
    expect(pcmWavDuration(wav())).toBe(1)
    const audio = wav().slice(0, -2)
    await expect(transcribeMuseVoice({ ...options(), audio })).rejects.toThrow('complete PCM WAV')
    expect(calls).toHaveLength(0)
  })
})
