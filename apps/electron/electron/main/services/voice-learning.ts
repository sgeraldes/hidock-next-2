/**
 * Learning voices from the simplest meetings up (spec
 * docs/superpowers/specs/2026-10-03-people-identity-autoresolve-design.md, Phase 2).
 *
 * - The owner's voice (2a) is anchored elsewhere: by the microphone channel of a live
 *   recording (live-channel-speakers.ts) and by the owner's self-identification. Without it,
 *   nothing here runs.
 * - One-on-one (2b): a meeting of the owner and one other person, recorded with exactly two
 *   voices of 30 s or more, one of them the owner's. The other voice votes for that person.
 * - Elimination (2c): when every voice but one is known to be an attendee and exactly one
 *   attendee has no voice yet, the remaining voice votes for that attendee.
 * - Votes of both kinds share voice_elimination_votes. Two recordings voting the same person,
 *   and none voting anyone else, anchor the voice; one recording never does, since an invitee
 *   may stay silent while an off-invite guest speaks.
 * - Propagation (2d): every new anchor names that voice's speakers in the other recordings
 *   through applyKnownVoiceBindings, which also applies the conflict rule.
 *
 * Every anchor and speaker named here is journaled in identity_decisions and can be undone;
 * an undone decision is never made again for the same subject and person, by any method.
 */

import { getConfig } from './config'
import { assignSpeaker, filterVisibleEntityIds, queryAll, queryOne, runInTransaction, runNoSave } from './database'
import {
  recordDecisionNoSave,
  snapshotSpeakerNoSave,
  snapshotVoiceAnchorNoSave,
  speakerSubjectKey,
  voiceAnchorSubjectKey,
  wasAnchorUndoneFor,
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
/**
 * A voice is anchored once this many different recordings vote it the same person. One
 * recording is not enough even for a one-on-one: the invitee may have stayed silent while an
 * off-invite guest spoke.
 */
export const VOTES_NEEDED = 2
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

/** What one recording taught: the vote it cast, and the anchor that vote completed, if any. */
export interface VoteResult {
  anchored: boolean
  /** The vote this recording cast, or null when it could not cast one. */
  voted: { clusterId: string; contactId: string } | null
  clusterId?: string
  contactId?: string
  /** The anchor's method: 'one-on-one' when any agreeing vote came from a one-on-one. */
  method?: LearningMethod
  reason?: string
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

const CONFIDENCE: Record<LearningMethod, number> = {
  'one-on-one': ONE_ON_ONE_CONFIDENCE,
  elimination: ELIMINATION_CONFIDENCE
}

/**
 * Cast this recording's vote for a voice, then anchor the voice when two different recordings
 * agree on the person (one-on-one or elimination votes, any mix) and no vote names anyone
 * else. The anchor's method is 'one-on-one' when any agreeing vote came from a one-on-one,
 * else 'elimination'. Only then are the voice's speakers named in the voting recordings, each
 * by the rule that voted there. An anchor the owner undid for that person, by any method, is
 * never made again.
 */
function voteAndMaybeAnchor(
  recordingId: string,
  clusterId: string,
  contactId: string,
  method: LearningMethod,
  evidence: Record<string, unknown>
): VoteResult {
  runNoSave(
    `INSERT INTO voice_elimination_votes (cluster_id, contact_id, recording_id, method, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cluster_id, recording_id) DO UPDATE SET contact_id = excluded.contact_id, method = excluded.method`,
    [clusterId, contactId, recordingId, method, new Date().toISOString()]
  )
  const voted = { clusterId, contactId }
  const votes = queryAll<{ contact_id: string; recording_id: string; method: LearningMethod }>(
    'SELECT contact_id, recording_id, method FROM voice_elimination_votes WHERE cluster_id = ? ORDER BY recording_id',
    [clusterId]
  )
  const people = new Set(votes.map((v) => v.contact_id))
  if (people.size > 1) return { anchored: false, voted, reason: 'the votes disagree' }
  if (new Set(votes.map((v) => v.recording_id)).size < VOTES_NEEDED) {
    return { anchored: false, voted, reason: 'waiting for a second recording' }
  }
  const anchorMethod: LearningMethod = votes.some((v) => v.method === 'one-on-one') ? 'one-on-one' : 'elimination'
  if (
    wasUndone('voice-anchor', voiceAnchorSubjectKey(clusterId), anchorMethod) ||
    wasAnchorUndoneFor(clusterId, contactId)
  ) {
    return { anchored: false, voted, reason: 'the owner undid this before' }
  }
  if (!isVisibleContact(contactId)) return { anchored: false, voted, reason: 'the person is hidden' }

  runInTransaction(() => {
    anchorClusterNoSave(clusterId, contactId, anchorMethod, CONFIDENCE[anchorMethod], {
      ...evidence,
      votes: votes.map((v) => ({ recordingId: v.recording_id, method: v.method }))
    })
    for (const vote of votes) {
      const labels = queryAll<{ transcript_speaker_label: string }>(
        `SELECT DISTINCT transcript_speaker_label FROM recording_voice_clusters
          WHERE recording_id = ? AND voice_cluster_id = ? AND transcript_speaker_label IS NOT NULL`,
        [vote.recording_id, clusterId]
      )
      for (const { transcript_speaker_label: label } of labels) {
        bindLearnedSpeakerNoSave(vote.recording_id, label, contactId, vote.method, CONFIDENCE[vote.method], clusterId)
      }
    }
  })
  return { anchored: true, voted, clusterId, contactId, method: anchorMethod }
}

const noVote = (reason: string): VoteResult => ({ anchored: false, voted: null, reason })

/**
 * One-on-one (2b): a meeting of exactly the owner and X, recorded with exactly two voices of
 * 30 s or more, one of them the owner's (matched at 0.9 or more), the other tied to nobody.
 * The recording votes the other voice to X. It takes two agreeing recordings to anchor it
 * (voteAndMaybeAnchor): X may have stayed silent while an off-invite guest spoke.
 */
export function learnFromOneOnOne(recordingId: string): VoteResult {
  const owner = ownerContactId()
  if (!owner) return noVote('no owner chosen in Settings')
  if (!ownerVoiceClusterIds().length) return noVote("the owner's voice is not known yet")
  const meetingId = queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', [
    recordingId
  ])?.meeting_id
  if (!meetingId) return noVote('the recording has no meeting')

  const attendees = meetingAttendeeContacts(meetingId)
  if (attendees.contactIds.length !== 2 || !attendees.ownerAttends) {
    return noVote('the meeting is not the owner and one other person')
  }
  const other = attendees.contactIds.find((id) => id !== owner)!

  const voices = substantialVoices(recordingId)
  if (voices.length !== 2) return noVote('the recording does not have exactly two voices')
  const ownerVoice = voices.find((v) => v.knownContactId === owner)
  const otherVoice = voices.find((v) => v !== ownerVoice)
  if (!ownerVoice || !otherVoice) return noVote("the owner's voice is not in the recording")
  if (otherVoice.clusterId === ownerVoice.clusterId) return noVote('both voices are the owner')
  if (otherVoice.clusterContactId) return noVote('the other voice already belongs to someone')

  return voteAndMaybeAnchor(recordingId, otherVoice.clusterId, other, 'one-on-one', {
    meetingId,
    ownerVoiceClusterId: ownerVoice.clusterId
  })
}

