// @vitest-environment node

/**
 * After every calendar sync the time-only meeting links are checked again
 * against the calendar as it is now (owner, 2-oct-2026: "Almuerzo").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const recheckTimeLinks = vi.fn(() => ({ checked: 3, unlinked: 1 }))
vi.mock('../database', () => ({ recheckTimeLinks: (...args: unknown[]) => recheckTimeLinks(...(args as [])) }))

const calls: string[] = []
const autoLink = vi.fn(() => { calls.push('autoLink'); return 1 })
const fillTwins = vi.fn(() => { calls.push('fillTwins'); return { filled: 2, ambiguous: 0 } })
const upsertContacts = vi.fn(() => { calls.push('upsertContacts'); return { contacts: 3, links: 4 } })
vi.mock('../org-reconciler', () => ({
  autoLinkRecordingsToMeetings: () => autoLink(),
  fillAttendeesFromOutlookTwins: () => fillTwins(),
  upsertContactsFromMeetings: () => upsertContacts()
}))

import { getEventBus } from '../event-bus'
import { startMeetingLinkRecheck, RECHECK_DEBOUNCE_MS } from '../meeting-link-recheck'

function emitSynced(): void {
  getEventBus().emitDomainEvent({ type: 'calendar:synced', timestamp: new Date().toISOString(), payload: { meetingsCount: 10 } })
}

describe('startMeetingLinkRecheck', () => {
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    recheckTimeLinks.mockClear()
    autoLink.mockClear()
    fillTwins.mockClear()
    upsertContacts.mockClear()
    calls.length = 0
    stop = startMeetingLinkRecheck()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('re-checks the links once after a burst of calendar syncs, then links what is left unlinked', () => {
    emitSynced()
    emitSynced()
    expect(recheckTimeLinks).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)

    expect(recheckTimeLinks).toHaveBeenCalledTimes(1)
    expect(autoLink).toHaveBeenCalledTimes(1)
  })

  // An Outlook sync writes m365 rows; the ICS rows the recordings link to take
  // their attendees right away, not at the next start (owner, 3-oct-2026).
  it('copies attendees from Outlook twins and makes their contacts before re-checking links', () => {
    emitSynced()
    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)

    expect(calls).toEqual(['fillTwins', 'upsertContacts', 'autoLink'])
  })

  it('skips the contact pass when no meeting gained attendees', () => {
    fillTwins.mockImplementationOnce(() => { calls.push('fillTwins'); return { filled: 0, ambiguous: 1 } })

    emitSynced()
    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)

    expect(upsertContacts).not.toHaveBeenCalled()
    expect(autoLink).toHaveBeenCalledTimes(1)
  })

  it('a failure is logged and does not stop the next sync from re-checking', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    recheckTimeLinks.mockImplementationOnce(() => { throw new Error('database busy') })

    emitSynced()
    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)
    expect(error).toHaveBeenCalled()

    emitSynced()
    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)
    expect(recheckTimeLinks).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('stops listening when stopped', () => {
    stop()
    emitSynced()
    vi.advanceTimersByTime(RECHECK_DEBOUNCE_MS)
    expect(recheckTimeLinks).not.toHaveBeenCalled()
  })
})
