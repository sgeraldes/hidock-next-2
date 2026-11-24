// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ db: null as any, activeCounts: new Map<string, number>() }))
vi.mock('../database', () => ({
  run: (sql: string, values: any[] = []) => state.db.prepare(sql).run(...values),
  queryOne: (sql: string, values: any[] = []) => state.db.prepare(sql).get(...values),
  queryAll: (sql: string, values: any[] = []) => state.db.prepare(sql).all(...values),
  createProcessingRun: () => ({ id: 'isolated-run' }), completeProcessingRun: vi.fn(), failProcessingRun: vi.fn()
}))
vi.mock('../model-host-transport', () => ({ modelHostFetch: (url: string, options: any) => fetch(url, options) }))
vi.mock('../transcription-activity', () => ({
  addActiveTranscription: vi.fn((recordingId: string) => {
    state.activeCounts.set(recordingId, (state.activeCounts.get(recordingId) ?? 0) + 1)
  }),
  removeActiveTranscription: vi.fn((recordingId: string) => {
    const remaining = (state.activeCounts.get(recordingId) ?? 0) - 1
    if (remaining > 0) state.activeCounts.set(recordingId, remaining)
    else state.activeCounts.delete(recordingId)
  }),
  getActiveTranscriptionCount: vi.fn((recordingId: string) => state.activeCounts.get(recordingId) ?? 0)
}))
import { recoverRemoteJobs, stopRemoteRecovery } from '../remote-job-recovery'
import { remoteJobCheckpoints } from '../remote-job-checkpoints'
import { readStageCheckpoint } from '../stage-checkpoints'
import { providerDiarizationOutcome } from '../remote-diarization-quality'

it('persists recovered degraded MOSS quality through real HTTP and reopened SQLite to provider outcome', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'hidock-recovery-quality-'))
  const file = join(folder, 'isolated.sqlite')
  state.db = new DatabaseSync(file)
  state.db.exec('CREATE TABLE recordings (id TEXT PRIMARY KEY); INSERT INTO recordings VALUES (\'recording\')')
  const model = 'OpenMOSS-Team/MOSS-Transcribe-Diarize'
  const result = { model, modelVersion: 'saved-fixture-version', text: 'Fixture only.',
    segments: [{ start: 0, end: 1, text: 'Fixture only.', speaker: 'Speaker unresolved',
      speakerAssignment: 'unresolved-no-model-speaker-label', speakerAttribution: 'unresolved', speakerConfidence: 0,
      diarizationStatus: 'unavailable' }],
    diarizationStatus: 'degraded', diarizationUnavailableSegments: 1, speakerEmbeddingsAvailable: false }
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.method || '')
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401); res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'saved-job', audioHash: 'audio-hash', status: 'completed', result,
      resultHash: createHash('sha256').update(JSON.stringify(result)).digest('hex') }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    remoteJobCheckpoints('recording').save('request-key', { key: 'prior-intent', id: 'saved-job', request: {
      base, audioHash: 'audio-hash', model, stage: 'transcription', language: 'es'
    } })
    // Exercise discovery from durable storage rather than an in-memory fixture list.
    state.db.close()
    state.db = new DatabaseSync(file)
    const continued = vi.fn()
    await recoverRemoteJobs({ modelHostUrl: base, modelHostToken: 'fixture-only' }, continued)
    await vi.waitFor(() => expect(continued).toHaveBeenCalledWith('recording', model, 'transcription'), { timeout: 3000 })
    state.db.close()
    state.db = new DatabaseSync(file)
    const checkpoint = readStageCheckpoint<any>('recording', 'transcription', 'audio-hash')
    expect(checkpoint.fullText).toBe(result.text)
    expect(JSON.parse(checkpoint.speakers)).toEqual(result.segments)
    expect(checkpoint.remoteQuality).toMatchObject({ diarizationStatus: 'degraded',
      diarizationUnavailableSegments: 1, speakerEmbeddingsAvailable: false, hostJobId: 'saved-job' })
    const outcome = providerDiarizationOutcome({ status: 'high', reasons: [] }, checkpoint.remoteQuality)
    expect(outcome.status).toBe('degraded')
    expect(outcome.qualityStatus).toBe('degraded')
    expect(outcome.quality.reasons).toContain('Provider did not supply speaker labels for all segments; transcript retained without trusted speaker identity')
    expect(remoteJobCheckpoints('recording').load('request-key')?.observedStatus).toBe('completed')
    expect(requests).toEqual(['GET'])
  } finally {
    stopRemoteRecovery()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    state.db.close()
    state.activeCounts.clear()
    rmSync(folder, { recursive: true, force: true })
  }
})
