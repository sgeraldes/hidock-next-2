/**
 * Timing review of one transcript: lines out of time order, sections whose
 * times shifted, lines written twice, what the audio says about each, and the
 * owner's reversible fixes. Shared by the main process and the reader.
 */

export interface TimingSegment {
  start: number
  end?: number
  text: string
  speaker?: string
  /** Kept in the stored lines, left out of the text, search and checks. */
  timingHidden?: boolean
  /** The transcriber's own times, kept when the owner fixes them, so the fix can be undone. */
  timingOriginalStart?: number
  timingOriginalEnd?: number
  timingReviewed?: boolean
  /** How Fix times placed this line; absent on fixes made before it was recorded. */
  timingFixMethod?: TimingFixMethod
  /** A line written by "Transcribe this section again"; the id of that run. */
  sectionRunId?: string
  /** An old line that a section transcription replaced; hidden until that run is undone. */
  sectionReplacedBy?: string
}

/**
 * Lines this close to where their neighbours place them are two people
 * talking at once, not a misplaced section. Measured on the owner's library
 * (25-nov-2026): 144 of 189 single lines and 280 of 493 sections flagged out
 * of order were under 2 s off; a new transcription is not offered for them.
 */
export const OVERLAP_SECONDS = 2

/**
 * How Fix times placed the lines: on the words Parakeet heard on the model host,
 * or on this computer from the VAD's speech stretches, the stored loudness
 * envelope, or loudness decoded from the audio there and then.
 */
export type TimingFixMethod = 'model-host-words' | 'vad' | 'envelope' | 'decoded'

export const TIMING_FIX_METHOD_LABELS: Record<TimingFixMethod, string> = {
  'model-host-words': 'from the words Parakeet heard on the model host',
  vad: 'from the speech stretches on this computer',
  envelope: 'from the loudness of the audio on this computer',
  decoded: 'from the loudness of the audio on this computer'
}

export type TimingFindingKind = 'odd_line' | 'mistimed_run' | 'duplicate'

export type TimingClassification = 'out_of_place' | 'probable_hallucination' | 'unsure' | 'duplicate'

/** What "Fix times" would do for a finding, computed before the owner clicks. */
export interface TimingFixPreview {
  ok: boolean
  /** 0..1, how well the words fit the speech between the lines around the range. */
  confidence: number
  /** Where the first line would start. */
  firstStart: number | null
  /** Why it cannot be fixed from the sound, when ok is false. */
  reason: string
  /**
   * Whether a new transcription of the section is worth offering. Not for a
   * line a second or two off, which is two people talking at once.
   */
  offerSection: boolean
  /** Seconds between where the transcript puts the lines and where the lines around them say they belong. */
  displacement: number
  /**
   * Whether Fix times may send this range's audio to the model host: where it
   * belongs is known and no line holds turns with their own times.
   */
  hostEligible?: boolean
}

export interface TimingFinding {
  /** Stable for one transcript version: `${kind}:${from}-${to}`. */
  id: string
  kind: TimingFindingKind
  /** First source line, kept for callers that jump to one line. */
  index: number
  /** Source line range, inclusive. */
  from: number
  to: number
  /** The flagged lines: out of order (odd line, section) or the later copy (duplicate). */
  lines: number[]
  /** For a duplicate: the first copy, which stays. */
  originals?: number[]
  claimedStart: number
  claimedEnd: number
  /** Where the lines around the range say it belongs, seconds; null when unknown. */
  windowStart: number | null
  windowEnd: number | null
  impliedStart: number | null
  suggestedStart: number | null
  classification: TimingClassification
  /** Sound where the transcript puts the lines, and where the lines around them say they belong. */
  claimedAudio: boolean | null
  impliedAudio: boolean | null
  detail: string
  fix?: TimingFixPreview
}

export interface TimingFixedRange {
  from: number
  to: number
  /** How these lines were placed; absent on fixes made before it was recorded. */
  method?: TimingFixMethod
}

export interface TimingSectionRun {
  runId: string
  /** Lines the section transcription wrote, inclusive source range. */
  from: number
  to: number
}

export interface TimingAssessment {
  fingerprint: string
  findings: TimingFinding[]
  hiddenIndices: number[]
  /** Consecutive lines whose times were fixed and can be put back. */
  fixedRanges: TimingFixedRange[]
  /** Sections written again by a transcription, which can be undone. */
  sectionRuns: TimingSectionRun[]
  reviewed: boolean
  /** Where the speech evidence came from; null when no audio evidence exists. */
  evidence: 'vad' | 'envelope' | 'decoded' | null
  /** A paired model host offers Parakeet word alignment now (its health answer, cached for 15 s). */
  wordAlignment?: boolean
}

export type TimingReviewAction = 'fix_times' | 'undo_fix' | 'hide' | 'show' | 'undo_section'

export const TIMING_CLASSIFICATION_LABELS: Record<TimingClassification, string> = {
  out_of_place: 'Out of place',
  probable_hallucination: 'Probable hallucination',
  unsure: 'Unsure',
  duplicate: 'Written twice'
}

export const TIMING_KIND_LABELS: Record<TimingFindingKind, string> = {
  odd_line: 'Line out of order',
  mistimed_run: 'Section out of order',
  duplicate: 'Written twice'
}
