/**
 * One rule per kind of identity question (spec docs/superpowers/specs/
 * 2026-10-03-people-identity-autoresolve-design.md, Phase 3). The catalog with every rule, its
 * signals, method and rank is docs/identity-rules.md; this module applies the rules over the
 * library.
 *
 * - A shared first name in a recording (3a): the deterministic rules run in
 *   autoSplitAmbiguousBuckets (org-reconciler.ts); Jev breaks the remaining ties here, only
 *   between candidates that attended or whose voice is in the recording.
 * - Duplicate people (3b): the same exact email (the discovery flag `autoMergeable`), the same
 *   voice (clusters that consolidate at 0.9 or more), and similar names that co-attend or share
 *   a company email domain, where Jev decides.
 *
 * Every decision is applied at once through the existing writers, journaled in
 * identity_decisions with the state before, and can be undone; an undone decision is never made
 * again. Merges never cross the visibility boundary the startup dedup keeps
 * (mergeDuplicateContacts): two contacts merge only when both are visible or both are hidden.
 */

import { getConfig } from './config'
import {
  filterEligibleMembershipRows,
  filterVisibleEntityIds,
  getAmbiguousBucketIds,
  getAmbiguousBucketResolutions,
  getIdentitySuggestionById,
  mergeJournalIdsFor,
  queryAll,
  queryOne,
  run,
  runInTransaction,
  type IdentitySuggestion,
  type MembershipRow
} from './database'
import { isSuggestionEligibleForAccept } from './identity-discovery'
import { acceptIdentitySuggestionWithGraph, mergeContactsWithGraph } from './knowledge-graph-service'
import { applyMentionDecisionNoSave, autoSplitAmbiguousBuckets, pickKeeperContact } from './org-reconciler'
import { mentionSubjectKey, mergeSubjectKey, recordDecisionNoSave, wasMergeUndone, wasUndone } from './identity-decisions'
import { canUpgrade, methodConfidence } from './signal-tiers'
import { jevKeyFor } from './jev-settings'
import { askJev } from './jev-client'
import { createJevHarness } from './pipeline/jev-harness'
import { withCallRecord } from './pipeline/track-call'
import { isRecordingEligible } from './recording-eligibility'
import { accentFoldedKey, firstNameNicknameMatch } from './entity-normalize'
import { getActiveTranscriptions } from './transcription-activity'
import {
  buildMentionTiebreakRequest,
  buildMergeTiebreakRequest,
  mentionTurns,
  parseMentionTiebreak,
  parseMergeTiebreak,
  type MentionCandidate,
  type Turn
} from './jev-identity-tiebreak'

/** Two voices are one person at this similarity (voice-identity-consolidation's anchored line). */
export const SAME_VOICE_MIN_SIMILARITY = 0.9
/** Jev calls one run may make, across both tiebreaks; the next run continues. */
export const MAX_JEV_CALLS_PER_RUN = 50
/** A shared mail domain says nothing about who someone is when it is a public mail service. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'aol.com', 'proton.me', 'protonmail.com'
])
/** Marks that a tie was put to Jev with this evidence, so it is asked once (config table, like speaker inference). */
const ASKED_KEY_PREFIX = 'identity_rules:jev-asked:v1:'

export interface IdentityRulesDeps {
  isTranscribing?: () => boolean
  /** Hands the event loop back between steps and between Jev calls. */
  yieldToLoop?: () => Promise<void>
  /** The Jev key when the tiebreak may run (the Jev switch and "Name the speakers"), else null. */
  jevKey?: () => string | null
  askJev?: typeof askJev
  ownerContactId?: () => string | null
  maxJevCalls?: number
  /** The day the daily Jev cap counts against. */
  now?: () => Date
}

/** The Jev calls this run may still make, and the day they count against. */
interface JevBudget {
  left: number
  now: () => Date
}

interface Resolved {
  isTranscribing: () => boolean
  yieldToLoop: () => Promise<void>
  jevKey: () => string | null
  askJev: typeof askJev
  ownerContactId: () => string | null
  budget: JevBudget
}

