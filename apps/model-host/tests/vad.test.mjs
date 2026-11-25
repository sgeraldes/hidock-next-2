import { expect, it } from 'vitest'
import { mkdtemp, writeFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { WorkerJobs } from '../src/jobs.mjs'
import { HostState, READY } from '../src/state.mjs'
import { createHostServer } from '../src/server.mjs'
import { parseActivity, runVad } from '../src/vad.mjs'

it('closes trailing silence without inventing activity', () => {
  expect(parseActivity('Duration: 00:01:00.00\nsilence_start: 0').status).toBe('no_speech')
  expect(parseActivity('Duration: 00:01:00.00\nsilence_start: 20\nsilence_end: 30').nonSilentSeconds).toBe(50)
})

it('runs the installed ffmpeg through authenticated durable HTTP jobs and deletes the audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hidock-real-vad-'))
  const ffmpegPath = createRequire(new URL('../../electron/package.json', import.meta.url))('ffmpeg-static')
  const state = new HostState({ initial: READY })
  const jobs = new WorkerJobs({ directory, state, execute: runVad, options: () => ({ ffmpegPath, timeoutMs: 10000 }) })
  let server
  try {
    await jobs.initialize()
    const seconds = 2, rate = 16000
    const wav = Buffer.alloc(44 + seconds * rate * 2)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28)
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
    const hash = value => createHash('sha256').update(value).digest('hex')
    server = createHostServer({ state, jobs, pairing: { accepts: header => header === 'Bearer test-vad' },
      capabilities: () => ({ capabilities: ['vad'] }), jobOptions: () => ({}) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: 'Bearer test-vad', 'content-type': 'application/json' }
    const caps = await (await fetch(base + '/v1/capabilities', { headers })).json()
    expect(caps.stages).toEqual(['vad'])
    expect(caps.models).toEqual(['energy-vad-safety-v1'])
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({
      idempotencyKey: 'real-vad-test-silence', audioHash: hash(wav), bytes: wav.length,
      stage: 'vad', model: 'energy-vad-safety-v1', extension: '.wav' }) })
    expect(response.status).toBe(200)
    const job = await response.json()
    expect((await fetch(`${base}/v1/jobs/${job.id}/audio`, { method: 'PUT', headers, body: wav })).status).toBe(202)
    // ffmpeg's first start on a cold CI runner took over a second, the poll's
    // default (28-oct-2026). Wait up to the job's own 10 s limit and a margin.
    await expect.poll(() => jobs.get(job.id, headers.authorization).status, { timeout: 15000, interval: 100 }).toBe('completed')
    const completed = await (await fetch(`${base}/v1/jobs/${job.id}`, { headers })).json()
    expect(completed.result.status).toBe('no_speech')
    expect(completed.result.durationSeconds).toBe(seconds)
    expect(completed.resultHash).toBe(hash(JSON.stringify(completed.result)))
    expect((await readdir(directory)).filter(name => name.endsWith('.audio'))).toEqual([])
    const controller = new AbortController(); controller.abort()
    await expect(runVad('not-read.wav', { ffmpegPath, signal: controller.signal })).rejects.toThrow('cancelled')
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    jobs.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
