import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Download, Trash2, Wand2, Sparkles, FileText, RefreshCw, AudioLines, MoreHorizontal, Calendar, EyeOff, Eye, TrendingDown, Ban, RotateCcw, ArchiveRestore, AlertTriangle, XOctagon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { formatDateTime } from '@/lib/utils'
import { Meeting, Transcript } from '@/types'
import type { QualityRating } from '@/types/knowledge'
import { UnifiedRecording, hasLocalPath, isRecordingBacked } from '@/types/unified-recording'
import type { DownloadStatus } from '@/store/useAppStore'
import { toast } from '@/components/ui/toaster'
import { StatusIcon } from './StatusIcon'
import { TranscriptionStatusBadge } from './TranscriptionStatusBadge'
import { useLibraryStore } from '@/store/useLibraryStore'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import { highlightText } from '@/features/library/utils/highlightText'
import { getRowMeta } from '@/features/library/utils/rowMeta'
import { sourceTypeLabel } from '@/features/library/utils/sourceType'
import { formatValueReasons } from '@/features/library/utils/valueReasons'
import { ISSUE_TAGS, integrityIssues, integrityLabel } from '@/features/library/utils/transcriptIntegrity'
import { audioLabel } from '@/features/library/utils/audioCheck'
import {
  LABEL_DELETE_FROM_DEVICE,
  LABEL_MOVE_TO_TRASH,
  LABEL_DELETE_PERMANENTLY,
  LABEL_RESTORE,
  SCOPE_DEVICE_DELETE,
  SCOPE_DEVICE_DELETE_SYNCED,
  SCOPE_DEVICE_NOT_CONNECTED,
  SCOPE_TRASH,
  SCOPE_PERMANENT,
  SCOPE_RESTORE,
  ariaLabelWithScope
} from '@/features/library/utils/deletionCopy'

/**
 * F16/spec-003 — icon-only value badge, rendered only for low-value/garbage
 * (never valuable/archived/unrated). Lives in the row's `shrink-0` right
 * cluster so the H17 no-scroll invariant holds: no text label, so the
 * `flex-1 min-w-0` title always truncates before this cluster can grow.
 *
 * Relies on the single `<TooltipProvider>` SourceRow mounts around its whole
 * return value (/simplify S-6 — one provider per row, not one per tooltip
 * consumer) rather than mounting its own.
 */