/** Jev tiebreaks a day, across every run (review of PR 4, F2); the per-run cap alone repeats per run. */
export const MAX_JEV_CALLS_PER_DAY = 300
const DAILY_JEV_KEY = 'identity_rules:jev-calls-per-day'

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Jev calls already made on that day. Another day's count is a count of zero. */
function jevCallsOn(day: string): number {
  const row = queryOne<{ value: string }>('SELECT value FROM config WHERE key = ?', [DAILY_JEV_KEY])
  const stored = parseJson<{ date?: unknown; count?: unknown }>(row?.value, {})
  return stored.date === day && typeof stored.count === 'number' ? stored.count : 0
}

/** Take one Jev call from the budget and count it for the day. */
function spendJevCall(budget: JevBudget): void {
  budget.left--
  const day = localDate(budget.now())
  const value = JSON.stringify({ date: day, count: jevCallsOn(day) + 1 })
  run('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)', [
    DAILY_JEV_KEY,
    value,
    new Date().toISOString()
  ])
}

function resolve(deps: IdentityRulesDeps, budget?: JevBudget): Resolved {
  const now = deps.now ?? (() => new Date())
  return {
    isTranscribing: deps.isTranscribing ?? (() => getActiveTranscriptions().length > 0),
    yieldToLoop: deps.yieldToLoop ?? (() => new Promise<void>((done) => setTimeout(done, 0))),
    // The tiebreak names people in recordings, so it follows the speaker-naming job's switch.
    jevKey: deps.jevKey ?? (() => jevKeyFor('speakerNames')),
    askJev: deps.askJev ?? askJev,
    ownerContactId: deps.ownerContactId ?? (() => getConfig().identity?.ownerContactId || null),
    budget: budget ?? {
      left: Math.min(deps.maxJevCalls ?? MAX_JEV_CALLS_PER_RUN, MAX_JEV_CALLS_PER_DAY - jevCallsOn(localDate(now()))),
      now
    }
  }
}

function wasAsked(key: string): boolean {
  return !!queryOne('SELECT 1 FROM config WHERE key = ?', [`${ASKED_KEY_PREFIX}${key}`])
}

function markAsked(key: string): void {
  const now = new Date().toISOString()
  run('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)', [`${ASKED_KEY_PREFIX}${key}`, now, now])
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 3a.4 jev-tiebreak for a shared first name
// ---------------------------------------------------------------------------

function recordingTurns(recordingId: string): Turn[] {
  const row = queryOne<{ speakers: string | null }>('SELECT speakers FROM transcripts WHERE recording_id = ?', [recordingId])
  const turns = parseJson<unknown>(row?.speakers, [])
  if (!Array.isArray(turns)) return []
  return turns
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ speaker: String(t.speaker ?? ''), text: String(t.text ?? '') }))
}

/** The meeting's people by name: calendar links, and links this recording's transcript made. */
function meetingPeopleNames(meetingId: string | null, recordingId: string, exceptId: string): string[] {
  if (!meetingId) return []
  return queryAll<{ name: string }>(
    `SELECT DISTINCT c.name FROM meeting_contacts mc JOIN contacts c ON c.id = mc.contact_id
      WHERE mc.meeting_id = ? AND c.id != ? AND (mc.source_recording_id IS NULL OR mc.source_recording_id = ?)
      ORDER BY c.name`,
    [meetingId, exceptId, recordingId]
  ).map((r) => r.name)
}

/**
 * Ask Jev once per recording where a shared first name is still undecided and two or more
 * candidates have objective support (attended, or their voice is in the recording). Applies a
 * choice only with probability 0.8 or more and a margin of 0.3 or more, only for a supported
 * candidate, method 'jev-tiebreak', with the probabilities in the decision's evidence. Jev off
 * or failing leaves the recording undecided; a failed call is asked again next run.
 */
