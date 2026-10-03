/**
 * Learning voices from the simplest meetings up (spec
 * docs/superpowers/specs/2026-10-03-people-identity-autoresolve-design.md, Phase 2).
 *
 * - The owner's voice (2a) is anchored elsewhere: by the microphone channel of a live
 *   recording (live-channel-speakers.ts) and by the owner's self-identification. Without it,
 *   nothing here runs.
 * - One-on-one (2b): a meeting of the owner and one other person, recorded with exactly two
 *   voices of 30 s or more, one of them the owner's. The other voice is that person.
 * - Elimination (2c): when every voice but one is known to be an attendee and exactly one
 *   attendee has no voice yet, the remaining voice votes for that attendee. Two recordings
 *   voting the same person, and none voting anyone else, anchor the voice.
 * - Propagation (2d): every new anchor names that voice's speakers in the other recordings
 *   through applyKnownVoiceBindings, which also applies the conflict rule.
 *
 * Every anchor and speaker named here is journaled in identity_decisions and can be undone;
 * an undone decision is never made again by the same method for the same subject.
 */

import { getConfig } from './config'
import { assignSpeaker, filterVisibleEntityIds, queryAll, queryOne, runInTransaction, runNoSave } from './database'
import {
  recordDecisionNoSave,
  snapshotSpeakerNoSave,
  snapshotVoiceAnchorNoSave,
  speakerSubjectKey,
  voiceAnchorSubjectKey,
  wasSpeakerUndoneFor,
  wasUndone
} from './identity-decisions'
import { filterEligibleRecordingIds } from './recording-eligibility'
import {
  ANCHORED_VOICE_MATCH_THRESHOLD,
  applyKnownVoiceBindings,
  mayReplaceSpeaker,
  recordVoiceConflictNoSave
} from './speaker-linking'
import { methodConfidence } from './signal-tiers'
import { getActiveTranscriptions } from './transcription-activity'

/** A voice says something about who it is only when it speaks this long in the recording. */
export const MIN_LEARNING_SPEECH_SECONDS = 30
export const ONE_ON_ONE_CONFIDENCE = methodConfidence('one-on-one')
export const ELIMINATION_CONFIDENCE = methodConfidence('elimination')
/** Elimination anchors a voice once this many different recordings vote the same person. */
export const ELIMINATION_VOTES_NEEDED = 2
/** A learning run stops after this many passes even if each pass still learns something. */
export const MAX_LEARNING_PASSES = 10

type LearningMethod = 'one-on-one' | 'elimination'

function ownerContactId(): string | null {
  return getConfig().identity?.ownerContactId || null
}

/** The voice clusters tied to the owner chosen in Settings (none without an owner). */
export function ownerVoiceClusterIds(): string[] {
  const owner = ownerContactId()
  if (!owner) return []
  return queryAll<{ id: string }>('SELECT id FROM voice_clusters WHERE contact_id = ? ORDER BY id', [owner]).map(
    (row) => row.id
  )
}

export interface MeetingAttendees {
  /** Each attendee contact once. */
  contactIds: string[]
  ownerId: string | null
  ownerAttends: boolean
}

function parseAttendeeEmails(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry: unknown) => {
      const email = typeof entry === 'string' ? entry : (entry as { email?: unknown } | null)?.email
      return typeof email === 'string' && email.includes('@') ? [email.trim().toLowerCase()] : []
    })
  } catch {
    return []
  }
}

/**
 * The people of a meeting: attendees and organizer matched by email (without case) to
 * contacts, plus contacts linked to it by the calendar (meeting_contacts source 'calendar').
 * When two contacts share one email, the owner wins, then one already linked to the meeting,
 * then the first by id: an email is one person.
 */
