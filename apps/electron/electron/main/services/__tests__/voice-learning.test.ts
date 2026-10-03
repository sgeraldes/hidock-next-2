// @vitest-environment node

/**
 * Learning voices from the simplest meetings up (spec 2026-10-03, Phase 2): the owner's voice,
 * one-on-one meetings, elimination, and propagation with the conflict rule.
 *
 * REAL temp DB, real database.ts (better-sqlite3). The voice worker never runs: the voice
 * evidence is written as fixtures, the way persistMatches would write it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-voice-learning-${process.pid}.sqlite`)

const identityConfig = vi.hoisted(() => ({ ownerContactId: 'owner' as string | undefined }))

vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../config', () => ({
  getConfig: () => ({
    identity: { ownerContactId: identityConfig.ownerContactId },
    transcription: {
      speakerLinkingEnabled: true,
      speakerLinkingMatchThreshold: 0.72,
      speakerLinkingMatchMargin: 0.08,
      speakerLinkingMinSpeechSeconds: 4
    }
  }),
  getDataPath: () => tmpdir(),
  updateConfig: vi.fn()
}))

import { closeDatabase, initializeDatabase, queryAll, queryOne, run } from '../database'
import { undoDecision, listDecisions } from '../identity-decisions'
import { applyKnownVoiceBindings } from '../speaker-linking'
import {
  learnByElimination,
  learnFromOneOnOne,
  meetingAttendeeContacts,
  ownerVoiceClusterIds,
  recordingVoices,
  runVoiceLearning,
  ELIMINATION_CONFIDENCE,
  ONE_ON_ONE_CONFIDENCE
} from '../voice-learning'

const EXPECTED_SCHEMA_VERSION = Number(
  readFileSync(join(__dirname, '..', 'database.ts'), 'utf-8').match(/const SCHEMA_VERSION = (\d+)\b/)![1]
)

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

const T = '2026-10-01T10:00:00Z'

function contact(id: string, name: string, email: string | null = `${id}@dfx5.com`): void {
  run(
    `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, source)
     VALUES (?, ?, ?, 'unknown', ?, ?, 'user')`,
    [id, name, email, T, T]
  )
}

function meeting(id: string, attendeeEmails: string[], organizerEmail: string | null = null): void {
  run(
    `INSERT INTO meetings (id, subject, start_time, end_time, organizer_email, attendees)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      `Meeting ${id}`,
      T,
      '2026-10-01T11:00:00Z',
      organizerEmail,
      JSON.stringify(attendeeEmails.map((email) => ({ name: email.split('@')[0], email })))
    ]
  )
}

function recording(id: string, meetingId: string | null, date = T): void {
  run('INSERT INTO recordings (id, filename, date_recorded, meeting_id) VALUES (?, ?, ?, ?)', [
    id,
    `${id}.wav`,
    date,
    meetingId
  ])
}

interface VoiceSeed {
  cluster: string
  contactId?: string | null
  method?: string | null
  seconds?: number
  similarity?: number | null
  label?: string | null
  local?: string
}

/** What persistMatches (and the backfill's tie step) write for one voice of a recording. */
function voice(recordingId: string, seed: VoiceSeed): void {
  if (!queryOne('SELECT 1 FROM voice_clusters WHERE id = ?', [seed.cluster])) {
    run(
      `INSERT INTO voice_clusters
       (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds,
        contact_id, contact_link_method, contact_link_confidence)
       VALUES (?, 'community-1', '4.0.0', 3, '[1,0,0]', 1, 60, ?, ?, ?)`,
      [seed.cluster, seed.contactId ?? null, seed.contactId ? seed.method ?? 'manual' : null, seed.contactId ? 1 : null]
    )
  }
  const local = seed.local ?? `SPEAKER_${seed.cluster}`
  run(
    `INSERT INTO voice_cluster_observations
     (id, voice_cluster_id, recording_id, local_speaker_label, embedding_json, speech_seconds)
     VALUES (?, ?, ?, ?, '[1,0,0]', ?)`,
    [`obs-${recordingId}-${local}`, seed.cluster, recordingId, local, seed.seconds ?? 120]
  )
  run(
    `INSERT INTO recording_voice_clusters
     (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
     VALUES (?, ?, ?, ?, 'matched', ?)`,
    [
      recordingId,
      local,
      seed.label === undefined ? `Voice ${seed.cluster}` : seed.label,
      seed.cluster,
      seed.similarity === undefined ? 0.95 : seed.similarity
    ]
  )
}

