// @vitest-environment node

/**
 * One rule per kind of identity question (spec 2026-10-03, Phase 3; catalog in
 * docs/identity-rules.md): the Jev tiebreak for a shared first name, duplicate people by exact
 * email, by voice and by similar name, and the runner that applies them over the library.
 *
 * REAL temp DB, real database.ts (better-sqlite3). Jev is always a mock: no call leaves the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dbPath = join(tmpdir(), `hidock-identity-rules-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../config', () => ({
  getConfig: () => ({ identity: { ownerContactId: undefined }, transcription: {}, decisions: { jevEnabled: false } }),
  getDataPath: () => tmpdir(),
  updateConfig: vi.fn()
}))

import { closeDatabase, initializeDatabase, queryAll, queryOne, run } from '../database'
import { listDecisions, undoDecision, mergeSubjectKey, wasUndone } from '../identity-decisions'
import { setCallSink, type CallRecord } from '../pipeline/call-store'
import type { JevQuestion, JevResponse, JevStructured } from '../jev-client'
import {
  autoMergeExactEmail,
  autoMergeSameVoice,
  resolveBucketTiesWithJev,
  resolveSimilarNameMerges,
  runIdentityRules,
  MAX_JEV_CALLS_PER_DAY
} from '../identity-rules'

const T = '2026-10-01T10:00:00Z'

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

function contact(id: string, name: string, email: string | null = null, source: string | null = 'user'): void {
  run(
    `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count, source)
     VALUES (?, ?, ?, 'unknown', ?, ?, 0, ?)`,
    [id, name, email, T, T, source]
  )
}

function meeting(id: string, subject = `Meeting ${id}`): void {
  run(`INSERT INTO meetings (id, subject, start_time, end_time) VALUES (?, ?, ?, '2026-10-01T11:00:00Z')`, [id, subject, T])
}

function recording(id: string, meetingId: string | null): void {
  run(`INSERT INTO recordings (id, filename, date_recorded, status, meeting_id) VALUES (?, ?, ?, 'complete', ?)`, [
    id,
    `${id}.wav`,
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

function transcript(recordingId: string, turns: Array<{ speaker: string; text: string }>): void {
  run(`INSERT INTO transcripts (id, recording_id, full_text, speakers) VALUES (?, ?, ?, ?)`, [
    `t-${recordingId}`,
    recordingId,
    turns.map((t) => t.text).join(' '),
    JSON.stringify(turns)
  ])
}

function cluster(id: string, contactId: string | null, centroid: number[], method = 'manual'): void {
  run(
    `INSERT INTO voice_clusters
     (id, model, model_version, embedding_dimension, centroid_json, observation_count, total_speech_seconds,
      contact_id, contact_link_method, contact_link_confidence)
     VALUES (?, 'community-1', '4.0.0', 3, ?, 1, 60, ?, ?, ?)`,
    [id, JSON.stringify(centroid), contactId, contactId ? method : null, contactId ? 1 : null]
  )
}

function heard(recordingId: string, clusterId: string): void {
  run(
    `INSERT INTO recording_voice_clusters
     (recording_id, local_speaker_label, transcript_speaker_label, voice_cluster_id, match_status, similarity)
     VALUES (?, ?, ?, ?, 'matched', 0.95)`,
    [recordingId, `SPEAKER_${clusterId}`, `Voice ${clusterId}`, clusterId]
  )
}

function suggestion(id: string, loserName: string, keeperId: string, loserId: string, evidence: Record<string, unknown>): void {
  run(
    `INSERT INTO identity_suggestions (id, kind, candidate_name, target_id, confidence, evidence, status, created_at)
     VALUES (?, 'person', ?, ?, ?, ?, 'pending', ?)`,
    [id, loserName, keeperId, evidence.composite ?? 0.6, JSON.stringify({ keeperId, loserId, ...evidence }), T]
  )
}

const exists = (id: string) => !!queryOne('SELECT 1 FROM contacts WHERE id = ?', [id])
const status = (id: string) => queryOne<{ status: string }>('SELECT status FROM identity_suggestions WHERE id = ?', [id])?.status

/** A Jev mock that answers the one question with these probabilities, keyed by what each option says. */
function jevAnswering(pick: (criteria: Record<string, JevStructured | null>) => Record<string, number>) {
  return vi.fn(async (_key: string, _state: JevStructured, questions: Record<string, JevQuestion>): Promise<JevResponse> => {
    const answers: JevResponse['answers'] = {}
    for (const [key, q] of Object.entries(questions)) {
      if (q.type !== 'choice') continue
      const probabilities = pick(q.criteria)
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
      answers[key] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] }
    }
    return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5 } }
  })
}

