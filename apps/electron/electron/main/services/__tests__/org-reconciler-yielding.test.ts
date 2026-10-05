// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import Database from 'better-sqlite3'

const hooks = vi.hoisted(() => ({ ticks: 0, write: undefined as (() => void) | undefined }))
const dbPath = join(tmpdir(), `org-yield-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../event-loop', () => ({
  yieldToEventLoop: async () => {
    hooks.ticks++
    const write = hooks.write
    hooks.write = undefined
    write?.()
  }
}))

import { closeDatabase, initializeDatabase, queryAll, run, runInTransaction, unmergeContacts } from '../database'
import { mergeContactsWithGraph } from '../knowledge-graph-service'
import {
  upsertContactsFromMeetings, upsertContactsFromMeetingsYielding,
  mergeDuplicateContacts, mergeDuplicateContactsYielding,
  mergeDuplicateRecordings, mergeDuplicateRecordingsYielding,
  repairEscapedMeetingText, repairEscapedMeetingTextYielding,
  renameAddressNamedContacts, renameAddressNamedContactsYielding,
  autoSplitAmbiguousBuckets, autoSplitAmbiguousBucketsYielding,
  RECONCILE_STEPS, reconcileOrganizationYielding
} from '../org-reconciler'

function contact(id: string, name = 'Alex Stone', email = `${id}@example.com`): void {
  run(`INSERT INTO contacts (id, name, email, source, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 'calendar', '2026-09-24', '2026-09-24')`, [id, name, email])
}
function seed(size = 160): void {
  runInTransaction(() => {
    contact('person')
    for (let i = 0; i < size; i++) {
      run(`INSERT INTO meetings (id, subject, start_time, end_time, attendees)
        VALUES (?, 'Review', '2026-09-24T10:00:00Z', '2026-09-24T11:00:00Z', ?)`,
      [`m${i}`, JSON.stringify([{ name: 'Alex Stone', email: 'person@example.com' }])])
    }
  })
}
function seedBucket(): void {
  seed(); contact('bucket', 'Alex'); contact('candidate', 'Alex Jones')
  runInTransaction(() => {
    for (let i = 0; i < 80; i++) {
      run(`INSERT INTO meeting_contacts (meeting_id, contact_id, source) VALUES (?, 'bucket', 'transcript')`, [`m${i}`])
      run(`INSERT INTO meeting_contacts (meeting_id, contact_id, source) VALUES (?, 'person', 'calendar')`, [`m${i}`])
      run(`INSERT INTO recordings (id, filename, file_path, date_recorded, meeting_id, on_local)
        VALUES (?, ?, '/unused', '2026-09-24T10:00:00Z', ?, 1)`, [`r${i}`, `r${i}.wav`, `m${i}`])
    }
  })
}
function state(): unknown {
  return {
    contacts: queryAll('SELECT id, name, email, meeting_count, last_seen_at FROM contacts ORDER BY id'),
    links: queryAll('SELECT * FROM meeting_contacts ORDER BY meeting_id, contact_id'),
    mentions: queryAll('SELECT recording_id, source_name, resolved_contact_id, method FROM mention_resolutions ORDER BY recording_id')
  }
}
function writeAfterCommit(write: () => void): void {
  hooks.write = () => {
    if (queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_contacts')[0].n > 0) write()
    else writeAfterCommit(write)
  }
}
async function reset(): Promise<void> {
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath)
  await initializeDatabase()
  hooks.ticks = 0
  hooks.write = undefined
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T15:00:00Z'))
  await initializeDatabase(); hooks.ticks = 0; hooks.write = undefined
  // Force a time-budget checkpoint at each batch for deterministic interleavings.
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 25))
})
afterEach(() => { closeDatabase(); if (existsSync(dbPath)) rmSync(dbPath); vi.restoreAllMocks(); vi.useRealTimers() })

describe('organization batches on real SQLite', () => {
  it('serializes passes and shares the queued follow-up promise', async () => {
    const events: string[] = []
    const releases: Array<() => void> = []
    let pass = 0
    for (const step of RECONCILE_STEPS) {
      vi.spyOn(step, 'run').mockImplementation(() => undefined)
      if (step.runYielding) vi.spyOn(step, 'runYielding').mockResolvedValue(undefined)
    }
    vi.spyOn(RECONCILE_STEPS[0], 'runYielding').mockImplementation(async () => {
      const id = ++pass
      events.push(`start${id}`)
      await new Promise<void>((resolve) => releases.push(resolve))
      events.push(`end${id}`)
    })
    const first = reconcileOrganizationYielding()
    const second = reconcileOrganizationYielding()
    const third = reconcileOrganizationYielding()
    const shared = second === third
    const initial = [...events]
    releases.shift()?.()
    // Drain the real pass's promise continuations without wall-clock timers.
    for (let i = 0; i < 100; i++) await Promise.resolve()
    const middle = [...events]
    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second, third])
    expect(shared).toBe(true)
    expect(initial).toEqual(['start1'])
    expect(middle).toEqual(['start1', 'end1', 'start2'])
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2'])
  })

  it('queues a later pass for a caller arriving after the follow-up starts', async () => {
    const releases: Array<() => void> = []
    for (const step of RECONCILE_STEPS) {
      vi.spyOn(step, 'run').mockImplementation(() => undefined)
      if (step.runYielding) vi.spyOn(step, 'runYielding').mockResolvedValue(undefined)
    }
    const start = vi.spyOn(RECONCILE_STEPS[0], 'runYielding').mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)))
    const first = reconcileOrganizationYielding()
    const second = reconcileOrganizationYielding()
    releases.shift()?.()
    await first
    const third = reconcileOrganizationYielding()
    const fourth = reconcileOrganizationYielding()
    expect(third).toBe(fourth)
    expect(third).not.toBe(second)
    expect(start).toHaveBeenCalledTimes(2)
    releases.shift()?.()
    await second
    expect(start).toHaveBeenCalledTimes(3)
    releases.shift()?.()
    await Promise.all([third, fourth])
  })

  it('rejects callers of a throwing pass and still runs the queued and next passes', async () => {
    for (const step of RECONCILE_STEPS) {
      vi.spyOn(step, 'run').mockImplementation(() => undefined)
      if (step.runYielding) vi.spyOn(step, 'runYielding').mockResolvedValue(undefined)
    }
    let release!: () => void
    const failure = new Error('pass failed')
    const start = vi.spyOn(RECONCILE_STEPS[0], 'runYielding')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        throw failure
      })
      .mockResolvedValue(undefined)
    const first = reconcileOrganizationYielding()
    const second = reconcileOrganizationYielding()
    const third = reconcileOrganizationYielding()
    const rejected = expect(second).rejects.toBe(failure)
    const alsoRejected = expect(third).rejects.toBe(failure)
    await first
    release()
    await Promise.all([rejected, alsoRejected])
    await reconcileOrganizationYielding()
    expect(start).toHaveBeenCalledTimes(3)
  })

  it('finishes a step under a writer mutating on every yield', async () => {
    seed()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let writes = 0
    function write(): void {
      // Stop the old unbounded implementation safely, so the red test cannot hang.
      if (++writes > 12) throw new Error('unbounded restart loop')
      run("UPDATE contacts SET name = 'Owner', source = 'user' WHERE id = 'person'")
      hooks.write = write
    }
    hooks.write = write
    await expect(upsertContactsFromMeetingsYielding()).resolves.toEqual({ contacts: 0, links: 160 })
    expect(writes).toBe(3)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('restarts'))).toHaveLength(1)
    expect(queryAll('SELECT meeting_count, name FROM contacts')).toEqual([{ meeting_count: 160, name: 'Owner' }])
    expect(queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])
  })

  it('restores the automatic checkpoint setting after success and a failed write', async () => {
    seed()
    run('PRAGMA wal_autocheckpoint = 400')
    await upsertContactsFromMeetingsYielding()
    expect(queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 400 }])
    await reset(); seed(); run('PRAGMA wal_autocheckpoint = 400')
    run("CREATE TRIGGER block_org BEFORE INSERT ON meeting_contacts BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(upsertContactsFromMeetingsYielding()).rejects.toThrow('blocked')
    expect(queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 400 }])
    expect(queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_contacts')[0].n).toBe(0)
  })

  it('repairs escaped calendar text in bounded pages with equivalent stored rows', async () => {
    function setup(): void {
      seed(640)
      // SQLite's CURRENT_TIMESTAMP uses the real clock even with Date faked above.
      // Give both independently seeded databases identical persisted timestamps.
      run('UPDATE meetings SET description = ?, created_at = ?, updated_at = ?', [
        'Line 1\\nLine 2', '2026-10-04 15:00:00', '2026-10-04 15:00:00'
      ])
    }
    setup()
    const count = repairEscapedMeetingText()
    const expected = queryAll('SELECT * FROM meetings ORDER BY id')
    await reset(); setup()
    expect(await repairEscapedMeetingTextYielding()).toBe(count)
    expect(queryAll('SELECT * FROM meetings ORDER BY id')).toEqual(expected)
    expect(hooks.ticks).toBeGreaterThan(2)
    expect(await repairEscapedMeetingTextYielding()).toBe(0)
    expect(queryAll('SELECT * FROM meetings ORDER BY id')).toEqual(expected)
  })

  it('rebuilds later bucket evidence after a previous bucket changes memberships', async () => {
    function setup(): void {
      seedBucket(); contact('bucket-2', 'Alex')
      run("INSERT INTO meeting_contacts (meeting_id, contact_id, source) SELECT meeting_id, 'bucket-2', 'transcript' FROM meeting_contacts WHERE contact_id = 'bucket'")
      run("UPDATE recordings SET meeting_id = 'm0'")
      run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source)
        VALUES ('speaker', 'r0', 'Speaker 1', 'candidate', 'user')`)
    }
    setup()
    const result = autoSplitAmbiguousBuckets()
    const expected = state()
    await reset(); setup()
    expect(await autoSplitAmbiguousBucketsYielding()).toEqual(result)
    expect(state()).toEqual(expected)
  })

  it('coalesces cheap committed checkpoints without waiting on a timer for each one', async () => {
    seed()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.001))
    expect(await upsertContactsFromMeetingsYielding()).toEqual({ contacts: 0, links: 160 })
    expect(hooks.ticks).toBe(0)
    expect(queryAll<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_contacts')[0].n).toBe(160)
  })

  it('keeps calendar renaming equivalent across parsed and committed pages', async () => {
    seed(); run("UPDATE contacts SET name = 'person' WHERE id = 'person'")
    const count = renameAddressNamedContacts()
    const expected = state()
    await reset(); seed(); run("UPDATE contacts SET name = 'person' WHERE id = 'person'")
    expect(await renameAddressNamedContactsYielding()).toBe(count)
    expect(state()).toEqual(expected)
    expect(hooks.ticks).toBeGreaterThan(0)
  })

  it('rebuilds calendar rename targets after an owner edit during parsing', async () => {
    seed(); run("UPDATE contacts SET name = 'person' WHERE id = 'person'")
    hooks.write = () => run("UPDATE contacts SET name = 'Owner Choice', source = 'user' WHERE id = 'person'")
    expect(await renameAddressNamedContactsYielding()).toBe(0)
    expect(queryAll<{ name: string }>("SELECT name FROM contacts WHERE id = 'person'")[0].name).toBe('Owner Choice')
  })

  it('includes negative rowids when materializing meetings and existing links', async () => {
    contact('person')
    run(`INSERT INTO meetings (rowid, id, subject, start_time, end_time, attendees)
      VALUES (-5, 'negative', 'Review', '2026-09-24', '2026-09-25', ?)`,
    [JSON.stringify([{ name: 'Alex Stone', email: 'person@example.com' }])])
    run("INSERT INTO meeting_contacts (rowid, meeting_id, contact_id, source) VALUES (-2, 'negative', 'person', 'calendar')")
    expect(await upsertContactsFromMeetingsYielding()).toEqual({ contacts: 0, links: 0 })
    expect(queryAll<{ n: number }>('SELECT meeting_count AS n FROM contacts')[0].n).toBe(1)
  })

  function seedDuplicateRecordings(): void {
    runInTransaction(() => {
      for (let i = 0; i < 40; i++) {
        run(`INSERT INTO recordings (id, filename, file_path, date_recorded, created_at, on_local)
          VALUES (?, ?, '/unused', '2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z', 1)`,
        [`r${i}`, `take${Math.floor(i / 2)}.${i % 2 ? 'wav' : 'hda'}`])
      }
    })
  }

  it('merges recordings in committed batches with the same survivors', async () => {
    seedDuplicateRecordings()
    const result = mergeDuplicateRecordings()
    const expected = queryAll('SELECT * FROM recordings ORDER BY id')
    await reset(); seedDuplicateRecordings()
    expect(await mergeDuplicateRecordingsYielding()).toBe(result)
    expect(hooks.ticks).toBeGreaterThan(2)
    expect(queryAll('SELECT * FROM recordings ORDER BY id')).toEqual(expected)
  })

  it('rereads recording eligibility after a personal flag edit', async () => {
    seedDuplicateRecordings()
    hooks.write = () => run("UPDATE recordings SET personal = 1 WHERE id = 'r39'")
    await mergeDuplicateRecordingsYielding()
    expect(queryAll("SELECT id FROM recordings WHERE id IN ('r38', 'r39') ORDER BY id"))
      .toEqual([{ id: 'r38' }, { id: 'r39' }])
  })

  it('upserts in multiple committed batches and matches the synchronous result', async () => {
    seed()
    const result = upsertContactsFromMeetings()
    const expected = state()
    await reset(); seed()
    expect(await upsertContactsFromMeetingsYielding()).toEqual(result)
    expect(hooks.ticks).toBeGreaterThan(2)
    expect(state()).toEqual(expected)
  })

  it('merges in batches and matches the synchronous survivor and links', async () => {
    seed(); contact('duplicate'); contact('other', 'Another Person')
    const result = mergeDuplicateContacts()
    const expected = state()
    await reset(); seed(); contact('duplicate'); contact('other', 'Another Person')
    expect(await mergeDuplicateContactsYielding()).toBe(result)
    expect(hooks.ticks).toBeGreaterThan(0)
    expect(state()).toEqual(expected)
  })

  it('splits buckets in batches with identical results', async () => {
    seedBucket()
    const result = autoSplitAmbiguousBuckets()
    const expected = state()
    await reset(); seedBucket()
    expect(await autoSplitAmbiguousBucketsYielding()).toEqual(result)
    expect(hooks.ticks).toBeGreaterThan(0)
    expect(state()).toEqual(expected)
    expect(result.resolved).toBe(80)
  })

  it('rereads a changed attendee list after yielding', async () => {
    seed(); contact('new-person', 'Taylor Lake')
    hooks.write = () => run(`UPDATE meetings SET attendees = ? WHERE id = 'm159'`,
      [JSON.stringify([{ name: 'Taylor Lake', email: 'new-person@example.com' }])])
    await upsertContactsFromMeetingsYielding()
    expect(queryAll("SELECT contact_id FROM meeting_contacts WHERE meeting_id = 'm159'")).toEqual([{ contact_id: 'new-person' }])
  })

  it('does not overwrite an owner name edited between batches', async () => {
    seed()
    run("UPDATE contacts SET name = 'person' WHERE id = 'person'")
    writeAfterCommit(() => run("UPDATE contacts SET name = 'Owner Name', source = 'user' WHERE id = 'person'"))
    await upsertContactsFromMeetingsYielding()
    expect(queryAll("SELECT name FROM contacts WHERE id = 'person'")).toEqual([{ name: 'Owner Name' }])
  })

  it('detects a commit on a separate connection and yields with committed links', async () => {
    seed()
    let observedLinks = 0
    writeAfterCommit(() => {
      const other = new Database(dbPath)
      try {
        observedLinks = (other.prepare('SELECT COUNT(*) AS n FROM meeting_contacts').get() as { n: number }).n
        other.prepare("UPDATE contacts SET name = 'External Owner', source = 'user' WHERE id = 'person'").run()
      } finally { other.close() }
    })
    await upsertContactsFromMeetingsYielding()
    expect(observedLinks).toBeGreaterThan(0)
    expect(queryAll("SELECT name FROM contacts WHERE id = 'person'")).toEqual([{ name: 'External Owner' }])
  })

  it('drops a meeting deleted after an earlier batch committed', async () => {
    seed()
    writeAfterCommit(() => run("DELETE FROM meetings WHERE id = 'm159'"))
    await upsertContactsFromMeetingsYielding()
    expect(queryAll("SELECT * FROM meeting_contacts WHERE meeting_id = 'm159'")).toEqual([])
    expect(queryAll('SELECT COUNT(*) AS n FROM meeting_contacts')).toEqual([{ n: 159 }])
  })

  it('follows an IPC merge made after an upsert batch committed', async () => {
    seed(); contact('keeper', 'Keeper Owner', 'keeper@example.com')
    writeAfterCommit(() => mergeContactsWithGraph('keeper', 'person'))
    await upsertContactsFromMeetingsYielding()
    expect(queryAll('SELECT id FROM contacts')).toEqual([{ id: 'keeper' }])
    expect(queryAll('SELECT DISTINCT contact_id FROM meeting_contacts')).toEqual([{ contact_id: 'keeper' }])
  })

  it('rereads merge-journal ownership after an IPC unmerge', async () => {
    seed(); contact('keeper', 'Keeper Owner', 'keeper@example.com')
    mergeContactsWithGraph('keeper', 'person')
    const journal = queryAll<{ id: string }>('SELECT id FROM merge_journal')[0]
    writeAfterCommit(() => unmergeContacts(journal.id))
    await upsertContactsFromMeetingsYielding()
    expect(queryAll("SELECT contact_id FROM meeting_contacts WHERE meeting_id = 'm159'"))
      .toEqual([{ contact_id: 'person' }])
  })

  it('does not use a deleted contact from a cached lookup', async () => {
    seed()
    hooks.write = () => run("DELETE FROM contacts WHERE id = 'person'")
    await expect(upsertContactsFromMeetingsYielding()).resolves.toBeDefined()
    expect(queryAll('SELECT COUNT(*) AS n FROM contacts')).toEqual([{ n: 1 }])
    expect(queryAll('SELECT COUNT(*) AS n FROM meeting_contacts')).toEqual([{ n: 160 }])
  })

  it('rechecks merge keys after an IPC edit between batches', async () => {
    seed(); contact('duplicate')
    hooks.write = () => run("UPDATE contacts SET name = 'Separate Person' WHERE id = 'duplicate'")
    await mergeDuplicateContactsYielding()
    expect(queryAll('SELECT COUNT(*) AS n FROM contacts')).toEqual([{ n: 2 }])
  })

  it('rechecks the contact visibility partition after an eligibility change', async () => {
    seed(); contact('duplicate')
    run(`INSERT INTO recordings (id, filename, file_path, date_recorded, personal)
      VALUES ('private', 'private.wav', '/unused', '2026-09-24T10:00:00Z', 1)`)
    hooks.write = () => run("UPDATE contacts SET source = 'transcript', source_recording_id = 'private' WHERE id = 'duplicate'")
    await mergeDuplicateContactsYielding()
    expect(queryAll('SELECT COUNT(*) AS n FROM contacts')).toEqual([{ n: 2 }])
  })

  it('preserves a manual mention choice written between bucket batches', async () => {
    seedBucket()
    hooks.write = () => run(`INSERT INTO mention_resolutions
      (recording_id, source_name, resolved_contact_id, method, confidence)
      VALUES ('r79', 'alex', 'candidate', 'manual', 1)`)
    await autoSplitAmbiguousBucketsYielding()
    expect(queryAll("SELECT resolved_contact_id, method FROM mention_resolutions WHERE recording_id = 'r79'"))
      .toEqual([{ resolved_contact_id: 'candidate', method: 'manual' }])
  })

  it('keeps one evidence snapshot across its own bucket writes', async () => {
    function seedSharedMeeting(): void {
      seedBucket()
      run("UPDATE recordings SET meeting_id = 'm0'")
      run(`INSERT INTO transcript_speakers (id, recording_id, speaker_label, contact_id, source)
        VALUES ('speaker', 'r0', 'Speaker 1', 'candidate', 'user')`)
    }
    seedSharedMeeting()
    const result = autoSplitAmbiguousBuckets()
    const expected = state()
    await reset(); seedSharedMeeting()
    expect(await autoSplitAmbiguousBucketsYielding()).toEqual(result)
    expect(state()).toEqual(expected)
  })

  it('rechecks bucket evidence after attendees change between batches', async () => {
    seedBucket()
    hooks.write = () => run("INSERT INTO meeting_contacts (meeting_id, contact_id, source) VALUES ('m79', 'candidate', 'calendar')")
    await autoSplitAmbiguousBucketsYielding()
    expect(queryAll("SELECT * FROM mention_resolutions WHERE recording_id = 'r79'")).toEqual([])
  })

  it('rechecks eligibility when a recording becomes personal between bucket batches', async () => {
    seedBucket()
    hooks.write = () => run("UPDATE recordings SET personal = 1 WHERE id = 'r79'")
    await autoSplitAmbiguousBucketsYielding()
    expect(queryAll("SELECT * FROM mention_resolutions WHERE recording_id = 'r79'")).toEqual([])
  })
})