export function meetingAttendeeContacts(meetingId: string): MeetingAttendees {
  const owner = ownerContactId()
  const meeting = queryOne<{ attendees: string | null; organizer_email: string | null }>(
    'SELECT attendees, organizer_email FROM meetings WHERE id = ?',
    [meetingId]
  )
  const linked = queryAll<{ contact_id: string }>(
    "SELECT contact_id FROM meeting_contacts WHERE meeting_id = ? AND source = 'calendar'",
    [meetingId]
  ).map((row) => row.contact_id)
  const linkedSet = new Set(linked)

  const emails = new Set(parseAttendeeEmails(meeting?.attendees ?? null))
  if (meeting?.organizer_email?.includes('@')) emails.add(meeting.organizer_email.trim().toLowerCase())

  const ids = new Set<string>()
  for (const email of emails) {
    const matches = queryAll<{ id: string }>('SELECT id FROM contacts WHERE LOWER(TRIM(email)) = ? ORDER BY id', [
      email
    ]).map((row) => row.id)
    if (!matches.length) continue
    const pick =
      matches.find((id) => id === owner) ?? matches.find((id) => linkedSet.has(id)) ?? matches[0]
    ids.add(pick)
  }
  for (const id of linked) ids.add(id)

  const contactIds = [...ids]
  return { contactIds, ownerId: owner, ownerAttends: !!owner && ids.has(owner) }
}

export interface RecordingVoice {
  localLabel: string
  transcriptLabel: string | null
  clusterId: string
  similarity: number | null
  speechSeconds: number
  /** The contact the voice's cluster is tied to, however weakly this voice matched it. */
  clusterContactId: string | null
  /** That contact, only when this voice matched the cluster at 0.9 or more (or founded it). */
  knownContactId: string | null
}

/** The voices of a recording, with their speech and the person each is known to be. */
export function recordingVoices(recordingId: string): RecordingVoice[] {
  const rows = queryAll<{
    local_speaker_label: string
    transcript_speaker_label: string | null
    voice_cluster_id: string
    similarity: number | null
    contact_id: string | null
    speech_seconds: number
  }>(
    `SELECT rvc.local_speaker_label, rvc.transcript_speaker_label, rvc.voice_cluster_id, rvc.similarity,
            vc.contact_id,
            COALESCE((SELECT SUM(o.speech_seconds) FROM voice_cluster_observations o
                       WHERE o.recording_id = rvc.recording_id AND o.local_speaker_label = rvc.local_speaker_label), 0)
              AS speech_seconds
       FROM recording_voice_clusters rvc
       JOIN voice_clusters vc ON vc.id = rvc.voice_cluster_id
      WHERE rvc.recording_id = ?
      ORDER BY rvc.local_speaker_label`,
    [recordingId]
  )
  return rows.map((row) => {
    const strong = row.similarity === null || row.similarity >= ANCHORED_VOICE_MATCH_THRESHOLD
    return {
      localLabel: row.local_speaker_label,
      transcriptLabel: row.transcript_speaker_label,
      clusterId: row.voice_cluster_id,
      similarity: row.similarity,
      speechSeconds: row.speech_seconds,
      clusterContactId: row.contact_id,
      knownContactId: row.contact_id && strong ? row.contact_id : null
    }
  })
}

export interface LearningResult {
  anchored: boolean
  clusterId?: string
  contactId?: string
  reason?: string
}

export interface EliminationResult extends LearningResult {
  /** The vote this recording cast, or null when it could not cast one. */
  voted: { clusterId: string; contactId: string } | null
}

function isVisibleContact(contactId: string): boolean {
  const { visible, failClosed } = filterVisibleEntityIds('contact', [contactId])
  return !failClosed && visible.has(contactId)
}

/**
 * Name one transcript speaker after a learned voice, journaled, inside the caller's
 * transaction. A speaker already named after someone else is replaced only when the method
 * outranks the binding's source; otherwise the disagreement becomes a voice-conflict
 * suggestion. Returns true when the speaker was named.
 */
