// @vitest-environment node

/**
 * People shows what is left and how the app decided (spec 2026-10-03, Phase 4).
 *
 *   identity:listDecisions       the journal, with what the page needs to say each decision in words
 *   identity:undoDecision        Undo one decision, errors in words
 *   identity:listVoiceConflicts  the voice conflicts still open, with names, title and date
 *   identity:resolveVoiceConflict  "Keep <bound name>" or "It is <voice's person>"
 *   identity:getQuestionCounts   Settings > Speakers & voices: counts per kind of question
 *
 * REAL handlers, REAL DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-identity-decisions-ipc-${process.pid}.sqlite`)
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => dbPath }))

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn) } }
}))

import {
  closeDatabase,
  initializeDatabase,
  insertIdentitySuggestion,
  mergeContacts,
  mergeJournalIdsFor,
  queryAll,
  queryOne,
  run,
  runInTransaction
} from '../../services/database'
import {
  mentionSubjectKey,
  mergeSubjectKey,
  recordDecisionNoSave,
  snapshotMentionNoSave,
  snapshotSpeakerNoSave,
  speakerSubjectKey,
  voiceAnchorSubjectKey
} from '../../services/identity-decisions'
import { recordVoiceConflictNoSave } from '../../services/speaker-linking'
import { registerIdentityHandlers } from '../identity-handlers'

function invoke(channel: string, ...args: any[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(fn({} as any, ...args))
}

function contact(id: string, name: string, email: string | null = null): void {
  run(
    `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, source)
     VALUES (?, ?, ?, 'unknown', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'user')`,
    [id, name, email]
  )
}

function seed(): void {
  contact('ana', 'Ana Ruiz')
  contact('bea', 'Bea Paz')
  contact('seb', 'Sebastian Geraldes')
  contact('sebas', 'Sebas')
  run(
    `INSERT INTO meetings (id, subject, start_time, end_time) VALUES ('m1', 'Weekly sync', '2026-09-12T10:00:00Z', '2026-09-12T11:00:00Z')`
  )
  run(`INSERT INTO recordings (id, filename, date_recorded, meeting_id) VALUES ('rec1', 'rec1.wav', '2026-09-12T10:00:00Z', 'm1')`)
  run(`INSERT INTO recordings (id, filename, date_recorded) VALUES ('rec2', 'rec2.wav', '2026-10-03T09:00:00Z')`)
}

function speakerDecision(recordingId: string, label: string, contactId: string, method: string, at: string): string {
  let id = ''
  runInTransaction(() => {
    const before = snapshotSpeakerNoSave(recordingId, label)
    run(
      `INSERT OR REPLACE INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
       VALUES (?, ?, ?, ?, ?, 0.9)`,
      [`ts-${recordingId}-${label}`, recordingId, label, contactId, method]
    )
    id = recordDecisionNoSave({
      kind: 'speaker',
      subjectKey: speakerSubjectKey(recordingId, label),
      method,
      contactId,
      evidence: { voiceClusterId: 'v1' },
      before
    })
  })
  run('UPDATE identity_decisions SET created_at = ? WHERE id = ?', [at, id])
  return id
}

function seedConflict(): string {
  run(
    `INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
     VALUES ('ts-conf', 'rec1', 'Speaker 2', 'bea', 'manual', 1)`
  )
  runInTransaction(() => {
    recordVoiceConflictNoSave({
      recordingId: 'rec1',
      speakerLabel: 'Speaker 2',
      voiceClusterId: null,
      similarity: 0.93,
      voiceContactId: 'ana',
      boundContactId: 'bea',
      boundSource: 'manual'
    })
  })
  return queryOne<{ id: string }>("SELECT id FROM identity_suggestions WHERE candidate_name LIKE 'voice-conflict:%'")!.id
}

const speakerOf = (recordingId: string, label: string) =>
  queryOne<{ contact_id: string; source: string | null }>(
    'SELECT contact_id, source FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
    [recordingId, label]
  )
const suggestionStatus = (id: string) =>
  queryOne<{ status: string }>('SELECT status FROM identity_suggestions WHERE id = ?', [id])!.status
const aliases = () => queryAll<{ alias_norm: string }>('SELECT alias_norm FROM contact_aliases')

beforeEach(async () => {
  handlers.clear()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
  registerIdentityHandlers()
  seed()
})

afterEach(() => {
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('identity:listDecisions', () => {
  it('returns each decision newest first with the person, the recording title and date, the kind and the method', async () => {
    speakerDecision('rec1', 'Speaker 2', 'ana', 'one-on-one', '2026-10-01T10:00:00.000Z')
    runInTransaction(() => {
      const before = snapshotMentionNoSave('rec2', 'Sebas')
      run(
        `INSERT INTO mention_resolutions (id, recording_id, source_name, resolved_contact_id, method, confidence)
         VALUES ('mr1', 'rec2', 'sebas', 'seb', 'voice-presence', 0.82)`
      )
      recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec2', 'sebas'),
        method: 'voice-presence',
        contactId: 'seb',
        evidence: { bucketContactId: 'sebas', bucketName: 'Sebas' },
        before
      })
    })
    run("UPDATE identity_decisions SET created_at = '2026-10-02T10:00:00.000Z' WHERE kind = 'mention'")

    const res = await invoke('identity:listDecisions', { limit: 10 })

    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({
      kind: 'mention',
      method: 'voice-presence',
      personName: 'Sebastian Geraldes',
      subjectName: 'Sebas',
      recordingId: 'rec2',
      recordingTitle: 'rec2.wav',
      recordingDate: '2026-10-03T09:00:00Z',
      meetingSubject: null,
      createdAt: '2026-10-02T10:00:00.000Z',
      undoneAt: null
    })
    expect(res.data[1]).toMatchObject({
      kind: 'speaker',
      method: 'one-on-one',
      personName: 'Ana Ruiz',
      subjectName: 'Speaker 2',
      recordingId: 'rec1',
      meetingSubject: 'Weekly sync',
      recordingDate: '2026-09-12T10:00:00Z'
    })
  })

  it('says how many recordings taught a voice, and the merged-away name of a merge', async () => {
    run(
      `INSERT INTO voice_clusters (id, model, model_version, embedding_dimension, centroid_json, contact_id, created_at, updated_at)
       VALUES ('v1', 'wespeaker', '1', 2, '[1,0]', NULL, '2026-09-01', '2026-09-01')`
    )
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'voice-anchor',
        subjectKey: voiceAnchorSubjectKey('v1'),
        method: 'one-on-one',
        contactId: 'ana',
        evidence: { votes: [{ recordingId: 'rec1', method: 'one-on-one' }, { recordingId: 'rec2', method: 'one-on-one' }] },
        before: { clusterId: 'v1', contactId: null, method: null, confidence: null }
      })
    })
    contact('ana-r', 'Ana R.')
    mergeContacts('ana', 'ana-r')
    const journalId = [...mergeJournalIdsFor('contact', 'ana')][0]
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'merge',
        subjectKey: mergeSubjectKey('ana', 'ana-r'),
        method: 'exact-email',
        contactId: 'ana',
        evidence: { emailMatch: 'exact' },
        before: { mergeJournalId: journalId, keeperId: 'ana', loserId: 'ana-r', suggestionId: null, suggestionStatus: null }
      })
    })

    const res = await invoke('identity:listDecisions', { limit: 10 })

    const anchor = res.data.find((d: any) => d.kind === 'voice-anchor')
    expect(anchor).toMatchObject({ personName: 'Ana Ruiz', votes: { oneOnOne: 2, elimination: 0 }, recordingId: null })
    const merge = res.data.find((d: any) => d.kind === 'merge')
    expect(merge).toMatchObject({ personName: 'Ana Ruiz', subjectName: 'Ana R.', method: 'exact-email' })
  })

  it("carries Jev's probability for a tiebreak", async () => {
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec2', 'sebas'),
        method: 'jev-tiebreak',
        contactId: 'seb',
        evidence: { bucketName: 'Sebas', probability: 0.87, margin: 0.6 },
        before: snapshotMentionNoSave('rec2', 'Sebas')
      })
    })
    const res = await invoke('identity:listDecisions', {})
    expect(res.data[0]).toMatchObject({ method: 'jev-tiebreak', probability: 0.87 })
  })

  it('leaves undone decisions out unless asked, and refuses a bad request', async () => {
    const id = speakerDecision('rec1', 'Speaker 2', 'ana', 'voice', '2026-10-01T10:00:00.000Z')
    run("UPDATE identity_decisions SET undone_at = '2026-10-02T00:00:00Z' WHERE id = ?", [id])

    expect((await invoke('identity:listDecisions', { limit: 10 })).data).toEqual([])
    const all = await invoke('identity:listDecisions', { limit: 10, includeUndone: true })
    expect(all.data).toHaveLength(1)
    expect(all.data[0].undoneAt).toBe('2026-10-02T00:00:00Z')

    const bad = await invoke('identity:listDecisions', { limit: 0 })
    expect(bad.success).toBe(false)
    expect(bad.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('identity:undoDecision', () => {
  it('puts the state before back and says whether it did', async () => {
    const id = speakerDecision('rec1', 'Speaker 2', 'ana', 'elimination', '2026-10-01T10:00:00.000Z')

    const res = await invoke('identity:undoDecision', id)

    expect(res).toEqual({ success: true, data: { restored: true } })
    expect(speakerOf('rec1', 'Speaker 2')).toBeUndefined()
    expect(queryOne<{ undone_at: string | null }>('SELECT undone_at FROM identity_decisions WHERE id = ?', [id])!.undone_at)
      .not.toBeNull()
  })

  it('explains in words when the decision is gone or already undone', async () => {
    const missing = await invoke('identity:undoDecision', 'nope')
    expect(missing.success).toBe(false)
    expect(missing.error.code).toBe('NOT_FOUND')
    expect(missing.error.message).toMatch(/no longer exists/i)

    const id = speakerDecision('rec1', 'Speaker 2', 'ana', 'elimination', '2026-10-01T10:00:00.000Z')
    await invoke('identity:undoDecision', id)
    const again = await invoke('identity:undoDecision', id)
    expect(again.success).toBe(false)
    expect(again.error.code).toBe('VALIDATION_ERROR')
    expect(again.error.message).toMatch(/already undone/i)
  })
})

describe('voice conflicts', () => {
  it('lists the open ones in words: recording, speaker, the voice person and the named person', async () => {
    const id = seedConflict()

    const res = await invoke('identity:listVoiceConflicts')

    expect(res.success).toBe(true)
    expect(res.data).toEqual([
      {
        id,
        recordingId: 'rec1',
        recordingTitle: 'rec1.wav',
        recordingDate: '2026-09-12T10:00:00Z',
        meetingSubject: 'Weekly sync',
        speakerLabel: 'Speaker 2',
        voiceContactId: 'ana',
        voiceContactName: 'Ana Ruiz',
        boundContactId: 'bea',
        boundContactName: 'Bea Paz',
        boundSource: 'manual'
      }
    ])
  })

  it('"Keep" rejects the suggestion, leaves the speaker as named, and writes no alias', async () => {
    const id = seedConflict()

    const res = await invoke('identity:resolveVoiceConflict', id, 'keep')

    expect(res.success).toBe(true)
    expect(suggestionStatus(id)).toBe('rejected')
    expect(speakerOf('rec1', 'Speaker 2')).toEqual({ contact_id: 'bea', source: 'manual' })
    expect(aliases()).toEqual([])
    expect((await invoke('identity:listVoiceConflicts')).data).toEqual([])
  })

  it('"It is <voice person>" re-binds the speaker by hand and resolves the suggestion', async () => {
    const id = seedConflict()

    const res = await invoke('identity:resolveVoiceConflict', id, 'voice')

    expect(res.success).toBe(true)
    expect(suggestionStatus(id)).toBe('accepted')
    expect(speakerOf('rec1', 'Speaker 2')).toEqual({ contact_id: 'ana', source: 'manual' })
    expect(aliases()).toEqual([])
  })

  it('refuses a suggestion that is not a voice conflict, one already answered, and a bad choice', async () => {
    insertIdentitySuggestion('person', 'Anita', 'ana', 0.7, { signals: { name: 0.7 }, composite: 0.7 })
    const plain = queryOne<{ id: string }>("SELECT id FROM identity_suggestions WHERE candidate_name = 'Anita'")!.id
    const notConflict = await invoke('identity:resolveVoiceConflict', plain, 'keep')
    expect(notConflict.success).toBe(false)
    expect(notConflict.error.code).toBe('VALIDATION_ERROR')
    expect(suggestionStatus(plain)).toBe('pending')

    const id = seedConflict()
    await invoke('identity:resolveVoiceConflict', id, 'keep')
    const twice = await invoke('identity:resolveVoiceConflict', id, 'voice')
    expect(twice.success).toBe(false)
    expect(twice.error.code).toBe('SUGGESTION_STALE')
    expect(twice.error.message).toMatch(/already answered/i)
    expect(speakerOf('rec1', 'Speaker 2')).toEqual({ contact_id: 'bea', source: 'manual' })

    const bad = await invoke('identity:resolveVoiceConflict', id, 'maybe')
    expect(bad.success).toBe(false)
    expect(bad.error.code).toBe('VALIDATION_ERROR')
  })

  it('the generic accept and reject still refuse a voice conflict', async () => {
    const id = seedConflict()
    expect((await invoke('identity:acceptSuggestion', id)).error.code).toBe('VOICE_CONFLICT')
    expect((await invoke('identity:rejectSuggestion', id)).error.code).toBe('VOICE_CONFLICT')
    expect(suggestionStatus(id)).toBe('pending')
  })
})

describe('identity:getQuestionCounts', () => {
  it('counts pending, decided automatically and decided by the owner, per kind of question', async () => {
    // Speakers: one named by a rule, one by hand, one voice heard but not named.
    speakerDecision('rec1', 'Speaker 1', 'ana', 'voice', '2026-10-01T10:00:00.000Z')
    const undone = speakerDecision('rec1', 'Speaker 3', 'seb', 'voice', '2026-10-01T10:00:00.000Z')
    run("UPDATE identity_decisions SET undone_at = '2026-10-02T00:00:00Z' WHERE id = ?", [undone])
    run(
      `INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
       VALUES ('ts-man', 'rec2', 'Speaker 1', 'seb', 'manual', 1)`
    )
    run(
      `INSERT INTO voice_clusters (id, model, model_version, embedding_dimension, centroid_json, contact_id, created_at, updated_at)
       VALUES ('vx', 'wespeaker', '1', 2, '[1,0]', NULL, '2026-09-01', '2026-09-01')`
    )
    run(
      `INSERT INTO recording_voice_clusters (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
       VALUES ('rec2', 'SPEAKER_01', 'Speaker 2', 'vx', 'new', NULL)`
    )
    // Duplicate people: one pending, one decided by the owner.
    insertIdentitySuggestion('person', 'Anita', 'ana', 0.7, { signals: { name: 0.7 }, composite: 0.7 })
    insertIdentitySuggestion('person', 'Bea P', 'bea', 0.7, { signals: { name: 0.7 }, composite: 0.7 })
    run("UPDATE identity_suggestions SET status = 'rejected' WHERE candidate_name = 'Bea P'")
    // Voices: 'vx' is heard and tied to nobody; 'vm' was tied by the owner.
    run(
      `INSERT INTO voice_clusters (id, model, model_version, embedding_dimension, centroid_json, contact_id, contact_link_method, created_at, updated_at)
       VALUES ('vm', 'wespeaker', '1', 2, '[0,1]', 'seb', 'manual', '2026-09-01', '2026-09-01')`
    )
    // Voice conflicts: one pending.
    seedConflict()

    const res = await invoke('identity:getQuestionCounts')

    expect(res.success).toBe(true)
    const row = (kind: string) => res.data.rows.find((r: any) => r.kind === kind)
    expect(res.data.rows.map((r: any) => r.kind)).toEqual([
      'shared-first-names',
      'duplicate-people',
      'speakers',
      'voices',
      'voice-conflicts'
    ])
    expect(row('speakers')).toEqual({ kind: 'speakers', pending: 1, automatic: 1, owner: 2 })
    expect(row('voices')).toEqual({ kind: 'voices', pending: 1, automatic: 0, owner: 1 })
    expect(row('duplicate-people')).toEqual({ kind: 'duplicate-people', pending: 1, automatic: 0, owner: 1 })
    expect(row('voice-conflicts')).toEqual({ kind: 'voice-conflicts', pending: 1, automatic: 0, owner: 0 })
    expect(row('shared-first-names')).toMatchObject({ kind: 'shared-first-names', automatic: 0, owner: 0 })
  })

  it('the automatic column adds up to the decisions People lists, voices included', async () => {
    speakerDecision('rec1', 'Speaker 1', 'ana', 'voice', '2026-10-01T10:00:00.000Z')
    const undone = speakerDecision('rec1', 'Speaker 3', 'seb', 'voice', '2026-10-01T10:00:00.000Z')
    run("UPDATE identity_decisions SET undone_at = '2026-10-02T00:00:00Z' WHERE id = ?", [undone])
    runInTransaction(() => {
      recordDecisionNoSave({
        kind: 'voice-anchor',
        subjectKey: voiceAnchorSubjectKey('v1'),
        method: 'one-on-one',
        contactId: 'ana',
        evidence: { votes: [] },
        before: { clusterId: 'v1', contactId: null, method: null, confidence: null }
      })
      recordDecisionNoSave({
        kind: 'mention',
        subjectKey: mentionSubjectKey('rec2', 'sebas'),
        method: 'voice-presence',
        contactId: 'seb',
        evidence: { bucketName: 'Sebas' },
        before: snapshotMentionNoSave('rec2', 'Sebas')
      })
      recordDecisionNoSave({
        kind: 'merge',
        subjectKey: mergeSubjectKey('ana', 'gone'),
        method: 'exact-email',
        contactId: 'ana',
        evidence: { loserName: 'Ana R.' },
        before: null
      })
    })

    const counts = await invoke('identity:getQuestionCounts')
    const listed = await invoke('identity:listDecisions', { limit: 100 })

    const automatic = counts.data.rows.reduce((sum: number, r: any) => sum + r.automatic, 0)
    expect(listed.data).toHaveLength(4)
    expect(automatic).toBe(listed.data.length)
  })

  it('counts duplicate people the way People shows them: unreadable evidence and bucket targets left out', async () => {
    insertIdentitySuggestion('person', 'Anita', 'ana', 0.7, { signals: { name: 0.7 }, composite: 0.7 })
    // Revalidation drops a suggestion whose evidence cannot be read.
    run(
      `INSERT INTO identity_suggestions (id, kind, candidate_name, target_id, confidence, evidence, status)
       VALUES ('bad-ev', 'person', 'Beatriz', 'bea', 0.7, 'not json', 'pending')`
    )
    // People drops a merge whose keeper is a shared first name ("Sergio" = two people).
    contact('s-h', 'Sergio Hurtado')
    contact('s-r', 'Sergio Reyes')
    contact('s-bucket', 'Sergio')
    insertIdentitySuggestion('person', 'Sergi', 's-bucket', 0.7, { signals: { name: 0.7 }, composite: 0.7 })

    const listed = await invoke('identity:getSuggestions', 'pending')
    expect(listed.data.map((s: any) => s.candidate_name).sort()).toEqual(['Anita', 'Sergi'])

    const res = await invoke('identity:getQuestionCounts')
    expect(res.data.rows.find((r: any) => r.kind === 'duplicate-people').pending).toBe(1)
  })
})

describe('a voice conflict in a recording that left the library', () => {
  it('"It is <voice person>" says so for good, changes no speaker, and closes the question', async () => {
    const id = seedConflict()
    run("UPDATE recordings SET deleted_at = '2026-10-03T00:00:00Z' WHERE id = 'rec1'")

    const res = await invoke('identity:resolveVoiceConflict', id, 'voice')

    expect(res.success).toBe(false)
    expect(res.error.code).toBe('RECORDING_INELIGIBLE')
    expect(res.error.message).toBe(
      'That recording is no longer in the library (trashed or marked personal), so its speaker cannot be changed.'
    )
    expect(suggestionStatus(id)).toBe('rejected')
    expect(speakerOf('rec1', 'Speaker 2')).toEqual({ contact_id: 'bea', source: 'manual' })
    expect(aliases()).toEqual([])
  })
})
