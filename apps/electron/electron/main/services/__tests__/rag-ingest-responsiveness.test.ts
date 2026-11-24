// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeDatabase, run, runInTransaction, closeDatabase, queryOne } from '../database'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
paths.root = join(tmpdir(), `hidock-background-fixture-${process.pid}-${Date.now()}`)
paths.db = `${paths.root}.sqlite`
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: {}, embeddings: { provider: 'ollama', chunkSize: 500, chunkOverlap: 50 }, storage: { dataPath: paths.root } }) }))
vi.mock('../embeddings', () => ({ getEmbeddingsService: () => ({ activeProviderId: async () => 'fixture', generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])) }) }))

async function hold(name: string, work: () => unknown | Promise<unknown>): Promise<number[]> {
  let last = performance.now()
  const gaps: number[] = []
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 0)
  const started = performance.now()
  try { await work() } finally {
    gaps.push(performance.now() - last)
    clearInterval(timer)
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  process.stdout.write(`BACKGROUND FIXTURE ${name}: longest event-loop hold ${sorted.at(-1)!.toFixed(1)}ms; p99 ${p99.toFixed(1)}ms; ` +
    `${gaps.filter((g) => g >= 100).length} over 100ms; total ${(performance.now() - started).toFixed(1)}ms\n`)
  return gaps
}

// The shared CI runner runs these passes up to 5 times slower than the dev PC
// (integrity 46 ms here, 217 ms there; validity 53 ms here, 257 to 710 ms there)
// and stalls the VM now and then. A pass that never yields still misses these
// limits (origin/main: 284 to 464 ms on the dev PC, five times that on CI); a
// single stall (here or there) gets one retry, on a fresh database.
const SCALE = process.env.CI ? 5 : 1
let attempt = 0

describe('RAG corpus responsiveness', () => {
  it('indexes 2,150 eligible 40KB transcripts without a long main-thread hold', { retry: 1, timeout: 300_000 }, async () => {
    paths.db = `${paths.root}-${++attempt}.sqlite`
    await initializeDatabase()
    const text='Spoken words about the project. '.repeat(1300).slice(0,40000)
    runInTransaction(() => {for(let i=0;i<2150;i++) {
      run('INSERT INTO recordings (id,filename,date_recorded) VALUES (?,?,?)',[`rag-${i}`,`rag-${i}.webm`,'2026-10-04'])
      run("INSERT INTO transcripts (id,recording_id,full_text,validity_status,integrity_status) VALUES (?,?,?,'valid','ok')",[`t-${i}`,`rag-${i}`,text])
    }})
    queryOne('PRAGMA wal_checkpoint(TRUNCATE)')
    // This fixture measures how the code yields. A WAL checkpoint's fsync costs
    // what the test machine's disk costs (46 to 720 ms measured on the dev PC),
    // so the fixture leaves durability to the OS for this temporary file.
    run('PRAGMA synchronous = OFF')
    try {
      const {getVectorStore}=await import('../vector-store')
      let indexed=0
      const gaps=await hold('RAG eligible backfill',async()=>{indexed=(await getVectorStore().backfillMissingTranscripts()).indexed})
      expect(indexed).toBe(2150)
      // The code yields after at most ~20 ms of its own work. What it cannot split
      // is a major GC of a 193,000-vector heap, which can pass 100 ms now and then;
      // a few such stalls in about 50,000 batches are allowed.
      const sorted=[...gaps].sort((a,b)=>a-b)
      expect(sorted[Math.floor(sorted.length*0.99)]).toBeLessThan(50 * SCALE)
      expect(gaps.filter((g)=>g>=100 * SCALE).length).toBeLessThanOrEqual(3)
      expect(sorted.at(-1)).toBeLessThan(250 * SCALE)
    } finally {closeDatabase()}
  })
})