function bindLearnedSpeakerNoSave(
  recordingId: string,
  label: string,
  contactId: string,
  method: LearningMethod,
  confidence: number,
  clusterId: string
): boolean {
  const subjectKey = speakerSubjectKey(recordingId, label)
  // An undone decision holds against every method that would make it again.
  if (wasUndone('speaker', subjectKey, method) || wasSpeakerUndoneFor(recordingId, label, contactId)) return false
  const before = snapshotSpeakerNoSave(recordingId, label)
  if (before.row) {
    if (before.row.contact_id === contactId) return false
    if (!mayReplaceSpeaker(before.row.source, method)) {
      recordVoiceConflictNoSave({
        recordingId,
        speakerLabel: label,
        voiceClusterId: clusterId,
        similarity: null,
        voiceContactId: contactId,
        boundContactId: before.row.contact_id,
        boundSource: before.row.source
      })
      return false
    }
  }
  assignSpeaker(recordingId, label, { contactId, source: method, confidence })
  recordDecisionNoSave({
    kind: 'speaker',
    subjectKey,
    method,
    contactId,
    evidence: { voiceClusterId: clusterId },
    before
  })
  return true
}

/** Tie a cluster to a person and journal it, inside the caller's transaction. */
function anchorClusterNoSave(
  clusterId: string,
  contactId: string,
  method: LearningMethod,
  confidence: number,
  evidence: Record<string, unknown>
): void {
  const before = snapshotVoiceAnchorNoSave(clusterId)
  runNoSave(
    `UPDATE voice_clusters SET contact_id = ?, contact_link_method = ?, contact_link_confidence = ?, updated_at = ?
     WHERE id = ?`,
    [contactId, method, confidence, new Date().toISOString(), clusterId]
  )
  recordDecisionNoSave({
    kind: 'voice-anchor',
    subjectKey: voiceAnchorSubjectKey(clusterId),
    method,
    contactId,
    evidence,
    before
  })
}

/** Voices that speak long enough to say who they are. */
function substantialVoices(recordingId: string): RecordingVoice[] {
  return recordingVoices(recordingId).filter((v) => v.speechSeconds >= MIN_LEARNING_SPEECH_SECONDS)
}

/**
 * One-on-one (2b): a meeting of exactly the owner and X, recorded with exactly two voices of
 * 30 s or more, one of them the owner's (matched at 0.9 or more), the other tied to nobody.
 * The other voice is X: its cluster is anchored to X and its transcript speaker named.
 */
export function learnFromOneOnOne(recordingId: string): LearningResult {
  const owner = ownerContactId()
  if (!owner) return { anchored: false, reason: 'no owner chosen in Settings' }
  if (!ownerVoiceClusterIds().length) return { anchored: false, reason: "the owner's voice is not known yet" }
  const meetingId = queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', [
    recordingId
  ])?.meeting_id
  if (!meetingId) return { anchored: false, reason: 'the recording has no meeting' }

  const attendees = meetingAttendeeContacts(meetingId)
  if (attendees.contactIds.length !== 2 || !attendees.ownerAttends) {
    return { anchored: false, reason: 'the meeting is not the owner and one other person' }
  }
  const other = attendees.contactIds.find((id) => id !== owner)!

  const voices = substantialVoices(recordingId)
  if (voices.length !== 2) return { anchored: false, reason: 'the recording does not have exactly two voices' }
  const ownerVoice = voices.find((v) => v.knownContactId === owner)
  const otherVoice = voices.find((v) => v !== ownerVoice)
  if (!ownerVoice || !otherVoice) return { anchored: false, reason: "the owner's voice is not in the recording" }
  if (otherVoice.clusterId === ownerVoice.clusterId) return { anchored: false, reason: 'both voices are the owner' }
  if (otherVoice.clusterContactId) return { anchored: false, reason: 'the other voice already belongs to someone' }
  if (wasUndone('voice-anchor', voiceAnchorSubjectKey(otherVoice.clusterId), 'one-on-one')) {
    return { anchored: false, reason: 'the owner undid this before' }
  }
  if (!isVisibleContact(other)) return { anchored: false, reason: 'the other attendee is hidden' }

  runInTransaction(() => {
    anchorClusterNoSave(otherVoice.clusterId, other, 'one-on-one', ONE_ON_ONE_CONFIDENCE, {
      recordingId,
      meetingId,
      ownerVoiceClusterId: ownerVoice.clusterId,
      speechSeconds: otherVoice.speechSeconds
    })
    if (otherVoice.transcriptLabel) {
      bindLearnedSpeakerNoSave(
        recordingId,
        otherVoice.transcriptLabel,
        other,
        'one-on-one',
        ONE_ON_ONE_CONFIDENCE,
        otherVoice.clusterId
      )
    }
  })
  return { anchored: true, clusterId: otherVoice.clusterId, contactId: other }
}