const OWNER_VOICE: VoiceSeed = { cluster: 'v-owner', contactId: 'owner', method: 'live-channel' }

const cluster = (id: string) =>
  queryOne<{ contact_id: string | null; contact_link_method: string | null; contact_link_confidence: number | null }>(
    'SELECT contact_id, contact_link_method, contact_link_confidence FROM voice_clusters WHERE id = ?',
    [id]
  )

const speaker = (recordingId: string, label: string) =>
  queryOne<{ contact_id: string; source: string | null; confidence: number | null }>(
    'SELECT contact_id, source, confidence FROM transcript_speakers WHERE recording_id = ? AND speaker_label = ?',
    [recordingId, label]
  )

const votes = (clusterId: string) =>
  queryAll<{ contact_id: string; recording_id: string }>(
    'SELECT contact_id, recording_id FROM voice_elimination_votes WHERE cluster_id = ? ORDER BY recording_id',
    [clusterId]
  )

/** A meeting of the owner and Bea, recorded, with the owner's voice and one unknown voice. */
function oneOnOne(recordingId = 'r1', other: VoiceSeed = { cluster: 'v-bea' }): void {
  meeting(`m-${recordingId}`, ['owner@dfx5.com', 'bea@dfx5.com'])
  recording(recordingId, `m-${recordingId}`)
  voice(recordingId, OWNER_VOICE)
  voice(recordingId, other)
}

