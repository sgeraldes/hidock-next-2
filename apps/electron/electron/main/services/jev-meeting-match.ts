/**
 * Which calendar meeting is this recording? Jev decides from what was said.
 *
 * The time scorer (recording-match-scoring.ts) gives every meeting that
 * overlaps the recording the same score, so a lunch and a working session at
 * the same hour both showed 72% (owner, 28-sep-2026). Jev reads the transcript
 * excerpt and summary against each candidate's subject, organizer and
 * attendees and answers one `choice`: which meeting, or none of them, with a
 * probability for each.
 *
 * One request per recording and candidate set; the answer is kept in
 * `recording_meeting_matches` (v63) and reused until the candidates change.
 */

import { createHash } from 'crypto'
import { askJev, JEV_MODEL, type JevQuestion, type JevResponse, type JevStructured } from './jev-client'
import { createJevHarness } from './pipeline/jev-harness'
import { askDecision, hasDecisionEngine } from './pipeline/decision-engines'
import { DEFAULT_QUALITY_RULES, qualityRules } from './quality-rules'

export const MEETING_MATCH_VERSION = 1

/** Candidates sent in one request: the overlapping ones first, then the closest by time. */
export const MAX_MATCH_CANDIDATES = 12

/**
 * A recording is linked by content only on a clear answer. These are the
 * defaults of Settings > Quality checks; isClearMatch reads the values in
 * force from qualityRules().
 */
export const AUTO_LINK_MIN_PROBABILITY = DEFAULT_QUALITY_RULES.meetingAutoLinkProbability
export const AUTO_LINK_MIN_MARGIN = DEFAULT_QUALITY_RULES.meetingAutoLinkMargin

const EXCERPT_HEAD_CHARS = 2500
const EXCERPT_TAIL_CHARS = 800
const NONE_KEY = 'none'

export interface MatchCandidate {
  meetingId: string
  subject: string
  startTime: string
  endTime: string
  organizer?: string | null
  attendees?: string[]
  hasOverlap: boolean
  timeScore: number
}

export interface MatchContext {
  title: string | null
  summary: string | null
  transcriptText: string | null
  recordingStart: string
  durationSeconds: number | null
}

export interface MeetingMatch {
  /** Probability per meeting id, from Jev. */
  probabilities: Record<string, number>
  /** Probability that none of the candidates is this recording. */
  none: number
  topMeetingId: string | null
  topProbability: number
  /** Top probability minus the next best (another meeting or none). */
  margin: number
  candidateKey: string
  inputTokens: number | null
}

/** Same meeting, two sources: the ICS feed and Microsoft 365 carry one event with the same subject and start. */
export function meetingCopyKey(subject: string, startTime: string): string {
  const start = Date.parse(startTime)
  return `${subject.trim().toLowerCase()}|${Number.isFinite(start) ? start : startTime}`
}

/** The candidates Jev sees: overlapping first, then by time score, at most MAX_MATCH_CANDIDATES. */
export function pickMatchCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
  return [...candidates]
    .sort((a, b) => Number(b.hasOverlap) - Number(a.hasOverlap) || b.timeScore - a.timeScore)
    .slice(0, MAX_MATCH_CANDIDATES)
}


/** The key a stored answer must carry to be reused for this recording and these candidates. */
export function matchRequestKey(context: MatchContext, allCandidates: MatchCandidate[]): string {
  const { state, questions } = buildMeetingMatchRequest(context, pickMatchCandidates(allCandidates))
  return requestKey(state, questions)
}

/** Stable key of everything Jev is sent for one match. */
export function requestKey(state: unknown, questions: unknown): string {
  return createHash('sha256')
    .update(`${MEETING_MATCH_VERSION}|${JSON.stringify(state)}|${JSON.stringify(questions)}`)
    .digest('hex')
    .slice(0, 32)
}

function excerpt(text: string | null): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS) return clean
  return `${clean.slice(0, EXCERPT_HEAD_CHARS)} … ${clean.slice(-EXCERPT_TAIL_CHARS)}`
}

function timeRange(startIso: string, endIso: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) : iso
  }
  return `${fmt(startIso)}-${fmt(endIso)} UTC`
}

export function describeCandidate(c: MatchCandidate): string {
  const parts = [`"${c.subject}"`, timeRange(c.startTime, c.endTime)]
  if (c.organizer) parts.push(`organized by ${c.organizer}`)
  if (c.attendees && c.attendees.length > 0) {
    const shown = c.attendees.slice(0, 12)
    parts.push(`attendees: ${shown.join(', ')}${c.attendees.length > shown.length ? ` and ${c.attendees.length - shown.length} more` : ''}`)
  }
  return parts.join('; ')
}

