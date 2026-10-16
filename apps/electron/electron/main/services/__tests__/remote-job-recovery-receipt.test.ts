// @vitest-environment node
import { createHash } from 'crypto'
import { expect, it, vi } from 'vitest'

vi.mock('../config', () => ({ getConfig: vi.fn() }))
vi.mock('../database', () => ({
  createProcessingRun: vi.fn(), completeProcessingRun: vi.fn(), failProcessingRun: vi.fn(),
  getTranscriptByRecordingId: vi.fn(), getDatabase: vi.fn(), queryOne: vi.fn(), queryAll: vi.fn(), run: vi.fn()
}))

import { getCompletedRemoteJob, validateCompletedRemoteJob, type CompletedRemoteJob } from '../remote-job-recovery'

const result = {
  model: 'Qwen/Qwen3-ASR-1.7B', modelVersion: 'fixture-version', language: 'en', text: 'fixture only',
  segments: [{ start: 0, end: 1, text: 'fixture only', speaker: 'Speaker 1' }]
}
const expected = {
  jobId: '87af7ec9-5f5f-4308-8ded-39481f442611', remoteRecordingId: 'remote-recording-receipt',
  audioHash: 'a'.repeat(64), bytes: 2048, model: 'Qwen/Qwen3-ASR-1.7B', language: 'en'
}
const job: CompletedRemoteJob = {
  ...expected, id: expected.jobId, recordingId: expected.remoteRecordingId, status: 'completed',
  stage: 'transcription', channelMode: 'mixed', channelMap: [], result,
  resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex')
}

it('observes one exact existing job using authenticated GET only', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(job), {
    status: 200, headers: { 'content-type': 'application/json' }
  })) as unknown as typeof fetch
  await getCompletedRemoteJob('https://model-host.example', 'fixture-token', expected.jobId, fetchFn)
  expect(fetchFn).toHaveBeenCalledTimes(1)
  const [url, init] = vi.mocked(fetchFn).mock.calls[0]
  expect(url).toBe(`https://model-host.example/v1/jobs/${expected.jobId}`)
  expect(init?.method).toBe('GET')
  expect(init?.redirect).toBe('error')
  expect((init?.headers as Record<string, string>).authorization).toBe('Bearer fixture-token')
})

it('rejects a completed receipt whose job or audio request differs', () => {
  expect(validateCompletedRemoteJob(job, expected)).toEqual(result)
  const mismatches: CompletedRemoteJob[] = [
    { ...job, id: 'different-job' },
    { ...job, recordingId: 'different-remote-recording' },
    { ...job, audioHash: 'b'.repeat(64) },
    { ...job, bytes: job.bytes + 1 },
    { ...job, model: 'different-model' },
    { ...job, stage: 'vad' },
    { ...job, language: 'es' },
    { ...job, channelMode: 'separate', activeChannels: [1] }
  ]
  for (const changed of mismatches) {
    expect(() => validateCompletedRemoteJob(changed, expected)).toThrow()
  }
})