function ValueBadge({ recording }: { recording: UnifiedRecording }) {
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
 * Transcript integrity badge: icon-only like ValueBadge, shown only while a
 * transcript is flagged. Red when its text cannot fit the audio, amber when
 * only its timing is wrong. An accepted or clean transcript shows nothing.
 */
function IntegrityBadge({ transcript }: { transcript?: Transcript }) {
  const label = integrityLabel(transcript)
  if (label !== 'suspect' && label !== 'broken') return null
  const broken = label === 'broken'
  const Icon = broken ? XOctagon : AlertTriangle
  const title = broken ? 'Transcript does not fit the audio' : 'Transcript timing is wrong'
  const tags = integrityIssues(transcript).map((i) => ISSUE_TAGS[i.code])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex shrink-0 ${broken ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
          role="img"
          aria-label={title}
          data-testid="integrity-badge"
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{tags.join(' · ')}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Audio check label, in words: "Silent", "Noise only", "Too short". Shown
 * whenever the audio holds no usable sound, whatever the transcript says.
 */
function AudioLabel({ recording }: { recording: UnifiedRecording }) {
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
 * `knowledge:update` reports a failure in its result (it does not throw) and
 * the shape of `error` differs by handler: a bare string in one, a coded
 * object in another. Read whichever is there rather than showing "[object
 * Object]" to the user.
 */
function renameErrorMessage(result: unknown): string {
  const err = (result as { error?: unknown } | null | undefined)?.error
  if (typeof err === 'string' && err.trim()) return err
  const message = (err as { message?: unknown } | null | undefined)?.message
  if (typeof message === 'string' && message.trim()) return message
  return 'The title was not saved.'
}

interface SourceRowProps {
  recording: UnifiedRecording
  meeting?: Meeting
  transcript?: Transcript
  isSelected?: boolean
  isActiveSource?: boolean
  /** Permanent-delete feedback. Keeps the fixed row in place until the local
   *  purge commits, while disabling every interaction. */
  isDeleting?: boolean
  deletionLabel?: string
  /**
   * FIXED-HEIGHT row (48px, title truncated to one line). The compact list
   * uses this so virtualized offsets are ALWAYS exact (48 × index) — variable
   * heights (line-clamp-2 titles at ~74px) made every measurement/scroll/
   * alignment bug possible (2026-07-22).
   */
  compact?: boolean
  /** Bulk-selection checkbox was removed from the row (owner request). Retained so
      existing callers keep type-checking; no longer drives any UI. */
  anySelected?: boolean
  searchQuery?: string
  /** Called after an in-place rename commits, so the list can update without a refetch. */
  onRenamed?: (id: string, userTitle: string | undefined) => void
  /** Row-level checkbox selection was removed; kept for caller compatibility. */
  onSelectionChange?: (id: string, shiftKey: boolean) => void
  onClick?: () => void
  // Action handlers
  onDownload?: () => void
  onDelete?: () => void
  onDeletePermanent?: () => void
  /** Trash-mode only (spec-005/F17 §D1) — Library passes this ONLY for trashed rows. */
  onRestore?: () => void
  /** Synced ("both") rows only (spec-005/F17 §D3) — erases the device copy via the
   *  existing renderer device path, keeps the local copy. */
  onDeleteFromDevice?: () => void
  onMarkPersonal?: () => void
  /** F16/spec-003 — manual per-row value-rating override (overflow menu). */
  onSetValueRating?: (rating: QualityRating) => void
  onTranscribe?: () => void
  onReprocessVibeVoice?: () => void
  onAskAssistant?: () => void
  onGenerateOutput?: () => void
  // Download state for device-only recordings
  isDownloading?: boolean
  downloadProgress?: number
  downloadStatus?: DownloadStatus
  deviceConnected?: boolean
}

export const SourceRow = memo(function SourceRow({
  recording,
  meeting,
  transcript,
  isSelected = false,
  isActiveSource = false,
  isDeleting = false,
  deletionLabel = 'Removing local data…',
  compact = false,
  searchQuery = '',
  onSelectionChange,
  onClick,
  onDownload,
  onDelete,
  onDeletePermanent,
  onRestore,
  onDeleteFromDevice,
  onMarkPersonal,
  onSetValueRating,
  onTranscribe,
  onReprocessVibeVoice,
  onAskAssistant,
  onGenerateOutput,
  isDownloading = false,
  downloadProgress,
  downloadStatus,
  deviceConnected = false,
  onRenamed
}: SourceRowProps) {
  const error = useLibraryStore((state) => state.recordingErrors.get(recording.id))
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ x: number; y: number } | null>(null)

  // Meeting subject, typed title, suggested title, or kind and date. The file
  // name never appears in the list; it is in the reader's Metadata section.
  const { primaryText } = getDisplayTitle(recording, meeting, transcript)

  // Rename in place. The reader has had this for a while; the list did not, so
  // renaming meant opening a source just to retitle it. Same IPC, no new
  // backend. Without a capture there is nowhere to store the title, so the
  // affordance is withheld rather than failing on save.
  const canRename = Boolean(recording.knowledgeCaptureId)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  /** Blur and Enter can both land while a save is in flight; one write only. */
  const savingRef = useRef(false)
  /** A plain click opens the reader; a double click renames. Hold the open for
   *  one double-click interval so renaming does not also open the source. */
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  useEffect(() => cancelPendingOpen, [])

  const commitRename = async () => {
    if (savingRef.current) return
    const trimmed = draftTitle.trim()
    const currentUserTitle = recording.userTitle?.trim() ?? ''
    if (trimmed === currentUserTitle) {
      setRenaming(false)
      return
    }
    // Opening the editor and committing it untouched must NOT turn the AI's
    // guess into a title the user never wrote: a stray double click plus a
    // click elsewhere would otherwise stamp `user_title`, which outranks the
    // suggested title and survives any later re-analysis.
    if (!currentUserTitle && trimmed === primaryText.trim()) {
      setRenaming(false)
      return
    }
    savingRef.current = true
    setSavingRename(true)
    try {
      // Empty clears the user title and falls back to the suggestion.
      const result = await window.electronAPI.knowledge.update(recording.knowledgeCaptureId!, {
        userTitle: trimmed || null,
      })
      // knowledge:update REPORTS failure, it does not throw. Trusting the
      // absence of an exception showed a rename that was never written and
      // vanished on the next refresh.
      if (!result?.success) {
        toast.error('Could not rename', renameErrorMessage(result))
        return
      }
      setRenaming(false)
      onRenamed?.(recording.id, trimmed || undefined)
    } catch (e) {
      console.error('[SourceRow] rename failed:', e)
      toast.error('Could not rename', e instanceof Error ? e.message : 'The title was not saved.')
    } finally {
      savingRef.current = false
      setSavingRename(false)
    }
  }

  const handleRowClick = (e: React.MouseEvent) => {
    if (isDeleting) return
    // The second click of a double click must not re-run this: it opened the
    // source once already, and with a modifier held it would toggle the
    // selection twice and cancel itself out.
    if (e.detail > 1) return
    // Don't trigger onClick when the click lands on an action button.
    const target = e.target as HTMLElement
    if (target.closest('button')) {
      return
    }
    // Explorer-style multi-select (no checkboxes, per owner): Ctrl/Cmd+click
    // toggles this row, Shift+click range-selects from the last-clicked row,
    // plain click opens the source. Selection shows the BulkActionsBar.
    if ((e.ctrlKey || e.metaKey) && onSelectionChange) {
      e.preventDefault()
      onSelectionChange(recording.id, false)
      return
    }
    if (e.shiftKey && onSelectionChange) {
      e.preventDefault()
      onSelectionChange(recording.id, true)
      return
    }
    onClick?.()
  }

  // Build the secondary line from the type-aware row metadata. Audio keeps
  // "date \u00B7 time \u00B7 duration"; non-audio artifacts (image/pdf/note) show their
  // kind + date and never a bogus duration. The leading glyph (TypeIcon) makes
  // the list scannable by kind.
  const { Icon: TypeIcon, parts: secondaryParts, type: sourceType } = getRowMeta(recording)
  const secondaryText = secondaryParts.join(' \u00B7 ')

  return (
    <TooltipProvider>
      <div
        data-testid={`source-row-${recording.id}`}
        className={[
          // select-none: shift+click (range select) must not start the browser's
          // native TEXT selection — the list behaves like a file explorer, not
          // a text document (2026-07-21 report).
          `@container flex ${compact ? 'h-12 items-center' : 'items-start'} justify-between gap-2 ${compact ? 'py-1.5' : 'py-2.5'} px-3 ${isDeleting ? 'cursor-wait' : 'cursor-pointer'} select-none`,
          'transition-[background-color,box-shadow] duration-150',
          // ONE visual system, ONE box (2026-07-22): background tints ONLY —
          // no outline rings. The wrapper owns separators (border-t); outline
          // rings on this div lived on a DIFFERENT box than those separators
          // and visibly misaligned on hover/selection (especially after a
          // deletion shifted measurements).
          isDeleting ? 'bg-muted/50' : 'hover:bg-muted/60',
          // Selection/active state shown via background tint (no side-stripe,
          // no outline ring, per the design rules).
          // ACTIVE (open in reader) must never be confusable with SELECTED
          // (bulk): a clearly stronger tint — no ring anywhere.
          isActiveSource
            ? 'bg-primary/25'
            : isSelected
              ? 'bg-primary/10'
              : ''
        ].filter(Boolean).join(' ')}
        role="option"
        onClick={handleRowClick}
        onContextMenu={(event) => {
          if (isDeleting) return
          event.preventDefault()
          setContextMenuAnchor({ x: event.clientX, y: event.clientY })
          setActionMenuOpen(true)
        }}
        aria-selected={isSelected}
        aria-disabled={isDeleting || undefined}
        tabIndex={isDeleting ? -1 : 0}
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {/* Content area — flex-1 to fill remaining space. Status icons moved to the
              right cluster so the title starts flush-left with no wasted gutter. */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-1.5 min-w-0">
              {renaming ? (
                <input
                  autoFocus
                  aria-label="Rename source"
                  // `title` is a VARCHAR the whole app renders in one line; a
                  // pasted document does not belong in it.
                  maxLength={200}
                  disabled={savingRename}
                  className="min-w-0 flex-1 rounded border border-input bg-background px-1 py-0.5 text-sm font-medium leading-tight"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                />
              ) : (
                <p
                  className={`font-medium text-sm ${compact ? 'truncate' : 'line-clamp-2'} text-foreground leading-tight min-w-0`}
                  title={
                    canRename
                      ? `${primaryText} — double-click to rename`
                      : `${primaryText} — this source has no knowledge capture yet, so there is nowhere to store a title. Transcribe it first.`
                  }
                  onClick={(e) => {
                    // A plain click on the title opens the source and a double
                    // click renames it, so the open waits out the double-click
                    // window. Without this the rename ALSO opened the reader
                    // and wiped any bulk selection — the exact trip to the
                    // reader this feature exists to avoid. Modifier clicks
                    // (select / range-select) bubble through untouched.
                    if (!canRename || isDeleting || e.ctrlKey || e.metaKey || e.shiftKey) return
                    if (!onClick) return
                    e.stopPropagation()
                    if (e.detail > 1) return
                    cancelPendingOpen()
                    openTimer.current = setTimeout(() => {
                      openTimer.current = null
                      onClick()
                    }, 250)
                  }}
                  onDoubleClick={(e) => {
                    if (!canRename) return
                    e.stopPropagation()
                    cancelPendingOpen()
                    setDraftTitle(recording.userTitle?.trim() || primaryText)
                    setRenaming(true)
                  }}
                >
                  {searchQuery ? highlightText(primaryText, searchQuery) : primaryText}
                </p>
              )}
              {/* Personal ("ignored") badge — this recording is kept but pulled out of
                  all AI processing and default surfaces (v38). */}
              {recording.personal && (
                <span
                  className="mt-[2px] inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  role="img"
                  aria-label="Personal — excluded from AI processing"
                  title="Personal — kept on disk but excluded from AI processing and default surfaces"
                >
                  <EyeOff className="h-2.5 w-2.5" aria-hidden="true" />
                  Personal
                </span>
              )}
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground truncate leading-tight mt-0.5">
              <TypeIcon
                className="h-3 w-3 shrink-0 text-muted-foreground/70"
                aria-label={`${sourceTypeLabel(sourceType)} source`}
              />
              <span className="truncate">
                {searchQuery ? highlightText(secondaryText, searchQuery) : secondaryText}
              </span>
            </p>
          </div>
        </div>

        {/* Right cluster — status + meeting link + error + overflow menu, aligned at
            the row's top line. The two status icons live here (not a left column) so
            the title starts flush-left. Playback lives in the mid-panel player. */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isDeleting && (
            <div
              className="flex max-w-44 items-center gap-1.5 text-xs font-medium text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <span className="truncate">{deletionLabel}</span>
            </div>
          )}
          {/* Value badge (F16/spec-003) — icon-only, low-value/garbage only. Sits
              before the meeting chip so the two provenance/quality glyphs read
              left-to-right in the same tight cluster. */}
          {!isDeleting && <ValueBadge recording={recording} />}
          {!isDeleting && <IntegrityBadge transcript={transcript} />}
          {!isDeleting && <AudioLabel recording={recording} />}
          {/* Meeting-link (calendar) provenance — the system knows this row maps to a
              calendar event; the status icons align with it. */}
          {!isDeleting && meeting && (
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
          )}
          {!isDeleting && <StatusIcon recording={recording} />}
          {!isDeleting && <TranscriptionStatusBadge status={recording.transcriptionStatus} compact />}
          {/* Error indicator */}
          {!isDeleting && error && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" aria-label="Processing error" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{error.message}</p>
                {error.details && <p className="text-xs text-muted-foreground mt-1">{error.details}</p>}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Download progress (device-only, in flight) */}
          {!isDeleting && recording.location === 'device-only' && downloadStatus && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground px-2" aria-live="polite">
              <RefreshCw
                className={`h-3.5 w-3.5 ${downloadStatus === 'downloading' || downloadStatus === 'cancelling' ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>
                {downloadStatus === 'pending'
                  ? 'Queued'
                  : downloadStatus === 'cancelling'
                    ? 'Cancelling'
                    : (downloadProgress ?? 0) > 0
                      ? `${downloadProgress}%`
                      : 'Starting'}
              </span>
            </div>
          )}

          {/* Secondary actions: overflow menu (labeled, keeps the row uncluttered).
              Right-click reuses this exact menu. The invisible context trigger is
              portaled out of the virtual row because its transform would otherwise
              make fixed pointer coordinates relative to the row, not the viewport. */}
          {!isDeleting && <DropdownMenu
            open={actionMenuOpen}
            onOpenChange={(open) => {
              setActionMenuOpen(open)
              if (!open) setContextMenuAnchor(null)
            }}
          >
            {contextMenuAnchor
              ? createPortal(
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      style={{
                        position: 'fixed',
                        left: contextMenuAnchor.x,
                        top: contextMenuAnchor.y,
                        width: 1,
                        height: 1,
                        opacity: 0,
                        pointerEvents: 'none'
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="More actions"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>,
                  document.body
                )
              : (
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="More actions"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                )}
            <DropdownMenuContent align={contextMenuAnchor ? 'start' : 'end'} className="w-56">
              {onAskAssistant && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onAskAssistant(); }}>
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Ask Assistant
                </DropdownMenuItem>
              )}
              {onGenerateOutput && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onGenerateOutput(); }}>
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  Generate output
                </DropdownMenuItem>
              )}
              {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && onTranscribe && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); onTranscribe(); }}
                  disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
                >
                  {recording.transcriptionStatus === 'processing'
                    ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Wand2 className="h-4 w-4" aria-hidden="true" />}
                  {recording.transcriptionStatus === 'pending' ? 'Transcription queued'
                    : recording.transcriptionStatus === 'processing' ? 'Transcribing…'
                      : 'Transcribe'}
                </DropdownMenuItem>
              )}
              {hasLocalPath(recording) && onReprocessVibeVoice && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); onReprocessVibeVoice(); }}
                  disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
                >
                  <AudioLines className="h-4 w-4" aria-hidden="true" />
                  Re-transcribe (VibeVoice)
                </DropdownMenuItem>
              )}
              {recording.location === 'device-only' && onDownload && !isDownloading && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); onDownload(); }}
                  disabled={!deviceConnected}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {deviceConnected
                    ? (downloadStatus === 'pending' ? 'Start queued download' : 'Download to computer')
                    : 'Device not connected'}
                </DropdownMenuItem>
              )}
              {onMarkPersonal && recording.location !== 'device-only' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onMarkPersonal(); }}
                  >
                    {recording.personal
                      ? <><Eye className="h-4 w-4" aria-hidden="true" />Unmark personal</>
                      : <><EyeOff className="h-4 w-4" aria-hidden="true" />Mark personal (ignore)</>}
                  </DropdownMenuItem>
                </>
              )}
              {/* Manual value-rating override (F16/spec-003) — capture-backed,
                  non-device rows only. Explicit user action always applies (the
                  never-downgrade guard only protects against a lower-confidence
                  AI re-classification, never against the user's own rating). */}
              {onSetValueRating && recording.location !== 'device-only' && recording.knowledgeCaptureId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onSetValueRating('low-value'); }}
                  >
                    <TrendingDown className="h-4 w-4" aria-hidden="true" />
                    Mark low-value
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onSetValueRating('garbage'); }}
                  >
                    <Ban className="h-4 w-4" aria-hidden="true" />
                    Mark garbage
                  </DropdownMenuItem>
                  {recording.quality && recording.quality !== 'unrated' && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onSetValueRating('unrated'); }}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      Clear rating
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {/* spec-005/F17 T5 §D1/§D2/§D3/AR3-4 — every item below is individually
                  onX &&-guarded, which is what lets Library reuse this SAME menu for
                  Trash rows (only onRestore + onDeletePermanent passed) and for
                  synced rows (onDelete + onDeleteFromDevice + onDeletePermanent).
                  AR3-4 (binding): capture-only synthetic rows (no source recording)
                  render NONE of these — gated on isRecordingBacked. */}
              {isRecordingBacked(recording) && (onDelete || onRestore || onDeletePermanent || onDeleteFromDevice) && (
                <>
                  <DropdownMenuSeparator />
                  {onRestore && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onRestore(); }}
                      className="items-start gap-2"
                      aria-label={ariaLabelWithScope(LABEL_RESTORE, SCOPE_RESTORE)}
                    >
                      <ArchiveRestore className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="flex flex-col">
                        <span>{LABEL_RESTORE}</span>
                        <span className="text-xs text-muted-foreground">{SCOPE_RESTORE}</span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {onDelete && recording.location === 'device-only' && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onDelete(); }}
                      disabled={!deviceConnected}
                      className="items-start gap-2 text-destructive focus:text-destructive"
                      aria-label={ariaLabelWithScope(LABEL_DELETE_FROM_DEVICE, deviceConnected ? SCOPE_DEVICE_DELETE : SCOPE_DEVICE_NOT_CONNECTED)}
                    >
                      <Trash2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="flex flex-col">
                        <span>{LABEL_DELETE_FROM_DEVICE}</span>
                        <span className="text-xs text-muted-foreground">
                          {deviceConnected ? SCOPE_DEVICE_DELETE : SCOPE_DEVICE_NOT_CONNECTED}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {onDelete && recording.location !== 'device-only' && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onDelete(); }}
                      className="items-start gap-2 text-destructive focus:text-destructive"
                      aria-label={ariaLabelWithScope(LABEL_MOVE_TO_TRASH, SCOPE_TRASH)}
                    >
                      <Trash2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="flex flex-col">
                        <span>{LABEL_MOVE_TO_TRASH}</span>
                        <span className="text-xs text-muted-foreground">{SCOPE_TRASH}</span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {onDeleteFromDevice && recording.location === 'both' && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onDeleteFromDevice(); }}
                      disabled={!deviceConnected}
                      className="items-start gap-2 text-destructive focus:text-destructive"
                      aria-label={ariaLabelWithScope(LABEL_DELETE_FROM_DEVICE, deviceConnected ? SCOPE_DEVICE_DELETE_SYNCED : SCOPE_DEVICE_NOT_CONNECTED)}
                    >
                      <Trash2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="flex flex-col">
                        <span>{LABEL_DELETE_FROM_DEVICE}</span>
                        <span className="text-xs text-muted-foreground">
                          {deviceConnected ? SCOPE_DEVICE_DELETE_SYNCED : SCOPE_DEVICE_NOT_CONNECTED}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {onDeletePermanent && recording.location !== 'device-only' && (
                    <DropdownMenuItem
                      onClick={(e) => { e.stopPropagation(); onDeletePermanent(); }}
                      className="items-start gap-2 text-destructive focus:text-destructive"
                      aria-label={ariaLabelWithScope(LABEL_DELETE_PERMANENTLY, SCOPE_PERMANENT)}
                    >
                      <Trash2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="flex flex-col">
                        <span>{LABEL_DELETE_PERMANENTLY}</span>
                        <span className="text-xs text-muted-foreground">{SCOPE_PERMANENT}</span>
                      </span>
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>
      </div>
    </TooltipProvider>
  )
}, (prevProps, nextProps) => {
  // Custom comparison for performance
  // LB-16 fix: Include recording.location in equality check to detect download state changes
  return (
    prevProps.recording.id === nextProps.recording.id &&
    prevProps.recording.location === nextProps.recording.location &&
    prevProps.recording.personal === nextProps.recording.personal &&
    prevProps.recording.transcriptionStatus === nextProps.recording.transcriptionStatus &&
    prevProps.recording.title === nextProps.recording.title &&
    prevProps.recording.meetingSubject === nextProps.recording.meetingSubject &&
    prevProps.recording.audioCategory === nextProps.recording.audioCategory &&
    prevProps.recording.category === nextProps.recording.category &&
    prevProps.recording.quality === nextProps.recording.quality &&
    prevProps.recording.qualityReasons?.join('|') === nextProps.recording.qualityReasons?.join('|') &&
    prevProps.recording.qualitySource === nextProps.recording.qualitySource &&
    prevProps.recording.duration === nextProps.recording.duration &&
    prevProps.recording.size === nextProps.recording.size &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isActiveSource === nextProps.isActiveSource &&
    prevProps.isDeleting === nextProps.isDeleting &&
    prevProps.deletionLabel === nextProps.deletionLabel &&
    prevProps.transcript?.id === nextProps.transcript?.id &&
    prevProps.transcript?.title_suggestion === nextProps.transcript?.title_suggestion &&
    prevProps.transcript?.integrity_status === nextProps.transcript?.integrity_status &&
    prevProps.transcript?.integrity_accepted_at === nextProps.transcript?.integrity_accepted_at &&
    prevProps.transcript?.integrity_json === nextProps.transcript?.integrity_json &&
    prevProps.meeting?.id === nextProps.meeting?.id &&
    prevProps.meeting?.subject === nextProps.meeting?.subject &&
    prevProps.searchQuery === nextProps.searchQuery &&
    // OP-F-LOW-1 (spec-005 fix round): deviceConnected drives the device-delete
    // items' disabled state + "Device not connected" scope line. Today a fresh
    // inline onClick makes this comparator return false every render anyway,
    // but if onClick is ever stabilized for perf, this keeps the honesty-
    // critical affordance from silently going stale.
    prevProps.deviceConnected === nextProps.deviceConnected &&
    // Include callback props to detect when they change
    prevProps.onClick === nextProps.onClick
  )
})
