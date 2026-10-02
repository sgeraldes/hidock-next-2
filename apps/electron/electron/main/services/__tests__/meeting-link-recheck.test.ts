// @vitest-environment node

/**
 * After every calendar sync the time-only meeting links are checked again
 * against the calendar as it is now (owner, 2-oct-2026: "Almuerzo").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const recheckTimeLinks = vi.fn(() => ({ checked: 3, unlinked: 1 }))
vi.mock('../database', () => ({ recheckTimeLinks: (...args: unknown[]) => recheckTimeLinks(...(args as [])) }))

const autoLink = vi.fn(() => 1)
vi.mock('../org-reconciler', () => ({ autoLinkRecordingsToMeetings: () => autoLink() }))

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