/**
 * Elimination (2c) for one recording: attendees A, voices V of 30 s or more. When exactly one
 * voice is not known to be an attendee, exactly one attendee has no known voice, |V| <= |A|
 * and that voice's cluster is tied to nobody, the recording votes the voice to that attendee.
 * Once two recordings vote the same person, and none votes anyone else, the voice is anchored
 * and its speakers in the voting recordings are named.
 */
export function learnByElimination(recordingId: string): EliminationResult {
  const none = (reason: string): EliminationResult => ({ anchored: false, voted: null, reason })
  if (!ownerContactId()) return none('no owner chosen in Settings')
  if (!ownerVoiceClusterIds().length) return none("the owner's voice is not known yet")
  const meetingId = queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', [
    recordingId
  ])?.meeting_id
  if (!meetingId) return none('the recording has no meeting')

  const attendees = new Set(meetingAttendeeContacts(meetingId).contactIds)
  const voices = substantialVoices(recordingId)
  if (!attendees.size || !voices.length) return none('no attendees or no voices')
  if (voices.length > attendees.size) return none('more voices than attendees')

  const known = voices.filter((v) => v.knownContactId && attendees.has(v.knownContactId))
  const unknown = voices.filter((v) => !known.includes(v))
  if (unknown.length !== 1) return none('not exactly one unknown voice')
  const heard = new Set(known.map((v) => v.knownContactId!))
  const silent = [...attendees].filter((id) => !heard.has(id))
  if (silent.length !== 1) return none('not exactly one attendee without a voice')
  const voice = unknown[0]
  const contactId = silent[0]
  if (voice.clusterContactId) return none('the remaining voice already belongs to someone')

  runNoSave(
    `INSERT INTO voice_elimination_votes (cluster_id, contact_id, recording_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(cluster_id, recording_id) DO UPDATE SET contact_id = excluded.contact_id`,
    [voice.clusterId, contactId, recordingId, new Date().toISOString()]
  )
  const voted = { clusterId: voice.clusterId, contactId }

  const tally = queryAll<{ contact_id: string; recordings: number }>(
    `SELECT contact_id, COUNT(DISTINCT recording_id) AS recordings FROM voice_elimination_votes
      WHERE cluster_id = ? GROUP BY contact_id`,
    [voice.clusterId]
  )
  if (tally.length !== 1 || tally[0].recordings < ELIMINATION_VOTES_NEEDED) {
    return { anchored: false, voted, reason: tally.length > 1 ? 'the votes disagree' : 'waiting for a second recording' }
  }
  if (wasUndone('voice-anchor', voiceAnchorSubjectKey(voice.clusterId), 'elimination')) {
    return { anchored: false, voted, reason: 'the owner undid this before' }
  }
  if (!isVisibleContact(contactId)) return { anchored: false, voted, reason: 'the attendee is hidden' }

  const voters = queryAll<{ recording_id: string }>(
    'SELECT recording_id FROM voice_elimination_votes WHERE cluster_id = ? ORDER BY recording_id',
    [voice.clusterId]
  ).map((row) => row.recording_id)
  runInTransaction(() => {
    anchorClusterNoSave(voice.clusterId, contactId, 'elimination', ELIMINATION_CONFIDENCE, {
      recordingIds: voters,
      meetingId
    })
    for (const voter of voters) {
      const labels = queryAll<{ transcript_speaker_label: string }>(
        `SELECT DISTINCT transcript_speaker_label FROM recording_voice_clusters
          WHERE recording_id = ? AND voice_cluster_id = ? AND transcript_speaker_label IS NOT NULL`,
        [voter, voice.clusterId]
      )
      for (const { transcript_speaker_label: label } of labels) {
        bindLearnedSpeakerNoSave(voter, label, contactId, 'elimination', ELIMINATION_CONFIDENCE, voice.clusterId)
      }
    }
  })
  return { anchored: true, voted, clusterId: voice.clusterId, contactId }
}

