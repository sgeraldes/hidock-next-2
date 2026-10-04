/**
 * Organization Reconciler
 *
 * Ties the knowledge graph together after calendar syncs and transcriptions:
 *  - auto-links recordings to meetings by time overlap (recordings and
 *    meetings arrive independently — the device downloads audio, the ICS sync
 *    brings meetings, and either can come first)
 *  - creates/updates People (contacts) from meeting attendees and links them
 *    via meeting_contacts
 *  - one-time repair of meetings stored before ICS text unescaping existed
 *    (descriptions with literal "\n" runs)
 */

import { unescapeIcsText } from '@hidock/calendar-sync'
import {
  queryAll,
  queryOne,
  run,
  runInTransaction,
  meetingBaseUid,
  insertIdentitySuggestion,
  getAllRecordingPreassignments,
  getMentionResolution,
  recordMentionResolutionNoSave,
  getAmbiguousBucketResolutions,
  getBucketResolution,
  getActiveCalendarSyncToken,
  healRecordingStatusFromTranscripts,
  isProjectDiscoveryRejected,
  filterVisibleEntityIds,
  recordProjectDiscoveryObservation,
  clearProjectDiscoveryObservations,
  getProjectDiscoveryCorroborations,
  type RecordingPreassignment,
  type BucketRecording,
  type BucketResolution,
  type BucketRuleOptions
} from './database'
import {
  mentionSubjectKey,
  recordDecisionNoSave,
  snapshotMentionNoSave,
  wasMentionUndoneFor,
  wasUndone
} from './identity-decisions'
import { filterEligibleRecordingIds } from './recording-eligibility'
import { mergeContactsWithGraph } from './knowledge-graph-service'
import { resolveContact, resolveProject } from './entity-resolver'
import {
  isGenericSpeakerLabel,
  cleanRole,
  isNotAPersonName,
  calendarDisplayName,
  addressLocalPart,
  addressesUnderTwoNames,
  isSharedMailbox
} from './entity-normalize'
import { decideProjectDiscovery, scoreProjectNameCandidate } from './project-discovery-gate'
import { canUpgrade, methodConfidence } from './signal-tiers'
import { LONG_MEETING_MS } from './recording-match-scoring'
import { EARLY_START_TOLERANCE_MS, MIN_TIME_LINK_COVERAGE, meetingCoverage } from './meeting-coverage'
import { createHash, randomUUID } from 'crypto'

/** Resolver thresholds (INTELLIGENCE.md §2): ≥0.8 auto-link, 0.5–0.8 suggest, <0.5 create. */
const AUTO_LINK_THRESHOLD = 0.8
const SUGGEST_THRESHOLD = 0.5

interface MeetingRow {
  id: string
  subject: string
  start_time: string
  end_time: string
  is_all_day?: number
  attendees?: string
  organizer_name?: string
  organizer_email?: string
  description?: string
  location?: string
}

interface RecordingRow {
  id: string
  filename?: string
  date_recorded: string
  duration_seconds?: number
  file_size?: number
  meeting_id?: string
}

/**
 * correlation_method marking a recording the user explicitly forced STANDALONE
 * (via a live-recording pre-assignment with meeting_id = NULL). Rows with this
 * method are excluded from time-overlap auto-linking on every subsequent pass, so
 * the "don't link me to any meeting" choice sticks after the preassignment row is
 * consumed.
 */
const STANDALONE_METHOD = 'user_preassign_standalone'

/** Estimated duration for recordings without one (seconds). */
const DEFAULT_RECORDING_DURATION = 30 * 60

/**
 * Minimum symmetric fit (intersection-over-union of the two windows) an auto-link
 * winner must clear. Blocks a sliver overlap from silently attributing a recording,
 * and — with the bridge exclusion below — guarantees a tightly-fitting meeting is
 * preferred over a containing all-day event.
 */
export const MIN_AUTO_LINK_FIT = 0.1

export interface AutoLinkWindow {
  id: string
  start: number
  end: number
  isAllDay?: boolean
}

export type AutoLinkDecision =
  | { id: string; fit: number }
  | { id: null; declinedBridge: boolean }

/**
 * Choose the meeting to auto-link a recording to — or decline. Pure so the policy is
 * unit-testable without a database. Rules:
 *   - Score each overlapping meeting by symmetric fit (IoU), NOT raw overlap, so a
 *     tightly-fitting parallel meeting beats a longer one that merely contains the
 *     recording.
 *   - NEVER auto-link to an all-day / ≥4h "bridge" meeting: containment there is a
 *     weak signal with no corroboration available at link time. Such recordings are
 *     left UNLINKED for the dialog / user to place, rather than dumped on the bridge.
 *   - The winner must clear {@link MIN_AUTO_LINK_FIT}.
 * Returns `{ id }` for a link, or `{ id: null, declinedBridge }` when nothing linkable
 * was found (declinedBridge = the only overlaps were bridges we refused to auto-attach).
 */
export function selectAutoLinkMeeting(
  recStart: number,
  recEnd: number,
  windows: AutoLinkWindow[],
  earlyStartToleranceMs = EARLY_START_TOLERANCE_MS
): AutoLinkDecision {
  let best: { id: string; fit: number; overlap: number } | null = null
  let declinedBridge = false

  for (const m of windows) {
    if (!Number.isFinite(m.start) || !Number.isFinite(m.end) || m.end < m.start) continue
    const mStartTol = m.start - earlyStartToleranceMs
    const overlap = Math.max(0, Math.min(recEnd, m.end) - Math.max(recStart, mStartTol))
    if (overlap <= 0) continue

    // Bridge detection uses the REAL duration, not the tolerance-extended window.
    const bridge = m.isAllDay === true || m.end - m.start >= LONG_MEETING_MS
    if (bridge) {
      declinedBridge = true
      continue
    }

    // A meeting that covers less than half of the recording is one of several
    // in it; the transcript match decides those (owner, 2-oct-2026: "Almuerzo").
    if (meetingCoverage(recStart, recEnd, m.start, m.end, earlyStartToleranceMs) < MIN_TIME_LINK_COVERAGE) continue

    const unionMs = Math.max(recEnd, m.end) - Math.min(recStart, mStartTol)
    const fit = unionMs > 0 ? overlap / unionMs : 0
    if (!best || fit > best.fit || (fit === best.fit && overlap > best.overlap)) {
      best = { id: m.id, fit, overlap }
    }
  }

  if (best && best.fit >= MIN_AUTO_LINK_FIT) return { id: best.id, fit: best.fit }
  // declinedBridge is only meaningful when we found no linkable winner at all.
  return { id: null, declinedBridge: declinedBridge && !best }
}

/**
 * Link unlinked recordings to the meeting they overlap the most.
 * A recording may span several meetings (running late / merged sessions) —
 * it links to the one with the largest overlap; other overlaps stay visible
 * as candidates in recording_meeting_candidates.
 */
/** Meetings synced by a connector: ids are `<connectorId>:<externalId>` (connectors/ingestion.ts). */
export const CONNECTOR_MEETING_PREDICATE = `(calendar_sync_token IS NULL AND id LIKE 'm365%:%')`

/**
 * The same meeting often arrives twice, from the ICS feed and from Microsoft
 * 365, with the same times. The selector keeps the first of two equal fits, so
 * the order decides: connector copies first (they carry attendee emails), then
 * by id, the same on every run.
 */
export const CONNECTOR_FIRST_ORDER = `CASE WHEN ${CONNECTOR_MEETING_PREDICATE} THEN 0 ELSE 1 END, id`

/**
 * The meetings that can overlap [recStart, recEnd]: those starting before the
 * recording ends (plus the early-start tolerance) and after it starts minus the
 * longest meeting. `sorted` is by start, stable, so equal starts keep SQL order.
 */
export function windowsNear(
  sorted: AutoLinkWindow[],
  starts: number[],
  maxDurationMs: number,
  recStart: number,
  recEnd: number,
  earlyStartToleranceMs = EARLY_START_TOLERANCE_MS
): AutoLinkWindow[] {
  const lo = lowerBound(starts, recStart - maxDurationMs)
  const hi = lowerBound(starts, recEnd + earlyStartToleranceMs + 1)
  return sorted.slice(lo, hi)
}

