/**
 * After a calendar sync, check the time-only meeting links again.
 *
 * Recordings are linked to meetings when they arrive, against the calendar the
 * app has stored at that moment. When that copy is old the link can point at a
 * meeting that has since moved (2-oct-2026: a 13:00 recording linked to a lunch
 * the calendar had moved to 19:30). Every calendar sync, from the ICS feed or a
 * connector, ends with `calendar:synced`; this listener then re-checks the
 * links (database.recheckTimeLinks) and links what is left unlinked.
 *
 * Before that, meetings from the ICS feed (no attendees) take the attendees of
 * their Outlook twin, and those attendees become contacts, so an Outlook sync
 * helps the next identity pass at once instead of at the next start (3-oct-2026).
 */

import { getEventBus } from './event-bus'
import { recheckTimeLinks } from './database'
import {
  autoLinkRecordingsToMeetings,
  fillAttendeesFromOutlookTwins,
  upsertContactsFromMeetings
} from './org-reconciler'

/** Syncs often come in a burst (ICS, then each connector account); run once after the last. */
export const RECHECK_DEBOUNCE_MS = 2_000

/** Subscribe to calendar syncs. Returns a function that stops listening. */
export function startMeetingLinkRecheck(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = getEventBus().onDomainEvent('calendar:synced', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        // The contact pass reads every meeting; run it only when one gained attendees.
        if (fillAttendeesFromOutlookTwins().filled > 0) upsertContactsFromMeetings()
        recheckTimeLinks()
        autoLinkRecordingsToMeetings()
      } catch (error) {
        console.error('[MeetingLinks] Re-check after calendar sync failed:', error)
      }
    }, RECHECK_DEBOUNCE_MS)
    timer.unref?.()
  })
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    unsubscribe()
  }
}