/** A meeting of the owner, Bea and Carl where the owner and Bea are known by voice. */
function threeWithCarlUnknown(recordingId: string, unknownCluster = 'v-carl'): void {
  meeting(`m-${recordingId}`, ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
  recording(recordingId, `m-${recordingId}`)
  voice(recordingId, OWNER_VOICE)
  voice(recordingId, { cluster: 'v-bea-known', contactId: 'bea' })
  voice(recordingId, { cluster: unknownCluster })
}

beforeEach(async () => {
  cleanup()
  identityConfig.ownerContactId = 'owner'
  await initializeDatabase()
  contact('owner', 'Sebastian Geraldes')
  contact('bea', 'Bea Paz')
  contact('carl', 'Carl Ruiz')
  contact('dana', 'Dana Soto')
})

afterEach(() => {
  closeDatabase()
  cleanup()
})

describe('schema', () => {
  it('creates voice_elimination_votes keyed by cluster and recording', () => {
    const columns = queryAll<{ name: string; pk: number }>('PRAGMA table_info(voice_elimination_votes)')
    expect(columns.map((c) => c.name)).toEqual(['cluster_id', 'contact_id', 'recording_id', 'created_at'])
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['cluster_id', 'recording_id'])
    expect(EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(67)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })

  it('the migration creates the table on a database that predates v67', async () => {
    closeDatabase()
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(dbPath)
    raw.exec('DROP TABLE voice_elimination_votes')
    raw.exec('DELETE FROM schema_version WHERE version >= 67')
    raw.close()

    await initializeDatabase()

    expect(queryAll('PRAGMA table_info(voice_elimination_votes)')).toHaveLength(4)
    expect(queryOne<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')!.v).toBe(EXPECTED_SCHEMA_VERSION)
  })
})

describe('ownerVoiceClusterIds', () => {
  it('lists the clusters tied to the owner, and none without an owner', () => {
    recording('r1', null)
    voice('r1', OWNER_VOICE)
    voice('r1', { cluster: 'v-bea', contactId: 'bea' })
    expect(ownerVoiceClusterIds()).toEqual(['v-owner'])
    identityConfig.ownerContactId = undefined
    expect(ownerVoiceClusterIds()).toEqual([])
  })
})

describe('meetingAttendeeContacts', () => {
  it('matches attendee and organizer emails without case, adds calendar links, and counts each contact once', () => {
    meeting('m1', ['OWNER@dfx5.com', 'Bea@DFX5.com', 'nobody@else.com'], 'carl@dfx5.com')
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES ('m1', 'bea', 'attendee', 'calendar')`)
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES ('m1', 'dana', 'attendee', 'calendar')`)
    run(`INSERT INTO contacts (id, name, type, first_seen_at, last_seen_at, source)
         VALUES ('eve', 'Eve', 'unknown', ?, ?, 'transcript')`, [T, T])
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES ('m1', 'eve', 'attendee', 'transcript')`)

    const attendees = meetingAttendeeContacts('m1')

    expect([...attendees.contactIds].sort()).toEqual(['bea', 'carl', 'dana', 'owner'])
    expect(attendees.ownerId).toBe('owner')
    expect(attendees.ownerAttends).toBe(true)
  })

  it('says when the owner is not among the attendees', () => {
    meeting('m1', ['bea@dfx5.com'])
    const attendees = meetingAttendeeContacts('m1')
    expect(attendees.contactIds).toEqual(['bea'])
    expect(attendees.ownerAttends).toBe(false)
  })
})

describe('recordingVoices', () => {
  it('sums each voice speech, names the contact of its cluster and says whether it matched at 0.9 or more', () => {
    recording('r1', null)
    voice('r1', { ...OWNER_VOICE, seconds: 40 })
    // A second observation of the same voice, left under the cluster it was merged from.
    run(`INSERT INTO voice_clusters (id, model, model_version, embedding_dimension, centroid_json)
         VALUES ('v-old', 'community-1', '4.0.0', 3, '[1,0,0]')`)
    run(
      `INSERT INTO voice_cluster_observations
       (id, voice_cluster_id, recording_id, local_speaker_label, embedding_json, speech_seconds)
       VALUES ('obs-extra', 'v-old', 'r1', 'SPEAKER_v-owner', '[1,0,0]', 15)`
    )
    voice('r1', { cluster: 'v-bea', contactId: 'bea', similarity: 0.8, seconds: 50 })
    voice('r1', { cluster: 'v-new', similarity: null, seconds: 31, label: null })

    const voices = recordingVoices('r1')
    const byCluster = Object.fromEntries(voices.map((v) => [v.clusterId, v]))

    expect(byCluster['v-owner']).toMatchObject({ speechSeconds: 55, clusterContactId: 'owner', knownContactId: 'owner' })
    expect(byCluster['v-bea']).toMatchObject({ speechSeconds: 50, clusterContactId: 'bea', knownContactId: null })
    expect(byCluster['v-new']).toMatchObject({ speechSeconds: 31, clusterContactId: null, knownContactId: null, transcriptLabel: null })
  })
})

describe('learnFromOneOnOne', () => {
  it('ties the voice that is not the owner to the other attendee, binds its speaker and journals both', () => {
    oneOnOne()

    const result = learnFromOneOnOne('r1')

    expect(result).toMatchObject({ anchored: true, clusterId: 'v-bea', contactId: 'bea' })
    expect(cluster('v-bea')).toEqual({
      contact_id: 'bea',
      contact_link_method: 'one-on-one',
      contact_link_confidence: ONE_ON_ONE_CONFIDENCE
    })
    expect(speaker('r1', 'Voice v-bea')).toEqual({ contact_id: 'bea', source: 'one-on-one', confidence: ONE_ON_ONE_CONFIDENCE })
    const decisions = listDecisions()
    expect(decisions.map((d) => [d.kind, d.subjectKey, d.method, d.contactId]).sort()).toEqual([
      ['speaker', 'recording:r1:speaker:Voice v-bea', 'one-on-one', 'bea'],
      ['voice-anchor', 'cluster:v-bea', 'one-on-one', 'bea']
    ])
    const anchor = decisions.find((d) => d.kind === 'voice-anchor')!
    expect(anchor.before).toEqual({ clusterId: 'v-bea', contactId: null, method: null, confidence: null })
  })

  it('anchors without binding when the voice has no transcript speaker', () => {
    oneOnOne('r1', { cluster: 'v-bea', label: null })
    expect(learnFromOneOnOne('r1')).toMatchObject({ anchored: true })
    expect(listDecisions().map((d) => d.kind)).toEqual(['voice-anchor'])
  })

  it('does not anchor a voice that already belongs to someone else', () => {
    oneOnOne('r1', { cluster: 'v-dana', contactId: 'dana', similarity: 0.95 })
    expect(learnFromOneOnOne('r1').anchored).toBe(false)
    expect(cluster('v-dana')!.contact_id).toBe('dana')
  })

  it('does not anchor a cluster tied to someone else even when this voice matched it weakly', () => {
    oneOnOne('r1', { cluster: 'v-dana', contactId: 'dana', similarity: 0.8 })
    expect(learnFromOneOnOne('r1').anchored).toBe(false)
    expect(cluster('v-dana')!.contact_id).toBe('dana')
  })

  it('needs exactly the owner and one other attendee, two voices of 30 s, and the owner voice', () => {
    // Three attendees.
    meeting('m-a', ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
    recording('ra', 'm-a')
    voice('ra', OWNER_VOICE)
    voice('ra', { cluster: 'v-a' })
    // A voice under 30 s.
    oneOnOne('rb', { cluster: 'v-b', seconds: 29 })
    // Three voices of 30 s or more.
    oneOnOne('rc', { cluster: 'v-c' })
    voice('rc', { cluster: 'v-c2' })
    // The owner's voice matched below 0.9.
    meeting('m-d', ['owner@dfx5.com', 'bea@dfx5.com'])
    recording('rd', 'm-d')
    voice('rd', { ...OWNER_VOICE, similarity: 0.85 })
    voice('rd', { cluster: 'v-d' })
    // No meeting.
    recording('re', null)
    voice('re', OWNER_VOICE)
    voice('re', { cluster: 'v-e' })

    for (const id of ['ra', 'rb', 'rc', 'rd', 're']) {
      expect(learnFromOneOnOne(id).anchored, id).toBe(false)
    }
    expect(queryAll('SELECT 1 FROM voice_clusters WHERE contact_id = ?', ['bea'])).toHaveLength(0)
  })

  it('ignores a short third voice: two voices of 30 s or more is what counts', () => {
    oneOnOne('r1')
    voice('r1', { cluster: 'v-blip', seconds: 6 })
    expect(learnFromOneOnOne('r1')).toMatchObject({ anchored: true, clusterId: 'v-bea' })
  })

  it('does nothing without an owner, or when the owner voice is not known', () => {
    oneOnOne()
    identityConfig.ownerContactId = undefined
    expect(learnFromOneOnOne('r1').anchored).toBe(false)
    identityConfig.ownerContactId = 'owner'
    run(`UPDATE voice_clusters SET contact_id = NULL WHERE id = 'v-owner'`)
    expect(learnFromOneOnOne('r1').anchored).toBe(false)
  })

  it('never repeats an anchor the owner undid', () => {
    oneOnOne()
    learnFromOneOnOne('r1')
    const anchor = listDecisions().find((d) => d.kind === 'voice-anchor')!

    expect(undoDecision(anchor.id)).toEqual({ restored: true })
    expect(cluster('v-bea')).toEqual({ contact_id: null, contact_link_method: null, contact_link_confidence: null })

    expect(learnFromOneOnOne('r1').anchored).toBe(false)
    expect(cluster('v-bea')!.contact_id).toBeNull()
  })

  it('an undone speaker stays undone, whatever method would decide it again', () => {
    oneOnOne()
    learnFromOneOnOne('r1')
    const named = listDecisions().find((d) => d.kind === 'speaker')!
    undoDecision(named.id)
    expect(speaker('r1', 'Voice v-bea')).toBeUndefined()

    // The cluster is still Bea's: propagation would name the speaker again by voice.
    applyKnownVoiceBindings('r1')
    expect(speaker('r1', 'Voice v-bea')).toBeUndefined()
    // The owner's speaker, never undone, is still named.
    expect(speaker('r1', 'Voice v-owner')).toMatchObject({ contact_id: 'owner', source: 'voice' })
  })

  it('a speaker undone after the voice named it is not named again by the one-on-one', () => {
    oneOnOne()
    run(`INSERT INTO identity_decisions (id, kind, subject_key, method, contact_id, evidence_json, created_at, undone_at)
         VALUES ('d-old', 'speaker', 'recording:r1:speaker:Voice v-bea', 'voice', 'bea', '{}', ?, ?)`, [T, T])
    expect(learnFromOneOnOne('r1').anchored).toBe(true)
    expect(speaker('r1', 'Voice v-bea')).toBeUndefined()
  })

  it('an undone speaker blocks only the person it named', () => {
    oneOnOne()
    learnFromOneOnOne('r1')
    undoDecision(listDecisions().find((d) => d.kind === 'speaker')!.id)
    // Another person's voice for that speaker is a different decision.
    run(`UPDATE voice_clusters SET contact_id = 'dana' WHERE id = 'v-bea'`)
    applyKnownVoiceBindings('r1')
    expect(speaker('r1', 'Voice v-bea')).toMatchObject({ contact_id: 'dana', source: 'voice' })
  })

  it('leaves a manual speaker alone', () => {
    oneOnOne()
    run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
         VALUES ('ts1', 'r1', 'Voice v-bea', 'dana', 'manual', 1)`)
    expect(learnFromOneOnOne('r1').anchored).toBe(true)
    expect(speaker('r1', 'Voice v-bea')).toEqual({ contact_id: 'dana', source: 'manual', confidence: 1 })
  })
})

