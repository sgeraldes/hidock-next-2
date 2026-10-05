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

describe('RAG corpus responsiveness', () => {
  it('indexes 2,150 eligible 40KB transcripts without a long main-thread hold', async () => {
    await initializeDatabase()
    const text='Spoken words about the project. '.repeat(1300).slice(0,40000)
    runInTransaction(() => {for(let i=0;i<2150;i++) {
      run('INSERT INTO recordings (id,filename,date_recorded) VALUES (?,?,?)',[`rag-${i}`,`rag-${i}.webm`,'2026-10-04'])
      run("INSERT INTO transcripts (id,recording_id,full_text,validity_status,integrity_status) VALUES (?,?,?,'valid','ok')",[`t-${i}`,`rag-${i}`,text])
    }})
    queryOne('PRAGMA wal_checkpoint(TRUNCATE)')
    try {
      const {getVectorStore}=await import('../vector-store')
      let indexed=0
      const longest=await hold('RAG eligible backfill',async()=>{indexed=(await getVectorStore().backfillMissingTranscripts()).indexed})
      expect(indexed).toBe(2150)
      expect(longest).toBeLessThan(100)
    } finally {closeDatabase()}
  },120000)
})