export interface VoiceLearningDeps {
  isTranscribing?: () => boolean
  /** Hands the event loop back between recordings. */
  yieldToLoop?: () => Promise<void>
}

export interface LearnedAnchor {
  clusterId: string
  contactId: string
  method: LearningMethod
  recordingId: string
}

export interface VoiceLearningSummary {
  ran: boolean
  reason?: 'transcription-active' | 'no-owner' | 'no-owner-voice' | 'already-running'
  /** Set when a run started and was cut short. */
  stopped?: 'transcription-active'
  passes: number
  anchored: LearnedAnchor[]
  /** Speakers named in other recordings by the new anchors. */
  propagated: number
}

let learning = false

/** Recordings with voice evidence and a meeting, fewest voices first, then oldest. */
function learningCandidates(): string[] {
  const ids = queryAll<{ id: string }>(
    `SELECT r.id FROM recordings r
       JOIN recording_voice_clusters rvc ON rvc.recording_id = r.id
      WHERE r.meeting_id IS NOT NULL AND r.deleted_at IS NULL
      GROUP BY r.id
      ORDER BY COUNT(*), r.date_recorded, r.id`
  ).map((row) => row.id)
  if (!ids.length) return []
  const { eligible } = filterEligibleRecordingIds(ids)
  return ids.filter((id) => eligible.has(id))
}

/** Name the new anchor's speakers in every recording that holds its voice. */
function propagate(clusterId: string): number {
  const recordings = queryAll<{ recording_id: string }>(
    'SELECT DISTINCT recording_id FROM recording_voice_clusters WHERE voice_cluster_id = ?',
    [clusterId]
  ).map((row) => row.recording_id)
  const { eligible } = filterEligibleRecordingIds(recordings)
  let named = 0
  for (const id of recordings) {
    if (eligible.has(id)) named += applyKnownVoiceBindings(id)
  }
  return named
}

/**
 * Learn voices over the library: one-on-ones, then elimination, recording by recording from
 * the simplest, and again while a pass learns something new (at most MAX_LEARNING_PASSES).
 * Each new anchor is propagated at once. Never runs while a transcription is active, and stops
 * between recordings when one starts.
 */
export async function runVoiceLearning(deps: VoiceLearningDeps = {}): Promise<VoiceLearningSummary> {
  const isTranscribing = deps.isTranscribing ?? (() => getActiveTranscriptions().length > 0)
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  const summary: VoiceLearningSummary = { ran: false, passes: 0, anchored: [], propagated: 0 }
  if (learning) return { ...summary, reason: 'already-running' }
  if (isTranscribing()) return { ...summary, reason: 'transcription-active' }
  if (!ownerContactId()) return { ...summary, reason: 'no-owner' }
  if (!ownerVoiceClusterIds().length) return { ...summary, reason: 'no-owner-voice' }

  learning = true
  summary.ran = true
  try {
    while (summary.passes < MAX_LEARNING_PASSES) {
      summary.passes++
      let learnedThisPass = 0
      for (const recordingId of learningCandidates()) {
        if (isTranscribing()) {
          summary.stopped = 'transcription-active'
          return summary
        }
        for (const [method, learn] of [
          ['one-on-one', learnFromOneOnOne],
          ['elimination', learnByElimination]
        ] as const) {
          const result = learn(recordingId)
          if (!result.anchored || !result.clusterId || !result.contactId) continue
          summary.anchored.push({ clusterId: result.clusterId, contactId: result.contactId, method, recordingId })
          summary.propagated += propagate(result.clusterId)
          learnedThisPass++
        }
        await yieldToLoop()
      }
      if (!learnedThisPass) break
    }
  } finally {
    learning = false
  }
  if (summary.anchored.length) {
    console.log(
      `[VoiceLearning] ${summary.anchored.length} voice(s) learned in ${summary.passes} pass(es), ` +
        `${summary.propagated} speaker(s) named elsewhere`
    )
  }
  return summary
}
