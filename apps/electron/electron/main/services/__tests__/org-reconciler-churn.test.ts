// @vitest-environment node

/**
 * The contact churn found in the start-up log (30-sep-2026): two contacts with one name and
 * two emails were merged by name, the merge dropped the loser's email, the next pass saw an
 * address nobody owned and created the contact again, and the name merge folded it away again.
 * On the real data that was the same 34 contacts on every start and after every calendar sync,
 * and the merge journal grew by about 1,000 rows a day. A merged address now belongs to the
 * survivor, so the pass converges.
 *
 * REAL temp DB, real database.ts (better-sqlite3).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-reconciler-churn-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll, queryOne } from '../database'
import { mergeDuplicateContacts, reconcileOrganization, upsertContactsFromMeetings } from '../org-reconciler'

function meeting(id: string, attendees: Array<{ name?: string; email?: string }>): void {
  run(
    `INSERT INTO meetings (id, subject, start_time, end_time, attendees)
     VALUES (?, ?, '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', ?)`,
    [id, id, JSON.stringify(attendees)]
  )
}

const contacts = () => queryAll<{ id: string; name: string; email: string | null }>('SELECT id, name, email FROM contacts ORDER BY rowid')
const journalRows = () => queryOne<{ n: number }>("SELECT COUNT(*) n FROM merge_journal WHERE kind = 'contact'")?.n ?? 0
const linkedContactIds = (meetingId: string) =>
  queryAll<{ contact_id: string }>('SELECT contact_id FROM meeting_contacts WHERE meeting_id = ?', [meetingId]).map((r) => r.contact_id)

beforeEach(async () => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
})
afterEach(() => {
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('one person with two email addresses', () => {
  beforeEach(() => {
    meeting('m1', [{ name: 'Gwen Stacy', email: 'gwen@one.com' }])
    meeting('m2', [{ name: 'Gwen Stacy', email: 'gwen@two.com' }])
  })

  it('is merged once and then left alone, without new contacts or journal rows', () => {
    reconcileOrganization()
    expect(contacts()).toHaveLength(1)
    const survivor = contacts()[0].id
    const journalAfterFirst = journalRows()
    expect(journalAfterFirst).toBe(1)

    reconcileOrganization()
    reconcileOrganization()

    expect(contacts().map((c) => c.id)).toEqual([survivor])
    expect(journalRows()).toBe(journalAfterFirst)
    expect(mergeDuplicateContacts()).toBe(0)
  })

  it('keeps both meetings linked to the survivor after every pass', () => {
    reconcileOrganization()
    reconcileOrganization()

    const survivor = contacts()[0].id
    expect(linkedContactIds('m1')).toEqual([survivor])
    expect(linkedContactIds('m2')).toEqual([survivor])
  })

  it('reports no new contact on the second pass', () => {
    reconcileOrganization()

    expect(upsertContactsFromMeetings()).toEqual({ contacts: 0, links: 0 })
  })

  it('creates the contact again for an address whose merge was undone', () => {
    reconcileOrganization()
    run("UPDATE merge_journal SET undone_at = '2026-01-03T00:00:00Z' WHERE kind = 'contact'")

    const result = upsertContactsFromMeetings()

    expect(result.contacts).toBe(1)
    expect(contacts()).toHaveLength(2)
  })

  it('follows a survivor that was itself merged later', () => {
    reconcileOrganization()
    const survivor = contacts()[0].id
    const survivorEmail = contacts()[0].email
    // A third contact takes the survivor: the journal now says survivor -> newer.
    const newer = 'contact-newer'
    run(
      `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count)
       VALUES (?, 'Gwen S.', 'gwen.s@three.com', 'unknown', '2026-01-01', '2026-01-01', 0)`,
      [newer]
    )
    run(
      `INSERT INTO merge_journal (id, kind, keeper_id, loser_id, loser_snapshot, repointed_manifest, folded_fields, created_at, seq)
       VALUES ('j-chain', 'contact', ?, ?, ?, '{}', '{}', '2026-01-04T00:00:00Z', (SELECT COALESCE(MAX(seq), 0) + 1 FROM merge_journal))`,
      [newer, survivor, JSON.stringify({ email: survivorEmail })]
    )
    run('DELETE FROM meeting_contacts WHERE contact_id = ?', [survivor])
    run('DELETE FROM contacts WHERE id = ?', [survivor])

    upsertContactsFromMeetings()

    // Both addresses resolve through the chain to the contact that still exists.
    expect(contacts().map((c) => c.id)).toEqual([newer])
    expect(linkedContactIds('m1')).toEqual([newer])
    expect(linkedContactIds('m2')).toEqual([newer])
  })
})
