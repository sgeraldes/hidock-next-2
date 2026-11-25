// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const fixture = vi.hoisted(() => ({ path: '' }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => fixture.path }))
import { initializeDatabase, closeDatabase, upsertMeetingsBatch, activateCalendarSyncToken, getMeetingById } from '../database'
import { getCachedCalendarMeetings, markConnectorMeetingDeleted, retireMissingIcsMeetings, CONNECTOR_ACTIVE_TOKEN } from '../calendar-cache'

beforeAll(async () => { fixture.path = join(mkdtempSync(join(tmpdir(), 'hidock-calendar-cache-')), 'fixture.db'); await initializeDatabase() })
afterAll(() => closeDatabase())
const row = (id: string) => ({ id, subject: 'Fixture', start_time: '2026-10-05T23:00:00.000Z', end_time: '2026-10-06T02:00:00.000Z', location: null, organizer_name: null, organizer_email: null, attendees: '[]', description: null, is_recurring: 0 })

describe('persisted calendar cache (SQLite)', () => {
  it('returns crossing-midnight events, retains history and scopes deletion to one account', () => {
    upsertMeetingsBatch([row('m365:a:shared'), row('m365:b:shared')], CONNECTOR_ACTIVE_TOKEN)
    markConnectorMeetingDeleted('m365:a', 'shared')
    const ids = getCachedCalendarMeetings('2026-10-06T00:00:00Z', '2026-10-06T23:59:59Z').map(m => m.id)
    expect(ids).not.toContain('m365:a:shared'); expect(ids).toContain('m365:b:shared')
    expect(getMeetingById('m365:a:shared')).toBeDefined()
    upsertMeetingsBatch([row('m365:a:shared')], CONNECTOR_ACTIVE_TOKEN)
    expect(getCachedCalendarMeetings().map(m => m.id)).toContain('m365:a:shared')
  })
  it('retires missing ICS events only after success, preserving Outlook', () => {
    upsertMeetingsBatch([row('ics:gone'), row('ics:kept')], 'previous')
    upsertMeetingsBatch([row('ics:kept')], 'fresh')
    expect(getCachedCalendarMeetings().map(m => m.id)).toContain('ics:gone')
    retireMissingIcsMeetings('fresh', Date.parse('2026-10-06T12:00:00Z')); activateCalendarSyncToken('fresh')
    const ids = getCachedCalendarMeetings().map(m => m.id)
    expect(ids).not.toContain('ics:gone'); expect(ids).toContain('ics:kept'); expect(ids).toContain('m365:b:shared')
    expect(getMeetingById('ics:gone')).toBeDefined()
  })
})
