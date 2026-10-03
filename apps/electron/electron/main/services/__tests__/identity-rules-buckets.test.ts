// @vitest-environment node

/**
 * A shared first name in a recording (spec 2026-10-03, 3a): the rules added in front of
 * today's order, and the auto-split that applies them with a journal entry each.
 *
 * REAL temp DB, real database.ts (better-sqlite3). Voices are written as fixtures, the way
 * the voice step writes them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-identity-rules-buckets-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { closeDatabase, getBucketResolution, initializeDatabase, queryOne, run } from '../database'
import { autoSplitAmbiguousBuckets } from '../org-reconciler'
import { listDecisions, mentionSubjectKey, undoDecision } from '../identity-decisions'

const T = '2026-10-01T10:00:00Z'

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

function contact(id: string, name: string): void {
  run(
    `INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, meeting_count, source)
     VALUES (?, ?, 'unknown', ?, ?, 0, 'user')`,
    [id, name, T, T]
  )
}

function meeting(id: string): void {
  run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, '2026-10-01T11:00:00Z')`, [
    id,
    `Meeting ${id}`,
    T
  ])
}

function recording(id: string, meetingId: string, filename = `${id}.wav`): void {
  run(`INSERT INTO recordings (id, filename, date_recorded, status, meeting_id) VALUES (?, ?, ?, 'complete', ?)`, [
    id,
    filename,
    T,
    meetingId
  ])
}

function attend(meetingId: string, contactId: string): void {
  run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES (?, ?, 'attendee', 'calendar')`, [
    meetingId,
    contactId
  ])
}

/** A voice in a recording; the cluster is tied to `contactId` when given. */
function voice(recordingId: string, clusterId: string, contactId: string | null, similarity = 0.95): void {
  if (!queryOne('SELECT 1 FROM voice_clusters WHERE id = ?', [clusterId])) {
    run(
      `INSERT INTO voice_clusters
       (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds,
        contact_id, contact_link_method, contact_link_confidence)
       VALUES (?, 'community-1', '4.0.0', 3, '[1,0,0]', 1, 60, ?, ?, ?)`,
      [clusterId, contactId, contactId ? 'manual' : null, contactId ? 1 : null]
    )
  }
  run(
    `INSERT INTO recording_voice_clusters
     (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
     VALUES (?, ?, ?, ?, 'matched', ?)`,
    [recordingId, `SPEAKER_${clusterId}`, `Voice ${clusterId}`, clusterId, similarity]
  )
}

const mention = (recordingId: string) =>
  queryOne<{ resolved_contact_id: string | null; method: string | null }>(
    `SELECT resolved_contact_id, method FROM mention_resolutions WHERE recording_id = ? AND source_name = 'sergio'`,
    [recordingId]
  )

const rec = (recordingId: string, ownerContactId?: string) =>
  getBucketResolution('bucket', { ownerContactId })!.recordings.find((r) => r.recordingId === recordingId)!

beforeEach(async () => {
  cleanup()
  await initializeDatabase()
  contact('sh', 'Sergio Hurtado')
  contact('sr', 'Sergio Reyes')
  contact('bucket', 'Sergio')
})

afterEach(() => {
  closeDatabase()
  cleanup()
})

/** Both Sergios attended; the bare "Sergio" mention is linked to the meeting too. */
function bothAttended(recordingId: string): void {
  meeting(`m-${recordingId}`)
  recording(recordingId, `m-${recordingId}`)
  attend(`m-${recordingId}`, 'bucket')
  attend(`m-${recordingId}`, 'sh')
  attend(`m-${recordingId}`, 'sr')
}

describe('voice-presence', () => {
  it('resolves the mention to the one candidate whose voice is in the recording', () => {
    bothAttended('r1')
    voice('r1', 'v-sh', 'sh')
    // Reyes has a known voice, heard elsewhere and not here: he did not speak in r1.
    meeting('m-other')
    recording('r-other', 'm-other')
    voice('r-other', 'v-sr', 'sr')

    expect(rec('r1')).toMatchObject({ method: 'voice-presence', bestGuessId: 'sh' })
    expect(autoSplitAmbiguousBuckets().resolved).toBe(1)
    expect(mention('r1')).toEqual({ resolved_contact_id: 'sh', method: 'voice-presence' })
  })

  it('stays undecided when another candidate attended and nobody knows that candidate\'s voice', () => {
    bothAttended('r1')
    voice('r1', 'v-sh', 'sh')

    const r = rec('r1')
    expect(r.method).toBe('unclear')
    expect([...r.supportedCandidateIds].sort()).toEqual(['sh', 'sr'])
    autoSplitAmbiguousBuckets()
    expect(mention('r1')).toBeUndefined()
  })

  it('a voice that matched its cluster below 0.9 is not presence', () => {
    meeting('m1')
    recording('r1', 'm1')
    attend('m1', 'bucket')
    voice('r1', 'v-sh', 'sh', 0.8)
    expect(rec('r1').method).toBe('unclear')
  })
})

