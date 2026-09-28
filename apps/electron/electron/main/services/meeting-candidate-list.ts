/**
 * The meetings a recording could be: the stored candidates plus the meetings
 * near its date, scored by time. Shared by the Reader's candidate list
 * (recordings:getCandidates) and the Jev meeting-match job, so both see the
 * same set.
 */

import {
  getCandidatesForRecordingWithDetails,
  getMeetingById,
  getMeetingsNearDate,
  getRecordingMeetingMatch,
  getTranscriptByRecordingId,
  saveRecordingMeetingMatch,
  type Recording
} from './database'
import {
  buildContentText,
  countTranscriptSpeakers,
  deriveTranscriptSummary,
  deriveTranscriptTitle,
  isCancelledMeetingSubject,
  scoreMeetingCandidates
} from './recording-match-scoring'
import { jevKeyFor } from './jev-settings'
import { JEV_MODEL, MEETING_MATCH_VERSION, meetingCopyKey, type MatchCandidate, type MatchContext, type MeetingMatchDeps } from './jev-meeting-match'

export type CandidateRow = ReturnType<typeof getCandidatesForRecordingWithDetails>[number]
export { meetingCopyKey }

export function listMeetingCandidates(recording: Recording) {
  const transcript = getTranscriptByRecordingId(recording.id)
  const recordingContext = {
    title: deriveTranscriptTitle(transcript),
    summary: deriveTranscriptSummary(transcript),
    speakerCount: countTranscriptSpeakers(transcript),
    hasTranscript: !!transcript
  }

  // Union the stored candidates with meetings near the recording, keyed by
  // meeting id (stored rows win: they carry the real candidate id and any user
  // confirmation). Nearby-only meetings get a synthetic id.
  const byMeeting = new Map<string, CandidateRow>()
  for (const candidate of getCandidatesForRecordingWithDetails(recording.id)) {
    byMeeting.set(candidate.meetingId, candidate)
  }
  try {
    for (const meeting of getMeetingsNearDate(recording.date_recorded)) {
      if (!byMeeting.has(meeting.id)) {
        byMeeting.set(meeting.id, {
          id: `nearby_${meeting.id}`,
          recordingId: recording.id,
          meetingId: meeting.id,
          subject: meeting.subject,
          startTime: meeting.start_time,
          endTime: meeting.end_time,
          confidenceScore: 0,
          matchReason: null,
          isAiSelected: false,
          isUserConfirmed: false,
          isAllDay: (meeting.is_all_day ?? 0) === 1
        })
      }
    }
  } catch (nearbyError) {
    // Nearby meetings are best-effort enrichment; never fail the list for it.
    console.error('listMeetingCandidates: nearby lookup failed:', nearbyError)
  }

  const candidates = collapseMeetingCopies(
    Array.from(byMeeting.values()).filter((candidate) => !isCancelledMeetingSubject(candidate.subject)),
    recording.meeting_id ?? null
  )
  const scored = scoreMeetingCandidates(
    {
      dateRecorded: recording.date_recorded,
      durationSeconds: recording.duration_seconds,
      contentText: buildContentText(transcript)
    },
    candidates.map((c) => ({
      meetingId: c.meetingId,
      subject: c.subject,
      startTime: c.startTime,
      endTime: c.endTime,
      isAllDay: c.isAllDay
    }))
  )
  const scoreByMeeting = new Map(scored.map((s) => [s.meetingId, s]))
  return { transcript, recordingContext, candidates, scored, scoreByMeeting }
}


/**
 * One candidate per real meeting. Among copies keep the one the person
 * confirmed, else the one the recording is linked to, else the connector copy
 * (it carries attendee emails), else the first.
 */
export function collapseMeetingCopies(candidates: CandidateRow[], linkedMeetingId: string | null): CandidateRow[] {
  const rank = (c: CandidateRow) =>
    (c.isUserConfirmed ? 8 : 0) + (c.meetingId === linkedMeetingId ? 4 : 0) + (c.meetingId.startsWith('m365') ? 2 : 0)
  const byKey = new Map<string, CandidateRow>()
  for (const c of candidates) {
    const key = meetingCopyKey(c.subject, c.startTime)
    const kept = byKey.get(key)
    if (!kept || rank(c) > rank(kept)) byKey.set(key, c)
  }
  const keep = new Set(byKey.values())
  return candidates.filter((c) => keep.has(c))
}

interface AttendeeJson {
  name?: string
  email?: string
}

function attendeeNames(json: string | undefined | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as AttendeeJson[]
    return parsed.map((a) => a.name?.trim() || a.email?.trim() || '').filter(Boolean)
  } catch {
    return []
  }
}

/** Candidates in the shape Jev reads: subject, time, organizer, attendees, and the time score. */
export function toMatchCandidates(list: ReturnType<typeof listMeetingCandidates>): MatchCandidate[] {
  return list.candidates.map((c) => {
    const meeting = getMeetingById(c.meetingId)
    const score = list.scoreByMeeting.get(c.meetingId)
    return {
      meetingId: c.meetingId,
      subject: c.subject,
      startTime: c.startTime,
      endTime: c.endTime,
      organizer: meeting?.organizer_name || meeting?.organizer_email || null,
      attendees: attendeeNames(meeting?.attendees),
      hasOverlap: !!score?.hasOverlap,
      timeScore: score?.confidenceScore ?? 0
    }
  })
}

export function toMatchContext(recording: Recording, list: ReturnType<typeof listMeetingCandidates>): MatchContext {
  return {
    title: list.recordingContext.title,
    summary: list.recordingContext.summary,
    transcriptText: list.transcript?.full_text ?? null,
    recordingStart: recording.date_recorded,
    durationSeconds: recording.duration_seconds ?? null
  }
}

/** Store and key for the Jev meeting match, or null when no Jev key is set. */
export function jevMeetingMatchDeps(): MeetingMatchDeps | null {
  const apiKey = jevKeyFor('meetingMatch')
  if (!apiKey) return null
  return {
    apiKey,
    load: (recordingId) => getRecordingMeetingMatch(recordingId, MEETING_MATCH_VERSION),
    save: (recordingId, match) => saveRecordingMeetingMatch(recordingId, MEETING_MATCH_VERSION, JEV_MODEL, match)
  }
}
