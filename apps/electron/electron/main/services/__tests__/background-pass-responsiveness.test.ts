// @vitest-environment node
import { afterAll, describe, it, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
// The second test runs the library's WAL checkpoints on a worker thread; the
// first keeps SQLite's automatic checkpoint, as #175 measured it.
const walWorker = vi.hoisted(() => ({ enabled: false, checkpoints: 0, longestMs: 0 }))
paths.root = join(tmpdir(), `hidock-background-fixture-${process.pid}-${Date.now()}`)
paths.db = `${paths.root}.sqlite`
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] }, utilityProcess: { fork: vi.fn() } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {}, embeddings: { provider: 'ollama', chunkSize: 500, chunkOverlap: 50 }, storage: { dataPath: paths.root } }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({ activeProviderId: async () => 'fixture', generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])) }) }))
// The real host, pointed at a runtime folder holding a worker entry equivalent
// to the bundled one, counting each checkpoint the worker reports.
vi.mock('../wal-checkpoint-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wal-checkpoint-host')>()
  const { getStartupState } = await import('../../startup-state')
  return {
    ...actual,
    createWalCheckpointer: ((dbPath, events) => {
      if (!walWorker.enabled) return null
      getStartupState().runtimeDir = paths.root
      return actual.createWalCheckpointer(dbPath, {
        ...events,
        onCheckpoint: (result) => {
          walWorker.checkpoints++
          walWorker.longestMs = Math.max(walWorker.longestMs, result.durationMs)
          events.onCheckpoint?.(result)
        },
      })
    }) as typeof actual.createWalCheckpointer,
  }
})

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

function writeWorkerEntry(): void {
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(join(paths.root, 'package.json'), '{"type":"module"}\n')
  const sqlite = pathToFileURL(join(repoRoot, 'packages/database/node_modules/better-sqlite3/lib/index.js')).href
  const source = pathToFileURL(join(repoRoot, 'packages/database/src/wal-checkpointer.ts')).href
  writeFileSync(join(paths.root, 'wal-checkpoint-worker.js'),
    `import Database from ${JSON.stringify(sqlite)}\nimport { runWalCheckpointWorker } from ${JSON.stringify(source)}\nrunWalCheckpointWorker(Database)\n`)
}

afterAll(() => {
  // The worker entry and its package.json; the databases are swept by setup-db.
  rmSync(paths.root, { recursive: true, force: true })
})

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

type Db = typeof import('../database')

/** A fresh 2,150-transcript library of 40 KB transcripts, its seed folded into the file. */
async function seededLibrary(): Promise<Db> {
  // A retry gets fresh modules: the vector store and other singletons keep
  // the first attempt's database and tables otherwise.
  vi.resetModules()
  const db = await import('../database')
  await db.initializeDatabase()
  const text = 'Spoken words about the project. '.repeat(1300).slice(0, 40_000)
  const speakers = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ speaker: 'Speaker 1', start: i * 7, end: i * 7 + 6, text: text.slice(0, 80) })))
  db.runInTransaction(() => {
    for (let i = 0; i < 2150; i++) {
      db.run('INSERT INTO recordings (id, filename, date_recorded, duration_seconds) VALUES (?, ?, ?, ?)', [`load-${i}`, `load-${i}.webm`, '2026-10-04T12:00:00Z', 3600])
      db.run('INSERT INTO transcripts (id, recording_id, full_text, speakers, summary, action_items) VALUES (?, ?, ?, ?, ?, ?)', [`t-${i}`, `load-${i}`, text, speakers, 'Project summary', '["Follow up"]'])
    }
  })
  // Finish the synthetic bulk-load WAL before measuring application work.
  // Real libraries are already persisted; one 250MB seed transaction is fixture setup.
  db.queryOne('PRAGMA wal_checkpoint(TRUNCATE)')
  return db
}

/** The #175 background passes, each timed. */
async function backgroundPasses(db: Db): Promise<Record<string, number>> {
  const { run, runInTransaction, queryAll } = db
  const holds: Record<string, number> = {}
  const { backfillKnowledgeCapturesYielding } = await import('../knowledge-capture-backfill')
  holds.captures = await hold('knowledge captures', () => backfillKnowledgeCapturesYielding())
  const classification = await import('../value-classification')
  const kind = vi.spyOn(classification, 'getValueClassifierKind').mockReturnValue('jev')
  const classify = vi.spyOn(classification, 'classifyCaptureValue').mockResolvedValue(undefined as never)
  try {
    const { evaluateRecentUnevaluated } = await import('../evaluation-catchup')
    holds.evaluation = await hold('recent evaluation candidate pass', () => evaluateRecentUnevaluated())
  } finally { kind.mockRestore(); classify.mockRestore() }
  holds.integrity = await hold('transcript integrity', () => db.backfillTranscriptIntegrity())
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
  holds.meetings = await hold('meeting link recheck', () => db.recheckTimeLinks({ now: new Date('2026-10-05') }))
  run("UPDATE recordings SET meeting_id=NULL, correlation_method=NULL")
  const org = await import('../org-reconciler')
  holds.autoLink = await hold('meeting auto-link', () => org.autoLinkRecordingsToMeetingsYielding())
  holds.twins = await hold('Outlook attendee twins', () => org.fillAttendeesFromOutlookTwins())
  holds.org = await hold('organization reconciliation', () => org.reconcileOrganizationYielding())
  holds.reanalysis = await hold('failed analysis candidate query', () => db.getFailedTranscriptsForReanalysis(3))
  run("UPDATE knowledge_captures SET quality_rating='garbage'")
  const { getVectorStore } = await import('../vector-store')
  holds.rag = await hold('RAG excluded backfill', () => getVectorStore().backfillMissingTranscripts())
  return holds
}

