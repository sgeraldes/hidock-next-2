/**
 * What a transcript's own timing says about whether it can be trusted.
 *
 * Transcribers return one start time per line (Gemini returns nothing else).
 * Those times are claims, and many are wrong in ways that can be read straight
 * off the transcript: two lines that start at the same instant, a start that
 * goes back in time, a line with more words than its few seconds could hold,
 * text that runs past the end of the audio, and more words overall than the
 * audio could contain at any speaking pace. Measured on 23-sep-2026 over 2,049
 * transcripts, 924 had repeated starts. The pace limit is the library's own
 * IMPOSSIBLE_WORDS_PER_SECOND, so there is one rule for "nobody speaks that
 * fast" and not two.
 *
 * Each finding becomes a label the Library can filter on. A transcript is
 * 'broken' when its text cannot fit in its audio (it was at least partly
 * invented), 'suspect' when only its timing is wrong, and 'ok' otherwise. The
 * way back to green is a new transcript, which is checked again, or the owner
 * accepting this one as it is.
 *
 * Spec: docs/superpowers/specs/2026-09-23-transcript-integrity-design.md
 */

import { IMPOSSIBLE_WORDS_PER_SECOND } from './value-thresholds'
import {
  CRAMPED_MIN_WORDS,
  CRAMPED_WORDS_PER_SECOND,
  countLineIssues,
  countWords,
  lineIssues
} from '../../../src/shared/transcript-line-issues'

// The per-line rules live in src/shared so the transcript viewer marks exactly
// the lines these counts describe.
export { CRAMPED_MIN_WORDS, CRAMPED_WORDS_PER_SECOND }

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
  /** How many lines show it; 1 for whole-transcript findings. */
  count: number
  /** One sentence the owner can read in a tooltip. */
  detail: string
}

export type IntegrityStatus = 'ok' | 'suspect' | 'broken'

export interface TranscriptIntegrity {
  version: number
  status: IntegrityStatus
  issues: IntegrityIssue[]
  /** Measured audio length used for the checks, null when it was unknown. */
  audioSeconds: number | null
  words: number
  lines: number
}

/**
 * Bumped when the rules change, so stored results are recomputed. 2: edits saved
 * before 28-sep-2026 were never checked again. 3: the transcript is judged
 * against the audio profile too (3-oct-2026).
 */
export const INTEGRITY_VERSION = 3

/** Above this over a whole recording, the text does not fit in the audio. */
export const MAX_WORDS_PER_AUDIO_SECOND = IMPOSSIBLE_WORDS_PER_SECOND
/** Slack for a last line that ends a little after the audio does. */
export const PAST_END_TOLERANCE_SECONDS = 2

/**
 * What the audio profile (audio-profile-store.ts) says about the recording:
 * its category and how many seconds of it hold sound above the loudness line.
 */
export interface IntegrityAudio {
  category: string
  soundSeconds: number | null
}

/** Words a transcript may hold over silent or noise-only audio: a cough read as "sí", not a story. */
export const MAX_WORDS_OVER_NOISE = 19
/**
 * Over this many words per second of measured sound, the text was not heard
 * in this file. Measured on the owner's library (3-oct-2026): speech
 * recordings run 2.8 at the median and 7.6 at p99; soft speech the loudness
 * line undercounts reached 22.5; every recording above 40 had under 30 s of
 * sound in 3 to 96 minutes.
 */
export const MAX_WORDS_PER_SOUND_SECOND = 40
/** Only a transcript this long is judged against its seconds of sound. */
export const MIN_WORDS_FOR_SOUND_CHECK = 100
/** A repeated line counts when it has at least this many words... */
export const REPEATED_LINE_MIN_WORDS = 6
/** ...and appears at least this many times. */
export const REPEATED_LINE_MIN_TIMES = 3
/** Share of all words in repeated lines that makes the transcript a loop. */
export const REPEATED_TEXT_MAX_SHARE = 0.5

function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Share of the transcript's words that sit in long lines repeated word for word. */
function repeatedShare(lines: Line[], totalWords: number): number {
  if (totalWords === 0) return 0
  const counts = new Map<string, number>()
  const keys = lines.map((line) => {
    const key = normalizeLine(line.text)
    if (countWords(key) >= REPEATED_LINE_MIN_WORDS) counts.set(key, (counts.get(key) ?? 0) + 1)
    return key
  })
  let repeated = 0
  for (const key of keys) {
    if ((counts.get(key) ?? 0) >= REPEATED_LINE_MIN_TIMES) repeated += countWords(key)
  }
  return repeated / totalWords
}

/** Findings that mean the text cannot have come from this audio. */
const BROKEN_CODES: ReadonlySet<IntegrityIssueCode> = new Set([
  'too_many_words',
  'text_over_noise',
  'words_beyond_sound',
  'repeated_text'
])