/** Probabilities by the option whose text contains `name`. */
function favour(name: string, p: number) {
  return (criteria: Record<string, JevStructured | null>): Record<string, number> => {
    const keys = Object.keys(criteria)
    const hit = keys.find((k) => String(criteria[k]).includes(name))!
    const rest = (1 - p) / (keys.length - 1)
    return Object.fromEntries(keys.map((k) => [k, k === hit ? p : rest]))
  }
}

let calls: CallRecord[]

beforeEach(async () => {
  cleanup()
  await initializeDatabase()
  calls = []
  setCallSink((_id, record) => {
    calls.push(record)
  })
})

afterEach(() => {
  setCallSink(null)
  closeDatabase()
  cleanup()
})

// ---------------------------------------------------------------------------
// 3a.4 jev-tiebreak
// ---------------------------------------------------------------------------

describe('jev-tiebreak for a shared first name', () => {
  beforeEach(() => {
    contact('sh', 'Sergio Hurtado')
    contact('sr', 'Sergio Reyes')
    contact('ana', 'Ana Ruiz')
    contact('bucket', 'Sergio')
    meeting('m1', 'Weekly ops')
    recording('r1', 'm1')
    attend('m1', 'bucket')
    attend('m1', 'sh')
    attend('m1', 'sr')
    transcript('r1', [
      { speaker: 'Speaker 1', text: 'Sergio, the Hurtado account report is late.' },
      { speaker: 'Speaker 2', text: 'Unrelated turn about lunch.' }
    ])
  })

  const mention = () =>
    queryOne<{ resolved_contact_id: string; method: string }>(
      `SELECT resolved_contact_id, method FROM mention_resolutions WHERE recording_id = 'r1' AND source_name = 'sergio'`
    )

  it('asks Jev once with the turns that mention the name and applies a sure, clear choice', async () => {
    const askJev = jevAnswering(favour('Hurtado', 0.9))
    const result = await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })

    expect(result).toMatchObject({ asked: 1, resolved: 1 })
    expect(mention()).toEqual({ resolved_contact_id: 'sh', method: 'jev-tiebreak' })
    const [, state, questions] = askJev.mock.calls[0]
    expect(JSON.stringify(state)).toContain('Hurtado account report')
    expect(JSON.stringify(state)).not.toContain('lunch')
    // Only candidates with objective support are options; Ana is not a candidate at all.
    const options = Object.values((Object.values(questions)[0] as { criteria: Record<string, string> }).criteria).join(' ')
    expect(options).toContain('Sergio Hurtado')
    expect(options).toContain('Sergio Reyes')

    const [decision] = listDecisions()
    expect(decision).toMatchObject({ kind: 'mention', method: 'jev-tiebreak', contactId: 'sh' })
    expect(decision.evidence).toMatchObject({ probabilities: { sh: 0.9 }, supportedCandidateIds: ['sh', 'sr'] })
    expect((decision.evidence as { margin: number }).margin).toBeCloseTo(0.85, 5)

    // Unavailable engines leave rows before the Jev attempt.
    expect(calls).toHaveLength(5)
    for (const call of calls.slice(0, 4)) {
      expect(call).toMatchObject({ step: 'identity-tiebreak', status: 'failed', recordingId: 'r1' })
      expect(call.errorMessage).toMatch(/^unavailable: /)
    }
    expect(calls[4]).toMatchObject({ step: 'identity-tiebreak', route: 'decision:jev', recordingId: 'r1', status: 'completed' })

    // Asked once: a second pass does not call Jev again.
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    expect(askJev).toHaveBeenCalledTimes(1)
  })

  it('leaves it undecided when Jev is not sure or not clear, and does not ask again', async () => {
    const askJev = jevAnswering(favour('Hurtado', 0.7))
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })).toMatchObject({ asked: 1, resolved: 0 })
    expect(mention()).toBeUndefined()
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    expect(askJev).toHaveBeenCalledTimes(1)
  })

  it('never applies "none of them"', async () => {
    const askJev = jevAnswering(favour('None', 0.95))
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })).toMatchObject({ resolved: 0 })
    expect(mention()).toBeUndefined()
  })

  it('does nothing when Jev is off', async () => {
    const askJev = jevAnswering(favour('Hurtado', 0.9))
    expect(await resolveBucketTiesWithJev({ jevKey: () => null, askJev })).toMatchObject({ asked: 0, resolved: 0 })
    expect(askJev).not.toHaveBeenCalled()
  })

  it('a failed call leaves it undecided and is asked again next time', async () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const askJev = vi.fn(async () => {
      throw new Error('Jev returned HTTP 529')
    })
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })).toMatchObject({ asked: 0, resolved: 0 })
    expect(calls[0]).toMatchObject({ step: 'identity-tiebreak', status: 'failed' })
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    expect(askJev).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('does not ask when only one candidate has support', async () => {
    run(`DELETE FROM meeting_contacts WHERE meeting_id = 'm1' AND contact_id = 'sr'`)
    const askJev = jevAnswering(favour('Hurtado', 0.9))
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    expect(askJev).not.toHaveBeenCalled()
  })

  // Review of PR 4 (F2): at most 300 Jev tiebreaks a day, counted in the config table.
  it('stops at the daily Jev cap, counts each call, and starts again the next day', async () => {
    const day = (d: number) => () => new Date(2026, 9, d, 12, 0, 0)
    const counter = () =>
      JSON.parse(queryOne<{ value: string }>(`SELECT value FROM config WHERE key = 'identity_rules:jev-calls-per-day'`)!.value)
    const setCount = (date: string, count: number) =>
      run(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('identity_rules:jev-calls-per-day', ?, ?)`, [
        JSON.stringify({ date, count }),
        T
      ])
    const askJev = jevAnswering(favour('Hurtado', 0.6))

    setCount('2026-10-03', MAX_JEV_CALLS_PER_DAY)
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev, now: day(3) })).toMatchObject({ asked: 0 })
    expect(askJev).not.toHaveBeenCalled()

    setCount('2026-10-03', MAX_JEV_CALLS_PER_DAY - 1)
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev, now: day(3) })).toMatchObject({ asked: 1 })
    expect(counter()).toEqual({ date: '2026-10-03', count: MAX_JEV_CALLS_PER_DAY })

    run(`DELETE FROM config WHERE key LIKE 'identity_rules:jev-asked:%'`)
    expect(await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev, now: day(4) })).toMatchObject({ asked: 1 })
    expect(counter()).toEqual({ date: '2026-10-04', count: 1 })
  })

  it('an undone tiebreak is not asked or made again', async () => {
    const askJev = jevAnswering(favour('Hurtado', 0.9))
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    undoDecision(listDecisions()[0].id)
    run(`DELETE FROM config WHERE key LIKE 'identity_rules:%'`)
    await resolveBucketTiesWithJev({ jevKey: () => 'k', askJev })
    expect(askJev).toHaveBeenCalledTimes(1)
    expect(mention()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3b duplicate people
// ---------------------------------------------------------------------------

describe('merge by exact email', () => {
  beforeEach(() => {
    contact('ana', 'Ana Ruiz', 'ana@dfx5.com')
    contact('ana2', 'Ana R.', 'ANA@dfx5.com ')
    suggestion('s1', 'Ana R.', 'ana', 'ana2', { composite: 0.96, autoMergeable: true, emailMatch: 'exact', signals: { name: 0.7 } })
  })

  it('accepts the suggestion through the accept path, keeps Undo, and journals a merge decision', () => {
    expect(autoMergeExactEmail()).toEqual({ merged: 1 })
    expect(exists('ana2')).toBe(false)
    expect(status('s1')).toBe('accepted')
    expect(queryAll(`SELECT id FROM merge_journal WHERE keeper_id = 'ana' AND loser_id = 'ana2'`)).toHaveLength(1)

    const [decision] = listDecisions()
    expect(decision).toMatchObject({ kind: 'merge', subjectKey: mergeSubjectKey('ana', 'ana2'), method: 'exact-email', contactId: 'ana' })

    expect(undoDecision(decision.id)).toEqual({ restored: true })
    expect(exists('ana2')).toBe(true)
    expect(status('s1')).toBe('pending')
    // The owner's undo holds.
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(exists('ana2')).toBe(true)
  })

  it('never merges across the visibility boundary', () => {
    run(`UPDATE contacts SET source = NULL WHERE id = 'ana2'`) // no membership, no structural source: suppressed
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(exists('ana2')).toBe(true)
    expect(status('s1')).toBe('pending')
  })

  const blockedReason = () =>
    (JSON.parse(queryOne<{ evidence: string }>(`SELECT evidence FROM identity_suggestions WHERE id = 's1'`)!.evidence) as {
      autoMergeBlocked?: string
    }).autoMergeBlocked

  it('a distribution list (two names on one address in one meeting) is not merged, and says why', () => {
    run(`UPDATE contacts SET name = 'Ana Gómez', email = 'pm-latam@acme.com' WHERE id = 'ana2'`)
    run(`UPDATE contacts SET email = 'pm-latam@acme.com' WHERE id = 'ana'`)
    run(`UPDATE identity_suggestions SET candidate_name = 'Ana Gómez' WHERE id = 's1'`)
    run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees) VALUES ('m-dl', 'Planning', ?, ?, ?)`, [
      T,
      '2026-10-01T11:00:00Z',
      JSON.stringify([
        { name: 'Ana Ruiz', email: 'pm-latam@acme.com' },
        { name: 'Ana Gómez', email: 'PM-LATAM@acme.com' }
      ])
    ])
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(exists('ana2')).toBe(true)
    expect(status('s1')).toBe('pending')
    expect(blockedReason()).toBe('shared-address')
  })

  it('a role or shared mailbox (info@, a plus address) is not merged', () => {
    run(`UPDATE contacts SET email = 'info@dfx5.com' WHERE id IN ('ana', 'ana2')`)
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(blockedReason()).toBe('role-mailbox')

    run(`UPDATE contacts SET email = 'ana+news@dfx5.com' WHERE id IN ('ana', 'ana2')`)
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(exists('ana2')).toBe(true)
  })

  it('two names that do not fit one person are not merged', () => {
    run(`UPDATE contacts SET name = 'Diana Soto' WHERE id = 'ana2'`)
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
    expect(blockedReason()).toBe('names-differ')
  })

  it('a name that is just the address fits the other name', () => {
    run(`UPDATE contacts SET email = 'aruiz@dfx5.com' WHERE id IN ('ana', 'ana2')`)
    run(`UPDATE contacts SET name = 'aruiz' WHERE id = 'ana2'`)
    run(`UPDATE identity_suggestions SET candidate_name = 'aruiz' WHERE id = 's1'`)
    expect(autoMergeExactEmail()).toEqual({ merged: 1 })
  })

  it('leaves a suggestion that is not marked auto-mergeable', () => {
    run(`UPDATE identity_suggestions SET evidence = '{"keeperId":"ana","loserId":"ana2","autoMergeable":false}'`)
    expect(autoMergeExactEmail()).toEqual({ merged: 0 })
  })
})

