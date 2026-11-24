import { expect, it } from 'vitest'
import { cpuPercent, HostTelemetry } from '../src/telemetry.mjs'
import { createHostServer } from '../src/server.mjs'
import { HostState, READY } from '../src/state.mjs'

it('serves measured output counts over real HTTP without treating missing usage as zero', async () => {
  let now = 0
  const telemetry = new HostTelemetry({ now: () => now, readCpu: () => ({ idle: 1, total: 2 }) })
  const server = createHostServer({ state: new HostState({ initial: READY }), telemetry,
    pairing: { accepts: () => true }, capabilities: () => ({ capabilities: [] }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const first = telemetry.start('transcription', 'measured-model', 'recording-fixture', 'durable-job-fixture')
    now = 2000; telemetry.finish(first, 'completed', 'cuda', { outputTokens: 66 })
    const unknown = telemetry.start('diarization', 'no-token-model')
    now = 12000; telemetry.finish(unknown, 'completed', 'cuda', {})
    const decision = telemetry.start('decision', 'clef')
    now = 13000; telemetry.finish(decision, 'completed', null, { usage: { output_tokens: 0 } })
    const data = await (await fetch(`http://127.0.0.1:${server.address().port}/telemetry`)).json()
    expect(data).toMatchObject({ tokens: 66, tokenMeasuredJobs: 2, tokenMeasuredJobMs: 3000,
      completedJobsWithoutTokenUsage: 1, outputTokensPerSecond: null, outputTokensPerSecondAverage: 22 })
    expect(data.recentJobs.find(job => job.model === 'no-token-model').outputTokens).toBeNull()
    expect(data.recentJobs.find(job => job.model === 'measured-model')).toMatchObject({
      recordingId: 'recording-fixture', hostJobId: 'durable-job-fixture', outputTokens: 66 })
    telemetry.finish(first, 'completed', 'cuda', { outputTokens: 66 })
    expect(telemetry.snapshot().tokens).toBe(66)
  } finally { telemetry.stop(); await new Promise(resolve => server.close(resolve)) }
})

const valid = { idle: 0, total: 10 }
it.each([
  ['before undefined', undefined, { idle: 5, total: 20 }],
  ['before null', null, { idle: 5, total: 20 }],
  ['after undefined', valid, undefined],
  ['after null', valid, null],
  ['both missing', undefined, undefined],
  ['before idle NaN', { idle: NaN, total: 10 }, { idle: 5, total: 20 }],
  ['before total NaN', { idle: 0, total: NaN }, { idle: 5, total: 20 }],
  ['after idle NaN', valid, { idle: NaN, total: 20 }],
  ['after total NaN', valid, { idle: 5, total: NaN }],
  ['after idle undefined', valid, { idle: undefined, total: 20 }],
  ['after total undefined', valid, { idle: 5, total: undefined }],
  ['after total Infinity', valid, { idle: 5, total: Infinity }],
  ['empty objects', {}, {}],
  ['total does not advance', valid, { idle: 5, total: 10 }],
  ['total goes backwards', valid, { idle: 5, total: 4 }],
])('keeps system CPU unknown when %s, with no NaN and no throw', (_name, before, after) => {
  expect(() => cpuPercent(before, after)).not.toThrow()
  expect(cpuPercent(before, after)).toBeNull()
})

it('still measures a real system CPU delta and keeps a genuine 0 and 100', () => {
  expect(cpuPercent({ idle: 0, total: 10 }, { idle: 5, total: 20 })).toBe(50)
  expect(cpuPercent({ idle: 0, total: 10 }, { idle: 10, total: 20 })).toBe(0)
  expect(cpuPercent({ idle: 0, total: 10 }, { idle: 0, total: 20 })).toBe(100)
})

it.each([undefined, null, -1, 0.5, true, '66', Infinity])('keeps invalid or missing usage %s unknown', outputTokens => {
  const telemetry = new HostTelemetry()
  try {
    const id = telemetry.start('transcription', 'fixture')
    telemetry.finish(id, 'completed', null, { outputTokens })
    expect(telemetry.snapshot().tokens).toBeNull()
    expect(telemetry.snapshot().completedJobsWithoutTokenUsage).toBe(1)
  } finally { telemetry.stop() }
})