/**
 * Elimination (2c) for one recording: attendees A, and V every voice stored for the recording
 * (the voice step already drops voices too short to measure). When |V| <= |A|, exactly one
 * voice is not known to be an attendee, exactly one attendee has no known voice, and that
 * voice speaks 30 s or more and is tied to nobody, the recording votes the voice to that
 * attendee. A short voice still counts as someone in the room: it is never left out of V.
 */
export function learnByElimination(recordingId: string): VoteResult {
  if (!ownerContactId()) return noVote('no owner chosen in Settings')
  if (!ownerVoiceClusterIds().length) return noVote("the owner's voice is not known yet")
  const meetingId = queryOne<{ meeting_id: string | null }>('SELECT meeting_id FROM recordings WHERE id = ?', [
    recordingId
  ])?.meeting_id
  if (!meetingId) return noVote('the recording has no meeting')

  const attendees = new Set(meetingAttendeeContacts(meetingId).contactIds)
  const voices = recordingVoices(recordingId)
  if (!attendees.size || !voices.length) return noVote('no attendees or no voices')
  if (voices.length > attendees.size) return noVote('more voices than attendees')

  const known = voices.filter((v) => v.knownContactId && attendees.has(v.knownContactId))
  const unknown = voices.filter((v) => !known.includes(v))
  if (unknown.length !== 1) return noVote('not exactly one unknown voice')
  const heard = new Set(known.map((v) => v.knownContactId!))
  const silent = [...attendees].filter((id) => !heard.has(id))
  if (silent.length !== 1) return noVote('not exactly one attendee without a voice')
  const voice = unknown[0]
  if (voice.speechSeconds < MIN_LEARNING_SPEECH_SECONDS) return noVote('the remaining voice speaks too little')
  if (voice.clusterContactId) return noVote('the remaining voice already belongs to someone')

  return voteAndMaybeAnchor(recordingId, voice.clusterId, silent[0], 'elimination', { meetingId })
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
        for (const learn of [learnFromOneOnOne, learnByElimination]) {
          const result = learn(recordingId)
          if (!result.anchored || !result.clusterId || !result.contactId || !result.method) continue
          summary.anchored.push({
            clusterId: result.clusterId,
            contactId: result.contactId,
            method: result.method,
            recordingId
          })
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
