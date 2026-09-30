import { memo } from 'react'
import {
  Calendar,
  Download,
  Eye,
  EyeOff,
  FileText,
  MoreHorizontal,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  AudioLines
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn, formatDuration } from '@/lib/utils'
import { formatSmartDate } from '@/lib/smartDate'
import { appLocale } from '@/lib/locale'
import { Transcript, Meeting } from '@/types'
import { UnifiedRecording, hasLocalPath, isDeviceOnly, isRecordingBacked } from '@/types/unified-recording'
import {
  LABEL_DELETE_FROM_DEVICE,
  LABEL_MOVE_TO_TRASH,
  SCOPE_DEVICE_DELETE,
  SCOPE_DEVICE_NOT_CONNECTED,
  SCOPE_TRASH,
  ariaLabelWithScope
} from '@/features/library/utils/deletionCopy'
import { useLibraryStore } from '@/store/useLibraryStore'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import { getRowMeta } from '@/features/library/utils/rowMeta'
import { sourceTypeLabel } from '@/features/library/utils/sourceType'
import type { DownloadStatus } from '@/store/useAppStore'
import { CHIPS_BOX_CLASS, RowChips, StatusPlaceIcon, TranscriptionPlaceIcon } from './RowIcons'

interface SourceCardProps {
  recording: UnifiedRecording
  transcript?: Transcript
  meeting?: Meeting
  isPlaying: boolean
  /** The source open in the reader. Stronger than a bulk selection, like the list rows. */
  isActiveSource?: boolean
  isDownloading: boolean
  downloadProgress?: number
  downloadStatus?: DownloadStatus
  isDeleting: boolean
  deviceConnected: boolean
  isSelected?: boolean
  onSelectionChange?: (id: string, shiftKey: boolean) => void
  onClick?: () => void
  onPlay: () => void
  onStop: () => void
  onDownload: () => void
  onDelete: () => void
  onMarkPersonal?: () => void
  onTranscribe?: () => void
  onReprocessVibeVoice?: () => void
  onAskAssistant: () => void
  onGenerateOutput: () => void
  onNavigateToMeeting: (meetingId: string) => void
}

/** Recording start time only ("7:02 PM"); empty for a missing or invalid date. */
function clockTime(value: Date | string | null | undefined): string {
  if (value == null) return ''
  const d = value instanceof Date ? value : new Date(value)
  const ms = d.getTime()
  if (Number.isNaN(ms) || ms <= 0) return ''
  return d.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' })
}

/**
 * One recording as a card of fixed size (the Library grid gives it CARD_HEIGHT_PX):
 * the title over two lines, date, time and length, the chips, a line of what is in it
 * (the summary, or what to do next), and a footer with the state of the file and of the
 * transcript on the left and the actions on the right. Everything else is in the reader:
 * a click opens it. The card never grows, so the grid can lay it out without measuring.
 */
