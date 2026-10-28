/**
 * RE-2 (Codex adversarial re-review round 2) — reanalyzeFailedTranscripts must
 * NOT re-upload trashed / personal / value-excluded transcripts to the provider
 * on boot. Real better-sqlite3 engine + real database; only the provider
 * (@google/generative-ai) and leaf side-effects are mocked. Proves the
 * query-level exclusion (soft-deleted + personal), the value-exclusion
 * pre-filter, and the post-await eligibility re-check (in-flight delete).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

const mockConfig: any = {
  transcription: {
    provider: 'gemini',
    geminiApiKey: 'test-api-key', // pragma: allowlist secret
    geminiModel: 'gemini-2.0-flash',
    // Keep the value-classification path OUT of this test — it is covered
    // elsewhere; here we focus on the exclusion gates.
    valueClassificationEnabled: false
  }
}
vi.mock('../config', () => ({ getConfig: vi.fn(() => mockConfig) }))

const mockGenerateContent = vi.fn()
vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent: (...args: any[]) => mockGenerateContent(...args) }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

vi.mock('@hidock/transcription', () => {
  // eslint-disable-next-line require-yield
  const gen = async function* () {
    throw new Error('unused in this suite')
  }
  function GeminiEngine() {
    return { isAvailable: async () => true, isStreaming: false, isLocal: false, transcribe: gen }
  }
  return { GeminiEngine }
})

vi.mock('../brains', () => ({
  getBrainRegistry: () => ({ get: () => ({ generate: vi.fn() }) }),
  resolveGeminiApiKey: () => 'test-api-key' // pragma: allowlist secret
}))

vi.mock('../vector-store', () => ({ getVectorStore: vi.fn(() => null) }))

const exportMeetingWikiMock = vi.hoisted(() => vi.fn(() => null))
vi.mock('../meeting-wiki', () => ({ exportMeetingWiki: exportMeetingWikiMock }))

let _dbCounter = 0
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => join(tmpdir(), `hidock-reanalyze-excl-${Date.now()}-${++_dbCounter}.sqlite`))
}))

import {
  initializeDatabase,
  run as dbRun,
  queryOne as dbQueryOne,
  setRecordingPersonal,
  deleteRecordingCascade
} from '../database'
import { reanalyzeFailedTranscripts } from '../transcription'

function geminiJsonResponse(json: Record<string, unknown>) {
  return { response: { text: () => JSON.stringify(json) } }
}
const HEALED = {
  summary: 'Healed summary.',
  action_items: [],
  topics: [],
  key_points: [],
  title_suggestion: 'Healed Title',
  question_suggestions: [],
  language: 'en'
}

function seedRecording(id: string, opts: { personal?: number } = {}): void {
  dbRun(
    `INSERT INTO recordings (id, filename, date_recorded, personal) VALUES (?, ?, ?, ?)`,
    [id, `${id}.hda`, '2026-06-01', opts.personal ?? 0]
  )
}
// A transcript with a NULL summary — selected by the reanalyze backfill query.
function seedFailedTranscript(id: string, recordingId: string): void {
  dbRun(
    `INSERT INTO transcripts (id, recording_id, full_text, summary, title_suggestion)
     VALUES (?, ?, ?, NULL, NULL)`,
    [id, recordingId, 'some real transcript body worth analyzing']
  )
}
function summaryOf(recordingId: string): string | null {
  return dbQueryOne<{ summary: string | null }>(
    'SELECT summary FROM transcripts WHERE recording_id = ?',
    [recordingId]
  )?.summary ?? null
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockConfig.transcription.valueClassificationEnabled = false
  mockGenerateContent.mockResolvedValue(geminiJsonResponse(HEALED))
  await initializeDatabase()
})

describe('RE-2 — reanalyzeFailedTranscripts excludes trashed/personal/value-excluded', () => {
  it('heals an eligible recording (control)', async () => {
    seedRecording('ok')
    seedFailedTranscript('t-ok', 'ok')

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(1)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(summaryOf('ok')).toBe('Healed summary.')
  })

  it('does NOT select or re-upload a soft-deleted recording', async () => {
    seedRecording('trashed')
    seedFailedTranscript('t-trashed', 'trashed')
    deleteRecordingCascade('trashed', { hard: false }) // soft delete

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(0)
    // The transcript's full_text was NEVER sent to the provider.
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(summaryOf('trashed')).toBeNull()
  })

  it('does NOT select or re-upload a personal recording', async () => {
    seedRecording('mine')
    seedFailedTranscript('t-mine', 'mine')
    setRecordingPersonal('mine', true)

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(0)
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(summaryOf('mine')).toBeNull()
  })

  it('does NOT re-upload a value-excluded recording (pre-filter Set, no provider call)', async () => {
    seedRecording('garbage')
    seedFailedTranscript('t-garbage', 'garbage')
    // A garbage capture with no "keep" capture ⇒ value-excluded.
    dbRun(
      'INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, quality_rating) VALUES (?, ?, ?, ?, ?)',
      ['cap-g', 'Cap', '2026-06-01', 'garbage', 'garbage']
    )

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(0)
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(summaryOf('garbage')).toBeNull()
  })

  it('a delete that lands mid-analysis blocks the heal (post-await re-check)', async () => {
    seedRecording('race')
    seedFailedTranscript('t-race', 'race')
    // The provider call resolves AFTER the recording is soft-deleted, exactly
    // simulating a trash committed while full_text was in flight.
    mockGenerateContent.mockImplementationOnce(async () => {
      deleteRecordingCascade('race', { hard: false })
      return geminiJsonResponse(HEALED)
    })

    const healed = await reanalyzeFailedTranscripts(10)

    // Provider WAS called (eligible at select time) but the heal is discarded.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(healed).toBe(0)
    expect(summaryOf('race')).toBeNull()
  })

  it('ADV41 sweep (round-43) — a LATER row excluded WHILE an earlier row is in flight is never sent to the provider', async () => {
    // Two eligible rows at select time; 'first' is NEWER so (created_at DESC) it
    // is processed first. While its provider call is in flight, the owner trashes
    // 'later'. The PER-ROW re-check immediately before the provider call (added in
    // round-43) must drop 'later' so its full_text never reaches the provider —
    // the post-await gate alone would have already sent it.
    seedRecording('first')
    seedFailedTranscript('t-first', 'first')
    dbRun("UPDATE transcripts SET created_at = '2026-06-10T00:00:00Z' WHERE recording_id = ?", ['first'])
    seedRecording('later')
    seedFailedTranscript('t-later', 'later')
    dbRun("UPDATE transcripts SET created_at = '2026-06-01T00:00:00Z' WHERE recording_id = ?", ['later'])

    mockGenerateContent.mockImplementationOnce(async () => {
      deleteRecordingCascade('later', { hard: false }) // exclude the LATER row mid-run
      return geminiJsonResponse(HEALED)
    })

    const healed = await reanalyzeFailedTranscripts(10)

    // Provider called EXACTLY once (for 'first'); 'later' was skipped before its
    // provider call, so nothing was uploaded and nothing was persisted for it.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(healed).toBe(1)
    expect(summaryOf('first')).toBe('Healed summary.')
    expect(summaryOf('later')).toBeNull()
  })

  it('heals only the eligible one when eligible + excluded rows are mixed', async () => {
    seedRecording('keep')
    seedFailedTranscript('t-keep', 'keep')
    seedRecording('drop')
    seedFailedTranscript('t-drop', 'drop')
    setRecordingPersonal('drop', true)

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(1)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1) // only for 'keep'
    expect(summaryOf('keep')).toBe('Healed summary.')
    expect(summaryOf('drop')).toBeNull()
  })

  it('INC-3 — an eligible failed transcript behind N NEWER garbage rows still gets reanalyzed', async () => {
    // 3 value-excluded (garbage) failed transcripts, all NEWER than the eligible
    // one. Under the old LIMIT-before-exclusion bug, the newest N garbage rows
    // filled the slot and the eligible transcript starved forever.
    for (const g of ['g1', 'g2', 'g3']) {
      seedRecording(g)
      seedFailedTranscript(`t-${g}`, g)
      dbRun("UPDATE transcripts SET created_at = '2026-06-10T00:00:00Z' WHERE recording_id = ?", [g])
      dbRun(
        'INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id, quality_rating) VALUES (?, ?, ?, ?, ?)',
        [`c-${g}`, 'C', '2026-06-01', g, 'garbage']
      )
    }
    seedRecording('eligible')
    seedFailedTranscript('t-eligible', 'eligible')
    dbRun("UPDATE transcripts SET created_at = '2026-06-01T00:00:00Z' WHERE recording_id = ?", ['eligible'])

    // Tight limit — the exclusion is baked into the query, so LIMIT counts only
    // eligible rows and the eligible transcript is reached.
    const healed = await reanalyzeFailedTranscripts(2)

    expect(healed).toBe(1)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    expect(summaryOf('eligible')).toBe('Healed summary.')
    expect(summaryOf('g1')).toBeNull()
  })

  it('P1 — aborts the run (zero provider calls) when the eligibility query fails', async () => {
    seedRecording('ok')
    seedFailedTranscript('t-ok', 'ok')
    dbRun('DROP TABLE transcripts') // force getFailedTranscriptsForReanalysis to throw

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(0)
    expect(mockGenerateContent).not.toHaveBeenCalled() // fail CLOSED — no upload
  })
})

describe('a summary that keeps failing is not paid for forever (review of #187, 27-oct-2026)', () => {
  function failedSummaryRun(recordingId: string, hoursAgo: number, n: number): void {
    const startedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
    dbRun(
      `INSERT INTO processing_runs (id, recording_id, stage, provider, status, started_at, error_message)
       VALUES (?, ?, 'summary', 'gemini', 'failed', ?, '503 high demand')`,
      [`run-${recordingId}-${n}`, recordingId, startedAt]
    )
  }

  it('waits two hours after a failed summary before trying that transcript again', async () => {
    seedRecording('recent')
    seedFailedTranscript('t-recent', 'recent')
    failedSummaryRun('recent', 0.5, 1)
    seedRecording('waited')
    seedFailedTranscript('t-waited', 'waited')
    failedSummaryRun('waited', 3, 1)

    await reanalyzeFailedTranscripts(10)

    expect(summaryOf('recent')).toBeNull()
    expect(summaryOf('waited')).toBe('Healed summary.')
  })

  it('stops after four failed summaries in a week', async () => {
    seedRecording('stuck')
    seedFailedTranscript('t-stuck', 'stuck')
    for (let n = 1; n <= 4; n++) failedSummaryRun('stuck', 3 + n * 10, n)

    const healed = await reanalyzeFailedTranscripts(10)

    expect(healed).toBe(0)
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('does not spend the weekly cap on quota refusals, which cost nothing (27-oct-2026)', async () => {
    // The summary model ran out of its free daily quota: four 429s two hours
    // apart would otherwise lock the transcript out for a week.
    seedRecording('quota-only')
    seedFailedTranscript('t-quota', 'quota-only')
    for (let n = 1; n <= 4; n++) {
      dbRun(
        `INSERT INTO processing_runs (id, recording_id, stage, provider, status, started_at, error_message)
         VALUES (?, 'quota-only', 'summary', 'gemini', 'failed', ?, ?)`,
        [`run-q-${n}`, new Date(Date.now() - (3 + n * 3) * 3_600_000).toISOString(),
          '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: [429 Too Many Requests] You exceeded your current quota']
      )
    }

    await reanalyzeFailedTranscripts(10)

    expect(summaryOf('quota-only')).toBe('Healed summary.')
  })

  it('does not spend the cap on depleted credits or on a request that was never sent (28-oct-2026)', async () => {
    // A 402 is refused before running; "checkpoint pending" sends nothing at all.
    // Both spent the cap overnight on ten recordings.
    seedRecording('unbilled')
    seedFailedTranscript('t-unbilled', 'unbilled')
    const refusals = [
      '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent: [402 Payment Required] Your prepayment credits are depleted.',
      'Provider checkpoint pending: previous request outcome unknown; explicit new transcription required',
    ]
    for (let n = 1; n <= 4; n++) {
      dbRun(
        `INSERT INTO processing_runs (id, recording_id, stage, provider, status, started_at, error_message)
         VALUES (?, 'unbilled', 'summary', 'gemini', 'failed', ?, ?)`,
        [`run-u-${n}`, new Date(Date.now() - (3 + n * 3) * 3_600_000).toISOString(), refusals[n % 2]]
      )
    }

    await reanalyzeFailedTranscripts(10)

    expect(summaryOf('unbilled')).toBe('Healed summary.')
  })

  it('still counts a billed failure that only quotes a 402 in its text (review of #190)', async () => {
    seedRecording('quotes-402')
    seedFailedTranscript('t-quotes-402', 'quotes-402')
    for (let n = 1; n <= 4; n++) {
      dbRun(
        `INSERT INTO processing_runs (id, recording_id, stage, provider, status, started_at, error_message)
         VALUES (?, 'quotes-402', 'summary', 'gemini', 'failed', ?, ?)`,
        [`run-b-${n}`, new Date(Date.now() - (3 + n * 3) * 3_600_000).toISOString(),
          '500 Internal error after retry; earlier attempt said 402 Payment Required']
      )
    }

    await reanalyzeFailedTranscripts(10)

    expect(summaryOf('quotes-402')).toBeNull()
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('tries the never-attempted and the longest-waiting first, so old ones are not starved', async () => {
    seedRecording('older-failure')
    seedFailedTranscript('t-older', 'older-failure')
    failedSummaryRun('older-failure', 30, 1)
    seedRecording('newer-failure')
    seedFailedTranscript('t-newer', 'newer-failure')
    failedSummaryRun('newer-failure', 5, 1)
    seedRecording('never-tried')
    seedFailedTranscript('t-never', 'never-tried')

    await reanalyzeFailedTranscripts(2)

    expect(summaryOf('never-tried')).toBe('Healed summary.')
    expect(summaryOf('older-failure')).toBe('Healed summary.')
    expect(summaryOf('newer-failure')).toBeNull()
  })
})
