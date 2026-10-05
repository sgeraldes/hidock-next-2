// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeDatabase, run, runInTransaction, closeDatabase, queryAll, queryOne } from '../database'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
paths.root = join(tmpdir(), `hidock-background-fixture-${process.pid}-${Date.now()}`)
paths.db = `${paths.root}.sqlite`
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {}, embeddings: { provider: 'ollama', chunkSize: 500, chunkOverlap: 50 }, storage: { dataPath: paths.root } }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({ activeProviderId: async () => 'fixture', generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])) }) }))

async function hold(name: string, work: () => unknown | Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 0)
  const started = performance.now()
  try { await work() } finally {
    longest = Math.max(longest, performance.now() - last)
    clearInterval(timer)
  }
  process.stdout.write(`BACKGROUND FIXTURE ${name}: longest event-loop hold ${longest.toFixed(1)}ms; total ${(performance.now() - started).toFixed(1)}ms\n`)
  return longest
}

describe('2,150 transcript background passes', () => {
  it('keeps each main-thread hold below 100 ms', async () => {
    await initializeDatabase()
    const text = 'Spoken words about the project. '.repeat(1300).slice(0, 40_000)
    const speakers = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ speaker: 'Speaker 1', start: i * 7, end: i * 7 + 6, text: text.slice(0, 80) })))
    runInTransaction(() => {
      for (let i = 0; i < 2150; i++) {
        run('INSERT INTO recordings (id, filename, date_recorded, duration_seconds) VALUES (?, ?, ?, ?)', [`load-${i}`, `load-${i}.webm`, '2026-10-04T12:00:00Z', 3600])
        run('INSERT INTO transcripts (id, recording_id, full_text, speakers, summary, action_items) VALUES (?, ?, ?, ?, ?, ?)', [`t-${i}`, `load-${i}`, text, speakers, 'Project summary', '["Follow up"]'])
      }
    })
    // Finish the synthetic bulk-load WAL before measuring application work.
    // Real libraries are already persisted; one 250MB seed transaction is fixture setup.
    queryOne('PRAGMA wal_checkpoint(TRUNCATE)')
    const holds: Record<string, number> = {}
    try {
      const { backfillKnowledgeCapturesYielding } = await import('../knowledge-capture-backfill')
      holds.captures = await hold('knowledge captures', () => backfillKnowledgeCapturesYielding())
      const classification = await import('../value-classification')
      const kind = vi.spyOn(classification, 'getValueClassifierKind').mockReturnValue('jev')
      const classify = vi.spyOn(classification, 'classifyCaptureValue').mockResolvedValue(undefined as never)
      try {
        const { evaluateRecentUnevaluated } = await import('../evaluation-catchup')
        holds.evaluation = await hold('recent evaluation candidate pass', () => evaluateRecentUnevaluated())
      } finally { kind.mockRestore(); classify.mockRestore() }
      const { backfillTranscriptIntegrity, recheckTimeLinks } = await import('../database')
      holds.integrity = await hold('transcript integrity', () => backfillTranscriptIntegrity())
      const { backfillTranscriptValidity } = await import('../transcript-validity-store')
      holds.validity = await hold('transcript validity', () => backfillTranscriptValidity())
      // The warning pass joins the real evaluations against the corpus.
      runInTransaction(() => {
        for (const row of queryAll<{ id: string; source_recording_id: string }>('SELECT id, source_recording_id FROM knowledge_captures')) {
          run('INSERT INTO recording_evaluations (recording_id, capture_id, model, version, answers_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)', [row.source_recording_id, row.id, 'fixture', 1, '{}', '2026-10-04'])
        }
      })
      const { recomputeAudioWarnings } = await import('../value-classification')
      holds.warnings = await hold('evaluation warnings', () => recomputeAudioWarnings())
      const { backfillMeetingWiki } = await import('../meeting-wiki')
      run("UPDATE transcripts SET validity_status='valid', integrity_status='ok'")
      holds.wiki = await hold('wiki backfill', () => backfillMeetingWiki({ budgetMs: 500, batchSize: 10 }))
      runInTransaction(() => {
        for (let i = 0; i < 2150; i++) run('INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, ?)', [`m-${i}`, `Project ${i}`, '2026-10-04T12:00:00Z', '2026-10-04T13:00:00Z'])
        run("UPDATE recordings SET meeting_id='m-0', correlation_method='time_overlap'")
      })
      holds.meetings = await hold('meeting link recheck', () => recheckTimeLinks({ now: new Date('2026-10-05') }))
      run("UPDATE recordings SET meeting_id=NULL, correlation_method=NULL")
      const org = await import('../org-reconciler')
      holds.autoLink = await hold('meeting auto-link', () => org.autoLinkRecordingsToMeetingsYielding())
      holds.twins = await hold('Outlook attendee twins', () => org.fillAttendeesFromOutlookTwins())
      holds.org = await hold('organization reconciliation', () => org.reconcileOrganizationYielding())
      const { getFailedTranscriptsForReanalysis } = await import('../database')
      holds.reanalysis = await hold('failed analysis candidate query', () => getFailedTranscriptsForReanalysis(3))
      run("UPDATE knowledge_captures SET quality_rating='garbage'")
      const { getVectorStore } = await import('../vector-store')
      holds.rag = await hold('RAG excluded backfill', () => getVectorStore().backfillMissingTranscripts())
      expect(holds).toEqual(expect.objectContaining({ captures: expect.any(Number), rag: expect.any(Number) }))
      for (const [name, duration] of Object.entries(holds)) expect(duration, name).toBeLessThan(100)
    } finally { closeDatabase() }
  }, 120_000)
})
