// @vitest-environment node

/**
 * v65: the identity decision journal (spec 2026-10-03, "How decisions are recorded").
 *
 * REAL temp DB, real database.ts (better-sqlite3). Every automatic decision leaves one row with
 * its evidence and the state before; undo puts that state back and marks the row, and an undone
 * decision is never made again by the same method for the same subject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync, readFileSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-identity-decisions-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import {
  initializeDatabase,
  closeDatabase,
  run,
  queryAll,
  queryOne,
  runInTransaction,
  mergeContacts,
  mergeJournalIdsFor,
  unmergeContacts
} from '../database'
import {
  mergeSubjectKey,
  recordDecisionNoSave,
  listDecisions,
  wasUndone,
  undoDecision,
  speakerSubjectKey,
  mentionSubjectKey,
  snapshotSpeakerNoSave,
  snapshotMentionNoSave
} from '../identity-decisions'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

function seed(): void {
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec', 'rec.wav', '2026-10-01T10:00:00Z')`)
  for (const [id, name] of [['ana', 'Ana Ruiz'], ['bea', 'Bea Paz']]) {
    run(
      `INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
       VALUES (?, ?, 'unknown', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'user')`,
      [id, name]
    )
  }
}

const speakerRow = (label: string) =>
  queryOne<{ id: string; contact_id: string; source: string | null; confidence: number | null }>(
    'SELECT id, contact_id, source, confidence FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
    ['rec', label]
  )

const mentionRow = (name: string) =>
  queryOne<{ resolved_contact_id: string | null; method: string | null }>(
    'SELECT resolved_contact_id, method FROM mention_resolutions WHERE recording_id = ? AND source_name = ?',
    ['rec', name]
  )

beforeEach(async () => {
  cleanup()
  await initializeDatabase()
  seed()
})

afterEach(() => {
  closeDatabase()
  cleanup()
})

describe('schema v65', () => {
  it('adds source and confidence to transcript_speakers and creates identity_decisions with its indexes', () => {
    const speakerColumns = queryAll<{ name: string }>('PRAGMA table_info(transcript_speakers)').map((c) => c.name)
    expect(speakerColumns).toEqual(expect.arrayContaining(['source', 'confidence']))

    const decisionColumns = queryAll<{ name: string }>('PRAGMA table_info(identity_decisions)').map((c) => c.name)
    expect(decisionColumns).toEqual([
      'id', 'kind', 'subject_key', 'method', 'contact_id', 'evidence_json', 'before_json', 'created_at', 'undone_at'
    ])
    const indexes = queryAll<{ name: string }>('PRAGMA index_list(identity_decisions)').map((i) => i.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_identity_decisions_subject', 'idx_identity_decisions_created']))

    const version = queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v
    expect(version).toBe(EXPECTED_SCHEMA_VERSION)
    expect(EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(65)
  })

  it('refuses a kind outside the four the spec names', () => {
    expect(() =>
      run(
        `INSERT INTO identity_decisions (id, kind, subject_key, method, evidence_json, created_at)
         VALUES ('x', 'project', 'k', 'm', '{}', '2026-10-03T00:00:00Z')`
      )
    ).toThrow()
  })

  it('the migration adds the same columns and table to a database that predates v65', async () => {
    closeDatabase()
    // A v64 database: drop what v65 adds, then boot again.
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(dbPath)
    raw.exec('DROP TABLE identity_decisions')
    raw.exec('ALTER TABLE transcript_speakers DROP COLUMN source')
    raw.exec('ALTER TABLE transcript_speakers DROP COLUMN confidence')
    raw.exec('DELETE FROM schema_version WHERE version >= 65')
    raw.close()

    await initializeDatabase()

    const speakerColumns = queryAll<{ name: string }>('PRAGMA table_info(transcript_speakers)').map((c) => c.name)
    expect(speakerColumns).toEqual(expect.arrayContaining(['source', 'confidence']))
    expect(queryAll('PRAGMA table_info(identity_decisions)')).toHaveLength(9)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })
})

describe('recording and listing decisions', () => {
  it('writes one row with the evidence and the state before, newest first', () => {
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 1'),
        method: 'one-on-one',
        contactId: 'ana',
        evidence: { meetingId: 'm1', similarity: 0.93 },
        before: snapshotSpeakerNoSave('rec', 'Speaker 1')
      })
    })
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec', 'bucket-sebas'),
        method: 'voice-presence',
        contactId: 'bea',
        evidence: { voices: ['v1'] },
        before: snapshotMentionNoSave('rec', 'Sebas')
      })
    })

    const all = listDecisions({ limit: 10 })
    expect(all.map((d) => d.kind)).toEqual(['mention', 'speaker'])
    expect(all[1]).toMatchObject({
      kind: 'speaker',
      subjectKey: 'recording:rec:speaker:Speaker 1',
      method: 'one-on-one',
      contactId: 'ana',
      evidence: { meetingId: 'm1', similarity: 0.93 },
      before: { recordingId: 'rec', speakerLabel: 'Speaker 1', row: null },
      undoneAt: null
    })
    expect(all[0].subjectKey).toBe('recording:rec:mention:bucket-sebas')
    expect(listDecisions({ limit: 1 })).toHaveLength(1)
  })

  it('leaves undone decisions out unless asked for them', () => {
    let id = ''
    runInTransaction(() => {
      id = recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 1'),
        method: 'voice',
        contactId: 'ana',
        evidence: {},
        before: snapshotSpeakerNoSave('rec', 'Speaker 1')
      })
    })
    undoDecision(id)
    expect(listDecisions({ limit: 10 })).toEqual([])
    expect(listDecisions({ limit: 10, includeUndone: true })).toHaveLength(1)
  })
})

describe('undo', () => {
  it('a speaker decision that created the binding removes it, and is never made again by that method', () => {
    let id = ''
    runInTransaction(() => {
      const before = snapshotSpeakerNoSave('rec', 'Speaker 1')
      run(
        `INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
         VALUES ('ts1', 'rec', 'Speaker 1', 'ana', 'elimination', 0.85)`
      )
      id = recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 1'),
        method: 'elimination',
        contactId: 'ana',
        evidence: { voice: 'v1' },
        before
      })
    })
    expect(wasUndone('speaker', speakerSubjectKey('rec', 'Speaker 1'), 'elimination')).toBe(false)

    undoDecision(id)

    expect(speakerRow('Speaker 1')).toBeUndefined()
    expect(wasUndone('speaker', speakerSubjectKey('rec', 'Speaker 1'), 'elimination')).toBe(true)
    // Another method for the same subject is not blocked.
    expect(wasUndone('speaker', speakerSubjectKey('rec', 'Speaker 1'), 'voice')).toBe(false)
    expect(queryOne<{ undone_at: string | null }>('SELECT undone_at FROM identity_decisions WHERE id = ?', [id])!.undone_at)
      .toEqual(expect.any(String))
  })

  it('a speaker decision that replaced a binding puts the old one back', () => {
    run(
      `INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence, created_at)
       VALUES ('ts-old', 'rec', 'Speaker 2', 'bea', 'speaker-inference', 0.7, '2026-10-01 10:00:00')`
    )
    let id = ''
    runInTransaction(() => {
      const before = snapshotSpeakerNoSave('rec', 'Speaker 2')
      run(`UPDATE transcript_speakers SET contact_id = 'ana', source = 'voice', confidence = 0.95 WHERE id = 'ts-old'`)
      id = recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 2'),
        method: 'voice',
        contactId: 'ana',
        evidence: {},
        before
      })
    })

    undoDecision(id)

    expect(speakerRow('Speaker 2')).toEqual({ id: 'ts-old', contact_id: 'bea', source: 'speaker-inference', confidence: 0.7 })
  })

  it('leaves a binding the owner changed after the decision alone', () => {
    let id = ''
    runInTransaction(() => {
      const before = snapshotSpeakerNoSave('rec', 'Speaker 3')
      run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source) VALUES ('ts3', 'rec', 'Speaker 3', 'ana', 'voice')`)
      id = recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 3'),
        method: 'voice',
        contactId: 'ana',
        evidence: {},
        before
      })
    })
    run(`UPDATE transcript_speakers SET contact_id = 'bea', source = 'manual', confidence = 1 WHERE id = 'ts3'`)

    const result = undoDecision(id)

    expect(result).toEqual({ restored: false })
    expect(speakerRow('Speaker 3')).toMatchObject({ contact_id: 'bea', source: 'manual' })
    expect(wasUndone('speaker', speakerSubjectKey('rec', 'Speaker 3'), 'voice')).toBe(true)
  })

  it('a mention decision removes the resolution it wrote, or restores the one it replaced', () => {
    run(
      `INSERT INTO mention_resolutions (id, recording_id, source_name, resolved_contact_id, method, confidence, created_at)
       VALUES ('mr-old', 'rec', 'bea', 'bea', 'attendee-context', 0.7, '2026-10-01T10:00:00Z')`
    )
    let created = ''
    let replaced = ''
    runInTransaction(() => {
      const beforeNew = snapshotMentionNoSave('rec', 'Sebas')
      run(
        `INSERT INTO mention_resolutions (id, recording_id, source_name, resolved_contact_id, method, confidence)
         VALUES ('mr-new', 'rec', 'sebas', 'ana', 'owner-presence', 0.8)`
      )
      created = recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec', 'bucket-sebas'),
        method: 'owner-presence',
        contactId: 'ana',
        evidence: {},
        before: beforeNew
      })
      const beforeOld = snapshotMentionNoSave('rec', 'Bea')
      run(`UPDATE mention_resolutions SET resolved_contact_id = 'ana', method = 'voice-presence' WHERE id = 'mr-old'`)
      replaced = recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec', 'bucket-bea'),
        method: 'voice-presence',
        contactId: 'ana',
        evidence: {},
        before: beforeOld
      })
    })

    undoDecision(created)
    undoDecision(replaced)

    expect(mentionRow('sebas')).toBeUndefined()
    expect(mentionRow('bea')).toEqual({ resolved_contact_id: 'bea', method: 'attendee-context' })
    expect(wasUndone('mention', mentionSubjectKey('rec', 'bucket-sebas'), 'owner-presence')).toBe(true)
  })

  it('undoes a voice anchor: the cluster gets back the person it had, unless someone changed it since', () => {
    run(`INSERT INTO voice_clusters
      (id, model, model_version, embedding_dimension, centroid_json, contact_id, contact_link_method, contact_link_confidence)
      VALUES ('v1', 'community-1', '4.0.0', 3, '[1,0,0]', 'ana', 'one-on-one', 0.94)`)
    run(`INSERT INTO voice_clusters
      (id, model, model_version, embedding_dimension, centroid_json, contact_id, contact_link_method, contact_link_confidence)
      VALUES ('v2', 'community-1', '4.0.0', 3, '[1,0,0]', 'bea', 'manual', 1)`)
    let first = ''
    let second = ''
    runInTransaction(() => {
      first = recordDecisionNoSave({
        kind: 'voice-anchor',
        subjectKey: 'cluster:v1',
        method: 'one-on-one',
        contactId: 'ana',
        evidence: {},
        before: { clusterId: 'v1', contactId: null, method: null, confidence: null }
      })
      second = recordDecisionNoSave({
        kind: 'voice-anchor',
        subjectKey: 'cluster:v2',
        method: 'elimination',
        contactId: 'ana',
        evidence: {},
        before: { clusterId: 'v2', contactId: null, method: null, confidence: null }
      })
    })
    const clusterRow = (id: string) =>
      queryOne('SELECT contact_id, contact_link_method, contact_link_confidence FROM voice_clusters WHERE id = ?', [id])

    expect(undoDecision(first)).toEqual({ restored: true })
    expect(clusterRow('v1')).toEqual({ contact_id: null, contact_link_method: null, contact_link_confidence: null })
    expect(wasUndone('voice-anchor', 'cluster:v1', 'one-on-one')).toBe(true)

    // v2 was tied to Bea by hand after the decision: that stays.
    expect(undoDecision(second)).toEqual({ restored: false })
    expect(clusterRow('v2')).toEqual({ contact_id: 'bea', contact_link_method: 'manual', contact_link_confidence: 1 })
  })

  it('undoes a merge through merge_journal: the loser comes back and the suggestion asks again', () => {
    run(`UPDATE contacts SET email = 'ana@dfx5.com' WHERE id = 'ana'`)
    run(
      `INSERT INTO identity_suggestions (id, kind, candidate_name, target_id, confidence, evidence, status, created_at)
       VALUES ('sug', 'person', 'Bea Paz', 'ana', 0.96, '{"loserId":"bea"}', 'accepted', '2026-10-01T10:00:00Z')`
    )
    let id = ''
    runInTransaction(() => {
      const before = mergeJournalIdsFor('contact', 'ana')
      mergeContacts('ana', 'bea')
      const journalId = [...mergeJournalIdsFor('contact', 'ana')].find((j) => !before.has(j))!
      id = recordDecisionNoSave({
        kind: 'merge',
        subjectKey: mergeSubjectKey('ana', 'bea'),
        method: 'exact-email',
        contactId: 'ana',
        evidence: {},
        before: { mergeJournalId: journalId, keeperId: 'ana', loserId: 'bea', suggestionId: 'sug', suggestionStatus: 'pending' }
      })
    })
    expect(queryOne(`SELECT id FROM contacts WHERE id = 'bea'`)).toBeUndefined()

    expect(undoDecision(id)).toEqual({ restored: true })
    expect(queryOne<{ name: string }>(`SELECT name FROM contacts WHERE id = 'bea'`)?.name).toBe('Bea Paz')
    expect(queryOne<{ status: string }>(`SELECT status FROM identity_suggestions WHERE id = 'sug'`)?.status).toBe('pending')
    expect(wasUndone('merge', mergeSubjectKey('ana', 'bea'), 'exact-email')).toBe(true)
  })

  it('a merge the owner already unmerged by hand is only marked', () => {
    let id = ''
    let journalId = ''
    runInTransaction(() => {
      const before = mergeJournalIdsFor('contact', 'ana')
      mergeContacts('ana', 'bea')
      journalId = [...mergeJournalIdsFor('contact', 'ana')].find((j) => !before.has(j))!
      id = recordDecisionNoSave({
        kind: 'merge',
        subjectKey: mergeSubjectKey('ana', 'bea'),
        method: 'voice',
        contactId: 'ana',
        evidence: {},
        before: { mergeJournalId: journalId, keeperId: 'ana', loserId: 'bea', suggestionId: null, suggestionStatus: null }
      })
    })
    unmergeContacts(journalId)
    expect(undoDecision(id)).toEqual({ restored: false })
    expect(queryOne<{ name: string }>(`SELECT name FROM contacts WHERE id = 'bea'`)?.name).toBe('Bea Paz')
  })

  it('refuses a merge decision with no state to restore, and a decision already undone', () => {
    let merge = ''
    let speaker = ''
    runInTransaction(() => {
      merge = recordDecisionNoSave({
        kind: 'merge',
        subjectKey: 'merge:ana:bea',
        method: 'email',
        contactId: 'ana',
        evidence: {},
        before: null
      })
      speaker = recordDecisionNoSave({
        kind: 'speaker',
        subjectKey: speakerSubjectKey('rec', 'Speaker 9'),
        method: 'voice',
        contactId: 'ana',
        evidence: {},
        before: snapshotSpeakerNoSave('rec', 'Speaker 9')
      })
    })
    expect(() => undoDecision(merge)).toThrow(/no state to restore/)
    undoDecision(speaker)
    expect(() => undoDecision(speaker)).toThrow(/already undone/)
    expect(() => undoDecision('missing')).toThrow(/not found/)
  })
})
