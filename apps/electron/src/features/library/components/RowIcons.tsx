import { AlertCircle, AlertTriangle, Ban, Calendar, Clock, FileWarning, FileX, Loader2, TrendingDown, XOctagon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime } from '@/lib/utils'
import type { Meeting, Transcript } from '@/types'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { LibraryError } from '@/features/library/utils/errorHandling'
import { CONTEXT_LABELS, KIND_LABELS, displayedEvaluation } from '@/features/library/utils/evaluation'
import { audioLabel } from '@/features/library/utils/audioCheck'
import { formatValueReasons } from '@/features/library/utils/valueReasons'
import { transcriptProblems, showsTranscriptProblem, type TranscriptProblemKind } from '@/features/library/utils/rowState'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import type { DownloadStatus } from '@/store/useAppStore'
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
  const shown = displayedEvaluation(recording)
  const kind = shown.kind ? KIND_LABELS[shown.kind] : null
  const context = shown.context ? CONTEXT_LABELS[shown.context] : null
  const stars = shown.stars
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex min-w-11 max-w-max flex-1 basis-11 items-center gap-1 rounded border border-border px-1.5 py-px text-[10px] leading-4 text-muted-foreground"
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
/**
 * A percentage shown in an icon place, with a tooltip that says what it counts.
 * Until the first number arrives the place shows a spinner instead of "0%"
 * (owner, 2-oct-2026: "60% de qué?").
 */
function ProgressInPlace({ percent, label, testId }: { percent: number | null; label: string; testId: string }) {
  const known = percent !== null && percent > 0
  const text = known ? `${Math.min(100, Math.round(percent))}%` : null
  const aria = text ? `${label}: ${text}` : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center text-yellow-600 dark:text-yellow-400"
          role="img"
          aria-label={aria}
          data-testid={testId}
        >
          {text ? (
            <span className="text-[10px] font-medium leading-none tabular-nums" aria-hidden="true">{text}</span>
          ) : (
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{aria}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/** A download from the device that is waiting, starting, running or being cancelled. */
export interface PlaceDownload {
  status: DownloadStatus
  progress?: number
}

function DownloadInPlace({ download }: { download: PlaceDownload }) {
  if (download.status === 'pending') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex shrink-0 text-yellow-600 dark:text-yellow-400"
            role="img"
            aria-label="Waiting to download from the device"
            data-testid="download-in-place"
          >
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>Waiting to download from the device</p>
        </TooltipContent>
      </Tooltip>
    )
  }
  if (download.status === 'cancelling') {
    return <ProgressInPlace percent={null} label="Cancelling the download from the device" testId="download-in-place" />
  }
  const percent = download.progress ?? 0
  return (
    <ProgressInPlace
      percent={percent > 0 ? percent : null}
      label={percent > 0 ? 'Downloading from the device' : 'Starting the download from the device'}
      testId="download-in-place"
    />
  )
}

/** Download states that take the file-status place while they last. */
const IN_PLACE_DOWNLOADS: ReadonlySet<DownloadStatus> = new Set(['pending', 'downloading', 'cancelling'])

export function StatusPlaceIcon({
  recording,
  error,
  download
}: {
  recording: UnifiedRecording
  error?: LibraryError
  /** A download in flight shows its state here, in place of the location icon. */
  download?: PlaceDownload
}) {
  if (download && recording.location === 'device-only' && IN_PLACE_DOWNLOADS.has(download.status)) {
    return <DownloadInPlace download={download} />
  }
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
  // The percentage of a running transcription; null until the first progress event.
  const progress = useTranscriptionStore((s) => {
    for (const item of s.queue.values()) {
      if (item.recordingId === recording.id && item.status === 'processing') return item.progress
    }
    return null
  })
  if (recording.transcriptionStatus === 'processing' && progress !== null && progress > 0) {
    return <ProgressInPlace percent={progress} label="Transcribing" testId="transcription-in-place" />
  }
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
