// @vitest-environment node

/**
 * org-reconcile froze the window for 4.9 s at boot (29-sep-2026). Two changes, pinned here:
 *
 * - upsertContactsFromMeetings reads the contacts and the links once and looks
 *   people up in memory (it filtered on LOWER(email), which no index serves, and
 *   prepared a statement per person: 15,920 person slots against 1,611 contacts).
 *   The result must be what the per-person queries produced.
 * - The reconcile pass has a yielding form that gives the event loop back between
 *   steps, keeps going when a step throws, and names a slow step in the log.
 *
 * REAL temp DB, real database.ts (better-sqlite3).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'

const dbPath = join(tmpdir(), `hidock-reconciler-startup-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('../../services/file-storage', () => ({ getDatabasePath: () => dbPath }))

import { initializeDatabase, closeDatabase, run, queryAll } from '../database'
import {
  RECONCILE_STEPS,
  SLOW_RECONCILE_STEP_MS,
  reconcileOrganization,
  reconcileOrganizationYielding,
  renameAddressNamedContacts,
  upsertContactsFromMeetings
} from '../org-reconciler'

function meeting(
  id: string,
  opts: { attendees?: unknown; organizerEmail?: string; organizerName?: string; start?: string } = {}
): void {
  run(
    `INSERT INTO meetings (id, subject, start_time, end_time, attendees, organizer_email, organizer_name)
     VALUES (?, ?, ?, '2026-01-02T11:00:00Z', ?, ?, ?)`,
    [
      id,
      id,
      opts.start ?? '2026-01-02T10:00:00Z',
      typeof opts.attendees === 'string' ? opts.attendees : opts.attendees ? JSON.stringify(opts.attendees) : null,
      opts.organizerEmail ?? null,
      opts.organizerName ?? null
    ]
  )
}

function contact(id: string, name: string, email: string | null): void {
  run(
    `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count)
     VALUES (?, ?, ?, 'unknown', '2026-01-01', '2026-01-01', 0)`,
    [id, name, email]
  )
}

const contacts = () =>
  queryAll<{ id: string; name: string; email: string; meeting_count: number }>(
    'SELECT id, name, email, meeting_count FROM contacts ORDER BY rowid'
  )
const links = () =>
  queryAll<{ meeting_id: string; contact_id: string; role: string; source: string }>(
    'SELECT meeting_id, contact_id, role, source FROM meeting_contacts ORDER BY rowid'
  )

beforeEach(async () => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
  await initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDatabase()
  if (existsSync(dbPath)) rmSync(dbPath, { force: true })
})

describe('upsertContactsFromMeetings', () => {
  it('creates a contact and a calendar link for the organizer and each attendee', () => {
    meeting('m1', {
      organizerEmail: 'Boss@X.com',
      organizerName: 'The Boss',
      attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }, { name: 'No Email' }]
    })

    const result = upsertContactsFromMeetings()

    expect(result).toEqual({ contacts: 2, links: 2 })
    expect(contacts().map((c) => [c.name, c.email])).toEqual([
      ['The Boss', 'boss@x.com'],
      ['Gwen Stacy', 'gwen@x.com']
    ])
    expect(links().map((l) => [l.meeting_id, l.role, l.source])).toEqual([
      ['m1', 'organizer', 'calendar'],
      ['m1', 'attendee', 'calendar']
    ])
  })

  it('finds an existing contact whatever the case of its stored email, and adds no duplicate', () => {
    contact('c-existing', 'Gwen Stacy', 'Gwen@X.COM')
    meeting('m1', { attendees: [{ name: 'Gwen Stacy', email: 'GWEN@x.com' }] })

    const result = upsertContactsFromMeetings()

    expect(result).toEqual({ contacts: 0, links: 1 })
    expect(contacts()).toHaveLength(1)
    expect(links()[0].contact_id).toBe('c-existing')
  })

  it('uses one contact for a person in several meetings and links each meeting once', () => {
    meeting('m1', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })
    meeting('m2', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })

    const result = upsertContactsFromMeetings()

    expect(result).toEqual({ contacts: 1, links: 2 })
    expect(contacts()).toHaveLength(1)
    expect(links().map((l) => l.meeting_id)).toEqual(['m1', 'm2'])
    expect(contacts()[0].meeting_count).toBe(2)
  })

  it('does nothing on a second run', () => {
    meeting('m1', { organizerEmail: 'boss@x.com', attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })
    upsertContactsFromMeetings()

    const second = upsertContactsFromMeetings()

    expect(second).toEqual({ contacts: 0, links: 0 })
    expect(contacts()).toHaveLength(2)
    expect(links()).toHaveLength(2)
  })

  // 4-oct-2026, a copy of the real library: 480 ms on every start and after every
  // calendar sync, parsing 6,615 attendee lists that had not changed.
  it('does not read the attendees again when the meetings, contacts and links did not change', () => {
    meeting('m1', { organizerEmail: 'boss@x.com', attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })
    upsertContactsFromMeetings()

    const parse = vi.spyOn(JSON, 'parse')
    expect(upsertContactsFromMeetings()).toEqual({ contacts: 0, links: 0 })
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('runs again when a meeting, a contact or a link changed since the last pass', () => {
    meeting('m1', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })
    upsertContactsFromMeetings()

    meeting('m2', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })
    expect(upsertContactsFromMeetings()).toEqual({ contacts: 0, links: 1 })

    run(`DELETE FROM meeting_contacts WHERE meeting_id = 'm1'`)
    expect(upsertContactsFromMeetings()).toEqual({ contacts: 0, links: 1 })

    run(`DELETE FROM meeting_contacts`)
    run(`DELETE FROM contacts`)
    expect(upsertContactsFromMeetings()).toEqual({ contacts: 1, links: 2 })

    run(`UPDATE contacts SET name = 'gwen'`)
    upsertContactsFromMeetings()
    expect(contacts()[0].name).toBe('Gwen Stacy')
  })

  it('lists a person who appears twice in one meeting once', () => {
    meeting('m1', { organizerEmail: 'gwen@x.com', attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })

    const result = upsertContactsFromMeetings()

    expect(result).toEqual({ contacts: 1, links: 1 })
  })

  it('gives a nameless attendee the start of the email, and upgrades it when a later meeting has the real name', () => {
    meeting('m1', { attendees: [{ email: 'gwen@x.com' }], start: '2026-01-02T10:00:00Z' })
    meeting('m2', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }], start: '2026-01-03T10:00:00Z' })

    upsertContactsFromMeetings()

    expect(contacts().map((c) => c.name)).toEqual(['Gwen Stacy'])
  })

  it('upgrades an existing placeholder name but never overwrites a real one', () => {
    contact('c-placeholder', 'gwen', 'gwen@x.com')
    contact('c-real', 'Peter Parker', 'peter@x.com')
    meeting('m1', {
      attendees: [
        { name: 'Gwen Stacy', email: 'gwen@x.com' },
        { name: 'Someone Else', email: 'peter@x.com' }
      ]
    })

    upsertContactsFromMeetings()

    expect(Object.fromEntries(contacts().map((c) => [c.id, c.name]))).toEqual({
      'c-placeholder': 'Gwen Stacy',
      'c-real': 'Peter Parker'
    })
  })

  it('links the first contact by row order when two share an email, like the query it replaces', () => {
    contact('c-first', 'Gwen One', 'gwen@x.com')
    contact('c-second', 'Gwen Two', 'GWEN@x.com')
    meeting('m1', { attendees: [{ email: 'gwen@x.com' }] })

    upsertContactsFromMeetings()

    expect(links().map((l) => l.contact_id)).toEqual(['c-first'])
    expect(contacts()).toHaveLength(2)
  })

  // 3-oct-2026: 297 contacts on the live database were named after their own address,
  // because the calendar listed the address as the display name.
  it('never stores an address as the name: it keeps the placeholder and upgrades it to a real name later', () => {
    meeting('m1', { attendees: [{ name: 'gwen@x.com', email: 'gwen@x.com' }], start: '2026-01-02T10:00:00Z' })

    upsertContactsFromMeetings()
    expect(contacts().map((c) => c.name)).toEqual(['gwen'])

    meeting('m2', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }], start: '2026-01-03T10:00:00Z' })
    upsertContactsFromMeetings()
    expect(contacts().map((c) => c.name)).toEqual(['Gwen Stacy'])
  })

  it('upgrades an existing contact named after its address, and never takes an address as the new name', () => {
    contact('c-addr', 'gwen@x.com', 'gwen@x.com')
    contact('c-addr2', 'peter@x.com', 'peter@x.com')
    meeting('m1', {
      attendees: [
        { name: 'Gwen Stacy', email: 'gwen@x.com' },
        { name: 'PETER@X.COM', email: 'peter@x.com' }
      ]
    })

    upsertContactsFromMeetings()

    expect(Object.fromEntries(contacts().map((c) => [c.id, c.name]))).toEqual({
      'c-addr': 'Gwen Stacy',
      'c-addr2': 'peter@x.com'
    })
  })

  // Review of PR 143, F1: "Carmen" for carmen@acme.com is a real name, not the placeholder.
  it('stores a real name that spells the start of the address, and upgrades the placeholder to it', () => {
    meeting('m1', { attendees: [{ name: 'Carmen', email: 'carmen@acme.com' }] })
    contact('c-pl', 'pedro', 'pedro@acme.com')
    meeting('m2', { attendees: [{ name: 'Pedro', email: 'pedro@acme.com' }] })

    upsertContactsFromMeetings()

    expect(contacts().map((c) => [c.email, c.name])).toEqual([
      ['pedro@acme.com', 'Pedro'],
      ['carmen@acme.com', 'Carmen']
    ])
  })

  // Review of PR 143, F3: a shared mailbox or a distribution list is not one person.
  it('never names a shared mailbox or an address listed under two names in one meeting', () => {
    contact('c-dl', 'dl-proyecto', 'dl-proyecto@acme.com')
    meeting('m1', {
      attendees: [
        { name: 'Maria Lopez', email: 'info@acme.com' },
        { name: 'Ana Soto', email: 'dl-proyecto@acme.com' },
        { name: 'Luis Rojas', email: 'dl-proyecto@acme.com' }
      ]
    })

    upsertContactsFromMeetings()

    expect(contacts().map((c) => [c.email, c.name])).toEqual([
      ['dl-proyecto@acme.com', 'dl-proyecto'],
      ['info@acme.com', 'info']
    ])
  })

  it('never renames a contact the owner made', () => {
    run(
      `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count, source)
       VALUES ('c-user', 'gwen', 'gwen@x.com', 'unknown', '2026-01-01', '2026-01-01', 0, 'user')`
    )
    meeting('m1', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })

    upsertContactsFromMeetings()

    expect(contacts().map((c) => c.name)).toEqual(['gwen'])
  })

  it('skips a meeting with malformed attendees and still handles the others', () => {
    meeting('m-bad', { attendees: '{not json', organizerEmail: 'boss@x.com' })
    meeting('m-ok', { attendees: [{ name: 'Gwen Stacy', email: 'gwen@x.com' }] })

    const result = upsertContactsFromMeetings()

    expect(result).toEqual({ contacts: 2, links: 2 })
  })
})

describe('renameAddressNamedContacts', () => {
  const nameOf = (id: string) => contacts().find((c) => c.id === id)?.name

  it('renames a contact named after its address to the display name the calendar uses most for it', () => {
    contact('c-mv', 'mvargs@amazon.com', 'mvargs@amazon.com')
    meeting('m1', { attendees: [{ name: 'Vargas, Marino', email: 'MVARGS@amazon.com' }] })
    meeting('m2', { attendees: [{ name: 'Vargas, Marino', email: 'mvargs@amazon.com' }] })
    meeting('m3', { organizerName: 'Marino Vargas', organizerEmail: 'mvargs@amazon.com' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(renameAddressNamedContacts()).toBe(1)

    expect(nameOf('c-mv')).toBe('Vargas, Marino')
    expect(log.mock.calls.some((call) => String(call[0]).includes('c-mv'))).toBe(true)
  })

  it('does not take the start of the address or another address as the name', () => {
    contact('c-cs', 'csiccha@antamina.com', 'csiccha@antamina.com')
    meeting('m1', { attendees: [{ name: 'csiccha', email: 'csiccha@antamina.com' }] })
    meeting('m2', { attendees: [{ name: 'csiccha', email: 'csiccha@antamina.com' }] })
    meeting('m3', { attendees: [{ name: 'other@antamina.com', email: 'csiccha@antamina.com' }] })
    meeting('m4', { attendees: [{ name: 'Siccha Maco, Carlos', email: 'csiccha@antamina.com' }] })

    renameAddressNamedContacts()

    expect(nameOf('c-cs')).toBe('Siccha Maco, Carlos')
  })

  it('reads the address out of a name like "Name <address>" when the email column is empty', () => {
    contact('c-ml', 'Marisel Lopez <mmauleon@seguros.com>', null)
    meeting('m1', { attendees: [{ name: 'Marisel Mauleon Lopez', email: 'mmauleon@seguros.com' }] })

    renameAddressNamedContacts()

    expect(nameOf('c-ml')).toBe('Marisel Mauleon Lopez')
  })

  it('leaves real names, owner-made contacts and addresses with no calendar name alone', () => {
    contact('c-real', 'Peter Parker', 'peter@x.com')
    contact('c-none', 'nobody@x.com', 'nobody@x.com')
    run(
      `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count, source)
       VALUES ('c-user', 'gwen@x.com', 'gwen@x.com', 'unknown', '2026-01-01', '2026-01-01', 0, 'user')`
    )
    meeting('m1', {
      attendees: [
        { name: 'Someone Else', email: 'peter@x.com' },
        { name: 'Gwen Stacy', email: 'gwen@x.com' }
      ]
    })

    expect(renameAddressNamedContacts()).toBe(0)

    expect(nameOf('c-real')).toBe('Peter Parker')
    expect(nameOf('c-none')).toBe('nobody@x.com')
    expect(nameOf('c-user')).toBe('gwen@x.com')
  })

  it('leaves a shared mailbox and an address listed under two names in one meeting alone', () => {
    contact('c-info', 'info@acme.com', 'info@acme.com')
    contact('c-dl', 'dl-proyecto@acme.com', 'dl-proyecto@acme.com')
    meeting('m1', {
      attendees: [
        { name: 'Maria Lopez', email: 'info@acme.com' },
        { name: 'Ana Soto', email: 'dl-proyecto@acme.com' },
        { name: 'Luis Rojas', email: 'dl-proyecto@acme.com' }
      ]
    })
    meeting('m2', { attendees: [{ name: 'Ana Soto', email: 'dl-proyecto@acme.com' }] })

    expect(renameAddressNamedContacts()).toBe(0)

    expect(nameOf('c-info')).toBe('info@acme.com')
    expect(nameOf('c-dl')).toBe('dl-proyecto@acme.com')
  })

  // Review of PR 143, F2: the addresses with no calendar name stay placeholders, so the
  // step used to parse every meeting on every reconcile.
  it('does not read the attendees again when neither the meetings nor the contacts changed', () => {
    contact('c-mv', 'mvargs@amazon.com', 'mvargs@amazon.com')
    contact('c-none', 'nobody@x.com', 'nobody@x.com')
    meeting('m1', { attendees: [{ name: 'Marino Vargas', email: 'mvargs@amazon.com' }] })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(renameAddressNamedContacts()).toBe(1)

    const parse = vi.spyOn(JSON, 'parse')
    expect(renameAddressNamedContacts()).toBe(0)
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()

    meeting('m2', { attendees: [{ name: 'Nobody Known', email: 'nobody@x.com' }] })
    expect(renameAddressNamedContacts()).toBe(1)
    expect(nameOf('c-none')).toBe('Nobody Known')
  })

  it('does nothing on a second run', () => {
    contact('c-mv', 'mvargs@amazon.com', 'mvargs@amazon.com')
    meeting('m1', { attendees: [{ name: 'Marino Vargas', email: 'mvargs@amazon.com' }] })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(renameAddressNamedContacts()).toBe(1)
    expect(renameAddressNamedContacts()).toBe(0)
    expect(nameOf('c-mv')).toBe('Marino Vargas')
  })

  it('runs after the contacts upsert and before the merge and the bucket split', () => {
    const names = RECONCILE_STEPS.map((s) => s.name)
    const at = names.indexOf('contacts-rename-from-calendar')
    expect(at).toBeGreaterThan(names.indexOf('contacts-upsert'))
    expect(at).toBeLessThan(names.indexOf('contact-merge'))
    expect(at).toBeLessThan(names.indexOf('ambiguous-bucket-split'))
  })
})

describe('reconcileOrganizationYielding', () => {
  function mockSteps(events: string[], failing: number[] = []) {
    RECONCILE_STEPS.forEach((step, index) => {
      vi.spyOn(step, 'run').mockImplementation(() => {
        events.push(`run:${index}`)
        setTimeout(() => events.push(`tick:${index}`), 0)
        if (failing.includes(index)) throw new Error(`boom ${index}`)
      })
    })
  }

  it('gives the event loop back after every step', async () => {
    const events: string[] = []
    mockSteps(events)

    await reconcileOrganizationYielding()

    const expected = RECONCILE_STEPS.flatMap((_, index) => [`run:${index}`, `tick:${index}`])
    expect(events).toEqual(expected)
  })

  it('the synchronous pass runs the same steps without giving anything back', async () => {
    const events: string[] = []
    mockSteps(events)

    reconcileOrganization()

    expect(events).toEqual(RECONCILE_STEPS.map((_, index) => `run:${index}`))
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

  it('keeps going when a step throws, and says which one', async () => {
    const events: string[] = []
    mockSteps(events, [1])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await reconcileOrganizationYielding()

    expect(events.filter((e) => e.startsWith('run:'))).toHaveLength(RECONCILE_STEPS.length)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toBe('[OrgReconciler] duplicate meeting-occurrence merge failed:')
  })

  it('names a step that held the main thread too long', async () => {
    mockSteps([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // start and end of each step, in order: only the third step is slow.
    const readings: number[] = []
    RECONCILE_STEPS.forEach((_, index) => readings.push(0, index === 2 ? 700 : SLOW_RECONCILE_STEP_MS - 1))
    let call = 0
    vi.spyOn(performance, 'now').mockImplementation(() => readings[call++] ?? 0)

    await reconcileOrganizationYielding()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[OrgReconciler] step "recording-merge" held the main thread for 700ms')
  })

  it('runs against a real, empty database without error', async () => {
    await expect(reconcileOrganizationYielding()).resolves.toBeUndefined()
  })
})
