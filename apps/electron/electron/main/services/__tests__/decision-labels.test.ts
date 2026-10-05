// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import SQLite from 'better-sqlite3'

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
beforeEach(async () => {
  closeDatabase()
  await initializeDatabase()
  runWithMassDeleteAllowed(() => {
  for (const { name } of queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'decision_label_items_legacy*'")) {
    run(`DROP TABLE "${name}"`)
  }
  run('DELETE FROM decision_label_items')
  run('DELETE FROM decision_label_sets')
  run('DELETE FROM decision_labels')
  run('DELETE FROM recording_evaluations')
  run('DELETE FROM knowledge_captures')
  run('DELETE FROM transcripts')
  run('DELETE FROM recordings')
  })
})
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
    run("INSERT INTO decision_labels VALUES ('legacy', 'kind', 'interview', 'today')")
    closeDatabase()
    await initializeDatabase()
    const set = getLabelSet()
    expect(set.size).toBe(1)
    expect(set.counts).toEqual({ doubtful: 1, random: 0 })
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
    expect(getLabelSet().counts).toEqual({ doubtful: 2, random: 0 })
    expect(getLabelSet().unavailable).toBe(1)
    expect(getLabelSet().labeled).toBe(0)
    expect(queryAll("SELECT * FROM decision_label_items WHERE recording_id = 'purge'")).toEqual([])
    expect(queryAll("SELECT * FROM decision_labels WHERE recording_id = 'purge'")).toEqual([])
    expect(queryOne('SELECT sample_size, doubtful_count, random_count FROM decision_label_sets')).toEqual({ sample_size: 2, doubtful_count: 2, random_count: 0 })
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
  it('creates decision-label tables on a fresh database and upgrades v70 without losing recordings', async () => {
    seed('preserved')
    expect(queryOne<{ v: number }>('SELECT MAX(version) v FROM schema_version')?.v).toBe(72)
    run('DROP TABLE decision_label_items')
    run('DROP TABLE decision_label_sets')
    run('DROP TABLE decision_labels')
    run('DELETE FROM schema_version WHERE version >= 71')
    closeDatabase()
    await initializeDatabase()
    expect(queryOne('SELECT id FROM recordings WHERE id = ?', ['preserved'])).toBeDefined()
    expect(queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'decision_label%' ")).toHaveLength(3)
  })
  it('takes the lowest 20 usable latest confidences and 20 random from the rest', () => {
    for (let i = 0; i < 60; i++) seed(`r${i}`, 0.4 + i / 1000)
    seed('garbage', 0.1)
    run("UPDATE knowledge_captures SET quality_rating = 'garbage', quality_source = 'user' WHERE source_recording_id = 'garbage'")
    run("INSERT INTO knowledge_captures (id, title, captured_at, source_recording_id) VALUES ('new', 'New', '2026-10-05', 'r0')")
    run("INSERT INTO recording_evaluations (capture_id, recording_id, version, model, kind_confidence, answers_json, evaluated_at) VALUES ('new', 'r0', 1, 'jev', 0.9, '{}', '2026-10-05')")
    const first = getLabelSet()
    expect(first.size).toBe(40)
    expect(first.counts).toEqual({ doubtful: 20, random: 20 })
    const rows = queryAll<{ recording_id: string; stratum: string }>('SELECT recording_id, stratum FROM decision_label_items ORDER BY position')
    expect(rows.filter(r => r.stratum === 'doubtful').map(r => r.recording_id)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i + 1}`))
    expect(rows.filter(r => r.stratum === 'random')).toHaveLength(20)
    expect(new Set(rows.map(r => r.recording_id)).size).toBe(40)
    expect(queryOne('SELECT sampling_rule FROM decision_label_sets')).toEqual({ sampling_rule: 'lowest20-random20-v1' })
    seed('new-lowest', 0.01)
    expect(getLabelSet()).toEqual(first)
  })
  it.each([0, 7, 20, 21, 39, 40, 45])('samples min(40, %i usable recordings)', count => {
    for (let i = 0; i < count; i++) seed(`r${i}`, 0.8)
    expect(getLabelSet()).toMatchObject({ size: Math.min(40, count), counts: { doubtful: Math.min(20, count), random: Math.min(20, Math.max(0, count - 20)) } })
  })
  it.each([null, 'old-rule'])('replaces an unlabeled set with rule %s', rule => {
    seed('old')
    const old = getLabelSet()
    run('UPDATE decision_label_sets SET sampling_rule = ?', [rule])
    for (let i = 0; i < 45; i++) seed(`r${i}`, 0.8)
    expect(getLabelSet()).toMatchObject({ size: 40 })
    expect(getLabelSet().id).not.toBe(old.id)
    expect(queryAll('SELECT * FROM decision_label_sets')).toHaveLength(1)
    expect(queryAll('SELECT * FROM decision_label_items WHERE set_id = ?', [old.id])).toEqual([])
  })
  it.each([null, 'old-rule'])('preserves a labeled set with rule %s even when its label is unavailable', rule => {
    seed('old')
    const old = getLabelSet()
    saveLabel({ setId: old.id, recordingId: 'old', answer: 'interview' })
    run('UPDATE decision_label_sets SET sampling_rule = ?', [rule])
    run("UPDATE recordings SET personal = 1 WHERE id = 'old'")
    seed('new')
    expect(getLabelSet()).toMatchObject({ id: old.id, size: 1, unavailable: 1 })
    expect(queryOne('SELECT answer FROM decision_labels')).toEqual({ answer: 'interview' })
  })
  it.each([false, true])('recovers interrupted membership rebuild before reads (new table exists: %s)', async newTableExists => {
    seed('stranded')
    const original = getLabelSet()
    saveLabel({ setId: original.id, recordingId: 'stranded', answer: 'interview' })
    const labeled = getLabelSet()
    run('UPDATE decision_label_sets SET sampling_rule = NULL')
    run('ALTER TABLE decision_label_items RENAME TO decision_label_items_legacy')
    if (newTableExists) {
      run("CREATE TABLE decision_label_items (set_id TEXT NOT NULL REFERENCES decision_label_sets(id) ON DELETE CASCADE, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, stratum TEXT NOT NULL CHECK(stratum IN ('doubtful', 'random')), position INTEGER NOT NULL, PRIMARY KEY(set_id, recording_id), UNIQUE(set_id, position))")
    }
    closeDatabase()
    await initializeDatabase()
    expect(queryAll('SELECT set_id, recording_id, stratum, position FROM decision_label_items')).toEqual([
      { set_id: original.id, recording_id: 'stranded', stratum: 'doubtful', position: 0 }
    ])
    expect(queryAll("SELECT name FROM sqlite_master WHERE name = 'decision_label_items_legacy'")).toEqual([])
    expect(getLabelSet()).toEqual(labeled)
    expect(queryOne('SELECT answer FROM decision_labels')).toEqual({ answer: 'interview' })
    closeDatabase()
    await initializeDatabase()
    expect(getLabelSet()).toEqual(labeled)
    expect(queryAll('SELECT * FROM decision_label_items')).toHaveLength(1)
  })
  it.each([true, false])('boots and recovers stranded members with position column: %s', async hasPosition => {
    seed('current')
    const set = getLabelSet()
    seed('recovered')
    run(`CREATE TABLE decision_label_items_legacy (set_id TEXT, recording_id TEXT, stratum TEXT${hasPosition ? ', position INTEGER' : ''}, extra TEXT)`)
    run(`INSERT INTO decision_label_items_legacy VALUES (?, 'recovered', 'confident'${hasPosition ? ', 0' : ''}, 'ignored')`, [set.id])
    run(`INSERT INTO decision_label_items_legacy VALUES (?, 'current', 'confident'${hasPosition ? ', 0' : ''}, 'ignored')`, [set.id])
    closeDatabase()
    await expect(initializeDatabase()).resolves.not.toThrow()
    expect(queryAll('SELECT recording_id, position, stratum FROM decision_label_items ORDER BY position')).toEqual([
      { recording_id: 'current', position: 0, stratum: 'doubtful' },
      { recording_id: 'recovered', position: 1, stratum: 'random' }
    ])
    expect(queryAll("SELECT name FROM sqlite_master WHERE name = 'decision_label_items_legacy'")).toEqual([])
  })
  it('raises recovered counts without reducing historical counts', async () => {
    seed('count-current')
    const set = getLabelSet()
    seed('count-random')
    seed('count-doubtful')
    run('CREATE TABLE decision_label_items_legacy (set_id TEXT, recording_id TEXT, stratum TEXT)')
    run("INSERT INTO decision_label_items_legacy VALUES (?, 'count-random', 'confident'), (?, 'count-doubtful', 'doubtful')", [set.id, set.id])
    closeDatabase()
    await initializeDatabase()
    expect(getLabelSet()).toMatchObject({ size: 3, unavailable: 0, counts: { doubtful: 2, random: 1 } })
    expect(queryOne('SELECT sample_size, doubtful_count, random_count FROM decision_label_sets')).toEqual({ sample_size: 3, doubtful_count: 2, random_count: 1 })
    run('UPDATE decision_label_sets SET sample_size = 8, doubtful_count = 5, random_count = 3')
    closeDatabase()
    await initializeDatabase()
    expect(getLabelSet()).toMatchObject({ size: 8, unavailable: 5, counts: { doubtful: 5, random: 3 } })
  })
  it('clamps unavailable below zero', () => {
    seed('under-counted')
    getLabelSet()
    run('UPDATE decision_label_sets SET sample_size = 0, doubtful_count = 0, random_count = 0')
    expect(getLabelSet()).toMatchObject({ size: 0, unavailable: 0 })
  })
  it('contains malformed-view fallback rename failure on every boot', async () => {
    seed('view-member')
    const set = getLabelSet()
    run('UPDATE decision_label_sets SET sampling_rule = NULL')
    run('CREATE TABLE decision_label_items_legacy (set_id TEXT, recording_id TEXT, stratum TEXT)')
    run("INSERT INTO decision_label_items_legacy VALUES (?, 'missing', 'invalid')", [set.id])
    run('CREATE VIEW legacy_positions AS SELECT position FROM decision_label_items_legacy')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let boot = 0; boot < 2; boot++) {
        closeDatabase()
        await expect(initializeDatabase()).resolves.not.toThrow()
        expect(getLabelSet().id).toBe(set.id)
      }
      const failures = warning.mock.calls.filter(args => String(args[0]).includes('label recovery failed'))
      expect(failures).toHaveLength(2)
      expect(failures.every(args => args.length === 1 && String(args[0]).includes('no such column: position'))).toBe(true)
    } finally {
      warning.mockRestore()
      run('DROP VIEW legacy_positions')
    }
  })
  it.each([
    ['run', 'SAVEPOINT decision_label_repair'],
    ['run', 'CREATE TABLE IF NOT EXISTS decision_label_sets'],
    ['exec', "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_label_items_legacy'"],
    ['exec', 'PRAGMA table_info(decision_label_sets)'],
    ['exec', "SELECT sql FROM sqlite_master WHERE name = 'decision_label_items'"],
    ['run', 'UPDATE decision_label_sets SET'],
    ['run', 'RELEASE decision_label_repair'],
    ['run', 'ROLLBACK TO decision_label_repair']
  ] as const)('contains failure at %s %s with guard active', async (method, statement) => {
    seed('failure-member')
    const set = getLabelSet()
    run('UPDATE decision_label_sets SET sampling_rule = NULL')
    const prototype = Object.getPrototypeOf(database.getDatabase())
    const original = prototype[method]
    closeDatabase()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(prototype, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const sql = String(args[0])
      if (sql.startsWith(statement) || (statement.startsWith('ROLLBACK') && sql.startsWith('CREATE TABLE IF NOT EXISTS decision_label_sets'))) {
        throw new Error('Injected repair failure')
      }
      return original.apply(this, args)
    })
    try { await expect(initializeDatabase()).resolves.not.toThrow() } finally { spy.mockRestore() }
    try {
      expect(getLabelSet().id).toBe(set.id)
      expect(warning.mock.calls.filter(args => String(args[0]).includes('label recovery failed'))).toEqual([
        ['[Database] Decision label recovery failed: Injected repair failure; label set replacement disabled']
      ])
    } finally { warning.mockRestore() }
  })
  it('boots with an unreadable legacy table and preserves sets on subsequent boots', async () => {
    seed('unreadable')
    const set = getLabelSet()
    run('UPDATE decision_label_sets SET sampling_rule = NULL')
    run('CREATE TABLE decision_label_items_legacy (set_id TEXT, recording_id TEXT, stratum TEXT)')
    const prototype = Object.getPrototypeOf(database.getDatabase())
    const originalExec = prototype.exec
    closeDatabase()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(prototype, 'exec').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (/SELECT .* FROM decision_label_items_legacy/.test(String(args[0]))) throw new Error('Unreadable legacy table')
      return originalExec.apply(this, args)
    })
    try { await expect(initializeDatabase()).resolves.not.toThrow() } finally { spy.mockRestore() }
    expect(warning.mock.calls.filter(args => String(args[0]).includes('decision_label_items_legacy_unrecovered_'))).toHaveLength(1)
    warning.mockRestore()
    expect(queryAll("SELECT name FROM sqlite_master WHERE name GLOB 'decision_label_items_legacy_unrecovered_*'")).toHaveLength(1)
    expect(getLabelSet().id).toBe(set.id)
    closeDatabase()
    await expect(initializeDatabase()).resolves.not.toThrow()
    expect(getLabelSet().id).toBe(set.id)
  })
  it('recovers valid rows around an invalid member and retains the remainder', async () => {
    seed('existing')
    const set = getLabelSet()
    seed('first')
    seed('last')
    run('UPDATE decision_label_sets SET sampling_rule = NULL')
    run('CREATE TABLE decision_label_items_legacy (set_id TEXT, recording_id TEXT, stratum TEXT, position INTEGER)')
    for (const [id, stratum] of [['first', 'confident'], ['missing-recording', 'invalid'], ['last', 'doubtful']]) {
      run('INSERT INTO decision_label_items_legacy VALUES (?, ?, ?, 0)', [set.id, id, stratum])
    }
    closeDatabase()
    await expect(initializeDatabase()).resolves.not.toThrow()
    expect(queryAll('SELECT recording_id, position FROM decision_label_items ORDER BY position')).toEqual([
      { recording_id: 'existing', position: 0 }, { recording_id: 'first', position: 1 }, { recording_id: 'last', position: 2 }
    ])
    expect(queryAll("SELECT name FROM sqlite_master WHERE name GLOB 'decision_label_items_legacy_unrecovered_*'")).toHaveLength(1)
    expect(getLabelSet().id).toBe(set.id)
  })
  it('boots and preserves unrecovered membership when copy fails', async () => {
    seed('rollback')
    const set = getLabelSet()
    saveLabel({ setId: set.id, recordingId: 'rollback', answer: 'interview' })
    run('DROP TABLE decision_label_items')
    run("CREATE TABLE decision_label_items (set_id TEXT NOT NULL REFERENCES decision_label_sets(id) ON DELETE CASCADE, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, stratum TEXT NOT NULL CHECK(stratum IN ('doubtful', 'confident')), position INTEGER NOT NULL, PRIMARY KEY(set_id, recording_id), UNIQUE(set_id, position))")
    run("INSERT INTO decision_label_items VALUES (?, 'rollback', 'confident', 0)", [set.id])
    const prototype = Object.getPrototypeOf(database.getDatabase())
    const originalRun = prototype.run
    closeDatabase()
    const spy = vi.spyOn(prototype, 'run').mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (String(args[0]).includes('INSERT INTO decision_label_items')) throw new Error('Interrupted before member copy')
      return originalRun.apply(this, args)
    })
    try {
      await expect(initializeDatabase()).resolves.not.toThrow()
    } finally { spy.mockRestore() }
    const persisted = new SQLite(paths.db)
    try {
      const remnant = persisted.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'decision_label_items_legacy_unrecovered_*'").get() as { name: string }
      expect(persisted.prepare(`SELECT stratum FROM "${remnant.name}"`).all()).toEqual([{ stratum: 'confident' }])
      expect(persisted.prepare("SELECT name FROM sqlite_master WHERE name = 'decision_label_items_legacy'").all()).toEqual([])
    } finally { persisted.close() }
    await initializeDatabase()
    expect(getLabelSet()).toMatchObject({ id: set.id })
    expect(queryOne('SELECT answer FROM decision_labels')).toEqual({ answer: 'interview' })
  })
  it('repairs live v71 without the rule column, preserving labeled legacy counts', async () => {
    seed('legacy-random')
    run('DROP TABLE decision_label_items')
    run('DROP TABLE decision_label_sets')
    run("CREATE TABLE decision_label_sets (id TEXT PRIMARY KEY, question TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0, doubtful_count INTEGER NOT NULL DEFAULT 0, confident_count INTEGER NOT NULL DEFAULT 0, CHECK(sample_size = doubtful_count + confident_count))")
    run("CREATE TABLE decision_label_items (set_id TEXT NOT NULL REFERENCES decision_label_sets(id) ON DELETE CASCADE, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE, stratum TEXT NOT NULL CHECK(stratum IN ('doubtful', 'confident')), position INTEGER NOT NULL, PRIMARY KEY(set_id, recording_id), UNIQUE(set_id, position))")
    run("INSERT INTO decision_label_sets VALUES ('live', 'kind', 'today', 1, 0, 1)")
    run("INSERT INTO decision_label_items VALUES ('live', 'legacy-random', 'confident', 0)")
    run("INSERT INTO decision_labels VALUES ('legacy-random', 'kind', 'interview', 'today')")
    closeDatabase()
    await initializeDatabase()
    expect(queryOne('SELECT sampling_rule FROM decision_label_sets')).toEqual({ sampling_rule: null })
    expect(getLabelSet()).toMatchObject({ id: 'live', size: 1, counts: { doubtful: 0, random: 1 }, labeled: 1 })
    clearLabel({ setId: 'live', recordingId: 'legacy-random' })
    expect(getLabelSet().id).not.toBe('live')
    expect(queryOne('SELECT stratum FROM decision_label_items')).toEqual({ stratum: 'doubtful' })
    closeDatabase()
    await initializeDatabase()
    expect(getLabelSet().size).toBe(1)
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
    expect(getLabelSet().counts).toEqual({ doubtful: 1, random: 0 })
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
    expect(sampled.counts).toEqual({ doubtful: 1, random: 0 })
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