describe('merge by voice', () => {
  beforeEach(() => {
    contact('seb', 'Sebastian Geraldes', 'seb@dfx5.com')
    contact('sebas', 'Sebas G')
    meeting('m1')
    meeting('m2')
    recording('r1', 'm1')
    recording('r2', 'm2')
    cluster('v1', 'seb', [1, 0, 0])
    cluster('v2', 'sebas', [0.99, 0.1, 0], 'self-identification')
    heard('r1', 'v1')
    heard('r2', 'v2')
  })

  it('merges two contacts whose voices consolidate at 0.9 or more, method voice, and undo restores', () => {
    expect(autoMergeSameVoice()).toEqual({ merged: 1 })
    expect(exists('sebas')).toBe(false)
    expect(queryOne<{ contact_id: string }>(`SELECT contact_id FROM voice_clusters WHERE id = 'v2'`)?.contact_id).toBe('seb')

    const [decision] = listDecisions()
    expect(decision).toMatchObject({ kind: 'merge', subjectKey: mergeSubjectKey('seb', 'sebas'), method: 'voice', contactId: 'seb' })
    expect(decision.evidence).toMatchObject({ keeperClusterId: 'v1', loserClusterId: 'v2' })
    expect((decision.evidence as { similarity: number }).similarity).toBeGreaterThanOrEqual(0.9)

    expect(undoDecision(decision.id)).toEqual({ restored: true })
    expect(exists('sebas')).toBe(true)
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
    expect(wasUndone('merge', mergeSubjectKey('seb', 'sebas'), 'voice')).toBe(true)
  })

  it('a merge undone by hand in People holds too', () => {
    autoMergeSameVoice()
    const journal = queryOne<{ id: string }>(`SELECT id FROM merge_journal WHERE loser_id = 'sebas'`)!
    run(`UPDATE merge_journal SET undone_at = ? WHERE id = ?`, [T, journal.id])
    run(`UPDATE identity_decisions SET undone_at = NULL`)
    // The contact is back (as an unmerge would leave it) and the voice is still similar.
    contact('sebas', 'Sebas G')
    run(`UPDATE voice_clusters SET contact_id = 'sebas' WHERE id = 'v2'`)
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
  })

  it('does not merge when both voices are heard in the same recording', () => {
    heard('r1', 'v2')
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
  })

  it('does not merge voices below 0.9', () => {
    run(`UPDATE voice_clusters SET centroid_json = '[0.7, 0.7, 0]' WHERE id = 'v2'`)
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
  })

  it('does not merge two people with different email addresses', () => {
    run(`UPDATE contacts SET email = 'sebas@other.com' WHERE id = 'sebas'`)
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
  })

  it('never merges across the visibility boundary', () => {
    run(`UPDATE contacts SET source = NULL WHERE id = 'sebas'`)
    expect(autoMergeSameVoice()).toEqual({ merged: 0 })
  })
})

