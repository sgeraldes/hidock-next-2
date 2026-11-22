/**
 * Retry policy of the persisted transcription queue, observed through the real processor.
 *
 * The code under test is transcription.ts: processQueueManually and the startTranscriptionProcessor
 * seam run unmodified, together with the real quality-rules module (maxRetries) and the real
 * recording-eligibility and feature-gate modules. Only the edges are replaced:
 *
 *   - ../database is an in-memory queue whose updateQueueItem copies the SQL semantics of
 *     database.ts updateQueueItem: 'processing' adds one to attempts, 'failed' stamps completed_at in
 *     SQLite's UTC format without a Z, 'pending' adds one to retry_count. It is NOT the real SQLite
 *     schema. If database.ts changes those rules, this fake does not follow.
 *   - Date is faked so backoff windows are exact. No sleeps.
 *   - fetch is a spy that must never be called. No audio, no model, no network, no app, no USB.
 *
 * A re-queued row goes on to fail in transcribeRecording because the fixture has no recording row
 * ("Recording not found", itself a permanent marker). That makes "the retry reached the processor"
 * observable (a 'processing' update) without any provider call.
 *
 * These are processor fixtures. They are not queue or runtime acceptance and prove nothing about a
 * real host, a real provider, or what a provider charges.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyQualityRules, qualityRules } from '../quality-rules'

const db = vi.hoisted(() => {
  type Row = {
    id: string; recording_id: string; status: string; provider: string; owner_requested: boolean
    retry_count: number; attempts: number; error_message: string | null; completed_at: string | null
    created_at: string; progress: number; date_recorded: string | null; filename?: string
  }
  const rows = new Map<string, Row>()
  const calls: Array<{ id: string; status: string }> = []
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  return {
    rows, calls, stamp,
    getQueueItems: (status?: string) => [...rows.values()].filter(row => !status || row.status === status).map(row => ({ ...row })),
    updateQueueItem: (id: string, status: string, error?: string) => {
      calls.push({ id, status })
      const row = rows.get(id)
      if (!row) return
      if (status === 'processing') Object.assign(row, { status, completed_at: null, error_message: null, attempts: row.attempts + 1 })
      else if (status === 'completed' || status === 'failed') Object.assign(row, { status, completed_at: stamp(Date.now()), error_message: error ?? null })
      else if (status === 'pending') Object.assign(row, { status, retry_count: row.retry_count + 1, progress: 0 })
      else row.status = status
    }
  }
})
const mocks = vi.hoisted(() => ({
  addToQueue: vi.fn(),
  createProcessingRun: vi.fn(({ stage }: { stage: string }) => ({ id: `run-${stage}` })),
  fetch: vi.fn()
}))
const cfg = vi.hoisted(() => ({ transcription: { provider: 'remote-worker', autoTranscribe: true, geminiApiKey: 'unused' } as Record<string, unknown> }))

vi.mock('../database', () => ({
  addToQueue: mocks.addToQueue,
  getOwnedPipelineRecordings: vi.fn(() => []),
  getRecordingById: vi.fn(() => undefined),
  resolveRecordingId: vi.fn(() => undefined),
  updateRecordingTranscriptionStatus: vi.fn(),
  updateRecordingStatus: vi.fn(),
  insertTranscript: vi.fn(),
  getQueueItems: (status?: string) => db.getQueueItems(status),
  updateQueueItem: (id: string, status: string, error?: string) => db.updateQueueItem(id, status, error),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(),
  findCandidateMeetingsForRecording: vi.fn(() => []),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: vi.fn(),
  cancelPendingTranscriptions: vi.fn(() => 0),
  run: vi.fn(),
  runInTransaction: vi.fn((fn: () => void) => fn()),
  saveDatabase: vi.fn(),
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  acquireTranscriptionLock: vi.fn(() => true),
  releaseTranscriptionLock: vi.fn(),
  clearStaleTranscriptionLock: vi.fn(),
  resetStuckTranscriptions: vi.fn(),
  getActiveProcessingRunsForRecording: vi.fn(() => []),
  enrichRecordingScheduleMetadata: vi.fn(),
  createProcessingRun: mocks.createProcessingRun,
  completeProcessingRun: vi.fn(),
  failProcessingRun: vi.fn()
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))
vi.mock('../config', () => ({ getConfig: vi.fn(() => cfg) }))
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class {} }))
vi.mock('@hidock/transcription', () => ({ GeminiEngine: class {} }))
vi.mock('../vector-store', () => ({ getVectorStore: vi.fn(() => null) }))
vi.mock('../knowledge-capture-backfill', () => ({
  ensureKnowledgeCaptureForRecording: vi.fn(),
  ensureNoSpeechKnowledgeCapture: vi.fn()
}))

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0)
const SECOND = 1000
const DAY = 86_400_000
// Error texts that match none of the permanent markers. Illustrative: they are not claimed to be what any
// particular engine or host emits.
const TRANSIENT = 'fetch failed: read ECONNRESET'

type SeedRow = { id: string } & Partial<ReturnType<typeof db.getQueueItems>[number]>
function seed(over: SeedRow): void {
  db.rows.set(over.id, {
    recording_id: `rec-${over.id}`, status: 'failed', provider: 'remote-worker', owner_requested: true,
    retry_count: 0, attempts: 1, error_message: TRANSIENT, completed_at: db.stamp(T0), created_at: db.stamp(T0 - 3_600_000),
    progress: 0, date_recorded: null, ...over
  } as never)
}
const advance = (ms: number) => vi.setSystemTime(T0 + ms)
const statuses = (id: string) => db.calls.filter(call => call.id === id).map(call => call.status)
const settle = async () => { for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => {
  db.rows.clear()
  db.calls.length = 0
  mocks.addToQueue.mockReset()
  mocks.createProcessingRun.mockClear()
  mocks.fetch.mockReset()
  vi.stubGlobal('fetch', mocks.fetch)
  vi.useFakeTimers({ toFake: ['Date'] })
  advance(0)
  cfg.transcription = { provider: 'remote-worker', autoTranscribe: true, geminiApiKey: 'unused' }
  applyQualityRules({})
})
afterEach(async () => {
  const { stopTranscriptionProcessor } = await import('../transcription')
  stopTranscriptionProcessor()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  applyQualityRules({})
})

describe('autoTranscribe=false and the persisted queue', () => {
  it('still processes a pending row the owner queued by hand', async () => {
    cfg.transcription.autoTranscribe = false
    seed({ id: 'manual', status: 'pending', error_message: null, completed_at: null })
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(statuses('manual')).toContain('processing')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('stops only discovery: the auto-queue funnel adds nothing while the owner queue is untouched', async () => {
    cfg.transcription.autoTranscribe = false
    const { queueTranscriptionIfEnabled } = await import('../transcription')
    expect(queueTranscriptionIfEnabled('rec-discovered')).toBe(false)
    expect(mocks.addToQueue).not.toHaveBeenCalled()
  })

  it('does NOT stop a failed owner row from being re-queued by the retry loop (the boot rerun seen in the trial)', async () => {
    cfg.transcription.autoTranscribe = false
    seed({ id: 'failed-manual', owner_requested: true })
    advance(31 * SECOND)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(statuses('failed-manual').slice(0, 2)).toEqual(['pending', 'processing'])
    expect(db.rows.get('failed-manual')?.retry_count).toBe(1)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does the same at start of the processor, which is where the rerun happened', async () => {
    cfg.transcription.autoTranscribe = false
    seed({ id: 'failed-at-boot', owner_requested: true })
    advance(31 * SECOND)
    const { startTranscriptionProcessor, stopTranscriptionProcessor } = await import('../transcription')
    vi.useRealTimers()
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 31 * SECOND)
    try {
      startTranscriptionProcessor()
      await settle()
      expect(statuses('failed-at-boot').slice(0, 2)).toEqual(['pending', 'processing'])
    } finally {
      stopTranscriptionProcessor()
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe('quality.maxRetries = 0', () => {
  beforeEach(() => applyQualityRules({ quality: { maxRetries: 0 } }))

  it('is read from the real rules module', () => {
    expect(qualityRules().maxRetries).toBe(0)
  })

  it.each([60 * SECOND, DAY, 30 * DAY])('never re-queues a failed row after %d ms', async elapsed => {
    seed({ id: 'transient-failure', error_message: TRANSIENT })
    advance(elapsed)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(db.calls).toEqual([])
    expect(db.rows.get('transient-failure')).toMatchObject({ status: 'failed', retry_count: 0, attempts: 1 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('still runs work the owner queues by hand', async () => {
    seed({ id: 'manual', status: 'pending', error_message: null, completed_at: null })
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(statuses('manual')).toContain('processing')
  })
})

describe('configured retries with an eligible failure', () => {
  it('defaults to three', () => {
    expect(qualityRules().maxRetries).toBe(3)
  })

  it.each([
    { retryCount: 0, backoffSeconds: 30 },
    { retryCount: 1, backoffSeconds: 60 },
    { retryCount: 2, backoffSeconds: 120 }
  ])('waits $backoffSeconds s before re-queue number $retryCount + 1', async ({ retryCount, backoffSeconds }) => {
    seed({ id: 'transient-failure', retry_count: retryCount, attempts: retryCount + 1 })
    const { processQueueManually } = await import('../transcription')

    advance((backoffSeconds - 1) * SECOND)
    await processQueueManually()
    expect(db.calls).toEqual([])

    advance(backoffSeconds * SECOND)
    await processQueueManually()
    expect(statuses('transient-failure').slice(0, 2)).toEqual(['pending', 'processing'])
    expect(db.rows.get('transient-failure')).toMatchObject({ retry_count: retryCount + 1, attempts: retryCount + 2 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('stops after the configured number of re-queues however long it waits', async () => {
    seed({ id: 'exhausted', retry_count: 3, attempts: 4 })
    advance(30 * DAY)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(db.calls).toEqual([])
    expect(db.rows.get('exhausted')?.status).toBe('failed')
  })

  it.each([
    { max: 1, retryCount: 0, requeued: true },
    { max: 1, retryCount: 1, requeued: false },
    { max: 2, retryCount: 1, requeued: true },
    { max: 2, retryCount: 2, requeued: false }
  ])('with maxRetries $max a row at retry_count $retryCount is re-queued: $requeued', async ({ max, retryCount, requeued }) => {
    applyQualityRules({ quality: { maxRetries: max } })
    seed({ id: 'bounded', retry_count: retryCount, attempts: retryCount + 1 })
    advance(DAY)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(statuses('bounded').includes('pending')).toBe(requeued)
  })

  it('caps the backoff at 120 s even when many retries are configured', async () => {
    applyQualityRules({ quality: { maxRetries: 10 } })
    seed({ id: 'late-retry', retry_count: 6, attempts: 7 })
    const { processQueueManually } = await import('../transcription')
    advance(119 * SECOND)
    await processQueueManually()
    expect(db.calls).toEqual([])
    advance(120 * SECOND)
    await processQueueManually()
    expect(statuses('late-retry').slice(0, 2)).toEqual(['pending', 'processing'])
  })

  it('means additional tries, so maxRetries N allows N + 1 executions in total', async () => {
    // The row has run once and failed (attempts 1). Re-queues are allowed while retry_count < maxRetries.
    applyQualityRules({ quality: { maxRetries: 2 } })
    seed({ id: 'count-me', retry_count: 0, attempts: 1 })
    const { processQueueManually } = await import('../transcription')
    let elapsed = 0
    const executions: number[] = [1]
    for (const retryCount of [0, 1, 2]) {
      db.rows.get('count-me')!.status = 'failed'
      db.rows.get('count-me')!.error_message = TRANSIENT
      db.rows.get('count-me')!.completed_at = db.stamp(T0 + elapsed)
      elapsed += DAY
      advance(elapsed)
      const before = db.rows.get('count-me')!.attempts
      await processQueueManually()
      executions.push(db.rows.get('count-me')!.attempts - before)
      if (retryCount === 2) break
    }
    // Two re-queues ran (one more execution each); the third pass found retry_count 2 >= maxRetries 2 and did nothing.
    expect(executions).toEqual([1, 1, 1, 0])
    expect(db.rows.get('count-me')!.retry_count).toBe(2)
    expect(db.rows.get('count-me')!.attempts).toBe(3)
  })
})

describe('failures that must not be retried automatically', () => {
  // Texts taken from the throw sites in remote-worker-jobs.ts and transcription.ts.
  it.each([
    'Remote worker HTTP 503; retained job identity for resume',
    'Remote worker timeout; retained job identity for resume',
    'Remote worker failed; automatic retry disabled',
    'Remote cancellation not confirmed; retained job identity for reconciliation; automatic retry disabled',
    'Local model timeout; automatic retry disabled',
    'Cloud transcription failed; automatic retry disabled',
    'Interrupted: coordinator ended before stage completion; automatic retry disabled',
    'Recording file not found: C:\\fixture\\missing.wav'
  ])('does not re-queue after: %s', async message => {
    seed({ id: 'permanent', error_message: message })
    advance(30 * DAY)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(db.calls).toEqual([])
    expect(db.rows.get('permanent')).toMatchObject({ status: 'failed', retry_count: 0, error_message: message })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.createProcessingRun).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline' }))
  })

  it('treats any message containing "timed out" as permanent, including an ordinary network timeout', async () => {
    seed({ id: 'network-timeout', error_message: 'connect ETIMEDOUT: request timed out' })
    advance(30 * DAY)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(db.calls).toEqual([])
  })

  it('does not let one permanent failure block another row that is eligible', async () => {
    seed({ id: 'permanent', error_message: 'Remote worker failed; automatic retry disabled', recording_id: 'rec-a' })
    seed({ id: 'transient', error_message: TRANSIENT, recording_id: 'rec-b' })
    advance(DAY)
    const { processQueueManually } = await import('../transcription')
    await processQueueManually()
    expect(statuses('permanent')).toEqual([])
    expect(statuses('transient').slice(0, 2)).toEqual(['pending', 'processing'])
  })
})