describe('owner-presence', () => {
  beforeEach(() => {
    contact('owner', 'Sergio Geraldes')
  })

  it('resolves to the owner on a Live recording where no other candidate attended or speaks', () => {
    meeting('m1')
    recording('r1', 'm1', '2026Oct01-100000-Live.wav')
    attend('m1', 'bucket')

    expect(rec('r1', 'owner')).toMatchObject({ method: 'owner-presence', bestGuessId: 'owner' })
    expect(autoSplitAmbiguousBuckets({ ownerContactId: 'owner' }).resolved).toBe(1)
    expect(mention('r1')).toEqual({ resolved_contact_id: 'owner', method: 'owner-presence' })
  })

  it('does not apply without an owner, or when another candidate attended', () => {
    meeting('m1')
    recording('r1', 'm1', '2026Oct01-100000-Live.wav')
    attend('m1', 'bucket')
    expect(rec('r1').method).toBe('unclear')

    attend('m1', 'sr')
    expect(rec('r1', 'owner').method).not.toBe('owner-presence')
  })
})

describe('auto-split journal', () => {
  it('journals every applied mention decision with the state before, and the undo holds', () => {
    bothAttended('r1')
    voice('r1', 'v-sh', 'sh')
    meeting('m-other')
    recording('r-other', 'm-other')
    voice('r-other', 'v-sr', 'sr')

    autoSplitAmbiguousBuckets()
    const [decision] = listDecisions()
    expect(decision).toMatchObject({
      kind: 'mention',
      subjectKey: mentionSubjectKey('r1', 'bucket'),
      method: 'voice-presence',
      contactId: 'sh',
      before: { recordingId: 'r1', sourceName: 'sergio', row: null }
    })
    expect(decision.evidence).toMatchObject({ bucketContactId: 'bucket', voicedCandidateIds: ['sh'] })

    expect(undoDecision(decision.id)).toEqual({ restored: true })
    expect(mention('r1')).toBeUndefined()

    // The owner's undo holds: no rule names Hurtado for this mention again.
    autoSplitAmbiguousBuckets()
    expect(mention('r1')).toBeUndefined()
  })

  it('never overwrites a manual decision', () => {
    bothAttended('r1')
    voice('r1', 'v-sh', 'sh')
    meeting('m-other')
    recording('r-other', 'm-other')
    voice('r-other', 'v-sr', 'sr')
    run(
      `INSERT INTO mention_resolutions (id, recording_id, source_name, resolved_contact_id, method, confidence, created_at)
       VALUES ('mr', 'r1', 'sergio', 'sr', 'manual', 1, ?)`,
      [T]
    )
    expect(autoSplitAmbiguousBuckets().resolved).toBe(0)
    expect(mention('r1')).toEqual({ resolved_contact_id: 'sr', method: 'manual' })
    expect(listDecisions()).toEqual([])
  })

  it('upgrades a weaker stored guess and journals it', () => {
    bothAttended('r1')
    voice('r1', 'v-sh', 'sh')
    meeting('m-other')
    recording('r-other', 'm-other')
    voice('r-other', 'v-sr', 'sr')
    run(
      `INSERT INTO mention_resolutions (id, recording_id, source_name, resolved_contact_id, method, confidence, created_at)
       VALUES ('mr', 'r1', 'sergio', 'sh', 'attendee-context', 0.7, ?)`,
      [T]
    )
    expect(autoSplitAmbiguousBuckets().resolved).toBe(1)
    expect(mention('r1')).toEqual({ resolved_contact_id: 'sh', method: 'voice-presence' })
    expect(listDecisions()[0].before).toMatchObject({ row: { method: 'attendee-context' } })
  })
})