// The shared CI runner runs these passes up to 5 times slower than the dev PC
// (integrity 46 ms here, 217 ms there; validity 53 ms here, 257 to 710 ms there)
// and stalls the VM now and then. A pass that never yields still misses these
// limits (origin/main: 284 to 464 ms on the dev PC, five times that on CI); a
// single stall (here or there) gets one retry, on a fresh database.
const SCALE = process.env.CI ? 5 : 1
let attempt = 0

// Both tests live in this file so the two 2,150-transcript fixtures never run
// at the same time on two vitest workers and contend for the disk.
describe('2,150 transcript background passes', () => {
  it('keeps each main-thread hold below 100 ms', { retry: 1, timeout: 300_000 }, async () => {
    walWorker.enabled = false
    paths.db = `${paths.root}-${++attempt}.sqlite`
    const db = await seededLibrary()
    // These fixtures measure how the code yields. A WAL checkpoint's fsync costs
    // what the test machine's disk costs (up to 720 ms seen on the dev PC), so the
    // fixture leaves durability to the OS for this temporary file. The next test
    // keeps the sync on and runs the checkpoints on the worker, as the app does.
    db.run('PRAGMA synchronous = OFF')
    try {
      const holds = await backgroundPasses(db)
      expect(holds).toEqual(expect.objectContaining({ captures: expect.any(Number), rag: expect.any(Number) }))
      for (const [name, duration] of Object.entries(holds)) expect(duration, name).toBeLessThan(100 * SCALE)
    } finally { db.closeDatabase() }
  })

  // With the sync on, as in the app. On origin/main SQLite's automatic
  // checkpoint ran inside COMMIT on the main thread (46 to 720 ms per
  // checkpoint on the owner's PC); here the worker runs them, and the same
  // passes stay below the same limit (G:\Code\_briefing\dod\2026-11-25-hidock-wal\).
  it('keeps each main-thread hold below 100 ms with WAL checkpoints on, run by the worker', { retry: 1, timeout: 300_000 }, async () => {
    walWorker.enabled = true
    walWorker.checkpoints = 0
    walWorker.longestMs = 0
    writeWorkerEntry()
    paths.db = join(paths.root, `library-${++attempt}.sqlite`)
    const db = await seededLibrary()
    try {
      const deadline = Date.now() + 10_000
      while (!db.walCheckpointsOffMainThread()) {
        if (Date.now() > deadline) throw new Error('the checkpoint worker never reported ready')
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(db.queryAll('PRAGMA synchronous')).toEqual([{ synchronous: 1 }])
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])
      const holds = await backgroundPasses(db)
      // A write path at its plainest: every transcript rewritten, 25 per
      // transaction (about 1 MB), yielding between transactions through the
      // budget the corpus passes share. With SQLite's automatic checkpoint,
      // every fourth COMMIT or so also copied the WAL into the file and synced
      // it on this thread.
      const { mainThreadBudget } = await import('../event-loop')
      holds.rewrite = await hold('transcript rewrite, 25 per transaction', async () => {
        const checkpoint = mainThreadBudget('TranscriptRewrite')
        for (let start = 0; start < 2150; start += 25) {
          db.runInTransaction(() => {
            for (let i = start; i < Math.min(start + 25, 2150); i++) db.run("UPDATE transcripts SET full_text = full_text || ' ' WHERE id = ?", [`t-${i}`])
          })
          await checkpoint()
        }
      })
      process.stdout.write(`BACKGROUND FIXTURE worker: ${walWorker.checkpoints} checkpoints off the main thread, longest ${walWorker.longestMs.toFixed(1)}ms\n`)
      // The checkpoints happened, with their real cost, on the worker.
      expect(walWorker.checkpoints).toBeGreaterThan(0)
      expect(db.walCheckpointsOffMainThread()).toBe(true)
      for (const [name, duration] of Object.entries(holds)) expect(duration, name).toBeLessThan(100 * SCALE)
    } finally { db.closeDatabase() }
  })
})
