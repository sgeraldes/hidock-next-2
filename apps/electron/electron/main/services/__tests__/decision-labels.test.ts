// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const paths = vi.hoisted(() => ({ db: '' }))
paths.db = join(tmpdir(), `hidock-labels-${process.pid}-${Date.now()}.db`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db }))
vi.mock('../config', () => ({ getConfig: () => ({ transcription: { valueClassificationMinConfidence: 0.6 } }) }))
import { initializeDatabase, closeDatabase, run, queryAll, queryOne, runWithMassDeleteAllowed } from '../database'
import { getLabelSet, getLabelItem, saveLabel, clearLabel } from '../pipeline/decision-labels'

function seed(id: string, confidence = 0.2, validity: string | null = 'valid') {
  run(`INSERT INTO recordings (id, filename, date_recorded, duration_seconds) VALUES (?, ?, '2026-10-04T12:00:00Z', 120)`, [id, `${id}.hda`])
  run('INSERT INTO transcripts (id, recording_id, full_text, validity_status) VALUES (?, ?, ?, ?)', [`t-${id}`, id, 'Opening '.repeat(1000), validity])
  run(`INSERT INTO knowledge_captures (id, title, source_recording_id, captured_at) VALUES (?, 'Capture', ?, '2026-10-04')`, [`c-${id}`, id])
  run(`INSERT INTO recording_evaluations (capture_id, recording_id, version, model, kind_confidence, answers_json, evaluated_at)
       VALUES (?, ?, 1, 'jev-1.13.0', ?, '{"kind":{"choice":"device_test"}}', '2026-10-04')`, [`c-${id}`, id, confidence])
}
beforeAll(async () => { await initializeDatabase() })
afterAll(() => {
  closeDatabase()
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(paths.db + suffix)) rmSync(paths.db + suffix)
})
beforeEach(() => runWithMassDeleteAllowed(() => {
  run('DELETE FROM decision_label_items')
  run('DELETE FROM decision_label_sets')
  run('DELETE FROM decision_labels')
  run('DELETE FROM recording_evaluations')
  run('DELETE FROM knowledge_captures')
  run('DELETE FROM transcripts')
  run('DELETE FROM recordings')
}))
describe('reference labels on real SQLite', () => {
  it('creates v71 tables on a fresh database and upgrades v70 without losing recordings', async () => {
    seed('preserved')
    expect(queryOne<{ v: number }>('SELECT MAX(version) v FROM schema_version')?.v).toBe(71)
    run('DROP TABLE decision_label_items')
    run('DROP TABLE decision_label_sets')
    run('DROP TABLE decision_labels')
    run('DELETE FROM schema_version WHERE version = 71')
    closeDatabase()
    await initializeDatabase()
    expect(queryOne('SELECT id FROM recordings WHERE id = ?', ['preserved'])).toBeDefined()
    expect(queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'decision_label%' ")).toHaveLength(3)
  })
  it('stores 20 per stratum, includes the boundary, and stays identical on a second call', () => {
    for (let i = 0; i < 25; i++) { seed(`d${i}`); seed(`c${i}`, 0.4) }
    const first = getLabelSet()
    expect(first.items).toHaveLength(40)
    expect(first.counts).toEqual({ doubtful: 20, confident: 20 })
    expect(new Set(first.items.map(i => i.recordingId)).size).toBe(40)
    seed('new')
    expect(getLabelSet()).toEqual(first)
  })
  it('excludes deleted, personal, value-excluded, invalid, unknown validity, rules and missing confidence', () => {
    for (const id of ['ok', 'deleted', 'personal', 'excluded', 'rules', 'null-confidence']) seed(id)
    for (const validity of ['invalid', 'incomplete', 'doubtful']) seed(validity, 0.8, validity)
    seed('unknown', 0.8, null)
    run("UPDATE recordings SET deleted_at = 'today' WHERE id = 'deleted'")
    run("UPDATE recordings SET personal = 1 WHERE id = 'personal'")
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'user' WHERE source_recording_id = 'excluded'")
    run("UPDATE recording_evaluations SET model = 'rules-v1' WHERE recording_id = 'rules'")
    run("UPDATE recording_evaluations SET kind_confidence = NULL WHERE recording_id = 'null-confidence'")
    expect(getLabelSet().items.map(i => i.recordingId)).toEqual(['ok'])
    expect(getLabelSet().counts).toEqual({ doubtful: 1, confident: 0 })
  })
  it('returns only owner decision context and gates an item after eligibility changes', () => {
    seed('ok')
    const set = getLabelSet()
    const item = getLabelItem({ setId: set.id, recordingId: 'ok' })!
    expect(Object.keys(item).sort()).toEqual(['answer', 'date', 'durationSeconds', 'excerpt', 'meetingSubject', 'recordingId'].sort())
    expect(item.excerpt).toBe('Opening '.repeat(1000).slice(0, 3000))
    run("UPDATE recordings SET personal = 1 WHERE id = 'ok'")
    expect(getLabelItem({ setId: set.id, recordingId: 'ok' })).toBeNull()
    expect(() => saveLabel({ setId: set.id, recordingId: 'ok', answer: 'interview' })).toThrow()
  })
  it('saves, changes and clears a label, rejecting invalid answers and ids', () => {
    seed('ok')
    const args = { setId: getLabelSet().id, recordingId: 'ok' }
    saveLabel({ ...args, answer: 'interview' })
    expect(getLabelSet().labeled).toBe(1)
    expect(getLabelItem(args)?.answer).toBe('interview')
    saveLabel({ ...args, answer: 'team_meeting' })
    expect(queryAll('SELECT * FROM decision_labels')).toHaveLength(1)
    expect(() => saveLabel({ ...args, answer: '__proto__' })).toThrow()
    expect(() => saveLabel({ ...args, recordingId: 'other', answer: 'interview' })).toThrow()
    clearLabel(args)
    expect(getLabelSet().labeled).toBe(0)
    expect(getLabelItem(args)?.answer).toBeNull()
  })
})
