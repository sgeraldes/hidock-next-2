import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { DECIDE_MODELS, DecideModels, checkDecisionRequest } from '../src/decide.mjs'

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-decide-worker.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CATALOG = {
  'clef-flash': { repo: 'Cloudflare/clef-flash', revision: 'aaaaaaaaaaaaaaaa', bytes: 1000, quantize: 'none' },
  clef: { repo: 'Cloudflare/clef', revision: 'bbbbbbbbbbbbbbbb', bytes: 1000, quantize: 'nf4' },
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error('timed out waiting')
}

const ask = (model, state = 'the checkout is down') => ({ model, state, questions: { outage: { type: 'noul' } } })

describe('decision models on the host', () => {
  let dir
  let models
  const make = (options = {}) =>
    new DecideModels({
      pythonPath: process.execPath,
      workerPath: fake,
      modelsDir: dir,
      catalog: CATALOG,
      idleMs: 60_000,
      ...options,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hidock-decide-'))
  })

  afterEach(() => {
    models?.stop()
    delete process.env.FAKE_DOWNLOAD_MS
    delete process.env.FAKE_DOWNLOAD_CODE
    rmSync(dir, { recursive: true, force: true })
  })

  it('pins both Clef repositories to a revision and sizes them', () => {
    expect(DECIDE_MODELS['clef-flash']).toMatchObject({ repo: 'Cloudflare/clef-flash', quantize: 'none' })
    expect(DECIDE_MODELS.clef).toMatchObject({ repo: 'Cloudflare/clef', quantize: 'nf4' })
    for (const model of Object.values(DECIDE_MODELS)) expect(model.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('downloads a model the first time it is asked for, and says so meanwhile', async () => {
    process.env.FAKE_DOWNLOAD_MS = '300'
    models = make()
    expect(models.report()['clef-flash'].state).toBe('absent')

    const first = await models.decide(ask('clef-flash')).catch((e) => e)
    expect(first.status).toBe(503)
    expect(first.extra.decide['clef-flash']).toMatchObject({ state: 'downloading', totalBytes: 1000 })
    expect(first.message).toMatch(/downloading/i)
    // Half the weights are there before the fake download finishes.
    await until(() => models.report()['clef-flash'].bytes === 500)

    await until(() => models.report()['clef-flash'].state === 'on-disk')
    expect(existsSync(join(models.modelDir('clef-flash'), '.complete'))).toBe(true)

    const answer = await models.decide(ask('clef-flash'))
    expect(answer.model).toBe('clef-flash')
    expect(answer.loaded).toMatchObject({ path: models.modelDir('clef-flash'), quantize: 'none', device: 'cuda' })
    expect(models.report()['clef-flash'].state).toBe('loaded')
  })

  it('downloads one model at a time', async () => {
    process.env.FAKE_DOWNLOAD_MS = '300'
    models = make()
    await models.decide(ask('clef-flash')).catch(() => {})
    const other = await models.decide(ask('clef')).catch((e) => e)
    expect(other.status).toBe(503)
    expect(other.message).toMatch(/clef-flash/)
    expect(models.report().clef.state).toBe('absent')
  })

  it('reports a download that failed and tries again on the next request', async () => {
    process.env.FAKE_DOWNLOAD_CODE = '1'
    models = make()
    await models.decide(ask('clef-flash')).catch(() => {})
    await until(() => models.report()['clef-flash'].state === 'failed')
    expect(models.report()['clef-flash'].error).toMatch(/exited with code 1/)

    delete process.env.FAKE_DOWNLOAD_CODE
    const again = await models.decide(ask('clef-flash')).catch((e) => e)
    expect(again.status).toBe(503)
    await until(() => models.report()['clef-flash'].state === 'on-disk')
  })

  async function onDisk(m, name) {
    await m.decide(ask(name)).catch(() => {})
    await until(() => m.report()[name].state === 'on-disk')
  }

  it('loads once and keeps the model for the next decisions; the other model replaces it', async () => {
    models = make()
    await onDisk(models, 'clef-flash')
    await onDisk(models, 'clef')

    const a = await models.decide(ask('clef-flash'))
    const b = await models.decide(ask('clef-flash'))
    expect(a.loads).toBe(1)
    expect(b.loads).toBe(1)
    expect(b.pid).toBe(a.pid)

    const c = await models.decide(ask('clef'))
    expect(c.loaded).toMatchObject({ path: models.modelDir('clef'), quantize: 'nf4' })
    expect(c.loads).toBe(2)
    expect(models.report()['clef-flash'].state).toBe('on-disk')
    expect(models.report().clef.state).toBe('loaded')
  })

  it('answers requests that arrive together, one after the other', async () => {
    models = make()
    await onDisk(models, 'clef-flash')
    const answers = await Promise.all([1, 2, 3].map(() => models.decide(ask('clef-flash'))))
    expect(answers.map((a) => a.loads)).toEqual([1, 1, 1])
  })

  it('lets the model go after a while without requests, which frees the GPU', async () => {
    models = make({ idleMs: 150 })
    await onDisk(models, 'clef-flash')
    const first = await models.decide(ask('clef-flash'))
    expect(models.report()['clef-flash'].state).toBe('loaded')
    await until(() => models.report()['clef-flash'].state === 'on-disk')
    const second = await models.decide(ask('clef-flash'))
    expect(second.pid).not.toBe(first.pid)
  })

  it('hands back a request the model could not encode as the caller’s mistake', async () => {
    models = make()
    await onDisk(models, 'clef-flash')
    const error = await models.decide(ask('clef-flash', 'invalid')).catch((e) => e)
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/criteria/)
  })

  it('starts a fresh worker after one dies mid-request', async () => {
    models = make()
    await onDisk(models, 'clef-flash')
    const before = await models.decide(ask('clef-flash'))
    const error = await models.decide(ask('clef-flash', 'die')).catch((e) => e)
    expect(error.status).toBe(500)
    expect(error.message).toMatch(/stopped/)
    const after = await models.decide(ask('clef-flash'))
    expect(after.pid).not.toBe(before.pid)
  })

  it('gives up on a decision that takes too long and ends the stuck worker', async () => {
    models = make({ decideTimeoutMs: 200 })
    await onDisk(models, 'clef-flash')
    const before = await models.decide(ask('clef-flash'))
    const error = await models.decide(ask('clef-flash', 'hang')).catch((e) => e)
    expect(error.status).toBe(504)
    const after = await models.decide(ask('clef-flash'))
    expect(after.pid).not.toBe(before.pid)
  })

  it('stops everything when the host steps aside', async () => {
    process.env.FAKE_DOWNLOAD_MS = '5000'
    models = make()
    await models.decide(ask('clef')).catch(() => {})
    expect(models.report().clef.state).toBe('downloading')
    models.stop()
    expect(models.report().clef.state).toBe('absent')
  })
})

describe('what a decision request must have', () => {
  const good = { model: 'clef-flash', state: { a: 1 }, questions: { q: { type: 'choice', criteria: { x: 'X', y: 'Y' } } } }

  it('accepts a SystemOne body for a model the host knows', () => {
    expect(checkDecisionRequest(good)).toBe('')
    expect(checkDecisionRequest({ ...good, model: 'clef', state: '' })).toBe('')
  })

  it('names what is wrong otherwise', () => {
    expect(checkDecisionRequest(null)).toMatch(/JSON object/)
    expect(checkDecisionRequest({ ...good, model: 'jev-latest' })).toMatch(/clef-flash or clef/)
    const { state, ...stateless } = good
    expect(checkDecisionRequest(stateless)).toMatch(/state/)
    expect(checkDecisionRequest({ ...good, questions: {} })).toMatch(/question/)
    expect(checkDecisionRequest({ ...good, questions: { q: { type: 'maybe' } } })).toMatch(/q: type/)
    expect(checkDecisionRequest({ ...good, questions: { q: { type: 'score', criteria: [] } } })).toMatch(/q: criteria/)
    expect(checkDecisionRequest({ ...good, images: ['x'] })).toMatch(/images/)
    expect(checkDecisionRequest({ ...good, videos: ['x'] })).toMatch(/videos/)
  })
})
