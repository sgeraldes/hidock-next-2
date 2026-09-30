/**
 * What a Library card says beyond the title: how many actions and key points the analysis found, who
 * took part, what is wrong with the recording, and the one thing the card offers to do about it.
 *
 * Everything here is read from data the list already holds (the transcript, the calendar meeting, the
 * error of the last attempt), so a card costs no extra query. The one exception, the names bound to
 * the speakers of a transcript, is fetched by `useCardPeople`.
 */

import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { LibraryError } from './errorHandling'
import { showsTranscriptProblem, transcriptProblems } from './rowState'

// ---------------------------------------------------------------------------- counts

export interface CardCounts {
  /** Action items the analysis found; null when the transcript was never analysed. */
  actions: number | null
  /** Key points, which the analysis prompt defines as "key points or decisions made"; null likewise. */
  keyPoints: number | null
}

const NO_COUNTS: CardCounts = { actions: null, keyPoints: null }
// Keyed by the transcript object, and checked against the text it parsed, so a transcript changed in place is parsed again.
const countCache = new WeakMap<Transcript, { actions: string | null; keyPoints: string | null; counts: CardCounts }>()

function arrayLength(json: string | null | undefined): number | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((item) => (typeof item === 'string' ? item.trim().length > 0 : item != null)).length
  } catch {
    return null
  }
}

/** The counts of a transcript. Parsed once per transcript object, so scrolling a list does not re-parse. */
export function cardCounts(transcript?: Transcript): CardCounts {
  if (!transcript) return NO_COUNTS
  const cached = countCache.get(transcript)
  if (cached && cached.actions === transcript.action_items && cached.keyPoints === transcript.key_points) return cached.counts
  const counts = { actions: arrayLength(transcript.action_items), keyPoints: arrayLength(transcript.key_points) }
  countCache.set(transcript, { actions: transcript.action_items, keyPoints: transcript.key_points, counts })
  return counts
}

// ---------------------------------------------------------------------------- notice

export interface CardNotice {
  tone: 'error' | 'warning'
  text: string
}

/**
 * What is wrong with the recording, in a sentence for the card: the error of the last attempt, a failed
 * transcription, or the worst problem with the finished transcript. Null when nothing is wrong.
 */
export function cardNotice(recording: UnifiedRecording, transcript?: Transcript, error?: LibraryError): CardNotice | null {
  if (error) {
    return { tone: 'error', text: [error.message, error.details].filter(Boolean).join('. ') }
  }
  if (recording.transcriptionStatus === 'error') {
    return { tone: 'error', text: 'The transcription failed.' }
  }
  if (showsTranscriptProblem(recording, transcript)) {
    const worst = transcriptProblems(recording, transcript)[0]
    return { tone: worst.kind === 'broken' ? 'error' : 'warning', text: [worst.label, worst.detail].filter(Boolean).join('. ') }
  }
  return null
}

// ---------------------------------------------------------------------------- action

export interface CardAction {
  kind: 'download' | 'transcribe'
  label: 'Download' | 'Transcribe' | 'Retry'
  /** True for a retry after an error, so the button reads as part of the notice. */
  retry: boolean
  title: string
}

export interface CardActionContext {
  /** The card has a transcribe handler and the recording is a file on this machine. */
  canTranscribe: boolean
  downloading: boolean
}

const DOWNLOAD_ERRORS = new Set(['download_failed', 'download_interrupted', 'device_disconnected'])

/**
 * The one action the card offers next to its state: retry what failed, or do the next step the
 * recording is waiting for (download it, transcribe it). Null when there is nothing to do or the
 * step is already running.
 */
export function cardAction(recording: UnifiedRecording, error: LibraryError | undefined, ctx: CardActionContext): CardAction | null {
  const status = recording.transcriptionStatus
  const deviceOnly = recording.location === 'device-only'

  if (error && DOWNLOAD_ERRORS.has(error.type) && deviceOnly && !ctx.downloading) {
    return { kind: 'download', label: 'Retry', retry: true, title: 'Try the download again' }
  }
  // Only where there is no good transcript to lose: a finished transcript with an old or unrelated error keeps its
  // notice but gets no button that would run the transcription over it.
  const noTranscript = status === 'none' || status === 'no_speech' || status === 'error'
  if (
    ctx.canTranscribe &&
    !deviceOnly &&
    noTranscript &&
    ((error && (error.type.startsWith('transcription_') || error.type === 'network_error')) || status === 'error')
  ) {
    return { kind: 'transcribe', label: 'Retry', retry: true, title: 'Try the transcription again' }
  }
  if (deviceOnly && !ctx.downloading) {
    return { kind: 'download', label: 'Download', retry: false, title: 'Download to computer' }
  }
  if (ctx.canTranscribe && !deviceOnly && (status === 'none' || status === 'no_speech')) {
    return { kind: 'transcribe', label: 'Transcribe', retry: false, title: 'Transcribe this capture' }
  }
  return null
}

// ---------------------------------------------------------------------------- avatars

/** "Ana Pérez" gives "AP", "sebastian" gives "SE", "ana.perez@dfx5.com" gives "AP". */
export function initialsOf(name: string): string {
  const local = name.includes('@') ? name.split('@')[0] : name
  const words = local.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]
  return letters.toLocaleUpperCase()
}

/** A stable hue (0 to 359) per name, so a person keeps their colour in every card. */
export function hueOf(name: string): number {
  let hash = 0
  for (const ch of name.toLocaleLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 360
}

/** The circle colour of a person: their own hue, full for someone who spoke, muted for someone only invited. */
export function avatarColor(name: string, spoke: boolean): string {
  return spoke ? `hsl(${hueOf(name)} 50% 38%)` : `hsl(${hueOf(name)} 16% 34%)`
}

const fold = (name: string): string[] =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/**
 * Same person: two or more words of the shorter name are all words of the longer ("Ana Pérez" and "Ana Pérez (DFX5)",
 * "Geraldes, Sebastian" and "Sebastián Geraldes"). A single word matches only the same single word: "Carlos" and
 * "Carlos Ruiz" may be two people, and showing both is better than hiding an attendee.
 */
export function sameName(a: string, b: string): boolean {
  const wa = fold(a)
  const wb = fold(b)
  if (wa.length === 0 || wb.length === 0) return false
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (short.length < 2) return short.length === long.length && short[0] === long[0]
  return short.every((w) => long.includes(w))
}

export interface CardPerson {
  key: string
  name: string
  /** True when the person is known to have spoken; false when only invited. */
  spoke: boolean
}

/** Who spoke first, then who was invited and is not among them. Order kept, duplicates dropped. */
export function mergePeople(spoke: readonly string[], invited: readonly string[]): CardPerson[] {
  const people: CardPerson[] = []
  const add = (name: string, didSpeak: boolean) => {
    const clean = name.trim()
    if (!clean || people.some((p) => sameName(p.name, clean))) return
    people.push({ key: `${didSpeak ? 's' : 'i'}:${clean.toLocaleLowerCase()}`, name: clean, spoke: didSpeak })
  }
  spoke.forEach((n) => add(n, true))
  invited.forEach((n) => add(n, false))
  return people
}
