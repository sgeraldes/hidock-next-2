// @vitest-environment node

/**
 * Attendees from the Outlook twin (spec 2026-10-03, section 1a). The ICS feed carries no
 * attendees; every Outlook event also arrives as an `m365:` row with the same subject and start
 * that does. A meeting without attendees takes them from its one twin; two twins that disagree
 * copy nothing.
 *
 * REAL temp DB, real database.ts (better-sqlite3).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-outlook-twin-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll, queryOne } from '../database'
import { fillAttendeesFromOutlookTwins, RECONCILE_STEPS, reconcileOrganization } from '../org-reconciler'

const START = '2026-10-01T14:00:00.000Z'
const ANA = [{ name: 'Ana Ruiz', email: 'ana@acme.com' }, { name: 'Bea Paz', email: 'bea@acme.com' }]
const OTHER = [{ name: 'Carla Gil', email: 'carla@acme.com' }]

function meeting(
  id: string,
  over: { subject?: string; start?: string; attendees?: string | null; organizerName?: string | null; organizerEmail?: string | null } = {}
): void {
  run(
    `INSERT INTO meetings (id, subject, start_time, end_time, attendees, organizer_name, organizer_email)
     VALUES (?, ?, ?, '2026-10-01T15:00:00.000Z', ?, ?, ?)`,
    [
      id,
      over.subject ?? 'Weekly sync',
      over.start ?? START,
      over.attendees === undefined ? null : over.attendees,
      over.organizerName ?? null,
      over.organizerEmail ?? null
    ]
  )
}

const row = (id: string) =>
  queryOne<{ attendees: string | null; organizer_name: string | null; organizer_email: string | null }>(
    'SELECT attendees, organizer_name, organizer_email FROM meetings WHERE id = ?',
    [id]
  )!

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

beforeEach(async () => {
  cleanup()
  await initializeDatabase()
})

afterEach(() => {
  closeDatabase()
  cleanup()
})

describe('fillAttendeesFromOutlookTwins', () => {
  it('copies attendees and organizer from the one twin, and a second run changes nothing', () => {
    meeting('ics-1', { attendees: null })
    meeting('m365:evt-1', { attendees: JSON.stringify(ANA), organizerName: 'Ana Ruiz', organizerEmail: 'ana@acme.com' })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 1, ambiguous: 0 })

    expect(row('ics-1')).toEqual({
      attendees: JSON.stringify(ANA),
      organizer_name: 'Ana Ruiz',
      organizer_email: 'ana@acme.com'
    })
    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 0, ambiguous: 0 })
  })

  it('treats an empty string and an empty list as no attendees', () => {
    meeting('ics-empty', { attendees: '' })
    meeting('ics-list', { subject: 'Planning', attendees: '[]' })
    meeting('m365:a', { attendees: JSON.stringify(ANA) })
    meeting('m365:b', { subject: 'Planning', attendees: JSON.stringify(OTHER) })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 2, ambiguous: 0 })
    expect(row('ics-empty').attendees).toBe(JSON.stringify(ANA))
    expect(row('ics-list').attendees).toBe(JSON.stringify(OTHER))
  })

  it('copies nothing when two twins disagree, and counts the meeting as ambiguous', () => {
    meeting('ics-1', { attendees: null })
    meeting('m365:evt-1', { attendees: JSON.stringify(ANA), organizerName: 'Ana Ruiz', organizerEmail: 'ana@acme.com' })
    meeting('m365:acct:evt-2', { attendees: JSON.stringify(OTHER), organizerName: 'Carla Gil', organizerEmail: 'carla@acme.com' })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 0, ambiguous: 1 })
    expect(row('ics-1')).toEqual({ attendees: null, organizer_name: null, organizer_email: null })
  })

  it('needs the same subject and the same start, and a twin that has attendees', () => {
    meeting('ics-1', { attendees: null })
    meeting('m365:other-subject', { subject: 'Weekly sync (moved)', attendees: JSON.stringify(ANA) })
    meeting('m365:other-start', { start: '2026-10-01T14:30:00.000Z', attendees: JSON.stringify(ANA) })
    meeting('m365:no-attendees', { attendees: null })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 0, ambiguous: 0 })
    expect(row('ics-1').attendees).toBeNull()
  })

  it('leaves a meeting that already has attendees untouched', () => {
    meeting('ics-1', { attendees: JSON.stringify(OTHER) })
    meeting('m365:evt-1', { attendees: JSON.stringify(ANA), organizerName: 'Ana Ruiz', organizerEmail: 'ana@acme.com' })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 0, ambiguous: 0 })
    expect(row('ics-1')).toEqual({ attendees: JSON.stringify(OTHER), organizer_name: null, organizer_email: null })
  })

  it('never fills an Outlook row, even one without attendees', () => {
    meeting('m365:empty', { attendees: null })
    meeting('m365:full', { attendees: JSON.stringify(ANA) })

    expect(fillAttendeesFromOutlookTwins()).toEqual({ filled: 0, ambiguous: 0 })
    expect(row('m365:empty').attendees).toBeNull()
  })

  it('copies the organizer only where the meeting has none', () => {
    meeting('ics-1', { attendees: null, organizerName: 'Calendar Owner', organizerEmail: 'owner@acme.com' })
    meeting('m365:evt-1', { attendees: JSON.stringify(ANA), organizerName: 'Ana Ruiz', organizerEmail: 'ana@acme.com' })

    fillAttendeesFromOutlookTwins()

    expect(row('ics-1')).toEqual({
      attendees: JSON.stringify(ANA),
      organizer_name: 'Calendar Owner',
      organizer_email: 'owner@acme.com'
    })
  })
})

describe('as a reconcile step', () => {
  it('runs before the contact steps', () => {
    const names = RECONCILE_STEPS.map((s) => s.name)
    expect(names).toContain('outlook-twin-attendees')
    expect(names.indexOf('outlook-twin-attendees')).toBeLessThan(names.indexOf('contacts-upsert'))
  })

  it('the filled meeting gets its contacts and meeting_contacts rows in the same pass', () => {
    meeting('ics-1', { attendees: null })
    meeting('m365:evt-1', { attendees: JSON.stringify(ANA), organizerName: 'Ana Ruiz', organizerEmail: 'ana@acme.com' })

    reconcileOrganization()

    const linked = queryAll<{ email: string; source: string | null }>(
      `SELECT c.email, mc.source FROM meeting_contacts mc JOIN contacts c ON c.id = mc.contact_id
       WHERE mc.meeting_id = 'ics-1' ORDER BY c.email`
    )
    expect(linked).toEqual([
      { email: 'ana@acme.com', source: 'calendar' },
      { email: 'bea@acme.com', source: 'calendar' }
    ])
  })
})
