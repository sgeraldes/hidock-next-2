import { AlertCircle, AlertTriangle, Ban, Calendar, FileWarning, FileX, TrendingDown, XOctagon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime } from '@/lib/utils'
import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { LibraryError } from '@/features/library/utils/errorHandling'
import { CONTEXT_LABELS, KIND_LABELS } from '@/features/library/utils/evaluation'
import { audioLabel } from '@/features/library/utils/audioCheck'
import { formatValueReasons } from '@/features/library/utils/valueReasons'
import { transcriptProblems, showsTranscriptProblem, type TranscriptProblemKind } from '@/features/library/utils/rowState'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { StatusIcon } from './StatusIcon'
import { TranscriptionStatusBadge, TRANSCRIPTION_STATUS_LABELS } from './TranscriptionStatusBadge'

/**
 * The pieces a Library row and a Library card share: the chips (value, audio
 * check, stars and kind) and the three icon places (calendar meeting, status of
 * the file, state of the transcript).
 *
 * Every piece renders inside a `TooltipProvider` its caller mounts once
 * (/simplify S-6 — one provider per row, not one per tooltip consumer).
 */

/**
 * Icon-only value badge, rendered only for low-value/garbage (never
 * valuable/archived/unrated). No text label, so a title always truncates before
 * the chips can grow.
 */
export function ValueBadge({ recording }: { recording: UnifiedRecording }) {
  if (recording.quality !== 'low-value' && recording.quality !== 'garbage') return null

  const isGarbage = recording.quality === 'garbage'
  const Icon = isGarbage ? Ban : TrendingDown
  const label = isGarbage ? 'Garbage' : 'Low value'
  const reasonsText = formatValueReasons(recording.qualityReasons)
  const secondLine = reasonsText || (recording.qualitySource === 'user' ? 'Set by you' : 'AI-assessed')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex shrink-0 ${isGarbage ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
          role="img"
          aria-label={label}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{secondLine}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Jev evaluation (v61): stars and the kind of recording, e.g. "4★ Team meeting".
 * Muted: it describes the recording, it does not warn. The tooltip adds the
 * context (work, personal).
 */
export function EvaluationLabel({ recording }: { recording: UnifiedRecording }) {
  if (!recording.evalStarLevel && !recording.evalKind) return null
  const kind = recording.evalKind ? KIND_LABELS[recording.evalKind] : null
  const context = recording.evalContext ? CONTEXT_LABELS[recording.evalContext] : null
  const stars = recording.evalStarLevel ?? null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex min-w-[2.75rem] max-w-max flex-1 basis-[2.75rem] items-center gap-1 rounded border border-border px-1.5 py-px text-[10px] leading-4 text-muted-foreground"
          data-testid="evaluation-label"
          aria-label={[stars ? `${stars} of 5 stars` : null, kind, context].filter(Boolean).join(', ')}
        >
          {stars && <span className="shrink-0 font-medium tabular-nums">{stars}★</span>}
          {kind && <span className="truncate">{kind}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{[stars ? `${stars} of 5 stars` : null, kind, context].filter(Boolean).join(' · ')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Audio check label, in words: "Silent", "Noise only", "Too short". Shown
 * whenever the audio holds no usable sound, whatever the transcript says.
 */
export function AudioLabel({ recording }: { recording: UnifiedRecording }) {
  const found = audioLabel(recording.audioCategory)
  if (!found) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center rounded border border-red-500/40 bg-red-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-red-700 dark:text-red-300"
          data-testid="audio-label"
        >
          {found.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{found.detail}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Class of the box that holds the chips of a recording: one line high, wrapping, so a chip that does
 * not fit is left out whole instead of being cut in half.
 */
export const CHIPS_BOX_CLASS = 'flex h-5 min-w-0 flex-wrap content-start items-center gap-1 overflow-hidden'

/** The chips of a recording, in one run: value, audio check, stars and kind. */
export function RowChips({ recording }: { recording: UnifiedRecording }) {
  return (
    <>
      <ValueBadge recording={recording} />
      <AudioLabel recording={recording} />
      <EvaluationLabel recording={recording} />
    </>
  )
}

/** Calendar icon of a recording linked to a meeting; nothing otherwise. */
export function MeetingIcon({ meeting }: { meeting?: Meeting }) {
  if (!meeting) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 text-primary/70"
          role="img"
          aria-label={`Linked to calendar meeting: ${meeting.subject}`}
        >
          <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>Linked to calendar meeting</p>
        <p className="text-xs text-muted-foreground mt-0.5">{formatDateTime(meeting.start_time)}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The status place: where the file is (on the device, downloaded, both), or a
 * processing error when the last attempt on it failed. The error takes the
 * place of the location icon instead of getting a place of its own.
 */
export function StatusPlaceIcon({ recording, error }: { recording: UnifiedRecording; error?: LibraryError }) {
  if (!error) return <StatusIcon recording={recording} />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 text-destructive" role="img" aria-label="Processing error" data-testid="processing-error">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{error.message}</p>
        {error.details && <p className="text-xs text-muted-foreground mt-1">{error.details}</p>}
      </TooltipContent>
    </Tooltip>
  )
}

const PROBLEM_ICON: Record<TranscriptProblemKind, typeof XOctagon> = {
  broken: XOctagon,
  invented: FileWarning,
  missed: FileX,
  suspect: AlertTriangle
}

/**
 * The transcription place: the state of the transcription, or the worst problem
 * with the finished transcript (timing that is wrong, text that does not fit
 * the audio, text that may be invented or missing). The problem takes the place
 * of the state; the tooltip lists every problem and still says the state.
 */
export function TranscriptionPlaceIcon({ recording, transcript }: { recording: UnifiedRecording; transcript?: Transcript }) {
  // Subscribed, so a changed Settings > Quality checks threshold redraws the row.
  useConfigStore((s) => s.config?.quality?.inventedProbability)
  if (!showsTranscriptProblem(recording, transcript)) {
    return <TranscriptionStatusBadge status={recording.transcriptionStatus} compact />
  }
  const problems = transcriptProblems(recording, transcript)
  const worst = problems[0]
  const Icon = PROBLEM_ICON[worst.kind]
  const red = worst.kind === 'broken'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex shrink-0 ${red ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
          role="img"
          aria-label={problems.map((p) => p.label).join(', ')}
          data-testid="transcript-problem"
          data-kind={worst.kind}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {problems.map((p) => (
          <div key={p.kind} className="mb-1 last:mb-0">
            <p>{p.label}</p>
            {p.detail && <p className="text-xs text-muted-foreground mt-0.5">{p.detail}</p>}
          </div>
        ))}
        <p className="text-xs text-muted-foreground mt-1">
          Transcription: {TRANSCRIPTION_STATUS_LABELS[recording.transcriptionStatus] ?? recording.transcriptionStatus}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