export async function resolveBucketTiesWithJev(
  deps: IdentityRulesDeps = {},
  budget?: JevBudget
): Promise<{ asked: number; resolved: number; stopped?: 'transcription-active' }> {
  const d = resolve(deps, budget)
  const result: { asked: number; resolved: number; stopped?: 'transcription-active' } = { asked: 0, resolved: 0 }
  const key = d.jevKey()
  if (!key) return result
  const harness = createJevHarness({ getKey: () => key, askImpl: d.askJev })

  for (const { resolution } of getAmbiguousBucketResolutions({ ownerContactId: d.ownerContactId() })) {
    const nameById = new Map(resolution.candidates.map((c) => [c.id, c.name]))
    for (const r of resolution.recordings) {
      if (r.method !== 'unclear' || r.supportedCandidateIds.length < 2) continue
      if (!canUpgrade(r.resolvedMethod, 'jev-tiebreak')) continue
      const subjectKey = mentionSubjectKey(r.recordingId, resolution.contactId)
      if (wasUndone('mention', subjectKey, 'jev-tiebreak')) continue
      const askedKey = `${subjectKey}:${r.supportedCandidateIds.join(',')}`
      if (wasAsked(askedKey)) continue

      const turns = mentionTurns(recordingTurns(r.recordingId), resolution.name)
      const attending = new Set(r.attendingCandidateIds)
      const voiced = new Set(r.voicedCandidateIds)
      const candidates: MentionCandidate[] = r.supportedCandidateIds.map((id) => ({
        id,
        name: nameById.get(id) ?? id,
        support: [
          ...(attending.has(id) ? ['attended the meeting'] : []),
          ...(voiced.has(id) ? ['voice in the recording'] : [])
        ]
      }))
      const subject = r.meetingId
        ? queryOne<{ subject: string | null }>('SELECT subject FROM meetings WHERE id = ?', [r.meetingId])?.subject ?? null
        : null
      const request = buildMentionTiebreakRequest({
        name: resolution.name,
        meetingSubject: subject,
        attendees: meetingPeopleNames(r.meetingId, r.recordingId, resolution.contactId),
        turns,
        candidates
      })
      if (!request) continue
      if (d.budget.left <= 0) return result
      if (d.isTranscribing()) return { ...result, stopped: 'transcription-active' }

      spendJevCall(d.budget)
      let answer
      try {
        const res = await withCallRecord({ step: 'identity-tiebreak', route: 'jev', recordingId: r.recordingId }, () =>
          harness.ask(request.state, request.questions)
        )
        answer = parseMentionTiebreak(res, request)
      } catch (e) {
        console.warn(`[IdentityRules] Jev tiebreak for ${r.recordingId} failed:`, e instanceof Error ? e.message : e)
        await d.yieldToLoop()
        continue
      }
      markAsked(askedKey)
      result.asked++

      // The recording may have left the library while Jev answered.
      if (answer?.contactId && r.supportedCandidateIds.includes(answer.contactId) && isRecordingEligible(r.recordingId)) {
        const chosen = answer
        const applied = runInTransaction(() =>
          applyMentionDecisionNoSave({
            recordingId: r.recordingId,
            meetingId: r.meetingId,
            bucketContactId: resolution.contactId,
            bucketName: resolution.name,
            contactId: chosen.contactId!,
            method: 'jev-tiebreak',
            confidence: methodConfidence('jev-tiebreak'),
            evidence: {
              bucketContactId: resolution.contactId,
              bucketName: resolution.name,
              meetingId: r.meetingId,
              supportedCandidateIds: r.supportedCandidateIds,
              voicedCandidateIds: r.voicedCandidateIds,
              attendingCandidateIds: r.attendingCandidateIds,
              probabilities: chosen.probabilities,
              probability: chosen.probability,
              margin: chosen.margin,
              turnsAsked: turns.length
            }
          })
        )
        if (applied) result.resolved++
      }
      await d.yieldToLoop()
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 3b duplicate people
// ---------------------------------------------------------------------------

interface ContactRow {
  id: string
  name: string
  email: string | null
  role: string | null
  company: string | null
  meeting_count: number | null
  created_at: string | null
}

function contactRow(id: string): ContactRow | undefined {
  return queryOne<ContactRow>(
    'SELECT id, name, email, role, company, meeting_count, created_at FROM contacts WHERE id = ?',
    [id]
  )
}

/**
 * Two contacts may be merged by a rule: both exist, the owner never undid a merge of the two,
 * and both sit on the same side of the visibility boundary (fail-closed when it cannot be read).
 */
function mergeAllowed(keeperId: string, loserId: string | undefined | null): loserId is string {
  if (!loserId || loserId === keeperId) return false
  if (!contactRow(keeperId) || !contactRow(loserId)) return false
  if (wasMergeUndone(keeperId, loserId)) return false
  const { visible, failClosed } = filterVisibleEntityIds('contact', [keeperId, loserId])
  if (failClosed) return false
  return visible.has(keeperId) === visible.has(loserId)
}

interface SuggestionEvidence {
  loserId?: string
  autoMergeable?: boolean
  emailMatch?: string
  [key: string]: unknown
}

/**
 * Accept a merge suggestion through the existing accept path (merge_journal keeps its Undo) and
 * journal a 'merge' decision, in one transaction. False when the accept merged nothing.
 */
function acceptMergeSuggestion(s: IdentitySuggestion, loserId: string, method: string, evidence: Record<string, unknown>): boolean {
  return runInTransaction(() => {
    const accepted = acceptIdentitySuggestionWithGraph(s.id)
    if (!accepted.mergeJournalId) return false
    recordDecisionNoSave({
      kind: 'merge',
      subjectKey: mergeSubjectKey(s.target_id, loserId),
      method,
      contactId: s.target_id,
      evidence: { suggestionId: s.id, ...evidence },
      before: {
        mergeJournalId: accepted.mergeJournalId,
        keeperId: s.target_id,
        loserId,
        suggestionId: s.id,
        suggestionStatus: s.status
      }
    })
    return true
  })
}

function pendingPersonSuggestions(): Array<{ s: IdentitySuggestion; ev: SuggestionEvidence }> {
  return queryAll<IdentitySuggestion>(
    "SELECT * FROM identity_suggestions WHERE status = 'pending' AND kind = 'person' ORDER BY confidence DESC, id"
  ).map((s) => ({ s, ev: parseJson<SuggestionEvidence>(s.evidence, {}) }))
}

/**
 * Local parts of role and shared mailboxes: one address, several people (review of PR 4, F1).
 * A local part matches when it is one of these, or starts with one followed by a separator
 * ("support-latam", "info.es").
 */
const SHARED_MAILBOX_LOCAL_PARTS = [
  'info', 'support', 'sales', 'admin', 'administracion', 'team', 'equipo', 'contact', 'contacto', 'hello', 'hola',
  'office', 'oficina', 'billing', 'facturacion', 'accounts', 'accounting', 'finance', 'finanzas', 'hr', 'rrhh',
  'jobs', 'careers', 'empleos', 'talento', 'marketing', 'help', 'helpdesk', 'service', 'services', 'servicio',
  'servicios', 'soporte', 'ventas', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'notificaciones', 'calendar', 'booking', 'bookings', 'reservas', 'recepcion', 'reception', 'it', 'ops',
  'operations', 'legal', 'press', 'prensa', 'media', 'security', 'compras', 'purchasing', 'mail', 'all', 'everyone',
  'todos', 'staff', 'group', 'grupo', 'list', 'lista'
]

/** True when an address belongs to a role or shared mailbox, or is a plus address. */
export function isSharedMailbox(email: string): boolean {
  const local = email.trim().toLowerCase().split('@')[0] ?? ''
  if (!local || local.includes('+')) return true
  return SHARED_MAILBOX_LOCAL_PARTS.some((word) => local === word || new RegExp(`^${word}[._-]`).test(local))
}

/** Whether two display names on one address can be one person. */
function namesCompatible(a: string, b: string, email: string): boolean {
  const address = email.trim().toLowerCase()
  const local = address.split('@')[0]
  const isJustTheAddress = (name: string) => {
    const n = name.trim().toLowerCase()
    return n === address || n === local
  }
  if (isJustTheAddress(a) || isJustTheAddress(b)) return true
  const fa = accentFoldedKey(a)
  const fb = accentFoldedKey(b)
  if (!fa || !fb) return false
  // One name inside the other, as whole words ("Ana" in "Diana Soto" does not count).
  if (` ${fa} `.includes(` ${fb} `) || ` ${fb} `.includes(` ${fa} `)) return true
  const firstA = fa.split(' ')[0]
  return firstNameNicknameMatch(firstA, b)
}

/** True when one meeting lists this address under two different display names (a distribution list). */
function addressSharedInAMeeting(email: string): boolean {
  const address = email.trim().toLowerCase()
  const escaped = address.replace(/[\\%_]/g, (c) => `\\${c}`)
  const meetings = queryAll<{ attendees: string | null }>(
    `SELECT attendees FROM meetings WHERE LOWER(attendees) LIKE ? ESCAPE '\\'`,
    [`%${escaped}%`]
  )
  for (const m of meetings) {
    const people = parseJson<unknown>(m.attendees, [])
    if (!Array.isArray(people)) continue
    const names = new Set<string>()
    for (const p of people) {
      if (!p || typeof p !== 'object') continue
      const entry = p as { email?: unknown; name?: unknown }
      if (typeof entry.email !== 'string' || entry.email.trim().toLowerCase() !== address) continue
      const name = typeof entry.name === 'string' ? accentFoldedKey(entry.name) : ''
      if (name && name !== address && name !== address.split('@')[0]) names.add(name)
    }
    if (names.size > 1) return true
  }
  return false
}

type ExactEmailBlock = 'role-mailbox' | 'names-differ' | 'shared-address'

/** Why an exact-email pair must stay a question for the owner, or null when it may merge. */
function exactEmailBlock(keeper: ContactRow, loser: ContactRow): ExactEmailBlock | null {
  const email = (keeper.email || loser.email || '').trim()
  if (!email || isSharedMailbox(email)) return 'role-mailbox'
  if (!namesCompatible(keeper.name, loser.name, email)) return 'names-differ'
  if (addressSharedInAMeeting(email)) return 'shared-address'
  return null
}

/**
 * 3b, the same exact email: every pending suggestion discovery marked `autoMergeable` (0.95 or
 * more, corroborated by an exact email) is accepted through the existing accept path, after the
 * same accept-time revalidation the People accept button runs. Method 'exact-email'.
 *
 * Only for a personal address (review of PR 4, F1): not a role or shared mailbox, the two names
 * fit one person, and no meeting lists the address under two names. Otherwise the suggestion
 * stays for the owner with the reason in evidence.autoMergeBlocked.
 */
export function autoMergeExactEmail(): { merged: number } {
  let merged = 0
  for (const { s, ev } of pendingPersonSuggestions()) {
    if (ev.autoMergeable !== true || ev.emailMatch !== 'exact') continue
    if (!mergeAllowed(s.target_id, ev.loserId)) continue
    const block = exactEmailBlock(contactRow(s.target_id)!, contactRow(ev.loserId)!)
    if (block) {
      if (ev.autoMergeBlocked !== block) {
        run('UPDATE identity_suggestions SET evidence = ? WHERE id = ?', [
          JSON.stringify({ ...ev, autoMergeBlocked: block }),
          s.id
        ])
      }
      continue
    }
    const fresh = getIdentitySuggestionById(s.id)
    if (!fresh || fresh.status !== 'pending' || !isSuggestionEligibleForAccept(fresh)) continue
    if (acceptMergeSuggestion(fresh, ev.loserId!, 'exact-email', { emailMatch: 'exact', confidence: fresh.confidence })) merged++
  }
  if (merged) console.log(`[IdentityRules] merged ${merged} contact(s) with the same email`)
  return { merged }
}

interface ClusterRow {
  id: string
  model: string
  model_version: string
  embedding_dimension: number
  centroid_json: string
  contact_id: string
}

function unit(values: number[]): number[] {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return []
  const length = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0))
  return length > 1e-12 ? values.map((v) => v / length) : []
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return -1
  return a.reduce((sum, v, i) => sum + v * b[i], 0)
}

function emailsConflict(a: string | null, b: string | null): boolean {
  const x = (a ?? '').trim().toLowerCase()
  const y = (b ?? '').trim().toLowerCase()
  return !!x && !!y && x !== y
}

/**
 * 3b, the same voice: two contacts whose voice clusters (same model) are 0.9 or more alike are
 * one person, merged with method 'voice'. Never when their voices are heard together in one
 * recording (two people in the room), when both have different email addresses, when one is a
 * shared-first-name bucket, or across the visibility boundary. The owner, when one of the two,
 * is the keeper; otherwise the startup dedup's keeper rule (email, role, meetings, oldest).
 */
export function autoMergeSameVoice(owner: string | null = null): { merged: number } {
  const clusters = queryAll<ClusterRow>(
    `SELECT id, model, model_version, embedding_dimension, centroid_json, contact_id FROM voice_clusters
      WHERE contact_id IS NOT NULL ORDER BY created_at, id`
  )
  if (clusters.length < 2) return { merged: 0 }
  const centroid = new Map(clusters.map((c) => [c.id, unit(parseJson<number[]>(c.centroid_json, []).map(Number))]))
  const recordingsOf = new Map<string, Set<string>>()
  for (const row of queryAll<{ voice_cluster_id: string; recording_id: string }>(
    'SELECT DISTINCT voice_cluster_id, recording_id FROM recording_voice_clusters'
  )) {
    let set = recordingsOf.get(row.voice_cluster_id)
    if (!set) recordingsOf.set(row.voice_cluster_id, (set = new Set()))
    set.add(row.recording_id)
  }
  const recordingsOfContact = new Map<string, Set<string>>()
  for (const c of clusters) {
    let set = recordingsOfContact.get(c.contact_id)
    if (!set) recordingsOfContact.set(c.contact_id, (set = new Set()))
    for (const r of recordingsOf.get(c.id) ?? []) set.add(r)
  }
  const heardTogether = (a: string, b: string): boolean => {
    const other = recordingsOfContact.get(b) ?? new Set<string>()
    for (const r of recordingsOfContact.get(a) ?? []) if (other.has(r)) return true
    return false
  }

  const pairs: Array<{ a: ClusterRow; b: ClusterRow; similarity: number }> = []
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i]
      const b = clusters[j]
      if (a.contact_id === b.contact_id) continue
      if (a.model !== b.model || a.model_version !== b.model_version || a.embedding_dimension !== b.embedding_dimension) continue
      const similarity = cosine(centroid.get(a.id)!, centroid.get(b.id)!)
      if (similarity >= SAME_VOICE_MIN_SIMILARITY) pairs.push({ a, b, similarity })
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity)

  const buckets = getAmbiguousBucketIds()
  let merged = 0
  const gone = new Set<string>()
  for (const { a, b, similarity } of pairs) {
    if (gone.has(a.contact_id) || gone.has(b.contact_id)) continue
    if (buckets.has(a.contact_id) || buckets.has(b.contact_id)) continue
    if (heardTogether(a.contact_id, b.contact_id)) continue
    const ca = contactRow(a.contact_id)
    const cb = contactRow(b.contact_id)
    if (!ca || !cb || emailsConflict(ca.email, cb.email)) continue
    const keeper = owner === ca.id ? ca : owner === cb.id ? cb : pickKeeperContact([ca, cb])
    const loser = keeper.id === ca.id ? cb : ca
    if (!mergeAllowed(keeper.id, loser.id)) continue
    const keeperCluster = keeper.id === a.contact_id ? a : b
    const loserCluster = keeperCluster === a ? b : a

    runInTransaction(() => {
      const journalsBefore = mergeJournalIdsFor('contact', keeper.id)
      mergeContactsWithGraph(keeper.id, loser.id)
      const journalId = [...mergeJournalIdsFor('contact', keeper.id)].find((id) => !journalsBefore.has(id))
      if (!journalId) throw new Error(`Merge of ${loser.id} into ${keeper.id} wrote no merge_journal row`)
      recordDecisionNoSave({
        kind: 'merge',
        subjectKey: mergeSubjectKey(keeper.id, loser.id),
        method: 'voice',
        contactId: keeper.id,
        evidence: {
          similarity: Math.round(similarity * 1000) / 1000,
          keeperClusterId: keeperCluster.id,
          loserClusterId: loserCluster.id,
          loserName: loser.name
        },
        before: { mergeJournalId: journalId, keeperId: keeper.id, loserId: loser.id, suggestionId: null, suggestionStatus: null }
      })
    })
    gone.add(loser.id)
    merged++
  }
  if (merged) console.log(`[IdentityRules] merged ${merged} contact(s) with the same voice`)
  return { merged }
}