interface Line {
  start: number | null
  end: number | null
  text: string
}

function toLines(speakersJson: string | null | undefined): Line[] {
  if (!speakersJson) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(speakersJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const lines: Line[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const seg = raw as Record<string, unknown>
    const start = typeof seg.start === 'number' && Number.isFinite(seg.start) ? seg.start : null
    const end = typeof seg.end === 'number' && Number.isFinite(seg.end) ? seg.end : null
    lines.push({ start, end, text: typeof seg.text === 'string' ? seg.text : '' })
  }
  return lines
}


function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Check one transcript. `speakersJson` is the stored segment array; the pace of
 * a line runs from its start to the next line's start, because that is the
 * only interval the transcriber actually stated.
 */
export function assessTranscriptIntegrity(
  speakersJson: string | null | undefined,
  audioSeconds: number | null | undefined,
  audioProfile?: IntegrityAudio | null
): TranscriptIntegrity {
  const lines = toLines(speakersJson)
  const audio = typeof audioSeconds === 'number' && audioSeconds > 0 ? audioSeconds : null
  const issues: IntegrityIssue[] = []

  const perLine = lineIssues(lines)
  const counts = countLineIssues(perLine)
  const repeated = counts.repeated_start
  const backwards = counts.backwards_start
  const cramped = counts.cramped_lines
  const untimed = counts.untimed_lines
  let words = 0
  let lastTime = 0
  for (const line of lines) {
    words += countWords(line.text)
    if (line.start !== null) lastTime = Math.max(lastTime, line.start, line.end ?? line.start)
  }

  if (repeated > 0) {
    issues.push({
      code: 'repeated_start',
      count: repeated,
      detail: `${plural(repeated, 'line starts', 'lines start')} at the same instant as another line.`,
    })
  }
  if (backwards > 0) {
    issues.push({
      code: 'backwards_start',
      count: backwards,
      detail: `${plural(backwards, 'line starts', 'lines start')} before the line above it.`,
    })
  }
  if (cramped > 0) {
    issues.push({
      code: 'cramped_lines',
      count: cramped,
      detail: `${plural(cramped, 'line has', 'lines have')} more than ${CRAMPED_WORDS_PER_SECOND} words per second, faster than anyone speaks.`,
    })
  }
  if (untimed > 0) {
    issues.push({
      code: 'untimed_lines',
      count: untimed,
      detail: `${plural(untimed, 'line has', 'lines have')} no time at all.`,
    })
  }
  if (audio !== null && lastTime > audio + PAST_END_TOLERANCE_SECONDS) {
    issues.push({
      code: 'past_audio_end',
      count: 1,
      detail: `The transcript runs to ${formatClock(lastTime)}, but the audio ends at ${formatClock(audio)}.`,
    })
  }
  if (audio !== null && words / audio > MAX_WORDS_PER_AUDIO_SECOND) {
    issues.push({
      code: 'too_many_words',
      count: 1,
      detail:
        `${words} words in ${formatClock(audio)} of audio is ${(words / audio).toFixed(1)} words per second; ` +
        'the text does not fit in the recording, so part of it was not heard there.',
    })
  }

  if (audioProfile && (audioProfile.category === 'silent' || audioProfile.category === 'noise') && words > MAX_WORDS_OVER_NOISE) {
    issues.push({
      code: 'text_over_noise',
      count: 1,
      detail:
        `${words} words over audio that is ${audioProfile.category === 'silent' ? 'silent' : 'only noise'}; ` +
        'the transcriber invented this text.',
    })
  }
  const soundSeconds = audioProfile?.soundSeconds
  if (
    audioProfile &&
    audioProfile.category === 'speech' &&
    typeof soundSeconds === 'number' &&
    words >= MIN_WORDS_FOR_SOUND_CHECK &&
    words / Math.max(soundSeconds, 1) > MAX_WORDS_PER_SOUND_SECOND
  ) {
    issues.push({
      code: 'words_beyond_sound',
      count: 1,
      detail:
        `${words} words, but only ${formatClock(soundSeconds)} of the audio holds sound; ` +
        'most of the text was not heard in this recording.',
    })
  }
  const loop = repeatedShare(lines, words)
  if (loop >= REPEATED_TEXT_MAX_SHARE) {
    issues.push({
      code: 'repeated_text',
      count: 1,
      detail: `${Math.round(loop * 100)}% of the words are the same lines repeated over and over.`,
    })
  }

  const status: IntegrityStatus = issues.some((i) => BROKEN_CODES.has(i.code))
    ? 'broken'
    : issues.length > 0
      ? 'suspect'
      : 'ok'
  return { version: INTEGRITY_VERSION, status, issues, audioSeconds: audio, words, lines: lines.length }
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
