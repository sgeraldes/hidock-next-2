/**
 * A summary that failed at transcription time left meeting resolution without
 * an answer (Rec19, the 15-oct Delivery, 27-oct-2026): no automatic link, only
 * "time overlap" candidate rows. reanalyzeFailedTranscripts heals the summary
 * later and must also choose the meeting again, through the same gate as the
 * live path, and never over a link or a rejection the owner set. Real
 * better-sqlite3 engine + real database; only the provider is mocked.
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
vi.mock('../meeting-wiki', () => ({ exportMeetingWiki: vi.fn(() => null) }))

let _dbCounter = 0
vi.mock('../file-storage', () => ({
  getDatabasePath: vi.fn(() => join(tmpdir(), `hidock-reanalyze-link-${Date.now()}-${++_dbCounter}.sqlite`))
}))

import { initializeDatabase, run as dbRun, queryOne as dbQueryOne } from '../database'
import { reanalyzeFailedTranscripts } from '../transcription'

const TRANSCRIPT = 'Welcome to the Delivery Weekly, we start with the release plan and the open risks.'

function healedAnswer(overrides: Record<string, unknown> = {}) {
  return {
    response: {
      text: () => JSON.stringify({
        summary: 'Healed summary.',
        action_items: [],
        topics: [],
        key_points: [],
        title_suggestion: 'Healed Title',
        question_suggestions: [],
        language: 'en',
        selected_meeting_id: 'm-delivery',
        meeting_confidence: 0.95,
        selection_reason: 'The event name is spoken',
        selection_evidence: {
          kind: 'explicit-event-reference',
          transcript_quote: 'Welcome to the Delivery Weekly',
          calendar_quote: 'Delivery Weekly'
        },
        ...overrides
      })
    }
  }
}

function seed(opts: { meetingId?: string | null; method?: string | null } = {}): void {
  dbRun(
    `INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)`,
    ['m-delivery', 'Delivery Weekly', '2026-10-15T14:00:00.000Z', '2026-10-15T15:00:00.000Z']
  )
  dbRun(
    `INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)`,
    ['m-other', 'Something Else', '2026-10-15T09:00:00.000Z', '2026-10-15T09:30:00.000Z']
  )
  dbRun(
    `INSERT INTO recordings (id, filename, date_recorded, duration_seconds, meeting_id, correlation_method)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['rec19', 'Rec19.hda', '2026-10-15T14:02:00.000Z', 1800, opts.meetingId ?? null, opts.method ?? null]
  )
  dbRun(
    `INSERT INTO transcripts (id, recording_id, full_text, summary, title_suggestion) VALUES (?, ?, ?, NULL, NULL)`,
    ['trans_rec19', 'rec19', TRANSCRIPT]
  )
}

function link(): { meeting_id: string | null; correlation_method: string | null } | undefined {
  return dbQueryOne('SELECT meeting_id, correlation_method FROM recordings WHERE id = ?', ['rec19'])
}

function promptSent(): string {
  return JSON.stringify(mockGenerateContent.mock.calls[0])
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockGenerateContent.mockResolvedValue(healedAnswer())
  await initializeDatabase()
})

describe('reanalyzeFailedTranscripts chooses the meeting again', () => {
  it('links an unlinked recording to the meeting its transcript names', async () => {
    seed()

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(promptSent()).toContain('m-delivery')
    expect(promptSent()).not.toContain('m-other')
    expect(link()).toEqual({ meeting_id: 'm-delivery', correlation_method: 'ai_transcript_match' })
    const candidate = dbQueryOne<{ is_selected: number; is_ai_selected: number; confidence_score: number }>(
      'SELECT is_selected, is_ai_selected, confidence_score FROM recording_meeting_candidates WHERE recording_id = ? AND meeting_id = ?',
      ['rec19', 'm-delivery']
    )
    expect(candidate).toEqual({ is_selected: 1, is_ai_selected: 1, confidence_score: 0.95 })
    const transcript = dbQueryOne<{ meeting_resolution_run_id: string | null }>(
      'SELECT meeting_resolution_run_id FROM transcripts WHERE recording_id = ?',
      ['rec19']
    )
    const run = dbQueryOne<{ stage: string; status: string }>(
      'SELECT stage, status FROM processing_runs WHERE id = ?',
      [transcript?.meeting_resolution_run_id ?? '']
    )
    expect(run).toEqual({ stage: 'meeting-resolution', status: 'completed' })
  })

  it('keeps a weak answer as a candidate without linking', async () => {
    seed()
    mockGenerateContent.mockResolvedValue(healedAnswer({ meeting_confidence: 0.5 }))

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(link()).toEqual({ meeting_id: null, correlation_method: null })
    const candidate = dbQueryOne<{ is_selected: number; confidence_score: number }>(
      'SELECT is_selected, confidence_score FROM recording_meeting_candidates WHERE recording_id = ? AND meeting_id = ?',
      ['rec19', 'm-delivery']
    )
    expect(candidate).toEqual({ is_selected: 0, confidence_score: 0.5 })
  })

  it('leaves a meeting the owner chose untouched and sends no candidates', async () => {
    seed({ meetingId: 'm-other', method: 'manual' })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(promptSent()).not.toContain('m-delivery')
    expect(link()).toEqual({ meeting_id: 'm-other', correlation_method: 'manual' })
  })

  it('leaves a recording the owner marked as no meeting unlinked', async () => {
    seed({ method: 'user_preassign_standalone' })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(promptSent()).not.toContain('m-delivery')
    expect(link()).toEqual({ meeting_id: null, correlation_method: 'user_preassign_standalone' })
  })

  it('does not re-decide a recording that already has an automatic link', async () => {
    seed({ meetingId: 'm-other', method: 'time_overlap' })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(promptSent()).not.toContain('m-delivery')
    expect(link()).toEqual({ meeting_id: 'm-other', correlation_method: 'time_overlap' })
  })

  it('an owner link made while the model answers wins over the automatic pick', async () => {
    seed()
    mockGenerateContent.mockImplementationOnce(async () => {
      dbRun(`UPDATE recordings SET meeting_id = 'm-other', correlation_method = 'manual' WHERE id = 'rec19'`)
      return healedAnswer()
    })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(link()).toEqual({ meeting_id: 'm-other', correlation_method: 'manual' })
  })

  it('keeps an automatic link written while the model answers', async () => {
    seed()
    mockGenerateContent.mockImplementationOnce(async () => {
      dbRun(`UPDATE recordings SET meeting_id = 'm-other', correlation_method = 'time_overlap' WHERE id = 'rec19'`)
      return healedAnswer({ meeting_confidence: 0.5 })
    })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    expect(link()).toEqual({ meeting_id: 'm-other', correlation_method: 'time_overlap' })
  })

  it('a meeting resolution that throws still heals the summary and fails its run', async () => {
    seed()
    mockGenerateContent.mockImplementationOnce(async () => {
      dbRun('DROP TABLE recording_meeting_candidates')
      return healedAnswer()
    })

    expect(await reanalyzeFailedTranscripts(10)).toBe(1)

    const transcript = dbQueryOne<{ summary: string | null }>(
      'SELECT summary FROM transcripts WHERE recording_id = ?',
      ['rec19']
    )
    expect(transcript?.summary).toBe('Healed summary.')
    const runs = dbQueryOne<{ running: number; failed: number }>(
      `SELECT SUM(status = 'running') AS running, SUM(status = 'failed') AS failed
         FROM processing_runs WHERE recording_id = ? AND stage = 'meeting-resolution'`,
      ['rec19']
    )
    expect(runs).toEqual({ running: 0, failed: 1 })
  })
})