describe('similar names without email or voice', () => {
  beforeEach(() => {
    contact('edu', 'Eduardo Paz', 'edu@dfx5.com')
    contact('edu2', 'Edu')
    suggestion('s1', 'Edu', 'edu', 'edu2', { composite: 0.62, autoMergeable: false, emailMatch: 'none', signals: { name: 0.62 } })
  })

  function coAttend(): void {
    meeting('m1', 'Pricing review')
    attend('m1', 'edu')
    attend('m1', 'edu2')
  }

  it('re-scores with co-attendance and asks Jev, which merges only a sure, clear "same person"', async () => {
    coAttend()
    const askJev = jevAnswering(favour('same person', 0.92))
    const result = await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })

    expect(result).toMatchObject({ asked: 1, merged: 1 })
    expect(exists('edu2')).toBe(false)
    expect(status('s1')).toBe('accepted')
    const [decision] = listDecisions()
    expect(decision).toMatchObject({ kind: 'merge', method: 'jev-tiebreak', contactId: 'edu' })
    expect(decision.evidence).toMatchObject({ sharedMeetings: 1, sameDomain: false })
    expect(calls[4]).toMatchObject({ step: 'identity-tiebreak', route: 'decision:jev', status: 'completed' })
    const [, state] = askJev.mock.calls[0]
    expect(JSON.stringify(state)).toContain('Pricing review')
  })

  it('without co-attendance or a shared domain, Jev is not asked and the question stays', async () => {
    const askJev = jevAnswering(favour('same person', 0.92))
    const result = await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })
    expect(result).toMatchObject({ asked: 0, merged: 0 })
    expect(askJev).not.toHaveBeenCalled()
    expect(status('s1')).toBe('pending')
  })

  it('a shared company domain is support', async () => {
    run(`UPDATE contacts SET email = 'eduardo.paz@acme.com' WHERE id = 'edu'`)
    run(`UPDATE contacts SET email = 'edu@acme.com' WHERE id = 'edu2'`)
    const askJev = jevAnswering(favour('same person', 0.92))
    expect(await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })).toMatchObject({ asked: 1 })
  })

  it('a shared public mail domain is not support', async () => {
    run(`UPDATE contacts SET email = 'eduardo.paz@gmail.com' WHERE id = 'edu'`)
    run(`UPDATE contacts SET email = 'edu@gmail.com' WHERE id = 'edu2'`)
    const askJev = jevAnswering(favour('same person', 0.92))
    expect(await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })).toMatchObject({ asked: 0 })
  })

  it('an unsure Jev leaves the question for the owner and is not asked again', async () => {
    coAttend()
    const askJev = jevAnswering(favour('same person', 0.6))
    expect(await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })).toMatchObject({ asked: 1, merged: 0 })
    expect(status('s1')).toBe('pending')
    await resolveSimilarNameMerges({ jevKey: () => 'k', askJev })
    expect(askJev).toHaveBeenCalledTimes(1)
  })

  it('Jev off: nothing is asked', async () => {
    coAttend()
    const askJev = jevAnswering(favour('same person', 0.92))
    expect(await resolveSimilarNameMerges({ jevKey: () => null, askJev })).toMatchObject({ asked: 0, merged: 0 })
    expect(askJev).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

describe('runIdentityRules', () => {
  it('does not run while a transcription runs', async () => {
    const summary = await runIdentityRules({ isTranscribing: () => true, jevKey: () => null })
    expect(summary).toMatchObject({ ran: false, reason: 'transcription-active' })
  })

  it('applies the bucket rules and the merges, giving the event loop back between steps', async () => {
    contact('sh', 'Sergio Hurtado')
    contact('sr', 'Sergio Reyes')
    contact('bucket', 'Sergio')
    meeting('m1')
    recording('r1', 'm1')
    attend('m1', 'bucket')
    attend('m1', 'sh')
    contact('ana', 'Ana Ruiz', 'ana@dfx5.com')
    contact('ana2', 'Ana R.', 'ana@dfx5.com')
    suggestion('s1', 'Ana R.', 'ana', 'ana2', { composite: 0.96, autoMergeable: true, emailMatch: 'exact', signals: { name: 0.7 } })

    const yieldToLoop = vi.fn(async () => undefined)
    const summary = await runIdentityRules({ isTranscribing: () => false, yieldToLoop, jevKey: () => null })

    expect(summary).toMatchObject({ ran: true, mentionsResolved: 1, mergedByEmail: 1, mergedByVoice: 0 })
    expect(yieldToLoop).toHaveBeenCalled()
    expect(exists('ana2')).toBe(false)
  })

  it('stops between steps when a transcription starts', async () => {
    let n = 0
    const summary = await runIdentityRules({ isTranscribing: () => n++ > 0, jevKey: () => null })
    expect(summary).toMatchObject({ ran: true, stopped: 'transcription-active' })
  })

  it('a second call while one runs returns at once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const first = runIdentityRules({ isTranscribing: () => false, yieldToLoop: () => gate, jevKey: () => null })
    const second = await runIdentityRules({ isTranscribing: () => false, jevKey: () => null })
    expect(second).toMatchObject({ ran: false, reason: 'already-running' })
    release()
    await first
  })
})