describe('learnByElimination', () => {
  it('stores one vote and anchors nothing until a second recording agrees', () => {
    threeWithCarlUnknown('r1')

    expect(learnByElimination('r1')).toMatchObject({ anchored: false, voted: { clusterId: 'v-carl', contactId: 'carl' } })
    expect(votes('v-carl')).toEqual([{ contact_id: 'carl', recording_id: 'r1' }])
    expect(cluster('v-carl')!.contact_id).toBeNull()
    expect(speaker('r1', 'Voice v-carl')).toBeUndefined()
  })

  it('anchors the voice when two recordings vote for the same person, and binds its speakers', () => {
    threeWithCarlUnknown('r1')
    threeWithCarlUnknown('r2')

    learnByElimination('r1')
    const result = learnByElimination('r2')

    expect(result).toMatchObject({ anchored: true, clusterId: 'v-carl', contactId: 'carl' })
    expect(cluster('v-carl')).toEqual({
      contact_id: 'carl',
      contact_link_method: 'elimination',
      contact_link_confidence: ELIMINATION_CONFIDENCE
    })
    for (const id of ['r1', 'r2']) {
      expect(speaker(id, 'Voice v-carl')).toEqual({ contact_id: 'carl', source: 'elimination', confidence: ELIMINATION_CONFIDENCE })
    }
    const decisions = listDecisions()
    expect(decisions.filter((d) => d.kind === 'voice-anchor').map((d) => [d.subjectKey, d.method])).toEqual([
      ['cluster:v-carl', 'elimination']
    ])
    expect(decisions.filter((d) => d.kind === 'speaker')).toHaveLength(2)
  })

  it('anchors nothing when the votes disagree, and keeps them', () => {
    threeWithCarlUnknown('r1')
    // The same unknown voice in a meeting of the owner, Bea and Dana.
    meeting('m-r2', ['owner@dfx5.com', 'bea@dfx5.com', 'dana@dfx5.com'])
    recording('r2', 'm-r2')
    voice('r2', OWNER_VOICE)
    voice('r2', { cluster: 'v-bea-known', contactId: 'bea' })
    voice('r2', { cluster: 'v-carl' })
    threeWithCarlUnknown('r3')

    learnByElimination('r1')
    learnByElimination('r2')
    expect(learnByElimination('r3').anchored).toBe(false)

    expect(cluster('v-carl')!.contact_id).toBeNull()
    expect(votes('v-carl').map((v) => v.contact_id)).toEqual(['carl', 'dana', 'carl'])
  })

  it('does nothing when the recording has more voices than the meeting has people', () => {
    meeting('m1', ['owner@dfx5.com', 'bea@dfx5.com'])
    recording('r1', 'm1')
    // Two clusters of the owner's voice, and one unknown: Bea is the only attendee left, but
    // three voices in a meeting of two people say the attendee list is not the whole room.
    voice('r1', OWNER_VOICE)
    voice('r1', { cluster: 'v-owner-2', contactId: 'owner' })
    voice('r1', { cluster: 'v-x' })
    expect(learnByElimination('r1')).toMatchObject({ anchored: false, voted: null })
    expect(votes('v-x')).toEqual([])
  })

  it('does nothing with two unknown voices, a short unknown voice, or an unknown voice tied to someone else', () => {
    // Two unknown voices.
    meeting('m1', ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
    recording('r1', 'm1')
    voice('r1', OWNER_VOICE)
    voice('r1', { cluster: 'v-p' })
    voice('r1', { cluster: 'v-q' })
    // The unknown voice speaks 20 s: it is left out, and nobody is left to name.
    meeting('m2', ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
    recording('r2', 'm2')
    voice('r2', OWNER_VOICE)
    voice('r2', { cluster: 'v-bea-known', contactId: 'bea' })
    voice('r2', { cluster: 'v-short', seconds: 20 })
    // The unknown voice matched Dana weakly: its cluster is Dana's.
    threeWithCarlUnknown('r3', 'v-dana')
    run(`UPDATE voice_clusters SET contact_id = 'dana' WHERE id = 'v-dana'`)
    run(`UPDATE recording_voice_clusters SET similarity = 0.8 WHERE voice_cluster_id = 'v-dana'`)

    for (const id of ['r1', 'r2', 'r3']) expect(learnByElimination(id).voted, id).toBeNull()
    expect(queryAll('SELECT * FROM voice_elimination_votes')).toEqual([])
  })

  it('never repeats an elimination anchor the owner undid', () => {
    threeWithCarlUnknown('r1')
    threeWithCarlUnknown('r2')
    learnByElimination('r1')
    learnByElimination('r2')
    const anchor = listDecisions().find((d) => d.kind === 'voice-anchor')!
    undoDecision(anchor.id)

    expect(learnByElimination('r2').anchored).toBe(false)
    expect(cluster('v-carl')!.contact_id).toBeNull()
  })
})

describe('runVoiceLearning', () => {
  /**
   * r1: a one-on-one with Bea teaches Bea's voice.
   * r2, r3: meetings of the owner, Bea and Carl. Once Bea is known, Carl is the last voice
   *         in both, so he is learned by elimination.
   * r4: no meeting. Carl's voice there names its speaker by propagation.
   */
  function library(): void {
    oneOnOne('r1', { cluster: 'v-bea' })
    for (const id of ['r2', 'r3']) {
      meeting(`m-${id}`, ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
      recording(id, `m-${id}`)
      voice(id, OWNER_VOICE)
      voice(id, { cluster: 'v-bea', similarity: 0.93 })
      voice(id, { cluster: 'v-carl' })
    }
    recording('r4', null)
    voice('r4', { cluster: 'v-carl', similarity: 0.92, label: 'Speaker 2' })
  }

  it('learns from the simplest meeting up, repeats while it learns, and names the same voices elsewhere', async () => {
    library()

    const summary = await runVoiceLearning({ isTranscribing: () => false })

    expect(summary.ran).toBe(true)
    expect(summary.anchored.map((a) => [a.clusterId, a.contactId, a.method])).toEqual([
      ['v-bea', 'bea', 'one-on-one'],
      ['v-carl', 'carl', 'elimination']
    ])
    expect(cluster('v-bea')!.contact_id).toBe('bea')
    expect(cluster('v-carl')!.contact_id).toBe('carl')
    // Bea's speakers in r2 and r3 are named by her voice once it is known.
    expect(speaker('r2', 'Voice v-bea')).toMatchObject({ contact_id: 'bea', source: 'voice' })
    expect(speaker('r4', 'Speaker 2')).toEqual({ contact_id: 'carl', source: 'voice', confidence: 0.92 })
  })

  it('runs again when a later recording unlocks an earlier one', async () => {
    // r0 and rx (three voices each) are visited first, by date, but need Bea, who is learned
    // only from r1 (also three voices, one of them a short blip, and the newest): the second
    // pass gets r0 and rx.
    for (const [id, date] of [['r0', '2026-09-01T10:00:00Z'], ['rx', '2026-09-02T10:00:00Z']]) {
      meeting(`m-${id}`, ['owner@dfx5.com', 'bea@dfx5.com', 'carl@dfx5.com'])
      recording(id, `m-${id}`, date)
      voice(id, OWNER_VOICE)
      voice(id, { cluster: 'v-bea', similarity: 0.93 })
      voice(id, { cluster: 'v-carl' })
    }
    meeting('m-r1', ['owner@dfx5.com', 'bea@dfx5.com'])
    recording('r1', 'm-r1', '2026-10-01T10:00:00Z')
    voice('r1', OWNER_VOICE)
    voice('r1', { cluster: 'v-bea' })
    voice('r1', { cluster: 'v-blip', seconds: 5 })

    const summary = await runVoiceLearning({ isTranscribing: () => false })

    expect(summary.passes).toBeGreaterThanOrEqual(2)
    expect(cluster('v-carl')).toMatchObject({ contact_id: 'carl', contact_link_method: 'elimination' })
  })

  it('does not run while a transcription is active', async () => {
    library()
    const summary = await runVoiceLearning({ isTranscribing: () => true })
    expect(summary).toMatchObject({ ran: false, reason: 'transcription-active' })
    expect(cluster('v-bea')!.contact_id).toBeNull()
  })

  it('stops between recordings when a transcription starts', async () => {
    library()
    let calls = 0
    const summary = await runVoiceLearning({ isTranscribing: () => calls++ > 1 })
    expect(summary).toMatchObject({ ran: true, stopped: 'transcription-active' })
    expect(cluster('v-carl')!.contact_id).toBeNull()
  })

  it('does not run without the owner voice', async () => {
    library()
    run(`UPDATE voice_clusters SET contact_id = NULL WHERE id = 'v-owner'`)
    const summary = await runVoiceLearning({ isTranscribing: () => false })
    expect(summary).toMatchObject({ ran: false, reason: 'no-owner-voice' })
  })

  it('a propagated voice never replaces a manual speaker: one voice-conflict suggestion, once', async () => {
    library()
    run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source, confidence)
         VALUES ('ts-manual', 'r4', 'Speaker 2', 'dana', 'manual', 1)`)

    await runVoiceLearning({ isTranscribing: () => false })
    await runVoiceLearning({ isTranscribing: () => false })

    expect(speaker('r4', 'Speaker 2')).toEqual({ contact_id: 'dana', source: 'manual', confidence: 1 })
    const conflicts = queryAll<{ kind: string; target_id: string; evidence: string; status: string }>(
      "SELECT kind, target_id, evidence, status FROM identity_suggestions WHERE json_extract(evidence, '$.type') = 'voice-conflict'"
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'person', target_id: 'carl', status: 'pending' })
    expect(JSON.parse(conflicts[0].evidence)).toMatchObject({
      type: 'voice-conflict',
      recordingId: 'r4',
      speakerLabel: 'Speaker 2',
      voiceContactId: 'carl',
      voiceContactName: 'Carl Ruiz',
      boundContactId: 'dana',
      boundContactName: 'Dana Soto',
      boundSource: 'manual'
    })
  })
})
