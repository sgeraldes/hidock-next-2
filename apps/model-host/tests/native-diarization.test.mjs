import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nativeDiarizationFingerprint, readyNativeDiarization, NATIVE_DIARIZATION_MODEL as model } from '../src/native-diarization.mjs'
import { createHandler } from '../src/server.mjs'
import { HostState } from '../src/state.mjs'
import { PairingStore } from '../src/auth.mjs'
import { request, response } from './helpers.mjs'

const directories = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function runtime() {
  const root = mkdtempSync(join(tmpdir(), 'hidock-native-diarization-'))
  directories.push(root)
  const python = join(root, 'python.exe')
  const manifest = join(root, 'models/nemotron-3-diarization-gguf/hidock-manifest.json')
  const exe = join(root, 'runtime/asr-nemotron/nemo-speech-0.2.0-windows-x86_64-cuda/bin/nemo-speech.exe')
  const weights = join(root, 'models/nemotron-3-diarization-gguf/Nemotron-3-Diarization.q8_0.gguf')
  for (const path of [python, manifest, exe, weights]) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture')
  }
  return { root, python, manifest, exe, weights }
}

function routeFixture(ready = false) {
  const pairing = new PairingStore()
  const token = pairing.redeem(pairing.openPairing()).token
  const calls = { jobs: [], preparations: [] }
  const deps = {
    state: new HostState(), pairing,
    capabilities: () => ({ capabilities: [], diarizationModels: ready ? [model] : [], asrModels: [] }),
    jobs: { create: async value => { calls.jobs.push(value); return { id: 'fixture' } } },
    maintenance: { prepareAsr: value => calls.preparations.push(value) },
  }
  const handler = createHandler(deps)
  async function call(url, { method = 'GET', body, authenticated = true, encrypted = true } = {}) {
    const req = request({ method, url, local: false,
      headers: authenticated ? { authorization: `Bearer ${token}` } : {},
      body: body ? JSON.stringify(body) : '' })
    req.socket.encrypted = encrypted
    const res = response()
    await handler(req, res)
    return res
  }
  return { deps, calls, call }
}

describe('native diarization readiness fingerprint', () => {
  it('accepts only a current CUDA proof and rejects absent or stale proof', () => {
    const { root, python } = runtime()
    const proof = { testedAt: 'fixture', modelVersion: 'pinned', device: 'cuda',
      fingerprint: nativeDiarizationFingerprint(python, root) }
    const check = value => readyNativeDiarization({ diarizationValidation: { [model]: value } }, python, root)
    expect(check(proof)).toBe(true)
    for (const value of [undefined, { ...proof, device: 'cpu' }, { ...proof, fingerprint: 'stale' },
      { ...proof, testedAt: undefined }, { ...proof, modelVersion: undefined }]) expect(check(value)).toBe(false)
  })
  it.each(['python', 'manifest', 'exe', 'weights'])('invalidates readiness when %s changes', key => {
    const fixture = runtime()
    const before = nativeDiarizationFingerprint(fixture.python, fixture.root)
    writeFileSync(fixture[key], 'changed-runtime-file')
    expect(nativeDiarizationFingerprint(fixture.python, fixture.root)).not.toBe(before)
  })
  it('fails closed when model artifacts are missing', () => {
    const { root, python, weights } = runtime()
    const proof = { testedAt: 'fixture', modelVersion: 'pinned', device: 'cuda',
      fingerprint: nativeDiarizationFingerprint(python, root) }
    rmSync(weights)
    expect(readyNativeDiarization({ diarizationValidation: { [model]: proof } }, python, root)).toBe(false)
  })
})

describe('native diarization actual HTTP handler boundary', () => {
  it.each([false, true])('advertises only readiness-backed native capability: %s', async ready => {
    const { call } = routeFixture(ready)
    const res = await call('/v1/capabilities')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.models.includes(model)).toBe(ready)
    expect(body.stages.includes('diarization')).toBe(ready)
    expect(body.models).not.toContain('pyannote/speaker-diarization-3.1')
  })
  it.each([false, true])('gates native job admission on matching readiness: %s', async ready => {
    const { call, calls } = routeFixture(ready)
    const res = await call('/v1/jobs', { method: 'POST', body: { stage: 'diarization', model } })
    expect(res.statusCode).toBe(ready ? 200 : 503)
    expect(calls.jobs.length).toBe(ready ? 1 : 0)
  })
  it('rejects native model for a mismatched stage', async () => {
    const { call, calls } = routeFixture(true)
    expect((await call('/v1/jobs', { method: 'POST', body: { stage: 'transcription', model } })).statusCode).toBe(400)
    expect(calls.jobs).toEqual([])
  })
  it('requires TLS and pairing for preparation', async () => {
    const { call, calls } = routeFixture()
    for (const [options, status] of [[{ authenticated: false }, 401], [{ encrypted: false }, 426]]) {
      expect((await call('/runtime/prepare-diarization', { method: 'POST', body: { model }, ...options })).statusCode).toBe(status)
    }
    expect(calls.preparations).toEqual([])
  })
  it('rejects ASR model on diarization preparation and native diarizer on ASR preparation', async () => {
    const { call, calls } = routeFixture()
    for (const [url, value] of [['/runtime/prepare-diarization', 'microsoft/VibeVoice-ASR'], ['/runtime/prepare-asr', model]]) {
      expect((await call(url, { method: 'POST', body: { model: value } })).statusCode).toBe(400)
    }
    expect(calls.preparations).toEqual([])
  })
  it('reserves maintenance before acknowledgement and starts preparation exactly once', async () => {
    const { call, calls, deps } = routeFixture()
    await deps.state.apply('start')
    expect((await call('/runtime/prepare-diarization', { method: 'POST', body: { model } })).statusCode).toBe(202)
    expect(deps.state.canAdmit()).toBe(false)
    expect((await call('/runtime/prepare-diarization', { method: 'POST', body: { model } })).statusCode).toBe(409)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(calls.preparations).toEqual([model])
  })
})