function lowerBound(values: number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function autoLinkRecordingsToMeetings(): number {
  // Exclude rows the user forced standalone — their choice must survive every
  // reconcile pass, even after the preassignment row is consumed.
  const recordings = queryAll<RecordingRow>(
    `SELECT id, filename, date_recorded, duration_seconds, file_size, meeting_id
     FROM recordings
     WHERE meeting_id IS NULL AND date_recorded IS NOT NULL
       AND deleted_at IS NULL AND COALESCE(personal, 0) = 0
       AND COALESCE(transcription_status, 'none') != 'no_speech'
       AND (correlation_method IS NULL OR correlation_method != '${STANDALONE_METHOD}')`
  )
  if (recordings.length === 0) return 0

  // User pre-assignments (attribution chosen IN ADVANCE while the device was still
  // recording), keyed by base filename so a .hda device name matches the .wav/.mp3
  // local name. These WIN over time-overlap: an explicit meeting forces that link;
  // an explicit NULL forces standalone. Each is consumed (deleted) once applied.
  const preassignments = getAllRecordingPreassignments()
  const preassignByBase = new Map<string, RecordingPreassignment>()
  for (const pa of preassignments) {
    preassignByBase.set(baseRecordingName(pa.filename).toLowerCase(), pa)
  }

  // Meetings in the current ICS snapshot, plus every meeting a connector
  // brought (Microsoft 365). Connector meetings carry no ICS token, so the
  // snapshot filter alone left every Outlook meeting out of linking (28-sep-2026).
  const activeCalendarToken = getActiveCalendarSyncToken()
  const meetings = queryAll<MeetingRow>(
    activeCalendarToken
      ? `SELECT id, subject, start_time, end_time, is_all_day FROM meetings
         WHERE calendar_sync_token = ? OR ${CONNECTOR_MEETING_PREDICATE}
         ORDER BY ${CONNECTOR_FIRST_ORDER}`
      : `SELECT id, subject, start_time, end_time, is_all_day FROM meetings ORDER BY ${CONNECTOR_FIRST_ORDER}`,
    activeCalendarToken ? [activeCalendarToken] : []
  )
  const meetingIds = new Set(meetings.map((m) => m.id))
  const meetingWindows: AutoLinkWindow[] = meetings
    .map((m) => ({
      id: m.id,
      start: new Date(m.start_time).getTime(),
      end: new Date(m.end_time).getTime(),
      isAllDay: (m.is_all_day ?? 0) === 1
    }))
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end))
  // Each recording checks only the meetings near it (thousands of meetings
  // after a calendar history pull made the full scan quadratic).
  const sortedWindows = [...meetingWindows].sort((a, b) => a.start - b.start)
  const windowStarts = sortedWindows.map((m) => m.start)
  const maxDurationMs = sortedWindows.reduce((max, m) => Math.max(max, m.end - m.start), 0)

  // Collect the work first, then apply in ONE transaction — per-row run()
  // persists the whole sql.js database to disk on every call.
  const overlapUpdates: Array<{ recordingId: string; meetingId: string }> = []
  const preassignUpdates: Array<{ recordingId: string; meetingId: string }> = []
  const standaloneMarks: string[] = []
  const consumedFilenames = new Set<string>()
  let declinedBridgeCount = 0

  for (const rec of recordings) {
    // Pre-assignment first — it overrides time-overlap for this recording.
    const pa = rec.filename ? preassignByBase.get(baseRecordingName(rec.filename).toLowerCase()) : undefined
    if (pa) {
      consumedFilenames.add(pa.filename)
      if (pa.meeting_id && meetingIds.has(pa.meeting_id)) {
        // Explicit meeting wins over any time overlap.
        preassignUpdates.push({ recordingId: rec.id, meetingId: pa.meeting_id })
        continue
      }
      if (pa.meeting_id === null) {
        // Explicit standalone — block time-overlap linking now and forever.
        standaloneMarks.push(rec.id)
        continue
      }
      // meeting_id points at a meeting that no longer exists — fall through to
      // time-overlap (still consume the stale preassignment).
    }

    const recStart = new Date(rec.date_recorded).getTime()
    if (!Number.isFinite(recStart)) continue
    const recEnd = recStart + (rec.duration_seconds || DEFAULT_RECORDING_DURATION) * 1000

    // Fit-based, bridge-excluding selection: a tightly-fitting meeting wins over a
    // containing all-day event, and an all-day/≥4h bridge is never auto-attached.
    const decision = selectAutoLinkMeeting(
      recStart,
      recEnd,
      windowsNear(sortedWindows, windowStarts, maxDurationMs, recStart, recEnd)
    )
    if (decision.id === null) {
      if (decision.declinedBridge) declinedBridgeCount++
    } else {
      overlapUpdates.push({ recordingId: rec.id, meetingId: decision.id })
    }
  }

  const hasWork =
    overlapUpdates.length > 0 ||
    preassignUpdates.length > 0 ||
    standaloneMarks.length > 0 ||
    consumedFilenames.size > 0
  if (!hasWork) {
    if (declinedBridgeCount > 0) {
      console.log(
        `[OrgReconciler] Left ${declinedBridgeCount} recording(s) unlinked - only ` +
        `all-day/long "bridge" meetings overlapped (need user/content corroboration)`
      )
    }
    return 0
  }

  let linked = 0
  runInTransaction(() => {
    for (const u of preassignUpdates) {
      run(
        `UPDATE recordings SET meeting_id = ?, correlation_confidence = 1.0, correlation_method = 'user_preassign'
         WHERE id = ? AND meeting_id IS NULL`,
        [u.meetingId, u.recordingId]
      )
      run(
        `UPDATE knowledge_captures
         SET meeting_id = ?, correlation_confidence = 1.0, correlation_method = 'user_preassign',
             updated_at = CURRENT_TIMESTAMP
         WHERE source_recording_id = ?`,
        [u.meetingId, u.recordingId]
      )
      linked++
    }
    for (const id of standaloneMarks) {
      run(
        `UPDATE recordings SET correlation_method = '${STANDALONE_METHOD}'
         WHERE id = ? AND meeting_id IS NULL`,
        [id]
      )
      run(
        `UPDATE knowledge_captures
         SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_recording_id = ?`,
        [id]
      )
    }
    for (const u of overlapUpdates) {
      run(
        `UPDATE recordings SET meeting_id = ?, correlation_confidence = 0.7, correlation_method = 'time_overlap'
         WHERE id = ? AND meeting_id IS NULL`,
        [u.meetingId, u.recordingId]
      )
      run(
        `UPDATE knowledge_captures
         SET meeting_id = ?, correlation_confidence = 0.7, correlation_method = 'time_overlap',
             updated_at = CURRENT_TIMESTAMP
         WHERE source_recording_id = ?`,
        [u.meetingId, u.recordingId]
      )
      linked++
    }
    // Consume every preassignment we applied (explicit link, standalone, or stale).
    for (const filename of consumedFilenames) {
      run(`DELETE FROM recording_preassignments WHERE filename = ?`, [filename])
    }
  })

  if (linked > 0 || standaloneMarks.length > 0 || declinedBridgeCount > 0) {
    console.log(
      `[OrgReconciler] Auto-linked ${linked} recordings ` +
      `(${preassignUpdates.length} pre-assigned, ${overlapUpdates.length} time-overlap, ` +
      `${standaloneMarks.length} forced standalone, ${declinedBridgeCount} declined-to-bridge)`
    )
  }
  return linked
}

interface AttendeeJson {
  name?: string
  email?: string
}

/** A contact as the calendar passes read it: enough to find, link and rename it. */
interface KnownContact {
  id: string
  name: string
  source: string | null
}

/** The organizer and the attendees with an address on a meeting row, addresses lowercased. */
function calendarPeople(meeting: {
  attendees?: string | null
  organizer_name?: string | null
  organizer_email?: string | null
}): Array<{ name?: string; email: string; role: string }> {
  const people: Array<{ name?: string; email: string; role: string }> = []
  if (meeting.organizer_email) {
    people.push({
      name: meeting.organizer_name ?? undefined,
      email: meeting.organizer_email.toLowerCase(),
      role: 'organizer'
    })
  }
  if (meeting.attendees) {
    try {
      const parsed = JSON.parse(meeting.attendees) as AttendeeJson[]
      for (const a of parsed) {
        if (a.email) people.push({ name: a.name, email: a.email.toLowerCase(), role: 'attendee' })
      }
    } catch {
      // malformed attendees JSON — skip
    }
  }
  return people
}

/** What the calendar says about the names of each address, read once per pass. */
interface CalendarNames {
  /** How many times each display name is given for an address. */
  namesByAddress: Map<string, Map<string, number>>
  /** Addresses that may not take a person's name: shared mailboxes, and addresses a
   *  meeting lists under two different names (a distribution list). */
  notOnePerson: Set<string>
}

