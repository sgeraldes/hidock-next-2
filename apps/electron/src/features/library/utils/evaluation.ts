/**
 * Labels and filters for the Jev evaluation (recording_evaluations, v61).
 *
 * Each recording's single Jev pass stores stars (1 to 5), a kind, work or
 * personal, and an audio-versus-transcript warning. The Library shows the
 * stars and the kind on the row and filters on kind, context, stars and
 * warnings. Undefined means the recording has not been evaluated yet.
 */

import type { AudioWarning, RecordingContext, RecordingKind } from '@/types/unified-recording'

export type { AudioWarning, RecordingContext, RecordingKind }

export const KIND_LABELS: Record<RecordingKind, string> = {
  interview: 'Interview',
  team_meeting: 'Team meeting',
  project_meeting: 'Project meeting',
  one_on_one: 'One-on-one',
  sales_support_call: 'Sales or support call',
  presentation_class: 'Class or presentation',
  personal_call: 'Personal call',
  gaming_entertainment: 'Gaming',
  media_playback: 'Media playing',
  device_test: 'Device test',
  noise_accidental: 'Noise or accidental'
}

export const CONTEXT_LABELS: Record<RecordingContext, string> = {
  work: 'Work',
  personal: 'Personal',
  mixed: 'Work and personal',
  unclear: 'Unclear'
}

export const WARNING_LABELS: Record<AudioWarning, { label: string; detail: string }> = {
  possible_invented_transcript: {
    label: 'Transcript may be invented',
    detail: 'The audio holds little or no sound, but the transcript is long or meaningful.'
  },
  possible_missed_transcription: {
    label: 'Transcription may be missing',
    detail: 'The audio holds a lot of sound, but the transcript has almost no words.'
  }
}

export type KindFilter = RecordingKind | 'unevaluated'
export type ContextFilter = RecordingContext
export type StarsFilter = '1' | '2' | '3' | '4' | '5' | '4plus' | '2minus'
export type WarningFilter = 'any' | AudioWarning

export const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  ...(Object.keys(KIND_LABELS) as RecordingKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] })),
  { value: 'unevaluated', label: 'Not evaluated yet' }
]

export const CONTEXT_FILTERS: { value: ContextFilter; label: string }[] = (
  Object.keys(CONTEXT_LABELS) as RecordingContext[]
).map((c) => ({ value: c, label: CONTEXT_LABELS[c] }))

export const STARS_FILTERS: { value: StarsFilter; label: string }[] = [
  { value: '4plus', label: '4 or 5 stars' },
  { value: '5', label: '5 stars' },
  { value: '4', label: '4 stars' },
  { value: '3', label: '3 stars' },
  { value: '2', label: '2 stars' },
  { value: '1', label: '1 star' },
  { value: '2minus', label: '1 or 2 stars' }
]

export const WARNING_FILTERS: { value: WarningFilter; label: string }[] = [
  { value: 'any', label: 'Any warning' },
  { value: 'possible_invented_transcript', label: WARNING_LABELS.possible_invented_transcript.label },
  { value: 'possible_missed_transcription', label: WARNING_LABELS.possible_missed_transcription.label }
]

const has = <T extends string>(list: { value: T }[], value: string): value is T => list.some((f) => f.value === value)
export const isKindFilter = (v: string): v is KindFilter => has(KIND_FILTERS, v)
export const isContextFilter = (v: string): v is ContextFilter => has(CONTEXT_FILTERS, v)
export const isStarsFilter = (v: string): v is StarsFilter => has(STARS_FILTERS, v)
export const isWarningFilter = (v: string): v is WarningFilter => has(WARNING_FILTERS, v)

/**
 * Stars and kind as the Library shows them. The main process caps a silent,
 * noise-only or too-short recording at one star and "Noise or accidental"
 * (stored evaluations are recomputed when the audio profile changes); the
 * renderer applies the same cap so an evaluation older than its audio profile
 * can never put "5★" next to "Noise only" (owner, 3-oct-2026).
 */
export function displayedEvaluation(r: {
  evalStarLevel?: number | null
  evalKind?: RecordingKind | null
  evalContext?: RecordingContext | null
  audioCategory?: string | null
}): { stars: number | null; kind: RecordingKind | null; context: RecordingContext | null } {
  if (r.audioCategory === 'silent' || r.audioCategory === 'noise' || r.audioCategory === 'too_short') {
    return { stars: 1, kind: 'noise_accidental', context: 'unclear' }
  }
  return { stars: r.evalStarLevel ?? null, kind: r.evalKind ?? null, context: r.evalContext ?? null }
}

export interface EvaluationFields {
  evalStarLevel?: number
  evalKind?: RecordingKind
  evalContext?: RecordingContext
  evalAudioWarning?: AudioWarning
}

/**
 * The warning a row shows: the stored audio-against-text rule result. Jev's
 * own "invented" answer is no warning: an LLM reading only text cannot tell
 * invented text (owner, 4-oct-2026).
 */
export function effectiveWarning(r: EvaluationFields): AudioWarning | null {
  return r.evalAudioWarning ?? null
}

export function matchesKindFilter(r: EvaluationFields, filter: KindFilter): boolean {
  return filter === 'unevaluated' ? !r.evalKind : r.evalKind === filter
}

export function matchesContextFilter(r: EvaluationFields, filter: ContextFilter): boolean {
  return r.evalContext === filter
}

export function matchesStarsFilter(r: EvaluationFields, filter: StarsFilter): boolean {
  const s = r.evalStarLevel
  if (!s) return false
  if (filter === '4plus') return s >= 4
  if (filter === '2minus') return s <= 2
  return s === Number(filter)
}

export function matchesWarningFilter(r: EvaluationFields, filter: WarningFilter): boolean {
  const w = effectiveWarning(r)
  return filter === 'any' ? w !== null : w === filter
}
