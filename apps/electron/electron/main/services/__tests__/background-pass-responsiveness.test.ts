// @vitest-environment node
import { afterAll, describe, it, expect, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

// The shared CI runner runs these passes up to 5 times slower than the dev PC
// (integrity 46 ms here, 217 ms there; validity 53 ms here, 257 to 710 ms there)
// and stalls the VM now and then. A pass that never yields still misses these
// limits (origin/main: 284 to 464 ms on the dev PC, five times that on CI); a
// single stall (here or there) gets one retry, on a fresh database.
const SCALE = process.env.CI ? 5 : 1
// HIDOCK_FIXTURE_SYNC=normal keeps synchronous NORMAL, as the app opens the
// library: checkpoints then sync, and the hold is what the owner's disk costs.
const KEEP_SYNC = process.env.HIDOCK_FIXTURE_SYNC === 'normal'
// HIDOCK_FIXTURE_MEASURE=1 records every hold without the suite's 100 ms limit.
const MEASURE_ONLY = process.env.HIDOCK_FIXTURE_MEASURE === '1'
let attempt = 0

// Each run leaves a 250 MB database and a folder of wiki pages in the temp folder otherwise.
afterAll(() => {
  for (let n = 1; n <= attempt; n++) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${paths.root}-${n}.sqlite${suffix}`
      if (existsSync(file)) rmSync(file, { force: true })
    }
  }
  if (existsSync(paths.root)) rmSync(paths.root, { recursive: true, force: true })
})

describe('2,150 transcript background passes', () => {
  it('keeps each main-thread hold below 100 ms', { retry: 1, timeout: 300_000 }, async () => {
    paths.db = `${paths.root}-${++attempt}.sqlite`
    // A retry gets fresh modules: the vector store and other singletons keep
    // the first attempt's database and tables otherwise.
    vi.resetModules()
    const { initializeDatabase, run, runInTransaction, closeDatabase, queryAll, queryOne } = await import('../database')
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
    // These fixtures measure how the code yields. A WAL checkpoint's fsync costs
    // what the test machine's disk costs (up to 720 ms seen on the dev PC), so the
    // fixture leaves durability to the OS for this temporary file.
    if (!KEEP_SYNC) run('PRAGMA synchronous = OFF')
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
      // This UPDATE rewrites every 100 KB transcript row, about 240 MB into the WAL,
      // as large as the seed. With synchronous OFF its checkpoint never syncs, so
      // the OS was still writing those pages back while the wiki pass read them:
      // the only pass measured right after a bulk write, and the only one that
      // stalled on CI (252, 301 and 556 ms holds; 25 to 33 ms otherwise, 27-nov).
      // Finish it the way the seed is finished, outside the measurement.
      run('PRAGMA synchronous = NORMAL')
      run("UPDATE transcripts SET validity_status='valid', integrity_status='ok'")
      queryOne('PRAGMA wal_checkpoint(TRUNCATE)')
      run('PRAGMA synchronous = OFF')
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
      process.stdout.write(`BACKGROUND FIXTURE worst: ${Math.max(...Object.values(holds)).toFixed(1)}ms ${JSON.stringify(holds)}\n`)
      if (!MEASURE_ONLY) for (const [name, duration] of Object.entries(holds)) expect(duration, name).toBeLessThan(100 * SCALE)
    } finally { closeDatabase() }
  })
})