function readCalendarNames(peopleByMeeting: ReadonlyArray<ReadonlyArray<{ name?: string; email: string }>>): CalendarNames {
  const namesByAddress = new Map<string, Map<string, number>>()
  const notOnePerson = new Set<string>()
  for (const people of peopleByMeeting) {
    for (const address of addressesUnderTwoNames(people)) notOnePerson.add(address)
    for (const person of people) {
      if (isSharedMailbox(person.email)) notOnePerson.add(person.email)
      const name = calendarDisplayName(person.name, person.email)
      if (!name) continue
      let counts = namesByAddress.get(person.email)
      if (!counts) namesByAddress.set(person.email, (counts = new Map()))
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return { namesByAddress, notOnePerson }
}

/**
 * Whether a contact's name is a placeholder the calendar should replace: not a name at
 * all (the address, "Name <address>", a phone number), or the start of its own address
 * as upsertContactsFromMeetings stores it when the calendar gave no name.
 */
function hasPlaceholderName(name: string, email: string | null): boolean {
  if (isNotAPersonName(name)) return true
  return !!email && name === addressLocalPart(email)
}

/** The address a contact stands for: its email, or one written inside its name. */
function contactAddress(contact: { name: string; email: string | null }): string | null {
  const stored = (contact.email || '').trim().toLowerCase()
  if (stored) return stored
  const inName = /[^\s<>()@"']+@[^\s<>()@"']+\.[^\s<>()@"']+/.exec(contact.name || '')
  return inName ? inName[0].toLowerCase() : null
}

/**
 * Create/update contacts from meeting attendees + organizers and link them to
 * their meetings. Idempotent — safe to run after every sync.
 *
 * A pass that would find nothing new is skipped: the shape of the meetings, the
 * contacts, the links and the merge journal is stored after each pass, and the next
 * one runs only when it differs (480 ms on every start and calendar sync on the real
 * library, parsing 6,615 unchanged attendee lists, 4-oct-2026). Known gap, the same
 * as the address rename's: an edit that keeps every count and length equal waits
 * for the next change.
 */
export function upsertContactsFromMeetings(): { contacts: number; links: number } {
  if (readConfigValue(CONTACTS_UPSERT_FINGERPRINT_KEY) === contactsUpsertFingerprint()) return { contacts: 0, links: 0 }

  const meetings = queryAll<MeetingRow>(
    `SELECT id, subject, start_time, attendees, organizer_name, organizer_email FROM meetings`
  )

  let newContacts = 0
  let newLinks = 0

  runInTransaction(() => {
    // One read of the contacts and of the links, then lookups in memory. The
    // per-person queries this replaces filtered on LOWER(email), which no index
    // serves, and prepared a statement on every call: 15,920 person slots against
    // 1,611 contacts froze the window for seconds at boot (30-sep-2026). The key
    // is SQLite's own LOWER(email), and the first row by rowid wins, exactly as
    // the query it replaces returned.
    const contactsByEmail = new Map<string, KnownContact>()
    const contactsById = new Map<string, KnownContact>()
    for (const known of queryAll<{ id: string; name: string; email_key: string | null; source: string | null }>(
      `SELECT id, name, LOWER(email) AS email_key, source FROM contacts ORDER BY rowid`
    )) {
      const entry = { id: known.id, name: known.name, source: known.source }
      contactsById.set(known.id, entry)
      if (known.email_key !== null && !contactsByEmail.has(known.email_key)) contactsByEmail.set(known.email_key, entry)
    }

    // The email of a contact that was merged into another belongs to the survivor.
    // A merge keeps the survivor's own email and drops the loser's, and the loser's
    // address is still on the meetings that named it: without this the next pass
    // saw an address nobody owned, created the contact again, and the name merge
    // folded it away again. Measured on the real data: the same 34 contacts were
    // created and merged on every start and after every calendar sync, and the
    // merge journal grew by about 1,000 rows a day (30-sep-2026). The journal is
    // the record of who took whom; a merge that was undone is not in it.
    // Known trade-off: an address that was reassigned to another person after a merge (or a
    // shared mailbox) resolves to the survivor of that merge until the merge is undone.
    const mergedInto = new Map<string, string>() // loser id -> keeper id
    const mergedEmailOwner = new Map<string, string>() // loser email -> keeper id
    for (const row of queryAll<{ loser_id: string | null; keeper_id: string; email: string | null }>(
      `SELECT loser_id, keeper_id, json_extract(loser_snapshot, '$.email') AS email
         FROM merge_journal WHERE kind = 'contact' AND undone_at IS NULL ORDER BY seq`
    )) {
      if (row.loser_id) mergedInto.set(row.loser_id, row.keeper_id)
      if (row.email && row.email.trim()) mergedEmailOwner.set(row.email.trim().toLowerCase(), row.keeper_id)
    }
    const survivorOfMergedEmail = (email: string): KnownContact | undefined => {
      let owner = mergedEmailOwner.get(email)
      // The keeper may itself have been merged later: follow the chain to a contact that still exists.
      for (let hops = 0; owner && !contactsById.has(owner) && hops < 20; hops++) owner = mergedInto.get(owner)
      return owner ? contactsById.get(owner) : undefined
    }
    const linkedPairs = new Set(
      queryAll<{ meeting_id: string; contact_id: string }>(`SELECT meeting_id, contact_id FROM meeting_contacts`).map(
        (link) => `${link.meeting_id}\u0000${link.contact_id}`
      )
    )

    // Parsed once: the name rules need every meeting before the first contact is named,
    // since a later meeting may show an address is a distribution list.
    const peopleByMeeting = meetings.map((meeting) => calendarPeople(meeting))
    const calendarNames = readCalendarNames(peopleByMeeting)

    for (const [index, meeting] of meetings.entries()) {
      for (const person of peopleByMeeting[index]) {
        let contact = contactsByEmail.get(person.email) ?? survivorOfMergedEmail(person.email)
        // A calendar often lists the address itself as the name: that is no name. A
        // shared mailbox or a distribution list is not one person, so it keeps the placeholder.
        const displayName = calendarNames.notOnePerson.has(person.email)
          ? null
          : calendarDisplayName(person.name, person.email)
        if (!contact) {
          const id = randomUUID()
          const now = meeting.start_time || new Date().toISOString()
          const storedName = displayName ?? addressLocalPart(person.email)
          run(
            `INSERT INTO contacts (id, name, email, type, first_seen_at, last_seen_at, meeting_count)
             VALUES (?, ?, ?, 'unknown', ?, ?, 0)`,
            [id, storedName, person.email, now, now]
          )
          contact = { id, name: storedName, source: null }
          contactsByEmail.set(person.email, contact)
          contactsById.set(id, contact)
          newContacts++
        } else if (displayName && contact.source !== 'user' && hasPlaceholderName(contact.name, person.email)) {
          // upgrade a placeholder name (the address, or its start) when a real name appears
          run(`UPDATE contacts SET name = ? WHERE id = ?`, [displayName, contact.id])
          contact.name = displayName
        }

        const pair = `${meeting.id}\u0000${contact.id}`
        if (!linkedPairs.has(pair)) {
          // These people come straight from the meeting's calendar organizer/
          // attendee data, so the membership is CALENDAR-authored (structural) —
          // tag it 'calendar' so the non-owner identity boundary treats it as
          // always-eligible, matching the sibling calendar path in database.ts
          // (syncMeetingContacts). Omitting the source left it NULL = legacy =
          // fail-closed suppressed, which would wrongly hide a real calendar
          // contact and (round-30) mis-partition it in mergeDuplicateContacts.
          run(
            `INSERT INTO meeting_contacts (meeting_id, contact_id, role, source) VALUES (?, ?, ?, 'calendar')`,
            [meeting.id, contact.id, person.role]
          )
          linkedPairs.add(pair)
          newLinks++
        }
      }
    }

    // Refresh meeting counts + last_seen from actual links
    run(`
      UPDATE contacts SET
        meeting_count = (SELECT COUNT(1) FROM meeting_contacts mc WHERE mc.contact_id = contacts.id),
        last_seen_at = COALESCE(
          (SELECT MAX(m.start_time) FROM meeting_contacts mc JOIN meetings m ON m.id = mc.meeting_id
           WHERE mc.contact_id = contacts.id),
          last_seen_at
        )
    `)
  })

  writeConfigValue(CONTACTS_UPSERT_FINGERPRINT_KEY, contactsUpsertFingerprint())

  if (newContacts > 0 || newLinks > 0) {
    console.log(`[OrgReconciler] Contacts: +${newContacts} people, +${newLinks} meeting links`)
  }
  return { contacts: newContacts, links: newLinks }
}

/** Config key of the state the last contacts upsert left behind. */
const CONTACTS_UPSERT_FINGERPRINT_KEY = 'orgReconciler.contactsUpsert.fingerprint'
/** Bump when the upsert rules change, so the next pass runs in full. */
const CONTACTS_UPSERT_RULES_VERSION = 1

/** Counts and lengths of everything the upsert reads, summed in SQLite. */
function contactsUpsertFingerprint(): string {
  const contacts = queryOne<{ n: number; last_row: number; names: number; emails: number; owned: number }>(
    `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_row, COALESCE(SUM(LENGTH(name)), 0) AS names,
            COALESCE(SUM(LENGTH(email)), 0) AS emails, COALESCE(SUM(source = 'user'), 0) AS owned
       FROM contacts`
  )
  const links = queryOne<{ n: number; last_row: number }>(
    'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_row FROM meeting_contacts'
  )
  // last_seen_at follows the meetings' start times, so a reschedule must change the
  // fingerprint even when MAX(updated_at) does not move (it is written in two formats).
  const startTimes = queryOne<{ seconds: number }>(
    "SELECT COALESCE(SUM(CAST(strftime('%s', start_time) AS INTEGER)), 0) AS seconds FROM meetings"
  )
  // rowid, not seq: seq has no index and the rows carry large snapshots, so MAX(seq)
  // read the whole table (50 ms on the real library). Every merge appends a row.
  const merges = queryOne<{ n: number; last_row: number; undone: number }>(
    'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_row, COUNT(undone_at) AS undone FROM merge_journal'
  )
  return createHash('sha256')
    .update(
      [
        CONTACTS_UPSERT_RULES_VERSION,
        addressRenameMeetingsShape(),
        JSON.stringify(startTimes),
        JSON.stringify(contacts),
        JSON.stringify(links),
        JSON.stringify(merges)
      ].join('\n')
    )
    .digest('hex')
}

/**
 * Give a contact named after its address the name the calendar uses for that address.
 * 3-oct-2026 on the live database: 299 contacts were named after an address (the
 * meeting sync stored the address when the calendar gave no name), 53 of them had a
 * display name in the calendar, and "juanchobq2017@gmail.com" had become a shared
 * first-name bucket for Juan. The most frequent display name wins (ties: the one with
 * more words, then alphabetical). A contact the owner made (source 'user') is never
 * renamed, and neither is a shared mailbox (info@) or an address a meeting lists under
 * two different names (a distribution list). There is no identity-decision kind for a
 * rename, so each one is logged. Idempotent: a renamed contact has a real name and is
 * not picked again.
 *
 * The addresses with no calendar name stay placeholders, so there are always targets.
 * To keep a reconcile with nothing new from parsing every meeting again (review of PR
 * 143, F2), the pass stores a fingerprint of the meetings (count, last row, last
 * update, and the total length of the attendee and organizer fields, which SQLite sums
 * without the app reading them) and of the remaining targets, and skips when both are
 * unchanged. Known gap: an edit that keeps every one of those numbers equal (a display
 * name changed to one of the same length, with no updated_at bump) waits for the next
 * change to the meetings or the contacts.
 */
export function renameAddressNamedContacts(): number {
  const targets = queryAll<{ id: string; name: string; email: string | null; source: string | null }>(
    `SELECT id, name, email, source FROM contacts WHERE source IS NULL OR source <> 'user'`
  )
    .map((c) => ({ ...c, address: contactAddress(c) }))
    .filter((c): c is typeof c & { address: string } => !!c.address && hasPlaceholderName(c.name, c.address))
  if (targets.length === 0) return 0

  const meetingsShape = addressRenameMeetingsShape()
  if (readConfigValue(ADDRESS_RENAME_FINGERPRINT_KEY) === addressRenameFingerprint(meetingsShape, targets)) return 0

  const calendarNames = readCalendarNames(
    queryAll<{ attendees: string | null; organizer_name: string | null; organizer_email: string | null }>(
      `SELECT attendees, organizer_name, organizer_email FROM meetings`
    ).map((meeting) => calendarPeople(meeting))
  )

  const words = (name: string) => name.split(/\s+/).length
  const renamedIds = new Set<string>()
  runInTransaction(() => {
    for (const contact of targets) {
      if (calendarNames.notOnePerson.has(contact.address)) continue
      const counts = calendarNames.namesByAddress.get(contact.address)
      if (!counts) continue
      const [best] = [...counts.entries()].sort(
        ([a, ca], [b, cb]) => cb - ca || words(b) - words(a) || a.localeCompare(b)
      )
      run(`UPDATE contacts SET name = ? WHERE id = ?`, [best[0], contact.id])
      console.log(`[OrgReconciler] Renamed contact ${contact.id} from its address to its calendar name "${best[0]}"`)
      renamedIds.add(contact.id)
    }
    const remaining = targets.filter((c) => !renamedIds.has(c.id))
    writeConfigValue(ADDRESS_RENAME_FINGERPRINT_KEY, addressRenameFingerprint(meetingsShape, remaining))
  })
  if (renamedIds.size > 0) console.log(`[OrgReconciler] Renamed ${renamedIds.size} contact(s) named after an address`)
  return renamedIds.size
}

/** Config key of the last address-rename pass's fingerprint. */
const ADDRESS_RENAME_FINGERPRINT_KEY = 'orgReconciler.addressRename.fingerprint'
/** Bump when the rename rules change, so the next pass runs in full. */
const ADDRESS_RENAME_RULES_VERSION = 1

/** Counts and lengths of the meetings table, summed in SQLite: no attendee list is read into the app. */
function addressRenameMeetingsShape(): string {
  const shape = queryOne<{ n: number; last_row: number; last_update: string; attendees: number; organizer: number }>(
    `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last_row, COALESCE(MAX(updated_at), '') AS last_update,
            COALESCE(SUM(LENGTH(attendees)), 0) AS attendees,
            COALESCE(SUM(LENGTH(organizer_email)), 0) + COALESCE(SUM(LENGTH(organizer_name)), 0) AS organizer
       FROM meetings`
  )
  return shape ? [shape.n, shape.last_row, shape.last_update, shape.attendees, shape.organizer].join('|') : ''
}

function addressRenameFingerprint(meetingsShape: string, targets: ReadonlyArray<{ id: string; address: string }>): string {
  const ids = targets.map((t) => `${t.id}:${t.address}`).sort()
  return createHash('sha256')
    .update(`${ADDRESS_RENAME_RULES_VERSION}\n${meetingsShape}\n${ids.join('\n')}`)
    .digest('hex')
}

function readConfigValue(key: string): string | null {
  return queryOne<{ value: string | null }>('SELECT value FROM config WHERE key = ?', [key])?.value ?? null
}

function writeConfigValue(key: string, value: string): void {
  run('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)', [key, value, new Date().toISOString()])
}

/**
 * One-time repair: meetings synced before ICS unescaping still store literal
 * "\n" and "\," sequences. Detect and unescape them in place.
 */
export function repairEscapedMeetingText(): number {
  const rows = queryAll<{ id: string; subject: string; description?: string; location?: string }>(
    `SELECT id, subject, description, location FROM meetings
     WHERE description LIKE '%\\n%' OR subject LIKE '%\\,%' OR location LIKE '%\\,%'`
  )
  let repaired = 0
  runInTransaction(() => {
    for (const row of rows) {
      const subject = unescapeIcsText(row.subject || '')
      const description = row.description ? unescapeIcsText(row.description) : row.description
      const location = row.location ? unescapeIcsText(row.location) : row.location
      if (subject !== row.subject || description !== row.description || location !== row.location) {
        run(`UPDATE meetings SET subject = ?, description = ?, location = ? WHERE id = ?`, [
          subject,
          description ?? null,
          location ?? null,
          row.id
        ])
        repaired++
      }
    }
  })
  if (repaired > 0) console.log(`[OrgReconciler] Unescaped ICS text on ${repaired} meetings`)
  return repaired
}

/**
 * Idempotently link a contact to a meeting and refresh its meeting count/last-seen.
 *
 * v44/round-27 provenance: this helper only ever links AI-EXTRACTED / auto-resolved
 * participants (applyTranscriptEntities + autoSplitAmbiguousBuckets), so a NEW row
 * it writes is TRANSCRIPT-derived — tagged source='transcript' + the source
 * recording id so the non-owner identity surfaces gate it by that recording's
 * eligibility. A NULL sourceRecordingId leaves the row transcript-with-no-recording
 * ⇒ ineligible fail-closed (correct: unprovenanced transcript membership).
 */
function linkContactToMeeting(
  contactId: string,
  meetingId: string | undefined,
  now: string,
  sourceRecordingId?: string | null
): void {
  if (!contactId || !meetingId) return
  const link = queryOne<{ meeting_id: string }>(
    `SELECT meeting_id FROM meeting_contacts WHERE meeting_id = ? AND contact_id = ?`,
    [meetingId, contactId]
  )
  if (!link) {
    run(`INSERT INTO meeting_contacts (meeting_id, contact_id, role, source, source_recording_id) VALUES (?, ?, 'attendee', 'transcript', ?)`, [
      meetingId,
      contactId,
      sourceRecordingId ?? null
    ])
  }
  run(
    `UPDATE contacts SET
       meeting_count = (SELECT COUNT(1) FROM meeting_contacts mc WHERE mc.contact_id = contacts.id),
       last_seen_at = ?
     WHERE id = ?`,
    [now, contactId]
  )
}

/**
 * Persist people + project extracted from a transcript by the AI analysis.
 * The published Outlook ICS feed carries no attendee data, so transcripts are
 * the primary source of "who was in this meeting". Projects are matched by
 * name (case-insensitive) or created when the model proposes a new one.
 */
export function applyTranscriptEntities(opts: {
  meetingId?: string
  /** The recording this analysis came from. When present, a stored per-recording
   *  mention resolution is honored, and an attendee-context split is remembered so a
   *  future re-analysis attributes the same mention to the same real person. */
  recordingId?: string
  participants?: Array<{ name: string; role?: string }>
  project?: { name: string; is_new?: boolean }
}): { contacts: number; projectLinked: boolean } {
  let contacts = 0
  let projectLinked = false

  runInTransaction(() => {
    const now = new Date().toISOString()

    // Names of other attendees already on the meeting — evidence for suggestions.
    const meetingAttendeeNames = (): string[] =>
      opts.meetingId
        ? queryAll<{ name: string }>(
            `SELECT c.name FROM meeting_contacts mc JOIN contacts c ON c.id = mc.contact_id WHERE mc.meeting_id = ?`,
            [opts.meetingId]
          )
            .map((r) => r.name)
            .slice(0, 5)
        : []

    for (const rawPerson of opts.participants ?? []) {
      const person = { ...rawPerson, role: cleanRole(rawPerson.role) || undefined }
      const name = (person.name || '').trim()
      if (!name || name.length < 2 || isGenericSpeakerLabel(name)) continue

      let contactId: string

      // 0. Honor a stored per-recording resolution first (user pick or auto-split) —
      // it overrides the resolver so a re-analysis never re-buckets a settled mention.
      if (opts.recordingId) {
        const decision = getMentionResolution(opts.recordingId, name)
        if (decision.decided) {
          if (decision.contactId) {
            contactId = decision.contactId
          } else {
            // Explicitly marked Unclear — leave it unattributed, do not create.
            continue
          }
          linkContactToMeeting(contactId, opts.meetingId, now, opts.recordingId)
          continue
        }
      }

      // Confidence-scored resolution replaces the old exact-name lookup — this is
      // what stops the duplicate factory (INTELLIGENCE.md §2).
      const res = resolveContact(name, { meetingId: opts.meetingId })

      // Ambiguous bare-first-name bucket ("Sergio" = several real people): keep the
      // mention in the bucket, NEVER auto-link to one surname-bearer and NEVER queue a
      // merge. It gets split per recording via the "Resolve per meeting" surface.
      if (res.ambiguous) {
        if (res.id) {
          contactId = res.id
        } else {
          const id = randomUUID()
          // v45/round-28: a transcript-extracted ENTITY ⇒ source='transcript' +
          // the source recording, so the visible-identity boundary suppresses it
          // on non-owner surfaces once that recording is excluded (ADV27-1).
          // v46/round-31 (ADV29-2): stamp role_source_recording_id = the recording
          // when we set a transcript-derived role, so a non-owner read can blank the
          // role if this recording is later excluded even while the entity stays
          // visible via another eligible recording.
          run(
            `INSERT INTO contacts (id, name, type, role, first_seen_at, last_seen_at, meeting_count, source, source_recording_id, role_source_recording_id, role_origin)
             VALUES (?, ?, 'unknown', ?, ?, ?, 0, 'transcript', ?, ?, ?)`,
            [id, name, person.role ?? null, now, now, opts.recordingId ?? null, person.role ? (opts.recordingId ?? null) : null, person.role ? 'transcript' : null]
          )
          contactId = id
          contacts++
        }
        linkContactToMeeting(contactId, opts.meetingId, now, opts.recordingId)
        continue
      }

      if (res.id && res.confidence >= AUTO_LINK_THRESHOLD) {
        // High confidence — link the existing contact, never create.
        contactId = res.id
        if (person.role) {
          // ADV28-1 (round-30): transcript enrichment must NOT mutate a STRUCTURAL
          // (calendar/user) or legacy contact's DISPLAYED fields. A transcript-derived
          // role written onto a structural entity would show on People + graph detail
          // and could never be revoked when the source recording is later excluded
          // (personal/soft-deleted/value/purged) — the structural entity has no field
          // provenance to reverse. So only fill an EMPTY role on a TRANSCRIPT-
          // provenanced contact, whose whole visibility is already gated by the
          // source recording via filterVisibleEntityIds. Structural/legacy contacts
          // keep only calendar/manual data (fail-closed: no laundering).
          const existing = queryOne<{ role?: string; source?: string | null }>(
            `SELECT role, source FROM contacts WHERE id = ?`,
            [contactId]
          )
          if (existing && !existing.role && existing.source === 'transcript') {
            // v46/round-31 (ADV29-2): record the recording that supplied this role so
            // a non-owner read blanks it if the recording is later excluded, even
            // though the entity stays visible via another eligible recording.
            run(`UPDATE contacts SET role = ?, role_source_recording_id = ?, role_origin = 'transcript' WHERE id = ?`, [
              person.role,
              opts.recordingId ?? null,
              contactId
            ])
          }
        }
        // Remember an attendee-context split so re-analysis attributes it the same way
        // instead of re-running the bucket guess (only meaningful with a recording).
        if (res.method === 'attendee-context' && opts.recordingId) {
          recordMentionResolutionNoSave(opts.recordingId, name, contactId, 'attendee-context', res.confidence)
        }
      } else if (res.id && res.confidence >= SUGGEST_THRESHOLD) {
        // Mid confidence — queue a reviewable suggestion; do NOT create or link.
        // v44/round-27 (ADV26-1): persist the authoritative source recording id so
        // this NON-graph transcript suggestion is revalidated through the recording
        // allowlist at surface + accept (excluded/purged source ⇒ suppressed/refused).
        insertIdentitySuggestion('person', name, res.id, res.confidence, {
          method: res.method,
          meetingId: opts.meetingId,
          coOccurring: meetingAttendeeNames(),
          ...(res.rarity ? { rarity: res.rarity } : {})
        }, opts.recordingId ? [opts.recordingId] : [])
        continue
      } else {
        // Low confidence — genuinely new person.
        const id = randomUUID()
        // v45/round-28: transcript-extracted ENTITY ⇒ source='transcript' + recording (ADV27-1).
        // v46/round-31 (ADV29-2): stamp role_source_recording_id when a transcript role is set.
        run(
          `INSERT INTO contacts (id, name, type, role, first_seen_at, last_seen_at, meeting_count, source, source_recording_id, role_source_recording_id, role_origin)
           VALUES (?, ?, 'unknown', ?, ?, ?, 0, 'transcript', ?, ?, ?)`,
          [id, name, person.role ?? null, now, now, opts.recordingId ?? null, person.role ? (opts.recordingId ?? null) : null, person.role ? 'transcript' : null]
        )
        contactId = id
        contacts++
      }

      if (contactId && opts.meetingId) {
        linkContactToMeeting(contactId, opts.meetingId, now, opts.recordingId)
      }
    }

    const projectName = (opts.project?.name || '').trim()
    if (projectName) {
      const res = resolveProject(projectName, { meetingId: opts.meetingId })
      let projectId: string | null = null

      if (res.id && res.confidence >= AUTO_LINK_THRESHOLD) {
        projectId = res.id
      } else if (res.id && res.confidence >= SUGGEST_THRESHOLD) {
        // v44/round-27 (ADV26-1): persist the source recording id (see person path).
        insertIdentitySuggestion('project', projectName, res.id, res.confidence, {
          method: res.method,
          meetingId: opts.meetingId,
          coOccurring: [],
          ...(res.rarity ? { rarity: res.rarity } : {})
        }, opts.recordingId ? [opts.recordingId] : [])
      } else if (isProjectDiscoveryRejected(projectName)) {
        // Dismissed discovery — a durable tombstone (v41) blocks silent
        // re-creation on re-analysis. Only the AUTO-create path is blocked:
        // if the user manually creates a project with this name, createProject
        // clears the tombstone and resolveProject links to it normally above.
        // Deliberately short-circuits BEFORE the discovery gate: a dismissed name
        // must not even accumulate sightings, or it would climb back into the
        // deferred-suggestion queue the user just cleared.
      } else {
        // F12 discovery gate. The resolver landing here means only "this is not a
        // project I already know" — NOT "this is a project". Require a plausible
        // name AND corroboration across >= 2 distinct sources before minting a
        // row; anything weaker is remembered as a deferred suggestion instead of
        // becoming a zero-item dead-end project.
        //
        // The ledger key must be STABLE across re-processing, so it identifies
        // the CAPTURE (the recording), not the meeting: a recording id never
        // changes, while its meeting_id is assigned late by correlation and
        // rewritten by occurrence merges. Keying on the meeting let one
        // conversation bank two sightings — once as 'r:x' before it was
        // correlated, again as 'm:y' after — manufacturing the very corroboration
        // this gate exists to require. The meeting rides along separately so the
        // count still collapses two recordings of one conversation into one
        // source. With neither id there is nothing to corroborate against, so we
        // neither record nor create.
        const quality = scoreProjectNameCandidate(projectName)
        const sourceKey = opts.recordingId
          ? `r:${opts.recordingId}`
          : opts.meetingId
            ? `m:${opts.meetingId}`
            : null
        // Score 0 is structural noise (a sentence fragment, digit soup) — dropped
        // before it reaches the ledger so the deferred queue stays reviewable.
        const distinctSources =
          quality.score > 0 && sourceKey
            ? recordProjectDiscoveryObservation(projectName, sourceKey, opts.meetingId ?? null, quality.score)
            : 0
        const decision = decideProjectDiscovery({ name: projectName, distinctSources })

        if (decision.action === 'create') {
          const id = randomUUID()
          // origin='discovered' (v42): durable provenance — ONLY rows created here
          // are dismissable via projects:dismissDiscovered (fail-closed elsewhere).
          // source='transcript' + recording (F18/round-28): the project ENTITY is
          // transcript-extracted, so it is suppressed on non-owner surfaces once its
          // source recording is excluded (ADV27-1).
          run(`INSERT INTO projects (id, name, status, origin, source, source_recording_id) VALUES (?, ?, 'active', 'discovered', 'transcript', ?)`, [
            id,
            projectName,
            opts.recordingId ?? null
          ])
          projectId = id

          // Link EVERY meeting whose mention earned this project, not just the one
          // that happened to cross the threshold. The corroborating sightings are
          // the evidence for creating it; dropping them when the ledger is cleared
          // left the graph permanently missing those associations (the first
          // meeting could only ever be linked by reprocessing its transcript).
          // Runs BEFORE the purge, inside applyTranscriptEntities' transaction.
          //
          // ADV-F1 (post-merge review): each backfilled row MUST carry the SAME
          // per-row provenance the normal link path stamps below —
          // source='transcript' + the recording that produced THIS corroborating
          // sighting (from the observation's 'r:<id>' source_key). A provenance-less
          // (source=NULL) row is legacy/ineligible under filterEligibleMembershipRows,
          // so if the threshold-crossing recording is later excluded, the still-
          // eligible corroborating recording could no longer keep the project visible
          // (filterVisibleEntityIds needs >= 1 ELIGIBLE membership) and the whole
          // project would vanish. Stamping the true source recording keeps the
          // corroborating association alive exactly as long as its recording is.
          const corroborating = getProjectDiscoveryCorroborations(projectName)
          let backfilled = 0
          for (const { meetingId: mid, recordingId: rid } of corroborating) {
            if (mid === opts.meetingId) continue // linked below by the normal path
            run(
              `INSERT OR IGNORE INTO meeting_projects (meeting_id, project_id, source, source_recording_id) VALUES (?, ?, 'transcript', ?)`,
              [mid, id, rid]
            )
            backfilled++
          }

          // The name is settled — stop tracking it as an open discovery question.
          clearProjectDiscoveryObservations(projectName)
          console.log(
            `[OrgReconciler] Discovered project "${projectName}" ` +
              `(name score ${decision.score}, seen in ${decision.distinctSources} sources` +
              `${backfilled > 0 ? `, linked ${backfilled} corroborating meeting(s)` : ''})`
          )
        } else {
          console.log(
            `[OrgReconciler] Withheld project "${projectName}" — ${decision.action} ` +
              `(name score ${decision.score}, ${decision.distinctSources} source(s): ${decision.reasons.join(', ')})`
          )
        }
      }

      if (projectId && opts.meetingId) {
        const link = queryOne<{ meeting_id: string }>(
          `SELECT meeting_id FROM meeting_projects WHERE meeting_id = ? AND project_id = ?`,
          [opts.meetingId, projectId]
        )
        if (!link) {
          // v44 provenance: this project link is AI-extracted from the transcript ⇒
          // 'transcript' + the source recording id (gated by its eligibility).
          run(`INSERT INTO meeting_projects (meeting_id, project_id, source, source_recording_id) VALUES (?, ?, 'transcript', ?)`, [
            opts.meetingId,
            projectId,
            opts.recordingId ?? null
          ])
        }
        projectLinked = true
      }
    }
  })

  return { contacts, projectLinked }
}

interface DuplicateRecordingRow {
  id: string
  filename: string
  file_path?: string | null
  created_at?: string | null
  on_device?: number | null
  on_local?: number | null
  meeting_id?: string | null
  /** Whether a transcript row points at this recording. */
  hasTranscript?: boolean
}

/** Strip a recording audio extension so .hda/.wav/.mp3/.m4a variants group together. */
function baseRecordingName(filename: string): string {
  return (filename || '').replace(/\.(hda|wav|mp3|m4a)$/i, '')
}

/**
 * Choose which row in a duplicate group to keep. Preference order:
 *   1. has a transcript (most expensive to recreate)
 *   2. .wav filename (the downloaded/played format the UI prefers)
 *   3. file_path set (an actual local file exists)
 *   4. most recent created_at
 * Pure so the selection rules can be unit-tested without a database.
 */
export function pickKeeperRecording<T extends DuplicateRecordingRow>(rows: T[]): T {
  const isWav = (r: T) => /\.wav$/i.test(r.filename || '')
  const hasPath = (r: T) => !!(r.file_path && r.file_path.length > 0)
  return [...rows].sort((a, b) => {
    const at = a.hasTranscript ? 1 : 0
    const bt = b.hasTranscript ? 1 : 0
    if (at !== bt) return bt - at
    const aw = isWav(a) ? 1 : 0
    const bw = isWav(b) ? 1 : 0
    if (aw !== bw) return bw - aw
    const ap = hasPath(a) ? 1 : 0
    const bp = hasPath(b) ? 1 : 0
    if (ap !== bp) return bp - ap
    const ac = a.created_at || ''
    const bc = b.created_at || ''
    if (ac !== bc) return ac < bc ? 1 : -1
    return 0
  })[0]
}

/**
 * Collapse legacy duplicate recordings — rows for the same audio that predate
 * markRecordingDownloaded() becoming extension-variant-aware (e.g. a .hda row
 * and a .wav row for the same take, both with file_path set). The Library
 * showed the meeting twice and batch transcription paid to transcribe it twice.
 *
 * For each base-filename group with more than one row we pick a keeper (see
 * pickKeeperRecording), repoint child rows off the losers, fold the losers'
 * lifecycle flags onto the keeper, and delete the loser rows — all in ONE
 * transaction so the whole sql.js DB is persisted once, not per row.
 */
export function mergeDuplicateRecordings(): number {
  const recordings = queryAll<DuplicateRecordingRow>(
    `SELECT id, filename, file_path, created_at, on_device, on_local, meeting_id FROM recordings`
  )
  if (recordings.length === 0) return 0

  // Which recordings already have a transcript — drives keeper selection.
  const withTranscript = new Set(
    queryAll<{ recording_id: string }>(`SELECT recording_id FROM transcripts`).map((t) => t.recording_id)
  )

  const groups = new Map<string, DuplicateRecordingRow[]>()
  for (const rec of recordings) {
    const key = baseRecordingName(rec.filename || rec.id).toLowerCase()
    const list = groups.get(key)
    if (list) list.push(rec)
    else groups.set(key, [rec])
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1)
  if (dupGroups.length === 0) return 0

  // ADV28-3 (round-30) — NEVER merge recordings across an eligibility boundary.
  // This reconcile REPARENTS a loser's knowledge_captures (and transcript / vector
  // rows) onto the keeper. If an ELIGIBLE keeper absorbed a personal / soft-deleted /
  // value-excluded sibling, that sibling's captures would be reparented onto the
  // eligible keeper and pass filterEligibleCaptureIds again ⇒ formerly-excluded
  // content reaches RAG / LLM / display / search (REOPENS the core F16/F17 promise).
  // Fix: partition each duplicate group by the positive recording allowlist and
  // collapse ONLY the ELIGIBLE members among themselves. Excluded recordings are
  // left as separate rows, each still gated by its own recording's exclusion (their
  // captures keep pointing at the excluded recording). This also side-steps a
  // value-flip: reparenting a valuable capture from an excluded sibling could
  // otherwise clear the keeper's value-exclusion. Fail-closed: an eligibility lookup
  // failure ⇒ merge nothing this pass.
  const { eligible: eligibleRecIds, failClosed: eligFailClosed } = filterEligibleRecordingIds(
    dupGroups.flat().map((r) => r.id)
  )

  // vector_embeddings is created lazily by the vector store and may not exist
  // yet; skip it rather than blowing up the whole transaction on a fresh DB.
  const existingTables = new Set(
    queryAll<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name)
  )

  let mergedGroups = 0
  let removedRows = 0

  runInTransaction(() => {
    if (eligFailClosed) return
    for (const group of dupGroups) {
      // Only the eligible members of the group may be collapsed together.
      const eligibleGroup = group.filter((r) => eligibleRecIds.has(r.id))
      if (eligibleGroup.length < 2) continue
      const rows = eligibleGroup.map((r) => ({ ...r, hasTranscript: withTranscript.has(r.id) }))
      const keeper = pickKeeperRecording(rows)
      const losers = rows.filter((r) => r.id !== keeper.id)
      if (losers.length === 0) continue

      // Keeper selection sorts transcript-holders first, so the keeper already
      // owns a transcript whenever the group has one; the repoint branch below
      // is defensive for the inverse case only.
      let keeperHasTranscript = keeper.hasTranscript === true

      for (const loser of losers) {
        if (loser.hasTranscript) {
          // transcripts.recording_id is UNIQUE and the PK is `trans_<recordingId>`.
          if (keeperHasTranscript) {
            run(`DELETE FROM transcripts WHERE recording_id = ?`, [loser.id])
          } else {
            run(`UPDATE transcripts SET id = ?, recording_id = ? WHERE recording_id = ?`, [
              `trans_${keeper.id}`,
              keeper.id,
              loser.id
            ])
            keeperHasTranscript = true
          }
        }

        run(`UPDATE transcription_queue SET recording_id = ? WHERE recording_id = ?`, [keeper.id, loser.id])
        // candidates are UNIQUE(recording_id, meeting_id) — move what won't
        // collide with the keeper's rows, then drop any leftover collisions.
        run(`UPDATE OR IGNORE recording_meeting_candidates SET recording_id = ? WHERE recording_id = ?`, [
          keeper.id,
          loser.id
        ])
        run(`DELETE FROM recording_meeting_candidates WHERE recording_id = ?`, [loser.id])
        if (existingTables.has('vector_embeddings')) {
          run(`UPDATE vector_embeddings SET recording_id = ? WHERE recording_id = ?`, [keeper.id, loser.id])
        }
        run(`UPDATE knowledge_captures SET source_recording_id = ? WHERE source_recording_id = ?`, [
          keeper.id,
          loser.id
        ])
      }

      // Fold lifecycle flags onto the keeper: a merged take is on-device/on-local
      // if ANY variant was, and keeps a meeting link / local file if one exists.
      const onDevice = rows.some((r) => (r.on_device ?? 0) === 1) ? 1 : 0
      const onLocal = rows.some((r) => (r.on_local ?? 0) === 1) ? 1 : 0
      const meetingId = keeper.meeting_id ?? rows.find((r) => r.meeting_id)?.meeting_id ?? null
      const wavPath = rows.find((r) => /\.wav$/i.test(r.filename || '') && r.file_path)?.file_path
      const filePath = keeper.file_path ?? wavPath ?? rows.find((r) => r.file_path)?.file_path ?? null
      // Keep the location badge consistent with the merged on_device/on_local flags.
      const location =
        onDevice && onLocal ? 'both' : onDevice ? 'device-only' : onLocal ? 'local-only' : 'deleted'

      run(`UPDATE recordings SET on_device = ?, on_local = ?, meeting_id = ?, file_path = ?, location = ? WHERE id = ?`, [
        onDevice,
        onLocal,
        meetingId,
        filePath,
        location,
        keeper.id
      ])

      for (const loser of losers) {
        run(`DELETE FROM recordings WHERE id = ?`, [loser.id])
        removedRows++
      }
      mergedGroups++
    }
  })

  if (mergedGroups > 0) {
    console.log(`[OrgReconciler] Merged ${mergedGroups} duplicate recording groups (removed ${removedRows} rows)`)
  }
  return mergedGroups
}

interface DuplicateContactRow {
  id: string
  name: string
  email?: string | null
  role?: string | null
  company?: string | null
  meeting_count?: number | null
  created_at?: string | null
}

/**
 * Choose which contact in a duplicate group to keep. Preference order:
 *   1. has an email (the strongest identity anchor)
 *   2. has a role or company (enriched)
 *   3. most meeting_count (most-connected)
 *   4. oldest created_at (the original record)
 * Pure so the selection rules can be unit-tested without a database.
 */
export function pickKeeperContact<T extends DuplicateContactRow>(rows: T[]): T {
  const notEmpty = (v?: string | null) => !!(v && v.trim())
  const hasEmail = (r: T) => notEmpty(r.email)
  const hasRoleOrCompany = (r: T) => notEmpty(r.role) || notEmpty(r.company)
  return [...rows].sort((a, b) => {
    const ae = hasEmail(a) ? 1 : 0
    const be = hasEmail(b) ? 1 : 0
    if (ae !== be) return be - ae
    const arc = hasRoleOrCompany(a) ? 1 : 0
    const brc = hasRoleOrCompany(b) ? 1 : 0
    if (arc !== brc) return brc - arc
    const am = a.meeting_count ?? 0
    const bm = b.meeting_count ?? 0
    if (am !== bm) return bm - am
    const ac = a.created_at || ''
    const bc = b.created_at || ''
    if (ac !== bc) return ac < bc ? -1 : 1 // oldest first
    return 0
  })[0]
}

/**
 * Auto-merge unambiguous duplicate contacts. Two contacts are merged ONLY when
 * they share a non-empty lower-cased email, OR an exact lower-cased name —
 * never on fuzzy/partial similarity. Email groups are collapsed first, then
 * name groups (recomputed after the email pass), reusing mergeContacts per pair.
 * Returns the number of contacts removed by merging.
 */
export function mergeDuplicateContacts(): number {
  let removed = 0

  const collapseGroups = (keyOf: (c: DuplicateContactRow) => string | null): void => {
    const contacts = queryAll<DuplicateContactRow>(
      'SELECT id, name, email, role, company, meeting_count, created_at FROM contacts'
    )
    const groups = new Map<string, DuplicateContactRow[]>()
    for (const c of contacts) {
      const key = keyOf(c)
      if (!key) continue
      const list = groups.get(key)
      if (list) list.push(c)
      else groups.set(key, [c])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const keeper = pickKeeperContact(group)
      // ADV28-2 (round-30): partition the group by the visible-identity boundary so
      // an AUTOMATIC startup dedup NEVER folds an excluded/suppressed transcript-only
      // contact's role/company/notes/tags/memberships into a structurally-visible
      // (calendar/manual/eligible-transcript) survivor — that would launder
      // excluded-derived fields onto a visible entity. Merge only pairs on the SAME
      // side of the visibility boundary: two visible contacts dedup as before; two
      // suppressed contacts collapse (the survivor stays suppressed, no leak); a
      // visible↔suppressed pair is left separate. Fail-closed: if visibility can't be
      // determined, fold nothing this pass.
      const { visible, failClosed } = filterVisibleEntityIds('contact', group.map((c) => c.id))
      if (failClosed) continue
      const keeperVisible = visible.has(keeper.id)
      for (const loser of group) {
        if (loser.id === keeper.id) continue
        if (visible.has(loser.id) !== keeperVisible) continue // cross visibility boundary — never launder
        // ADV55-1 (round-57): fold the backing graph person nodes atomically with the
        // relational merge (was bare mergeContacts, which left the loser's graph node +
        // provenance stranded under the deleted loser contact id whenever the
        // post-commit name event no-opped for contact-keyed nodes or graph sync was off).
        mergeContactsWithGraph(keeper.id, loser.id)
        removed++
      }
    }
  }

  collapseGroups((c) => (c.email && c.email.trim() ? c.email.trim().toLowerCase() : null))
  collapseGroups((c) => (c.name && c.name.trim() ? c.name.trim().toLowerCase() : null))

  if (removed > 0) {
    console.log(`[OrgReconciler] Merged ${removed} duplicate contacts (email/name match)`)
  }
  return removed
}

interface DuplicateMeetingRow {
  id: string
  subject: string
  start_time: string
  end_time: string
  is_recurring: number
  recurrence_rule?: string | null
  created_at?: string | null
  updated_at?: string | null
}

/**
 * Choose which row in a duplicate meeting-occurrence group to keep. Preference:
 *   1. has a linked recording (never orphan a recording's attribution)
 *   2. bare-uid id (matches the sync-time remap's canonical target → convergence)
 *   3. oldest created_at (the original record other rows may reference)
 * Pure so the selection rules can be unit-tested without a database.
 */
export function pickKeeperMeeting<T extends { id: string; created_at?: string | null }>(
  rows: T[],
  linkedMeetingIds: Set<string> = new Set()
): T {
  const hasRec = (r: T) => linkedMeetingIds.has(r.id)
  const isBare = (r: T) => !r.id.includes('::')
  return [...rows].sort((a, b) => {
    const ar = hasRec(a) ? 1 : 0
    const br = hasRec(b) ? 1 : 0
    if (ar !== br) return br - ar
    const ab = isBare(a) ? 1 : 0
    const bb = isBare(b) ? 1 : 0
    if (ab !== bb) return bb - ab
    const ac = a.created_at || ''
    const bc = b.created_at || ''
    if (ac !== bc) return ac < bc ? -1 : 1 // oldest first
    return 0
  })[0]
}

/**
 * Collapse duplicate meeting rows that describe the SAME real occurrence of a
 * recurring series. The recurrence-expansion rollout (commit 1e5125c6) changed
 * the occurrence id scheme from a bare `uid` to `uid::slotISO`; for a series
 * whose master DTSTART sits outside the expansion window, the stale
 * pre-expansion bare-uid row and the new `uid::slotISO` row both survived, so the
 * meeting appeared twice on the same slot.
 *
 * Rows group by base uid + start_time; any group with >1 row is a twin set. Keep
 * the row with linked recordings (or the bare-uid / oldest row), repoint every
 * child FK off the losers onto the keeper, refresh the keeper's content from the
 * most recently synced row, then delete the losers. Idempotent — a second run
 * finds no groups. sql.js does not enforce ON DELETE CASCADE, so child rows are
 * repointed explicitly rather than relying on the foreign keys.
 */
export function mergeDuplicateMeetingOccurrences(): number {
  const meetings = queryAll<DuplicateMeetingRow>(
    `SELECT id, subject, start_time, end_time, is_recurring, recurrence_rule, created_at, updated_at FROM meetings`
  )
  if (meetings.length === 0) return 0

  const groups = new Map<string, DuplicateMeetingRow[]>()
  for (const m of meetings) {
    const key = `${meetingBaseUid(m.id)}\u0000${m.start_time}`
    const list = groups.get(key)
    if (list) list.push(m)
    else groups.set(key, [m])
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1)
  if (dupGroups.length === 0) return 0

  // Which meetings have a recording linked — drives keeper selection so a
  // recording's meeting_id is never left pointing at a deleted row.
  const linkedMeetingIds = new Set(
    queryAll<{ meeting_id: string }>(
      `SELECT DISTINCT meeting_id FROM recordings WHERE meeting_id IS NOT NULL`
    ).map((r) => r.meeting_id)
  )
  // Some meeting-referencing tables are created lazily; skip any that don't exist
  // yet rather than aborting the whole transaction.
  const existingTables = new Set(
    queryAll<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name)
  )

  let mergedGroups = 0
  let removedRows = 0

  runInTransaction(() => {
    for (const group of dupGroups) {
      const keeper = pickKeeperMeeting(group, linkedMeetingIds)
      const losers = group.filter((r) => r.id !== keeper.id)
      if (losers.length === 0) continue

      for (const loser of losers) {
        // Plain meeting_id columns — straight repoint.
        run(`UPDATE recordings SET meeting_id = ? WHERE meeting_id = ?`, [keeper.id, loser.id])
        if (existingTables.has('knowledge_captures')) {
          run(`UPDATE knowledge_captures SET meeting_id = ? WHERE meeting_id = ?`, [keeper.id, loser.id])
        }
        if (existingTables.has('follow_ups')) {
          run(`UPDATE follow_ups SET scheduled_meeting_id = ? WHERE scheduled_meeting_id = ?`, [
            keeper.id,
            loser.id
          ])
        }
        if (existingTables.has('recording_preassignments')) {
          run(`UPDATE recording_preassignments SET meeting_id = ? WHERE meeting_id = ?`, [keeper.id, loser.id])
        }
        // Discovery ledger (v43): the sightings of the two occurrences describe
        // ONE conversation. Without this repoint the merged-away meeting id
        // survives in the ledger and the distinct-source count double-counts it,
        // which would let a single conversation clear the recurrence bar alone.
        if (existingTables.has('project_discovery_observations')) {
          run(`UPDATE project_discovery_observations SET meeting_id = ? WHERE meeting_id = ?`, [
            keeper.id,
            loser.id
          ])
        }
        // Composite-key link tables — move what won't collide, drop leftovers.
        run(`UPDATE OR IGNORE meeting_contacts SET meeting_id = ? WHERE meeting_id = ?`, [keeper.id, loser.id])
        run(`DELETE FROM meeting_contacts WHERE meeting_id = ?`, [loser.id])
        run(`UPDATE OR IGNORE meeting_projects SET meeting_id = ? WHERE meeting_id = ?`, [keeper.id, loser.id])
        run(`DELETE FROM meeting_projects WHERE meeting_id = ?`, [loser.id])
        run(`UPDATE OR IGNORE recording_meeting_candidates SET meeting_id = ? WHERE meeting_id = ?`, [
          keeper.id,
          loser.id
        ])
        run(`DELETE FROM recording_meeting_candidates WHERE meeting_id = ?`, [loser.id])
      }

      // Refresh the keeper's content from the most recently synced row in the
      // group so the surviving row reflects the latest feed (a stale bare-uid row
      // kept for its FKs otherwise shows pre-expansion subject / is_recurring).
      const best = [...group].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0]
      if (best && best.id !== keeper.id) {
        run(
          `UPDATE meetings SET subject = ?, start_time = ?, end_time = ?, is_recurring = ?,
             recurrence_rule = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [best.subject, best.start_time, best.end_time, best.is_recurring, best.recurrence_rule ?? null, keeper.id]
        )
      }

      for (const loser of losers) {
        run(`DELETE FROM meetings WHERE id = ?`, [loser.id])
        removedRows++
      }
      mergedGroups++
    }
  })

  if (mergedGroups > 0) {
    console.log(
      `[OrgReconciler] Merged ${mergedGroups} duplicate meeting-occurrence groups (removed ${removedRows} rows)`
    )
  }
  return mergedGroups
}

/** A stored attendees value that names nobody. */
const NO_ATTENDEES_SQL = `(attendees IS NULL OR TRIM(attendees) IN ('', '[]'))`

/**
 * Attendees from the Outlook twin (spec 2026-10-03, section 1a). The ICS feed carries no
 * attendees, and every Outlook event also arrives as an `m365…` row with the same subject and
 * start that does. A meeting that is not an Outlook row and has no attendees takes them from
 * its twin, plus the organizer where it has none. When the twins disagree (two Outlook rows
 * with the same subject and start and different attendees) nothing is copied and the meeting
 * counts as ambiguous. Twins that agree count as one.
 *
 * Idempotent: a filled meeting has attendees and is not a target again. It does not touch
 * updated_at, which mergeDuplicateMeetingOccurrences reads as "last synced". The contacts
 * and meeting_contacts rows come from upsertContactsFromMeetings, which runs after this step
 * and reads every meeting. An ICS resync keeps the copied attendees (upsertMeetingsBatch
 * writes COALESCE(?, attendees)) but writes the feed's empty organizer over the copied one,
 * so a meeting whose attendees equal its twin's and that has no organizer gets the organizer
 * back (not counted as filled). A blank subject names no meeting: those are never paired.
 */
export function fillAttendeesFromOutlookTwins(): { filled: number; ambiguous: number } {
  const targets = queryAll<{ id: string; subject: string; start_time: string; attendees: string | null }>(
    `SELECT id, subject, start_time, attendees FROM meetings
     WHERE id NOT LIKE 'm365%' AND TRIM(COALESCE(subject, '')) != ''
       AND (${NO_ATTENDEES_SQL} OR TRIM(COALESCE(organizer_email, '')) = '')`
  )
  if (targets.length === 0) return { filled: 0, ambiguous: 0 }

  const twinsBySlot = new Map<
    string,
    Array<{ attendees: string; organizer_name: string | null; organizer_email: string | null }>
  >()
  for (const twin of queryAll<{
    subject: string
    start_time: string
    attendees: string
    organizer_name: string | null
    organizer_email: string | null
  }>(
    `SELECT subject, start_time, attendees, organizer_name, organizer_email FROM meetings
     WHERE id LIKE 'm365%' AND NOT ${NO_ATTENDEES_SQL} ORDER BY id`
  )) {
    const key = `${twin.subject}\u0000${twin.start_time}`
    const list = twinsBySlot.get(key)
    if (list) list.push(twin)
    else twinsBySlot.set(key, [twin])
  }

  let filled = 0
  let ambiguous = 0
  runInTransaction(() => {
    for (const target of targets) {
      const twins = twinsBySlot.get(`${target.subject}\u0000${target.start_time}`)
      if (!twins) continue
      const hasAttendees = !!target.attendees && !['', '[]'].includes(target.attendees.trim())
      if (new Set(twins.map((t) => t.attendees)).size > 1) {
        if (!hasAttendees) ambiguous++
        continue
      }
      const twin = twins[0]
      if (hasAttendees) {
        // Filled earlier and its organizer since cleared by a resync: only the organizer comes back.
        if (target.attendees !== twin.attendees || !twin.organizer_email) continue
        run('UPDATE meetings SET organizer_name = COALESCE(NULLIF(organizer_name, \'\'), ?), organizer_email = ? WHERE id = ?', [
          twin.organizer_name,
          twin.organizer_email,
          target.id
        ])
        continue
      }
      run(
        `UPDATE meetings SET attendees = ?,
           organizer_name = COALESCE(NULLIF(organizer_name, ''), ?),
           organizer_email = COALESCE(NULLIF(organizer_email, ''), ?)
         WHERE id = ?`,
        [twin.attendees, twin.organizer_name, twin.organizer_email, target.id]
      )
      filled++
    }
  })

  if (filled > 0 || ambiguous > 0) {
    console.log(`[OrgReconciler] Attendees from the Outlook twin: ${filled} meetings filled, ${ambiguous} ambiguous`)
  }
  return { filled, ambiguous }
}

// ---------------------------------------------------------------------------
// BUG A — misbundled-recording repair (gated, idempotent stale-data cleanup)
// ---------------------------------------------------------------------------
//
// The live auto-correlation/occurrence-resolution code (selectAutoLinkMeeting +
// mergeDuplicateMeetingOccurrences) binds a recording to the occurrence whose
// window actually matches its timestamp and never forces it onto a far anchor
// (proven by recording-occurrence-binding.test.ts). But rows written BEFORE that
// policy landed can still point a recording at a meeting weeks away — e.g. a
// July-1 recording bundled onto the May-27 anchor of a recurring series.
//
// This is a STALE-DATA repair, so it is GATED: findMisbundledRecordings() /
// repairMisbundledRecordings({confirm:false}) only REPORT (count + sample); the
// rewrite runs only with confirm:true. It re-points a misbundled recording onto
// the better-matching sibling occurrence of the SAME series (using the exact
// selectAutoLinkMeeting policy) or, when no sibling matches, unlinks it so it
// returns to the candidate pool — never leaving it on a window weeks away.

/** A recording this far outside its linked meeting's window is clearly misbundled. */
export const MISBUNDLE_GAP_MS = 12 * 60 * 60 * 1000
/** Cap the returned sample (never the actual rewrite). */
const MISBUNDLE_SAMPLE_CAP = 25

export interface MisbundledRecording {
  recordingId: string
  filename: string | null
  dateRecorded: string
  currentMeetingId: string
  currentMeetingSubject: string | null
  currentMeetingStart: string
  currentMeetingEnd: string
  /** How far (hours) the recording sits outside its linked meeting's window. */
  gapHours: number
  action: 'rebundle' | 'unlink'
  /** Sibling occurrence to re-point onto (null when unlinking). */
  targetMeetingId: string | null
  targetMeetingStart: string | null
}

export interface MisbundleRepairReport {
  /** true = report only (no rewrite happened). */
  dryRun: boolean
  /** Total affected recordings (never truncated). */
  totalCount: number
  /** How many rows were rewritten (0 on a dry run). */
  applied: number
  /** First {@link MISBUNDLE_SAMPLE_CAP} affected bundles for review. */
  sample: MisbundledRecording[]
  /** true when totalCount exceeded the sample cap. */
  sampleTruncated: boolean
}

/** 0 when the two windows overlap; otherwise the gap to the nearest edge (ms). */
function windowGapMs(recStart: number, recEnd: number, mStart: number, mEnd: number): number {
  if (recEnd >= mStart && recStart <= mEnd) return 0
  return recEnd < mStart ? mStart - recEnd : recStart - mEnd
}

/**
 * Find recordings whose date_recorded sits far outside their linked meeting's
 * window (> gapThresholdMs). For each, resolve the intended target: the
 * better-matching sibling occurrence of the same series (selectAutoLinkMeeting
 * policy) → 'rebundle'; otherwise 'unlink'. Pure read — never mutates.
 */
export function findMisbundledRecordings(gapThresholdMs = MISBUNDLE_GAP_MS): MisbundledRecording[] {
  const recordings = queryAll<RecordingRow>(
    `SELECT id, filename, date_recorded, duration_seconds, meeting_id
       FROM recordings
      WHERE meeting_id IS NOT NULL AND date_recorded IS NOT NULL AND deleted_at IS NULL`
  )
  if (recordings.length === 0) return []

  const meetings = queryAll<MeetingRow>(`SELECT id, subject, start_time, end_time, is_all_day FROM meetings`)
  const byId = new Map(meetings.map((m) => [m.id, m]))

  // Group occurrences by base uid so a misbundled recording can be re-pointed onto
  // a sibling occurrence of the SAME recurring series (never a different series).
  const siblingsByBase = new Map<string, AutoLinkWindow[]>()
  for (const m of meetings) {
    const start = new Date(m.start_time).getTime()
    const end = new Date(m.end_time).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const base = meetingBaseUid(m.id)
    const list = siblingsByBase.get(base) ?? []
    list.push({ id: m.id, start, end, isAllDay: (m.is_all_day ?? 0) === 1 })
    siblingsByBase.set(base, list)
  }

  const out: MisbundledRecording[] = []
  for (const rec of recordings) {
    const m = rec.meeting_id ? byId.get(rec.meeting_id) : undefined
    if (!m) continue // dangling FK — handled by pre-migration cleanup, not here
    const recStart = new Date(rec.date_recorded).getTime()
    const mStart = new Date(m.start_time).getTime()
    const mEnd = new Date(m.end_time).getTime()
    if (!Number.isFinite(recStart) || !Number.isFinite(mStart) || !Number.isFinite(mEnd)) continue
    const recEnd = recStart + (rec.duration_seconds || DEFAULT_RECORDING_DURATION) * 1000

    const gap = windowGapMs(recStart, recEnd, mStart, mEnd)
    if (gap <= gapThresholdMs) continue // within tolerance — leave it alone

    // Re-point only onto a sibling occurrence of the same series, chosen by the
    // exact live auto-link policy (fit-based, bridge-excluding). No sibling → unlink.
    const base = meetingBaseUid(m.id)
    const siblings = (siblingsByBase.get(base) ?? []).filter((w) => w.id !== m.id)
    const decision = siblings.length > 0 ? selectAutoLinkMeeting(recStart, recEnd, siblings) : { id: null }
    const target = decision.id ? byId.get(decision.id) : undefined

    out.push({
      recordingId: rec.id,
      filename: rec.filename ?? null,
      dateRecorded: rec.date_recorded,
      currentMeetingId: m.id,
      currentMeetingSubject: m.subject ?? null,
      currentMeetingStart: m.start_time,
      currentMeetingEnd: m.end_time,
      gapHours: Math.round((gap / 3_600_000) * 10) / 10,
      action: target ? 'rebundle' : 'unlink',
      targetMeetingId: target?.id ?? null,
      targetMeetingStart: target?.start_time ?? null
    })
  }
  return out
}

/**
 * Gated repair for BUG A. With `confirm` falsy (default), returns a dry-run report
 * (totalCount + a capped sample) and rewrites NOTHING. With `confirm: true`, applies
 * the rewrite in one transaction: rebundle onto the matching sibling occurrence, or
 * unlink when none matches. Every change is logged (the merge-path journaling
 * pattern). Idempotent — a second confirmed run finds nothing.
 */
export function repairMisbundledRecordings(
  opts: { confirm?: boolean; gapThresholdMs?: number } = {}
): MisbundleRepairReport {
  const confirm = opts.confirm === true
  const found = findMisbundledRecordings(opts.gapThresholdMs)
  const totalCount = found.length
  const sample = found.slice(0, MISBUNDLE_SAMPLE_CAP)
  const sampleTruncated = totalCount > sample.length
  if (sampleTruncated) {
    console.log(
      `[OrgReconciler] Misbundle repair: ${totalCount} affected; sample capped at ${sample.length} ` +
      `(the confirmed rewrite still processes all ${totalCount}).`
    )
  }

  if (!confirm || totalCount === 0) {
    return { dryRun: true, totalCount, applied: 0, sample, sampleTruncated }
  }

  let applied = 0
  runInTransaction(() => {
    for (const item of found) {
      if (item.action === 'rebundle' && item.targetMeetingId) {
        run(
          `UPDATE recordings SET meeting_id = ?, correlation_confidence = 0.7, correlation_method = 'repair_rebundle'
             WHERE id = ? AND meeting_id = ?`,
          [item.targetMeetingId, item.recordingId, item.currentMeetingId]
        )
        console.log(
          `[OrgReconciler] Misbundle repair: rebundled ${item.recordingId} (${item.filename ?? '?'}) ` +
          `${item.currentMeetingId} → ${item.targetMeetingId} (was ${item.gapHours}h outside window)`
        )
      } else {
        run(
          `UPDATE recordings SET meeting_id = NULL, correlation_confidence = NULL, correlation_method = 'repair_unbundled'
             WHERE id = ? AND meeting_id = ?`,
          [item.recordingId, item.currentMeetingId]
        )
        console.log(
          `[OrgReconciler] Misbundle repair: unlinked ${item.recordingId} (${item.filename ?? '?'}) ` +
          `from ${item.currentMeetingId} (was ${item.gapHours}h outside; no sibling occurrence matched)`
        )
      }
      applied++
    }
  })

  console.log(`[OrgReconciler] Misbundle repair applied: ${applied}/${totalCount} recording(s) re-pointed or unlinked.`)
  return { dryRun: false, totalCount, applied, sample, sampleTruncated }
}

/**
 * Auto-split ambiguous mention buckets: for each bucket ("Sergio" = several real
 * people), walk its recordings and, where the signal is unambiguous — the transcript
 * names exactly one candidate as a speaker, or exactly one candidate is present in the
 * linked meeting — pin that recording's mention to the real person. Recordings with no
 * signal (or a tie) are left for the user's "Resolve per meeting" review.
 *
 * UPGRADE-ONLY and re-runnable (see signal-tiers.ts): a recording is (re)resolved only
 * when the available signal OUTRANKS any existing stored resolution — a 'manual' user
 * pick is never overwritten, and equal/lower signals are left alone (idempotent). This
 * is what lets a re-sweep upgrade transcript-derived guesses to 'attendee-email' once
 * the M365 connector backfills real calendar attendees.
 */
export interface MentionDecisionInput {
  recordingId: string
  meetingId: string | null
  bucketContactId: string
  /** The spoken name as the bucket contact holds it ("Sergio"). */
  bucketName: string
  contactId: string
  method: string
  confidence: number
  evidence: Record<string, unknown>
}

/**
 * Resolve one first-name mention to a person, inside the caller's transaction, and journal it
 * with the state before. The one writer for every automatic mention rule (auto-split and the
 * Jev tiebreak). Writes nothing, and returns false, when the owner undid this method's decision
 * on the mention or any decision naming this person there, or when the stored decision is
 * manual or ranks the same or higher (canUpgrade).
 */
export function applyMentionDecisionNoSave(input: MentionDecisionInput): boolean {
  const subjectKey = mentionSubjectKey(input.recordingId, input.bucketContactId)
  if (wasUndone('mention', subjectKey, input.method)) return false
  if (wasMentionUndoneFor(input.recordingId, input.bucketContactId, input.contactId)) return false
  const before = snapshotMentionNoSave(input.recordingId, input.bucketName)
  if (before.row && !canUpgrade(before.row.method, input.method)) return false
  recordMentionResolutionNoSave(input.recordingId, input.bucketName, input.contactId, input.method, input.confidence)
  linkContactToMeeting(input.contactId, input.meetingId ?? undefined, new Date().toISOString(), input.recordingId)
  recordDecisionNoSave({
    kind: 'mention',
    subjectKey,
    method: input.method,
    contactId: input.contactId,
    evidence: input.evidence,
    before
  })
  return true
}

/** What the journal keeps about why a bucket recording was resolved. */
function bucketEvidence(res: BucketResolution, r: BucketRecording): Record<string, unknown> {
  return {
    bucketContactId: res.contactId,
    bucketName: res.name,
    meetingId: r.meetingId,
    signal: r.signal,
    voicedCandidateIds: r.voicedCandidateIds,
    attendingCandidateIds: r.attendingCandidateIds
  }
}

export function autoSplitAmbiguousBuckets(opts: BucketRuleOptions = {}): { buckets: number; resolved: number } {
  const found = getAmbiguousBucketResolutions(opts)
  const buckets = found.map((item) => item.bucket)
  let resolvedTotal = 0
  const toResolveIn = (res: BucketResolution) =>
    res.recordings.filter((r) => r.method !== 'unclear' && r.bestGuessId && canUpgrade(r.resolvedMethod, r.method))
  for (const item of found) {
    // A bucket with nothing to resolve is skipped on the resolution built a moment
    // ago. Only a bucket that has work is built again, because the buckets before
    // it may have written links it depends on. (It used to be built again for every
    // bucket, on every start and after every calendar sync.)
    if (toResolveIn(item.resolution).length === 0) continue
    const res = getBucketResolution(item.bucket.contactId, opts)
    if (!res) continue
    const toResolve = toResolveIn(res)
    if (toResolve.length === 0) continue
    runInTransaction(() => {
      for (const r of toResolve) {
        const applied = applyMentionDecisionNoSave({
          recordingId: r.recordingId,
          meetingId: r.meetingId,
          bucketContactId: res.contactId,
          bucketName: res.name,
          contactId: r.bestGuessId as string,
          method: r.method,
          confidence: methodConfidence(r.method),
          evidence: bucketEvidence(res, r)
        })
        if (applied) resolvedTotal++
      }
    })
  }
  if (resolvedTotal > 0) {
    console.log(`[OrgReconciler] Auto-split ${resolvedTotal} bucket mentions across ${buckets.length} buckets`)
  }
  return { buckets: buckets.length, resolved: resolvedTotal }
}

export interface ReconcileStep {
  /** Name in the log when the step is slow. */
  name: string
  /** What the log says when the step throws. */
  failure: string
  run: () => unknown
}

/** The reconciliation steps, in the order they run. */
export const RECONCILE_STEPS: readonly ReconcileStep[] = [
  { name: 'text-repair', failure: 'text repair failed', run: repairEscapedMeetingText },
  {
    name: 'meeting-occurrence-merge',
    failure: 'duplicate meeting-occurrence merge failed',
    run: mergeDuplicateMeetingOccurrences
  },
  { name: 'recording-merge', failure: 'duplicate recording merge failed', run: mergeDuplicateRecordings },
  { name: 'recording-auto-link', failure: 'recording auto-link failed', run: autoLinkRecordingsToMeetings },
  // Before the contact steps, so the attendees it copies become contacts in the same pass.
  {
    name: 'outlook-twin-attendees',
    failure: 'attendees from the Outlook twin failed',
    run: fillAttendeesFromOutlookTwins
  },
  { name: 'contacts-upsert', failure: 'contacts upsert failed', run: upsertContactsFromMeetings },
  // Before the merge and the bucket split, so both see real names and not addresses.
  {
    name: 'contacts-rename-from-calendar',
    failure: 'renaming contacts named after an address failed',
    run: renameAddressNamedContacts
  },
  { name: 'contact-merge', failure: 'duplicate contact merge failed', run: mergeDuplicateContacts },
  { name: 'ambiguous-bucket-split', failure: 'ambiguous-bucket auto-split failed', run: autoSplitAmbiguousBuckets },
  {
    // BUG B self-heal: advance recordings.status for rows with a joined transcript
    // whose status drifted (never advanced past its insert-time default).
    name: 'status-self-heal',
    failure: 'recording status self-heal failed',
    // Called through an arrow so the import is read when the step runs, not when the module loads.
    run: () => healRecordingStatusFromTranscripts()
  }
]

/** A step that holds the main thread this long is named in the log. */
export const SLOW_RECONCILE_STEP_MS = 500

function runReconcileStep(step: ReconcileStep): void {
  const startedAt = performance.now()
  try {
    step.run()
  } catch (e) {
    console.error(`[OrgReconciler] ${step.failure}:`, e)
  }
  const tookMs = Math.round(performance.now() - startedAt)
  if (tookMs >= SLOW_RECONCILE_STEP_MS) {
    console.warn(`[OrgReconciler] step "${step.name}" held the main thread for ${tookMs}ms`)
  }
}

/** Full reconciliation pass — run after calendar syncs and at startup. */
export function reconcileOrganization(): void {
  for (const step of RECONCILE_STEPS) runReconcileStep(step)
}

/**
 * The same pass, giving the event loop back between steps, so the window and the
 * IPC handlers are only held for the longest step and not for all of them at
 * once (org-reconcile froze the window for 4.9 s at boot, 29-sep-2026). The boot
 * task and the post-sync pass use this one.
 */
export async function reconcileOrganizationYielding(): Promise<void> {
  for (const step of RECONCILE_STEPS) {
    runReconcileStep(step)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
