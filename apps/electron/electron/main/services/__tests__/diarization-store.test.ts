// @vitest-environment node
import { it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const paths = vi.hoisted(() => ({ db: '' }))
const dir = mkdtempSync(join(tmpdir(), 'hidock-diarization-store-'))
paths.db = join(dir, 'test.db')
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db }))
import { initializeDatabase, closeDatabase, run, queryOne } from '../database'
import { storeDiarizedSegments, getDiarizedSegments } from '../diarization-store'
beforeAll(async () => { await initializeDatabase() })
afterAll(() => { closeDatabase(); rmSync(dir, { recursive: true }) })

it('stores independent acoustic turns, replaces atomically, rejects bad timestamps', () => {
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec', 'rec.hda', '2026-10-04')`)
  run(`INSERT INTO processing_runs (id, recording_id, stage, provider, tool, execution, status, started_at)
    VALUES ('run', 'rec', 'diarization', 'pyannote', 'pyannote', 'local', 'completed', '2026-10-04')`)
  const segments = Array.from({ length: 413 }, (_, i) => ({ start: i * 1057 / 413, end: (i + 1) * 1057 / 413, speaker: `voice-${i % 4}` }))
  storeDiarizedSegments('rec', 'run', segments)
  expect(getDiarizedSegments('rec')).toHaveLength(413)
  expect(getDiarizedSegments('rec')[0]).toMatchObject({ voice_label: 'voice-0', run_id: 'run' })
  expect(() => storeDiarizedSegments('rec', 'run', [{ start: 2, end: 1, speaker: 'A' }])).toThrow()
  expect(getDiarizedSegments('rec')).toHaveLength(413)
  storeDiarizedSegments('rec', 'run', [{ start: 0, end: 10, speaker: 'A' }])
  expect(getDiarizedSegments('rec')).toHaveLength(1)
})

it('migrates a v71 database through the restore-point boundary without losing audio/text', async () => {
  run(`INSERT INTO transcripts (id, recording_id, full_text) VALUES ('trans-rec', 'rec', 'preserved')`)
  run('DROP TABLE diarized_segments')
  run('DELETE FROM schema_version')
  run('INSERT INTO schema_version (version) VALUES (71)')
  closeDatabase()
  await initializeDatabase()
  expect(queryOne<{ version: number }>('SELECT MAX(version) AS version FROM schema_version')?.version).toBe(73)
  expect(getDiarizedSegments('rec')).toEqual([])
  expect(queryOne<{ full_text: string }>('SELECT full_text FROM transcripts WHERE recording_id = ?', ['rec'])?.full_text).toBe('preserved')
  expect(readdirSync(dir).some(file => file.includes('pre-v73'))).toBe(true)
})