export const SourceCard = memo(function SourceCard({
  recording,
  transcript,
  meeting,
  isPlaying,
  isActiveSource = false,
  isDownloading,
  downloadProgress,
  downloadStatus,
  isDeleting,
  deviceConnected,
  isSelected = false,
  onSelectionChange,
  onClick,
  onPlay,
  onStop,
  onDownload,
  onDelete,
  onMarkPersonal,
  onTranscribe,
  onReprocessVibeVoice,
  onAskAssistant,
  onGenerateOutput,
  onNavigateToMeeting
}: SourceCardProps) {
  const canPlay = hasLocalPath(recording)
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))

  // Same title the list shows, same rules (getDisplayTitle): the file name
  // never appears on the card either.
  const { primaryText: displayTitle } = getDisplayTitle(recording, meeting, transcript)

  const { Icon: TypeIcon, type: sourceType } = getRowMeta(recording)
  const durationText =
    sourceType === 'audio' && recording.duration && recording.duration > 0 ? formatDuration(recording.duration) : ''
  const metaText = [
    formatSmartDate(recording.dateRecorded, { time: false }),
    clockTime(recording.dateRecorded),
    durationText
  ]
    .filter(Boolean)
    .join(' · ')

  const transcribing = recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'
  const canTranscribe = canPlay && recording.transcriptionStatus !== 'complete' && Boolean(onTranscribe)
  const summary = transcript?.summary?.trim()
  const deviceOnly = isDeviceOnly(recording)

  const handleCardClick = (e: React.MouseEvent) => {
    // Buttons and links own their clicks. Everywhere else on the card follows
    // Explorer semantics: modifier clicks change the selection without opening;
    // plain clicks replace the selection and open the source.
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('a')) {
      return
    }
    if (isDeleting) return
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      onSelectionChange?.(recording.id, e.shiftKey)
      return
    }
    onClick?.()
  }

  const downloadLabel =
    downloadStatus === 'pending'
      ? 'Queued'
      : downloadStatus === 'cancelling'
        ? 'Cancelling'
        : (downloadProgress ?? 0) > 0
          ? `${downloadProgress}%`
          : 'Starting'

  return (
    <TooltipProvider>
      <div
        className={cn(
          'group flex h-full cursor-pointer select-none flex-col overflow-hidden rounded-xl border bg-card p-3 text-card-foreground',
          'transition-[background-color,border-color,box-shadow] duration-150',
          isActiveSource ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-muted/40',
          isSelected && 'ring-2 ring-primary',
          isDeleting && 'pointer-events-none opacity-60'
        )}
        onClick={handleCardClick}
        data-testid="source-card"
        role="option"
        aria-selected={isPlaying || isSelected}
        aria-disabled={isDeleting || undefined}
        tabIndex={0}
      >
        <div className="flex items-start gap-2">
          <h3 className="line-clamp-2 min-h-10 min-w-0 flex-1 text-sm font-semibold leading-5" title={displayTitle}>
            {displayTitle}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-1 -mt-0.5 h-7 w-7 shrink-0 text-muted-foreground"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                aria-label="Card actions"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onAskAssistant() }}>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Ask Assistant
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onGenerateOutput() }}>
                <FileText className="h-4 w-4" aria-hidden="true" />
                Generate output
              </DropdownMenuItem>
              {canPlay && onReprocessVibeVoice && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); onReprocessVibeVoice() }}
                  disabled={transcribing}
                >
                  <AudioLines className="h-4 w-4" aria-hidden="true" />
                  Re-transcribe (VibeVoice)
                </DropdownMenuItem>
              )}
              {onMarkPersonal && !deviceOnly && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMarkPersonal() }}>
                    {recording.personal
                      ? <><Eye className="h-4 w-4" aria-hidden="true" />Unmark personal</>
                      : <><EyeOff className="h-4 w-4" aria-hidden="true" />Mark personal (ignore)</>}
                  </DropdownMenuItem>
                </>
              )}
              {/* spec-005/F17 §D3b/AR3-4 — the card is a delete surface too. onDelete routes
                  through Library's handleDelete: Move to Trash for a local copy, an erase for a
                  device-only recording. Capture-only rows (no source recording) get no delete. */}
              {isRecordingBacked(recording) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onDelete() }}
                    disabled={(deviceOnly && !deviceConnected) || isDeleting}
                    className="items-start gap-2 text-destructive focus:text-destructive"
                    aria-label={
                      deviceOnly
                        ? ariaLabelWithScope(LABEL_DELETE_FROM_DEVICE, deviceConnected ? SCOPE_DEVICE_DELETE : SCOPE_DEVICE_NOT_CONNECTED)
                        : ariaLabelWithScope(LABEL_MOVE_TO_TRASH, SCOPE_TRASH)
                    }
                  >
                    <Trash2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex flex-col">
                      <span>{deviceOnly ? LABEL_DELETE_FROM_DEVICE : LABEL_MOVE_TO_TRASH}</span>
                      <span className="text-xs text-muted-foreground">
                        {deviceOnly ? (deviceConnected ? SCOPE_DEVICE_DELETE : SCOPE_DEVICE_NOT_CONNECTED) : SCOPE_TRASH}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <p className="mt-1 flex items-center gap-1 text-xs leading-4 text-muted-foreground" data-testid="card-meta">
          <TypeIcon
            className="h-3 w-3 shrink-0 text-muted-foreground/70"
            aria-label={`${sourceTypeLabel(sourceType)} source`}
          />
          <span className="truncate">{metaText}</span>
        </p>

        <div className={`mt-2 ${CHIPS_BOX_CLASS}`} data-testid="card-chips">
          {recording.personal && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              role="img"
              aria-label="Personal — excluded from AI processing"
              title="Personal — kept on disk but excluded from AI processing and default surfaces"
            >
              <EyeOff className="h-2.5 w-2.5" aria-hidden="true" />
              Personal
            </span>
          )}
          <RowChips recording={recording} />
        </div>

        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden text-xs leading-4 text-muted-foreground">
          {summary ? (
            <p className={meeting ? 'line-clamp-1' : 'line-clamp-2'} data-testid="card-summary">
              {summary}
            </p>
          ) : deviceOnly ? (
            <p className="line-clamp-2 italic">On the device only. Download it to play it and get a transcript.</p>
          ) : recording.transcriptionStatus === 'none' ? (
            <p className="line-clamp-2 italic">Not transcribed yet.</p>
          ) : null}
          {meeting && (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded text-left text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              onClick={(e) => { e.stopPropagation(); onNavigateToMeeting(meeting.id) }}
              title={`Open the meeting: ${meeting.subject}`}
              data-testid="card-meeting"
            >
              <Calendar className="h-3 w-3 shrink-0 text-primary/70" aria-hidden="true" />
              <span className="truncate">{meeting.subject}</span>
            </button>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <div className="flex items-center gap-1.5" data-testid="card-status">
            <StatusPlaceIcon recording={recording} error={error} />
            <TranscriptionPlaceIcon recording={recording} transcript={transcript} />
          </div>
          <div className="flex items-center gap-0.5">
            {deviceOnly &&
              (downloadStatus ? (
                <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground" aria-live="polite">
                  <RefreshCw className={cn('h-3.5 w-3.5', isDownloading && 'animate-spin')} aria-hidden="true" />
                  {downloadLabel}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-7"
                  onClick={onDownload}
                  disabled={!deviceConnected}
                  title={deviceConnected ? 'Download to computer' : 'Device not connected'}
                  aria-label="Download to computer"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                </Button>
              ))}
            {canTranscribe && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7"
                onClick={onTranscribe}
                disabled={transcribing}
                title={
                  recording.transcriptionStatus === 'pending'
                    ? 'Transcription queued'
                    : recording.transcriptionStatus === 'processing'
                      ? 'Transcription in progress'
                      : 'Transcribe this capture'
                }
                aria-label="Transcribe"
              >
                {recording.transcriptionStatus === 'processing' ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Wand2 className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            )}
            {isPlaying ? (
              <Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={onStop} title="Stop" aria-label="Stop">
                <Square className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7"
                onClick={onPlay}
                disabled={!canPlay || error?.type === 'audio_not_found'}
                title={
                  error?.type === 'audio_not_found'
                    ? 'File missing'
                    : canPlay
                      ? 'Play capture'
                      : 'Download to play'
                }
                aria-label="Play"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for performance
  // C-005: Include recording.location and recording.title to detect download and title changes
  return (
    prevProps.recording.id === nextProps.recording.id &&
    prevProps.recording.location === nextProps.recording.location &&
    prevProps.recording.personal === nextProps.recording.personal &&
    prevProps.recording.transcriptionStatus === nextProps.recording.transcriptionStatus &&
    prevProps.recording.quality === nextProps.recording.quality &&
    prevProps.recording.title === nextProps.recording.title &&
    // The card is titled by getDisplayTitle now, so everything that decides
    // that title has to invalidate the memo — a rename that did not repaint
    // the card was the bug this line closes.
    prevProps.recording.userTitle === nextProps.recording.userTitle &&
    prevProps.recording.filename === nextProps.recording.filename &&
    prevProps.recording.meetingSubject === nextProps.recording.meetingSubject &&
    prevProps.meeting?.subject === nextProps.meeting?.subject &&
    prevProps.recording.category === nextProps.recording.category &&
    prevProps.recording.duration === nextProps.recording.duration &&
    prevProps.recording.size === nextProps.recording.size &&
    // The chips and the state icons read these.
    prevProps.recording.evalStarLevel === nextProps.recording.evalStarLevel &&
    prevProps.recording.evalKind === nextProps.recording.evalKind &&
    prevProps.recording.evalContext === nextProps.recording.evalContext &&
    prevProps.recording.evalAudioWarning === nextProps.recording.evalAudioWarning &&
    prevProps.recording.evalTranscriptInvented === nextProps.recording.evalTranscriptInvented &&
    prevProps.recording.audioCategory === nextProps.recording.audioCategory &&
    prevProps.recording.qualityReasons?.join('|') === nextProps.recording.qualityReasons?.join('|') &&
    prevProps.recording.qualitySource === nextProps.recording.qualitySource &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.isActiveSource === nextProps.isActiveSource &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.downloadProgress === nextProps.downloadProgress &&
    prevProps.downloadStatus === nextProps.downloadStatus &&
    prevProps.isDeleting === nextProps.isDeleting &&
    prevProps.deviceConnected === nextProps.deviceConnected &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.transcript?.id === nextProps.transcript?.id &&
    prevProps.transcript?.summary === nextProps.transcript?.summary &&
    prevProps.transcript?.integrity_status === nextProps.transcript?.integrity_status &&
    prevProps.transcript?.integrity_accepted_at === nextProps.transcript?.integrity_accepted_at &&
    prevProps.transcript?.integrity_json === nextProps.transcript?.integrity_json &&
    prevProps.meeting?.id === nextProps.meeting?.id
  )
})
