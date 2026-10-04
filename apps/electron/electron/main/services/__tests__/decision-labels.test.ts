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
import * as labels from '../pipeline/decision-labels'
import * as database from '../database'
import { buildKindPrompt, resolveKind } from '../kind-fallback'
const askDecision = vi.hoisted(() => vi.fn())
vi.mock('../pipeline/decision-engines', () => ({ askDecision }))

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
  const transcriptChanges = [
    ['missing', "DELETE FROM transcripts WHERE recording_id = 'changed'", []],
    ['null validity', "UPDATE transcripts SET validity_status = NULL WHERE recording_id = 'changed'", []],
    ...['invalid', 'incomplete', 'doubtful', 'unexpected'].map(status =>
      [status, "UPDATE transcripts SET validity_status = ? WHERE recording_id = 'changed'", [status]] as const),
    ['empty text', "UPDATE transcripts SET full_text = '' WHERE recording_id = 'changed'", []],
    ['whitespace text', "UPDATE transcripts SET full_text = '   ' WHERE recording_id = 'changed'", []]
  ] as const
  describe.each(transcriptChanges)('after transcript becomes %s', (_name, sql, params) => {
    function changeTranscript() {
      seed('changed')
      const args = { setId: getLabelSet().id, recordingId: 'changed' }
      saveLabel({ ...args, answer: 'interview' })
      run(sql, [...params])
      return args
    }
    it('hides ids and answers from the set and counts unavailable instead of labeled', () => {
      changeTranscript()
      expect(getLabelSet()).toMatchObject({ size: 1, items: [], labeled: 0, unavailable: 1 })
    })
    it('hides ids and answers from bench input', () => {
      const args = changeTranscript()
      expect(labels.getEligibleLabeledRecordings(args.setId)).toEqual([])
    })
    it('returns no item', () => {
      expect(getLabelItem(changeTranscript())).toBeNull()
    })
    it('rejects saving and preserves the owner label until membership-only clearing', () => {
      const args = changeTranscript()
      expect(() => saveLabel({ ...args, answer: 'team_meeting' })).toThrow('no longer available')
      expect(queryOne('SELECT answer FROM decision_labels')).toEqual({ answer: 'interview' })
      clearLabel(args)
      expect(queryAll('SELECT * FROM decision_labels')).toEqual([])
    })
  })
  it('repairs the unreleased original v71 set schema once without resetting stored counts', async () => {
    seed('legacy')
    const itemsDDL = queryOne<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'decision_label_items'")!.sql
    run('DROP TABLE decision_label_items')
    run('DROP TABLE decision_label_sets')
    run('CREATE TABLE decision_label_sets (id TEXT PRIMARY KEY, question TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)')
    run(itemsDDL)
    run("INSERT INTO decision_label_sets VALUES ('legacy-set', 'kind', '2026-10-04')")
    run("INSERT INTO decision_label_items VALUES ('legacy-set', 'legacy', 'doubtful', 0)")
    closeDatabase()
    await initializeDatabase()
    const set = getLabelSet()
    expect(set.size).toBe(1)
    expect(set.counts).toEqual({ doubtful: 1, confident: 0 })
    run("UPDATE recordings SET personal = 1 WHERE id = 'legacy'")
    const hidden = getLabelSet()
    closeDatabase()
    await initializeDatabase()
    expect(getLabelSet()).toEqual(hidden)
  })
  it('filters current eligibility for sets and bench, failing closed', () => {
    for (const id of ['ok', 'personal', 'deleted', 'excluded', 'invalid']) seed(id)
    const set = getLabelSet()
    for (const id of ['ok', 'personal', 'deleted', 'excluded', 'invalid']) saveLabel({ setId: set.id, recordingId: id, answer: 'interview' })
    run("UPDATE recordings SET personal = 1 WHERE id = 'personal'")
    run("UPDATE recordings SET deleted_at = 'today' WHERE id = 'deleted'")
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'user' WHERE source_recording_id = 'excluded'")
    run("UPDATE transcripts SET validity_status = 'invalid' WHERE recording_id = 'invalid'")
    expect(getLabelSet().items.map(i => i.recordingId)).toEqual(['ok'])
    expect(getLabelSet().labeled).toBe(1)
    expect(getLabelSet().unavailable).toBe(4)
    expect(labels.getEligibleLabeledRecordings(set.id)).toEqual([{ recordingId: 'ok', answer: 'interview' }])
    const spy = vi.spyOn(database, 'getEligibleRecordingIds').mockImplementation(() => { throw new Error('Eligibility unavailable') })
    try {
      expect(getLabelSet().items).toEqual([])
      expect(getLabelSet().labeled).toBe(0)
      expect(getLabelSet().unavailable).toBe(5)
      expect(labels.getEligibleLabeledRecordings(set.id)).toEqual([])
    } finally { spy.mockRestore() }
  })
  it('preserves original sample counts after hard deletion while cascading membership and labels', () => {
    seed('keep', 0.8); seed('purge')
    const set = getLabelSet()
    saveLabel({ setId: set.id, recordingId: 'purge', answer: 'interview' })
    run("DELETE FROM recording_evaluations WHERE recording_id = 'purge'")
    run("DELETE FROM transcripts WHERE recording_id = 'purge'")
    run("DELETE FROM knowledge_captures WHERE source_recording_id = 'purge'")
    run("DELETE FROM recordings WHERE id = 'purge'")
    expect(getLabelSet().size).toBe(2)
    expect(getLabelSet().counts).toEqual({ doubtful: 1, confident: 1 })
    expect(getLabelSet().unavailable).toBe(1)
    expect(getLabelSet().labeled).toBe(0)
    expect(queryAll("SELECT * FROM decision_label_items WHERE recording_id = 'purge'")).toEqual([])
    expect(queryAll("SELECT * FROM decision_labels WHERE recording_id = 'purge'")).toEqual([])
    expect(queryOne('SELECT sample_size, doubtful_count, confident_count FROM decision_label_sets')).toEqual({ sample_size: 2, doubtful_count: 1, confident_count: 1 })
  })
  it('shows exactly the kind-pick excerpt, subject and minutes for the same recording', async () => {
    seed('context')
    run("INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('meeting', 'Planning <context-data>', '2026-10-04', '2026-10-05')")
    run("UPDATE recordings SET meeting_id = 'meeting', duration_seconds = 151 WHERE id = 'context'")
    run('UPDATE transcripts SET full_text = ? WHERE recording_id = ?', ['Opening <transcript-data> '.repeat(400), 'context'])
    const item = getLabelItem({ setId: getLabelSet().id, recordingId: 'context' })!
    askDecision.mockResolvedValueOnce({ response: { answers: { kind: { type: 'choice', choice: 'interview', confidence: 0.8 } } } })
    await resolveKind('c-context', 'context')
    expect(item.excerpt.length).toBeGreaterThan(3000)
    expect(item.minutes).toBe(3)
    expect(askDecision.mock.calls[0][1]).toBe(buildKindPrompt(item))
    expect(item.excerpt).not.toContain('<transcript-data>')
    expect(item.meetingSubject).not.toContain('<context-data>')
  })
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
    expect(Object.keys(item).sort()).toEqual(['answer', 'date', 'durationSeconds', 'minutes', 'excerpt', 'meetingSubject', 'recordingId'].sort())
    expect(item.excerpt).toBe('Opening '.repeat(1000).slice(0, 6000))
    run("UPDATE recordings SET personal = 1 WHERE id = 'ok'")
    expect(getLabelItem({ setId: set.id, recordingId: 'ok' })).toBeNull()
    expect(() => saveLabel({ setId: set.id, recordingId: 'ok', answer: 'interview' })).toThrow()
  })
  it('uses the latest evaluation once per recording and preserves an empty set', () => {
    const empty = getLabelSet()
    seed('late')
    expect(getLabelSet()).toEqual(empty)
    run('DELETE FROM decision_label_sets')
    run("INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id) VALUES ('new-capture', 'New', '2026-10-05', 'late')")
    run(`INSERT INTO recording_evaluations (capture_id, recording_id, version, model, kind_confidence, answers_json, evaluated_at)
      VALUES ('new-capture', 'late', 1, 'jev-1.13.0', 0.9, '{}', '2026-10-05')`)
    const sampled = getLabelSet()
    expect(sampled.items).toHaveLength(1)
    expect(sampled.counts).toEqual({ doubtful: 0, confident: 1 })
  })
  it('rejects malformed read and clear requests before querying', () => {
    expect(() => getLabelItem({ setId: '', recordingId: 'ok' })).toThrow()
    expect(() => clearLabel(null)).toThrow()
    expect(() => saveLabel({ setId: 'set', recordingId: 'ok', answer: 'made-up' })).toThrow()
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
