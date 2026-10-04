// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askDecision, createDecisionEngines, decisionChain, decisionPrompt, parseDecisionReply, type DecisionEngine } from '../decision-engines'
import { setCallSink, type CallRecord } from '../call-store'
import { ModelHostDecisionError, resetModelHostHealthCache } from '../../model-host-client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const runtime = vi.hoisted(() => ({ config: { transcription: {} as Record<string, string> }, chat: vi.fn(), canServe: vi.fn().mockResolvedValue(false) }))
vi.mock('../../config', () => ({ getConfig: () => runtime.config }))
vi.mock('../../brains', () => ({
  getBrainRouter: () => ({ canServe: runtime.canServe }),
  getBrainRegistry: () => ({ get: () => ({ chat: runtime.chat }) })
}))

const questions = {
  kind: { type: 'choice' as const, instructions: 'Kind?', criteria: { meeting: 'Meeting', media: 'Media', noise: 'Noise' } },
  useful: { type: 'noul' as const, instructions: 'Useful?' },
  stars: { type: 'score' as const, instructions: 'Stars?', criteria: ['bad', 'ok', 'good'] }
}
const reply = '{"kind":{"choice":"media","confidence":0.8},"useful":{"noul":0.7},"stars":{"score":1.5}}'
const response = { model: 'test', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }
function engines(): DecisionEngine[] {
  return ['clef-flash', 'clef', 'jev', 'haiku', 'gemini-flash'].map((id, i) => ({
    id: id as DecisionEngine['id'], descriptor: { label: id, costPerCallUsd: [0, 0, null, 0.0075, 0.002][i], dataLeavesMachine: i < 2 ? 'lan' : 'cloud' },
    isAvailable: vi.fn().mockResolvedValue(true), ask: vi.fn().mockResolvedValue(response)
  }))
}
afterEach(() => { setCallSink(null); vi.useRealTimers() })
describe('decision presets', () => {
  it.each([
    ['zero-cost', ['clef-flash', 'clef', 'gemini-flash', 'haiku', 'jev']],
    ['cheapest', ['clef-flash', 'clef', 'gemini-flash', 'haiku', 'jev']],
    ['most-accurate', ['clef', 'jev', 'gemini-flash', 'clef-flash', 'haiku']],
    ['fastest', ['clef-flash', 'clef', 'jev', 'haiku', 'gemini-flash']]
  ] as const)('orders %s', (preset, expected) => {
    expect(decisionChain(preset, engines(), {})).toEqual(expected)
  })
  it('uses median latency and puts unmeasured engines last in descriptor order', () => {
    expect(decisionChain('fastest', engines(), { clef: 50, haiku: 20 })).toEqual(['haiku', 'clef', 'clef-flash', 'jev', 'gemini-flash'])
  })
  it('override wins', async () => {
    const list = engines()
    const result = await askDecision('evaluate', 'state', questions, { engines: list, config: { preset: 'zero-cost', overrides: { evaluate: 'jev' } } })
    expect(result.engine).toBe('jev')
    expect(list[2].ask).toHaveBeenCalledWith('state', questions)
    expect(list[0].ask).not.toHaveBeenCalled()
  })
  it('skips unavailable engines and records a failed 503 attempt then the answer', async () => {
    const list = engines()
    vi.mocked(list[0].ask).mockRejectedValue(new ModelHostDecisionError('Downloading', 503))
    vi.mocked(list[1].isAvailable).mockResolvedValue(false)
    const rows: CallRecord[] = []
    setCallSink((_id, row) => rows.push(row))
    expect((await askDecision('evaluate', 'state', questions, { engines: list, recordingId: 'rec' })).engine).toBe('gemini-flash')
    expect(list[1].ask).not.toHaveBeenCalled()
    expect(rows.map(r => [r.route, r.status])).toEqual([['decision:clef-flash', 'failed'], ['decision:clef', 'failed'], ['decision:gemini-flash', 'completed']])
    expect(rows[1]).toMatchObject({ step: 'evaluate', recordingId: 'rec', errorMessage: 'unavailable: engine is not available' })
    expect(rows[0]).toMatchObject({ step: 'evaluate', recordingId: 'rec', errorMessage: 'ModelHostDecisionError: Downloading' })
    expect(rows.every(r => r.durationMs >= 0)).toBe(true)
  })
  it('reports every reason when nobody answers', async () => {
    const list = engines()
    list.forEach(e => vi.mocked(e.isAvailable).mockResolvedValue(false))
    await expect(askDecision('evaluate', '', questions, { engines: list })).rejects.toThrow(/clef-flash.*clef.*gemini-flash.*haiku.*jev/)
  })
  it('preserves an all-auth failure status for backlog stop logic', async () => {
    const list = engines()
    list.forEach(e => vi.mocked(e.isAvailable).mockResolvedValue(e.id === 'jev'))
    vi.mocked(list[2].ask).mockRejectedValue(Object.assign(new Error('Bad key'), { status: 401 }))
    await expect(askDecision('evaluate', '', questions, { engines: list })).rejects.toMatchObject({ status: 401 })
  })
  it('records every skipped engine, including availability errors', async () => {
    const list = engines()
    list.forEach(e => vi.mocked(e.isAvailable).mockResolvedValue(false))
    vi.mocked(list[1].isAvailable).mockRejectedValue(new Error('health failed'))
    const rows: CallRecord[] = []
    setCallSink((_id, row) => rows.push(row))
    await expect(askDecision('meeting-match', '', questions, { engines: list, recordingId: 'rec' })).rejects.toThrow('health failed')
    expect(rows.map(row => row.route)).toEqual(decisionChain('zero-cost', list, {}).map(id => `decision:${id}`))
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row).toMatchObject({ step: 'meeting-match', recordingId: 'rec', status: 'failed' })
      expect(row.errorMessage).toMatch(/^unavailable: /)
    }
    expect(rows[1].errorMessage).toBe('unavailable: Error: health failed')
    list.forEach(e => expect(e.ask).not.toHaveBeenCalled())
  })
  it.each([60746, 98799])('records the full %i ms Haiku duration on parsing failure', async duration => {
    vi.useFakeTimers()
    const list = engines()
    vi.mocked(list[3].ask).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + duration)
      return parseDecisionReply('invalid JSON', questions, 'haiku')
    })
    const rows: CallRecord[] = []
    setCallSink((_id, row) => rows.push(row))
    await expect(askDecision('meeting-match', '', questions, {
      engines: list, recordingId: 'rec', config: { preset: 'zero-cost', overrides: { 'meeting-match': 'haiku' } }
    })).rejects.toThrow()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ route: 'decision:haiku', status: 'failed', durationMs: duration })
    expect(rows[0].errorMessage).toMatch(/^SyntaxError:/)
  })
})
describe('strict text decision parsing', () => {
  it.each([
    ['{}', 'expected keys [kind, useful, stars], missing [kind, useful, stars], unexpected []'],
    ['{"answers":{"private":"payload"}}', 'expected keys [kind, useful, stars], missing [kind, useful, stars], unexpected [answers]'],
    ['{"kind":{},"useful":{},"other":{}}', 'expected keys [kind, useful, stars], missing [stars], unexpected [other]']
  ])('reports only key structure for %s', (raw, message) => {
    expect(() => parseDecisionReply(raw, questions, 'haiku')).toThrow(message)
  })
  it('bounds all key lists to ten ids and each id to forty characters', () => {
    const expected = Array.from({ length: 12 }, (_, i) => `${i}-${'q'.repeat(50)}`)
    const unexpected = Array.from({ length: 12 }, (_, i) => `${i}-${'x'.repeat(50)}`)
    const qs = Object.fromEntries(expected.map(id => [id, questions.useful]))
    const raw = JSON.stringify(Object.fromEntries(unexpected.map(id => [id, 'private payload'])))
    const list = (ids: string[]) => ids.slice(0, 10).map(id => id.slice(0, 40)).join(', ')
    expect(() => parseDecisionReply(raw, qs, 'haiku')).toThrow(`expected keys [${list(expected)}], missing [${list(expected)}], unexpected [${list(unexpected)}]`)
  })
  it('reports the question and wrong option id', () => {
    expect(() => parseDecisionReply(reply.replace('media', 'none'), questions, 'haiku')).toThrow('Invalid option for kind: none')
  })
  it.each([['null', 'null'], ['[]', 'array'], ['"private payload"', 'string'], ['42', 'number'], ['true', 'boolean']])('reports JSON type for %s without content', (raw, type) => {
    expect(() => parseDecisionReply(raw, questions, 'haiku')).toThrow(`Expected a JSON object, got ${type}`)
  })
  it('reports JSON type for a non-object answer', () => {
    expect(() => parseDecisionReply(reply.replace('{"noul":0.7}', 'null'), questions, 'haiku')).toThrow('Expected a JSON object, got null')
  })
  it('enumerates exact top-level question ids and prohibits wrappers or omissions', () => {
    const prompt = decisionPrompt('evidence', questions)
    expect(prompt).toContain('Use exactly these top-level keys: ["kind","useful","stars"].')
    expect(prompt).toContain('Include one answer for every question, with no missing or extra keys. Do not wrap the object in "answers" or any other key.')
  })
  it('converts all three question types', () => {
    const parsed = parseDecisionReply(reply, questions, 'haiku')
    expect(parsed.answers.kind).toEqual({ type: 'choice', choice: 'media', confidence: 0.8, probabilities: { meeting: 0.09999999999999998, media: 0.8, noise: 0.09999999999999998 } })
    expect(parsed.answers.useful).toEqual({ type: 'noul', noul: 0.7 })
    expect(parsed.answers.stars).toMatchObject({ type: 'score', score: 1.5, probabilities: { '0': 0, '1': 0.5, '2': 0.5 } })
  })
  it.each([reply, '```json\n' + reply + '\n```', '```\n' + reply + '\n```', ' \r\n```json\r\n' + reply + '\r\n``` \n'])('accepts bare JSON or one fence: %s', raw => {
    expect(parseDecisionReply(raw, questions, 'haiku')).toEqual(parseDecisionReply(reply, questions, 'haiku'))
  })
  it.each(['Prose\n```json\n' + reply + '\n```', '```json\n' + reply + '\n```\nProse',
    '```json\n' + reply + '\n```\n```json\n' + reply + '\n```', '```javascript\n' + reply + '\n```'])('rejects prose, multiple fences and other languages: %s', raw => {
    expect(() => parseDecisionReply(raw, questions, 'haiku')).toThrow()
  })
  it.each([reply.replace('media', 'unknown'), '{}', `Sure: ${reply}`, reply.replace('0.8', '1.8'), reply.replace('1.5', '3')])('rejects malformed answers: %s', raw => {
    expect(() => parseDecisionReply(raw, questions, 'haiku')).toThrow()
  })
})

