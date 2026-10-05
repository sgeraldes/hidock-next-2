/**
 * Renderer side of the transcript integrity check: what a stored verdict means
 * for the Library, in words and as a filter.
 *
 * The verdict is computed in the main process (services/transcript-integrity.ts)
 * and stored on the transcript row. A flagged transcript leaves that state one
 * of two ways: a new transcription that checks clean, or the owner accepting it.
 */

import type { Transcript } from '@/types'
import { heldValidity, VALIDITY_LABELS, type HeldValidity } from './transcriptValidity'

export type IntegrityIssueCode =
  | 'repeated_start'
  | 'backwards_start'
  | 'cramped_lines'
  | 'past_audio_end'
  | 'too_many_words'
  | 'untimed_lines'
  | 'text_over_noise'
  | 'words_beyond_sound'
  | 'repeated_text'

export interface IntegrityIssue {
  code: IntegrityIssueCode
  count: number
  detail: string
}

/** What the Library shows. 'accepted' is green: the owner looked and kept it. */
export type IntegrityLabel = 'ok' | 'suspect' | 'broken' | 'accepted' | 'unchecked'

/** Short tag names, one per finding. */
export const ISSUE_TAGS: Record<IntegrityIssueCode, string> = {
  text_over_noise: 'Text over noise',
  words_beyond_sound: 'More words than sound',
  repeated_text: 'Looping text',
  too_many_words: 'Text does not fit the audio',
  past_audio_end: 'Runs past the audio',
  repeated_start: 'Repeated times',
  backwards_start: 'Times go backwards',
  cramped_lines: 'Impossible pace',
  untimed_lines: 'Lines without time',
}

export const ISSUE_ORDER: IntegrityIssueCode[] = [
  'text_over_noise',
  'words_beyond_sound',
  'repeated_text',
  'too_many_words',
  'past_audio_end',
  'repeated_start',
  'backwards_start',
  'cramped_lines',
  'untimed_lines',
]

type IntegrityFields = Pick<Transcript, 'integrity_status' | 'integrity_json' | 'integrity_accepted_at' | 'validity_status'>

export function integrityLabel(transcript: IntegrityFields | null | undefined): IntegrityLabel {
  if (transcript?.integrity_accepted_at) return 'accepted'
  const status = transcript?.integrity_status
  if (!status) return 'unchecked'
  if (status === 'ok') return 'ok'
  return status === 'broken' ? 'broken' : 'suspect'
}

/** Validity verdicts on which nothing may be built (services/transcript-validity.ts). */
const UNUSABLE_VALIDITY = new Set(['invalid', 'incomplete', 'doubtful'])

/**
 * Whether anything may be built on this transcript (summary, actions, search).
 * Mirrors isTranscriptUntrusted in the main process: broken and not accepted
 * by the owner, or a validity verdict of invalid, in doubt or incomplete
 * (owner, 4-oct-2026: a doubtful transcript shows nothing derived from it).
 * An unchecked transcript is trusted.
 */
export function isTranscriptTrusted(transcript: IntegrityFields | null | undefined): boolean {
  if (integrityLabel(transcript) === 'broken') return false
  return !UNUSABLE_VALIDITY.has(transcript?.validity_status ?? '')
}

type TrustFields = Partial<IntegrityFields>

/**
 * The summary to show, or null when there is none, the transcript is not
 * trusted, or the audio holds no speech (silent, noise only, too short): a
 * summary of text the transcriber invented is itself invented, and three words
 * read over a crackle make no summary either.
 */
export function trustedSummary(
  transcript: (TrustFields & { summary?: string | null }) | null | undefined,
  audioCategory?: string | null
): string | null {
  const summary = transcript?.summary?.trim()
  if (!summary) return null
  if (audioCategory === 'silent' || audioCategory === 'noise' || audioCategory === 'too_short') return null
  return isTranscriptTrusted(transcript as IntegrityFields) ? summary : null
}

/** Shown where a summary would be, when the transcript is not trusted. */
export const UNTRUSTED_SUMMARY_NOTE = 'No summary: the transcript does not match the audio.'

/** The note for a summary held back, in the words of the transcript's verdict. */
export function untrustedSummaryNote(transcript: Partial<IntegrityFields> | null | undefined): string {
  if (integrityLabel(transcript as IntegrityFields) === 'broken') return UNTRUSTED_SUMMARY_NOTE
  if (transcript?.validity_status === 'doubtful') return 'No summary: the transcript is in doubt until it is checked against the audio.'
  if (transcript?.validity_status === 'incomplete') return 'No summary: the transcript stops before the speech in the audio ends.'
  return UNTRUSTED_SUMMARY_NOTE
}

export function integrityIssues(transcript: IntegrityFields | null | undefined): IntegrityIssue[] {
  if (!transcript?.integrity_json) return []
  try {
    const parsed = JSON.parse(transcript.integrity_json) as { issues?: unknown }
    if (!Array.isArray(parsed.issues)) return []
    return parsed.issues
      .filter(
        (i): i is IntegrityIssue =>
          !!i && typeof i === 'object' && typeof (i as IntegrityIssue).code === 'string' &&
          (i as IntegrityIssue).code in ISSUE_TAGS
      )
      .sort((a, b) => ISSUE_ORDER.indexOf(a.code) - ISSUE_ORDER.indexOf(b.code))
  } catch {
    return []
  }
}

/**
 * Library filter values: 'flagged' (anything not green), 'broken', 'accepted',
 * one finding as `issue:<code>`, or one validity verdict as `validity:<status>`
 * (in doubt, not categorized, incomplete). A finding filter matches flagged
 * transcripts only: an accepted one has been dealt with.
 */
export type IntegrityFilter = 'flagged' | 'broken' | 'accepted' | `issue:${IntegrityIssueCode}` | `validity:${HeldValidity}`

export const VALIDITY_FILTER_ORDER: HeldValidity[] = ['invalid', 'incomplete', 'doubtful']

export function matchesIntegrityFilter(
  transcript: IntegrityFields | null | undefined,
  filter: IntegrityFilter | null
): boolean {
  if (filter === null) return true
  if (filter.startsWith('validity:')) return heldValidity(transcript) === filter.slice('validity:'.length)
  const label = integrityLabel(transcript)
  if (filter === 'flagged') return label === 'suspect' || label === 'broken' || heldValidity(transcript) !== null
  if (filter === 'broken') return label === 'broken'
  if (filter === 'accepted') return label === 'accepted'
  if (label !== 'suspect' && label !== 'broken') return false
  const code = filter.slice('issue:'.length)
  return integrityIssues(transcript).some((i) => i.code === code)
}

export function integrityFilterLabel(filter: IntegrityFilter): string {
  if (filter === 'flagged') return 'Transcription problems'
  if (filter === 'broken') return 'Text does not fit the audio'
  if (filter === 'accepted') return 'Accepted as is'
  if (filter.startsWith('validity:')) return VALIDITY_LABELS[filter.slice('validity:'.length) as HeldValidity]?.chip ?? filter
  return ISSUE_TAGS[filter.slice('issue:'.length) as IntegrityIssueCode] ?? filter
}

export function isIntegrityFilter(value: string): value is IntegrityFilter {
  if (value === 'flagged' || value === 'broken' || value === 'accepted') return true
  if (value.startsWith('validity:')) return (VALIDITY_FILTER_ORDER as string[]).includes(value.slice('validity:'.length))
  return value.startsWith('issue:') && value.slice('issue:'.length) in ISSUE_TAGS
}
