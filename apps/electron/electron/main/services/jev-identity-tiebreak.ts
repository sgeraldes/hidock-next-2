/**
 * Jev breaks an identity tie (spec 2026-10-03, 3a.4 and 3b; owner decision 3-oct-2026: Jev
 * chooses only among candidates an objective signal already supports, and its choice applies
 * only when that signal exists).
 *
 * Two questions, both `choice`:
 *   - mention: which of the supported candidates a shared first name means in one recording,
 *     read from the turns that mention the name and the meeting's attendees;
 *   - merge: whether two contacts with similar names are the same person, read from their
 *     names, emails, roles and the meetings they share.
 * An answer counts only when Jev is sure (TIEBREAK_MIN_PROBABILITY) and clearly ahead of the
 * next option (TIEBREAK_MIN_MARGIN), the same lines as naming speakers. Pure module: the caller
 * (identity-rules.ts) asks Jev and writes through the existing writers.
 */
import type { JevQuestion, JevResponse, JevStructured } from './jev-client'
import { SPEAKER_NAME_MIN_MARGIN, SPEAKER_NAME_MIN_PROBABILITY } from './jev-speaker-names'

export const TIEBREAK_MIN_PROBABILITY = SPEAKER_NAME_MIN_PROBABILITY
export const TIEBREAK_MIN_MARGIN = SPEAKER_NAME_MIN_MARGIN
/** Words of transcript Jev reads for one mention, at most. */
export const MAX_MENTION_WORDS = 2000
const NONE_KEY = 'none'
const QUESTION_KEY = 'who'

export interface Turn {
  speaker: string
  text: string
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * The turns that say the name (accent and case folded, as a whole word), as "speaker: text",
 * in order, until MAX_MENTION_WORDS words. A turn that would pass the cap is cut at it.
 */
export function mentionTurns(turns: Turn[], name: string, maxWords = MAX_MENTION_WORDS): string[] {
  const token = fold(name.trim().split(/\s+/)[0] ?? '')
  if (!token) return []
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u')
  const out: string[] = []
  let words = 0
  for (const turn of turns) {
    const text = String(turn.text ?? '').trim()
    if (!text || !word.test(fold(text))) continue
    const tokens = text.split(/\s+/)
    const room = maxWords - words
    if (room <= 0) break
    out.push(`${turn.speaker}: ${tokens.slice(0, room).join(' ')}`)
    words += Math.min(tokens.length, room)
  }
  return out
}

export interface MentionCandidate {
  id: string
  name: string
  /** Why this candidate has objective support here ("attended the meeting", "voice in the recording"). */
  support: string[]
}

export interface MentionTiebreakRequest {
  state: JevStructured
  questions: Record<string, JevQuestion>
  /** option key -> contact id */
  options: Map<string, string>
}

export function buildMentionTiebreakRequest(input: {
  name: string
  meetingSubject: string | null
  attendees: string[]
  turns: string[]
  candidates: MentionCandidate[]
}): MentionTiebreakRequest | null {
  // Jev chooses only among candidates an objective signal supports (owner, 3-oct-2026).
  const supported = input.candidates.filter((c) => c.support.length > 0)
  if (supported.length < 2 || input.turns.length === 0) return null
  const options = new Map<string, string>()
  const criteria: Record<string, JevStructured> = {}
  supported.forEach((c, i) => {
    const key = `c${i + 1}`
    options.set(key, c.id)
    criteria[key] = `${c.name} (${c.support.join(', ')})`
  })
  criteria[NONE_KEY] = 'None of these people, or the transcript does not show which one.'
  const questions: Record<string, JevQuestion> = {
    [QUESTION_KEY]: {
      type: 'choice',
      instructions:
        `Who is "${input.name}" in this meeting? Decide from the turns in \`turns\` that say the name and from ` +
        '`attendees`. Every option attended the meeting or speaks in the recording. Answer `none` when the ' +
        'turns do not show which person it is.',
      criteria
    }
  }
  const state: JevStructured = {
    name: input.name,
    meeting: input.meetingSubject,
    attendees: input.attendees,
    turns: input.turns
  }
  return { state, questions, options }
}

export interface TiebreakAnswer {
  /** The chosen contact when Jev is sure and clear; null otherwise (and for "none"). */
  contactId: string | null
  probability: number
  margin: number
  /** contact id -> probability, plus "none". */
  probabilities: Record<string, number>
}

function ranked(res: JevResponse): { probabilities: Record<string, number>; top: [string, number]; margin: number } | null {
  const answer = res.answers?.[QUESTION_KEY]
  if (!answer || answer.type !== 'choice') return null
  const entries = Object.entries(answer.probabilities ?? {})
    .filter(([, p]) => Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const top = entries[0]
  return { probabilities: Object.fromEntries(entries), top, margin: top[1] - (entries[1]?.[1] ?? 0) }
}

export function parseMentionTiebreak(res: JevResponse, req: MentionTiebreakRequest): TiebreakAnswer | null {
  const r = ranked(res)
  if (!r) return null
  const probabilities: Record<string, number> = {}
  for (const [key, p] of Object.entries(r.probabilities)) probabilities[req.options.get(key) ?? key] = p
  const chosen = req.options.get(r.top[0]) ?? null
  const sure = r.top[1] >= TIEBREAK_MIN_PROBABILITY && r.margin >= TIEBREAK_MIN_MARGIN
  return { contactId: sure ? chosen : null, probability: r.top[1], margin: r.margin, probabilities }
}

export interface MergePerson {
  name: string
  email: string | null
  role: string | null
}

export function buildMergeTiebreakRequest(input: {
  a: MergePerson
  b: MergePerson
  sharedMeetings: string[]
  sameDomain: boolean
}): { state: JevStructured; questions: Record<string, JevQuestion> } {
  return {
    state: {
      first: input.a,
      second: input.b,
      meetingsTogether: input.sharedMeetings,
      sameEmailDomain: input.sameDomain
    },
    questions: {
      [QUESTION_KEY]: {
        type: 'choice',
        instructions:
          'Are `first` and `second` the same person, written two ways (a nickname, a short name, a typo)? ' +
          'They share the meetings in `meetingsTogether`; two different people can also share meetings.',
        criteria: {
          same: 'The same person (one is a short form, nickname or misspelling of the other).',
          different: 'Two different people.',
          [NONE_KEY]: 'Cannot tell from this.'
        }
      }
    }
  }
}

/** True when Jev is sure and clear that the two are the same person. */
export function parseMergeTiebreak(res: JevResponse): { same: boolean; probability: number; margin: number; probabilities: Record<string, number> } | null {
  const r = ranked(res)
  if (!r) return null
  const same = r.top[0] === 'same' && r.top[1] >= TIEBREAK_MIN_PROBABILITY && r.margin >= TIEBREAK_MIN_MARGIN
  return { same, probability: r.top[1], margin: r.margin, probabilities: r.probabilities }
}