describe('decision adapters', () => {
  it.each([
    ['ready', ['decide'], true],
    ['busy', ['decide'], true],
    ['paused', ['decide'], false],
    ['stopped', ['decide'], false],
    ['ready', ['diarize'], false],
    ['busy', ['diarize'], false],
    ['ready', undefined, false],
    ['no answer', ['decide'], false]
  ])('checks both local engines for host %s with capabilities %j', async (state, capabilities, available) => {
    resetModelHostHealthCache()
    const requests: unknown[] = []
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/health') {
        if (state === 'no answer') res.statusCode = 503
        res.end(JSON.stringify({ state, capabilities }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      res.end(JSON.stringify({ ...response, model: body.model }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    runtime.config.transcription = { modelHostUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, modelHostToken: 'test-pairing-token' } // pragma: allowlist secret
    try {
      const local = (await createDecisionEngines('evaluate')).filter(engine => engine.id === 'clef' || engine.id === 'clef-flash')
      for (const engine of local) {
        expect(await engine.isAvailable()).toBe(available)
        if (available) {
          const out = await askDecision('evaluate', 'state', questions, { engines: local, config: { preset: 'zero-cost', overrides: { evaluate: engine.id } } })
          expect(out.engine).toBe(engine.id)
        }
      }
      expect(requests).toEqual(available ? local.map(engine => ({ model: engine.id, state: 'state', questions })) : [])
    } finally {
      runtime.config.transcription = {}
      resetModelHostHealthCache()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
  it.each(['haiku', 'gemini-flash'] as const)('uses a direct profile for %s without a second ledger row', async id => {
    runtime.canServe.mockResolvedValue(true)
    runtime.chat.mockResolvedValue(reply)
    const list = await createDecisionEngines('evaluate')
    const rows: CallRecord[] = []
    setCallSink((_id, row) => rows.push(row))
    const out = await askDecision('evaluate', 'excerpt', questions, { engines: list, config: { preset: 'zero-cost', overrides: { evaluate: id } } })
    expect(out.response.answers.useful).toEqual({ type: 'noul', noul: 0.7 })
    expect(runtime.chat).toHaveBeenLastCalledWith([{ role: 'user', content: expect.stringContaining(JSON.stringify(questions)) }], expect.objectContaining({ model: id === 'haiku' ? 'haiku' : 'gemini-3.8-flash' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ route: `decision:${id}`, status: 'completed' })
    runtime.canServe.mockResolvedValue(false)
  })
  it('falls back after a real HTTP 503 from the host and sends the same questions to both models', async () => {
    const requests: unknown[] = []
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/health') { res.end(JSON.stringify({ state: 'ready', capabilities: ['decide'] })); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      if (body.model === 'clef-flash') { res.statusCode = 503; res.end(JSON.stringify({ error: 'Downloading' })) }
      else res.end(JSON.stringify({ ...response, model: 'clef' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    runtime.config.transcription = { modelHostUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, modelHostToken: 'test-pairing-token' } // pragma: allowlist secret
    const rows: CallRecord[] = []
    setCallSink((_id, row) => rows.push(row))
    try {
      const out = await askDecision('evaluate', 'state', questions, { engines: await createDecisionEngines('evaluate') })
      expect(out.engine).toBe('clef')
      expect(requests).toEqual([{ model: 'clef-flash', state: 'state', questions }, { model: 'clef', state: 'state', questions }])
      expect(rows.map(row => row.status)).toEqual(['failed', 'completed'])
    } finally {
      runtime.config.transcription = {}
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