export function buildMeetingMatchRequest(
  context: MatchContext,
  candidates: MatchCandidate[]
): { state: JevStructured; questions: Record<string, JevQuestion>; keys: Map<string, string> } {
  const keys = new Map<string, string>()
  const criteria: Record<string, JevStructured> = {}
  candidates.forEach((c, i) => {
    const key = `m${i + 1}`
    keys.set(key, c.meetingId)
    criteria[key] = describeCandidate(c)
  })
  criteria[NONE_KEY] = 'None of these meetings: a different conversation, or one that was not on the calendar.'

  const state: JevStructured = {
    recording: {
      started_utc: context.recordingStart,
      duration_minutes: context.durationSeconds ? Math.round(context.durationSeconds / 60) : null,
      title: context.title,
      summary: context.summary,
      transcript_excerpt: excerpt(context.transcriptText)
    }
  }
  const questions: Record<string, JevQuestion> = {
    meeting: {
      type: 'choice',
      instructions:
        'Which calendar meeting is this recording of? Decide from what is said in `recording.transcript_excerpt` ' +
        'and `recording.summary` against each meeting subject, organizer and attendees. Several meetings overlap ' +
        'the recording time, so the time alone does not decide. Answer `none` when the conversation fits none of them.',
      criteria
    }
  }
  return { state, questions, keys }
}

export function parseMeetingMatch(res: JevResponse, keys: Map<string, string>, key: string): MeetingMatch | null {
  const answer = res.answers?.meeting
  if (!answer || answer.type !== 'choice') return null
  const probabilities: Record<string, number> = {}
  for (const [k, p] of Object.entries(answer.probabilities ?? {})) {
    const meetingId = keys.get(k)
    if (meetingId && Number.isFinite(p)) probabilities[meetingId] = p
  }
  const none = Number(answer.probabilities?.[NONE_KEY] ?? 0) || 0
  const ranked = [...Object.entries(probabilities), [NONE_KEY, none] as [string, number]].sort((a, b) => b[1] - a[1])
  const [topKey, topP] = ranked[0] ?? [NONE_KEY, 0]
  const second = ranked[1]?.[1] ?? 0
  return {
    probabilities,
    none,
    topMeetingId: topKey === NONE_KEY ? null : topKey,
    topProbability: topP,
    margin: topP - second,
    candidateKey: key,
    inputTokens: res.usage?.input_tokens ?? null
  }
}

/** Whether an answer is clear enough to link the recording without asking. */
export function isClearMatch(match: MeetingMatch | null): match is MeetingMatch & { topMeetingId: string } {
  const rules = qualityRules()
  return (
    !!match &&
    match.topMeetingId !== null &&
    match.topProbability >= rules.meetingAutoLinkProbability &&
    match.margin >= rules.meetingAutoLinkMargin
  )
}

export interface MeetingMatchDeps {
  apiKey: string
  load: (recordingId: string) => MeetingMatch | null
  save: (recordingId: string, match: MeetingMatch) => void
  ask?: typeof askJev
}

/**
 * Jev's answer for this recording and candidate set: the stored one when the
 * candidates are the same, else a new request. Null with fewer than two
 * candidates (the time match is the answer) or when the request fails.
 */
export async function matchMeetingWithJev(
  recordingId: string,
  context: MatchContext,
  allCandidates: MatchCandidate[],
  deps: MeetingMatchDeps
): Promise<MeetingMatch | null> {
  const candidates = pickMatchCandidates(allCandidates)
  if (candidates.length < 2) return null
  if (!context.transcriptText && !context.summary) return null
  const { state, questions, keys } = buildMeetingMatchRequest(context, candidates)
  // The stored answer is reused only for the same question: a corrected
  // transcript or a renamed or moved meeting asks Jev again.
  const key = requestKey(state, questions)
  const stored = deps.load(recordingId)
  if (stored && stored.candidateKey === key) return stored

  const harness = createJevHarness({ getKey: () => deps.apiKey, askImpl: deps.ask ?? askJev })
  if (!(await hasDecisionEngine('meeting-match', { jev: harness }))) return null
  const { response: res } = await askDecision('meeting-match', state, questions, { jev: harness, recordingId })
  const match = parseMeetingMatch(res, keys, key)
  if (match) deps.save(recordingId, match)
  return match
}

export { JEV_MODEL }