function eligibleMeetingIds(contactId: string): Set<string> {
  const rows = queryAll<MembershipRow & { meeting_id: string }>(
    'SELECT meeting_id, source, source_recording_id FROM meeting_contacts WHERE contact_id = ?',
    [contactId]
  )
  return new Set(filterEligibleMembershipRows(rows).eligible.map((r) => r.meeting_id))
}

function companyDomain(email: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return null
  const domain = e.slice(at + 1)
  return domain && !PUBLIC_MAIL_DOMAINS.has(domain) ? domain : null
}

function hasVoice(contactId: string): boolean {
  return !!queryOne('SELECT 1 FROM voice_clusters WHERE contact_id = ? LIMIT 1', [contactId])
}

/**
 * 3b, similar names without email or voice: each pending suggestion that no exact email and no
 * voice decided is re-scored with the meetings the two share (eligible links only) and a shared
 * company mail domain; both are written into its evidence. When one of them supports the pair,
 * Jev is asked once whether they are the same person; a sure, clear "same" merges them through
 * the accept path, method 'jev-tiebreak'. Otherwise the suggestion stays for the owner.
 */
export async function resolveSimilarNameMerges(
  deps: IdentityRulesDeps = {},
  budget?: JevBudget
): Promise<{ rescored: number; asked: number; merged: number; stopped?: 'transcription-active' }> {
  const d = resolve(deps, budget)
  const result: { rescored: number; asked: number; merged: number; stopped?: 'transcription-active' } = {
    rescored: 0,
    asked: 0,
    merged: 0
  }
  const key = d.jevKey()
  const harness = key ? createJevHarness({ getKey: () => key, askImpl: d.askJev }) : null
  const buckets = getAmbiguousBucketIds()

  for (const { s, ev } of pendingPersonSuggestions()) {
    if (ev.emailMatch === 'exact' || ev.autoMergeable === true) continue
    const loserId = ev.loserId
    if (!loserId || loserId === s.target_id) continue
    if (buckets.has(s.target_id) || buckets.has(loserId)) continue
    const keeper = contactRow(s.target_id)
    const loser = contactRow(loserId)
    if (!keeper || !loser) continue
    // Both voices known and not merged by the voice rule: the voice already says two people.
    if (hasVoice(keeper.id) && hasVoice(loser.id)) continue

    const loserMeetings = eligibleMeetingIds(loser.id)
    const shared = [...eligibleMeetingIds(keeper.id)].filter((id) => loserMeetings.has(id))
    const keeperDomain = companyDomain(keeper.email)
    const sameDomain = !!keeperDomain && keeperDomain === companyDomain(loser.email)
    if (ev.sharedMeetings !== shared.length || ev.sameDomain !== sameDomain) {
      run('UPDATE identity_suggestions SET evidence = ? WHERE id = ?', [
        JSON.stringify({ ...ev, sharedMeetings: shared.length, sameDomain }),
        s.id
      ])
      result.rescored++
    }

    if (!harness || (shared.length === 0 && !sameDomain)) continue
    const askedKey = `merge:${keeper.id}:${loser.id}:${shared.length}:${sameDomain ? 1 : 0}`
    if (wasAsked(askedKey) || !mergeAllowed(keeper.id, loser.id)) continue
    if (d.budget.left <= 0) break
    if (d.isTranscribing()) return { ...result, stopped: 'transcription-active' }

    const subjects = shared.length
      ? queryAll<{ subject: string | null }>(
          `SELECT subject FROM meetings WHERE id IN (${shared.map(() => '?').join(',')}) ORDER BY start_time DESC LIMIT 10`,
          shared
        ).map((m) => m.subject ?? '')
      : []
    const request = buildMergeTiebreakRequest({
      a: { name: keeper.name, email: keeper.email, role: keeper.role },
      b: { name: loser.name, email: loser.email, role: loser.role },
      sharedMeetings: subjects,
      sameDomain
    })
    spendJevCall(d.budget)
    let answer
    try {
      const res = await withCallRecord({ step: 'identity-tiebreak', route: 'jev', recordingId: null }, () =>
        harness.ask(request.state, request.questions)
      )
      answer = parseMergeTiebreak(res)
    } catch (e) {
      console.warn(`[IdentityRules] Jev merge tiebreak for ${s.id} failed:`, e instanceof Error ? e.message : e)
      await d.yieldToLoop()
      continue
    }
    markAsked(askedKey)
    result.asked++

    if (answer?.same && mergeAllowed(keeper.id, loser.id)) {
      const fresh = getIdentitySuggestionById(s.id)
      if (fresh && fresh.status === 'pending' && isSuggestionEligibleForAccept(fresh)) {
        const merged = acceptMergeSuggestion(fresh, loser.id, 'jev-tiebreak', {
          sharedMeetings: shared.length,
          sameDomain,
          probabilities: answer.probabilities,
          probability: answer.probability,
          margin: answer.margin
        })
        if (merged) result.merged++
      }
    }
    await d.yieldToLoop()
  }
  return result
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface IdentityRulesSummary {
  ran: boolean
  reason?: 'transcription-active' | 'already-running'
  stopped?: 'transcription-active'
  mentionsResolved: number
  tiebreaksAsked: number
  tiebreaksResolved: number
  mergedByEmail: number
  mergedByVoice: number
  nameMergesAsked: number
  mergedByName: number
}

let running = false

/**
 * Apply the rules over the library: the shared-first-name rules, the Jev tiebreak, then the
 * merges by email, by voice and by similar name. Runs after the voice learning pass and after
 * each calendar sync; never while a transcription runs, and stops between steps (and between Jev
 * calls) when one starts. One run at a time.
 */
export async function runIdentityRules(deps: IdentityRulesDeps = {}): Promise<IdentityRulesSummary> {
  const d = resolve(deps)
  const summary: IdentityRulesSummary = {
    ran: false,
    mentionsResolved: 0,
    tiebreaksAsked: 0,
    tiebreaksResolved: 0,
    mergedByEmail: 0,
    mergedByVoice: 0,
    nameMergesAsked: 0,
    mergedByName: 0
  }
  if (running) return { ...summary, reason: 'already-running' }
  if (d.isTranscribing()) return { ...summary, reason: 'transcription-active' }

  running = true
  summary.ran = true
  const owner = d.ownerContactId()
  const stepDeps: IdentityRulesDeps = { ...deps, isTranscribing: d.isTranscribing, yieldToLoop: d.yieldToLoop }
  const steps: Array<() => unknown> = [
    () => {
      summary.mentionsResolved = autoSplitAmbiguousBuckets({ ownerContactId: owner }).resolved
    },
    async () => {
      const r = await resolveBucketTiesWithJev(stepDeps, d.budget)
      summary.tiebreaksAsked = r.asked
      summary.tiebreaksResolved = r.resolved
    },
    () => {
      summary.mergedByEmail = autoMergeExactEmail().merged
    },
    () => {
      summary.mergedByVoice = autoMergeSameVoice(owner).merged
    },
    async () => {
      const r = await resolveSimilarNameMerges(stepDeps, d.budget)
      summary.nameMergesAsked = r.asked
      summary.mergedByName = r.merged
    }
  ]
  try {
    for (const step of steps) {
      if (d.isTranscribing()) {
        summary.stopped = 'transcription-active'
        return summary
      }
      await step()
      await d.yieldToLoop()
    }
  } finally {
    running = false
  }
  const decided =
    summary.mentionsResolved + summary.tiebreaksResolved + summary.mergedByEmail + summary.mergedByVoice + summary.mergedByName
  if (decided) {
    console.log(
      `[IdentityRules] ${summary.mentionsResolved + summary.tiebreaksResolved} mention(s) resolved, ` +
        `${summary.mergedByEmail + summary.mergedByVoice + summary.mergedByName} merge(s)`
    )
  }
  return summary
}
