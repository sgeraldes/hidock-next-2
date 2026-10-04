/**
 * What the two state places of a Library row show, and how the list sorts by them.
 *
 * A row has three fixed icon places on the right: the calendar meeting, the
 * status of the file (where it is, or a processing error) and the state of the
 * transcript (transcribed, or a problem with it). A problem takes the place of
 * the thing it is a problem with (owner, 30-sep-2026): a processing error
 * replaces the location icon, a transcript warning replaces the transcription
 * icon. The tooltip of the icon in the place says both.
 */

import type { Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import { WARNING_LABELS, effectiveWarning } from './evaluation'
import { ISSUE_TAGS, integrityIssues, integrityLabel } from './transcriptIntegrity'
import { VALIDITY_LABELS, heldValidity, validityReasons } from './transcriptValidity'

export type TranscriptProblemKind = 'broken' | 'invalid' | 'incomplete' | 'invented' | 'missed' | 'doubtful' | 'suspect'

export interface TranscriptProblem {
  kind: TranscriptProblemKind
  label: string
  detail: string
}

/** Worst first, so the icon shows the most serious problem and the tooltip lists the rest. */
export function transcriptProblems(recording: UnifiedRecording, transcript?: Transcript): TranscriptProblem[] {
  const problems: TranscriptProblem[] = []
  const integrity = integrityLabel(transcript)
  const tags = integrityIssues(transcript).map((i) => ISSUE_TAGS[i.code]).join(' · ')
  if (integrity === 'broken') {
    problems.push({ kind: 'broken', label: 'Transcript does not fit the audio', detail: tags })
  }
  // The validity verdict (owner, 4-oct-2026); broken already says "invalid".
  const held = integrity === 'broken' ? null : heldValidity(transcript)
  if (held === 'invalid' || held === 'incomplete') {
    problems.push({ kind: held, label: VALIDITY_LABELS[held].label, detail: validityReasons(transcript).join(' · ') })
  }
  const warning = effectiveWarning(recording)
  if (warning) {
    const { label, detail } = WARNING_LABELS[warning]
    problems.push({ kind: warning === 'possible_invented_transcript' ? 'invented' : 'missed', label, detail })
  }
  if (held === 'doubtful') {
    problems.push({ kind: 'doubtful', label: VALIDITY_LABELS.doubtful.label, detail: validityReasons(transcript).join(' · ') })
  }
  if (integrity === 'suspect') {
    problems.push({ kind: 'suspect', label: 'Transcript timing is wrong', detail: tags })
  }
  return problems
}

/**
 * Whether the transcription place shows a problem instead of the state. A run in
 * flight or a failed run says what is happening now, so it stays; a finished
 * transcript that has a problem shows the problem.
 */
export function showsTranscriptProblem(recording: UnifiedRecording, transcript?: Transcript): boolean {
  const status = recording.transcriptionStatus
  if (status === 'pending' || status === 'processing' || status === 'error') return false
  return transcriptProblems(recording, transcript).length > 0
}

/**
 * Sort rank of the transcription place, lowest first: failed, then a transcript
 * with a problem, then in flight, queued, not transcribed, no speech, transcribed.
 * Ascending puts what needs a look at the top.
 */
export function transcriptionRank(recording: UnifiedRecording, transcript?: Transcript): number {
  const status = recording.transcriptionStatus
  if (status === 'error') return 0
  if (showsTranscriptProblem(recording, transcript)) return 1
  switch (status) {
    case 'processing':
      return 2
    case 'pending':
      return 3
    case 'none':
      return 4
    case 'no_speech':
      return 5
    default:
      return 6
  }
}

/**
 * Sort rank of the status place, lowest first: a processing error, then only on
 * the device, then only on the computer, then on both.
 */
export function statusRank(recording: UnifiedRecording, hasError: boolean): number {
  if (hasError) return 0
  switch (recording.location) {
    case 'device-only':
      return 1
    case 'local-only':
      return 2
    default:
      return 3
  }
}
