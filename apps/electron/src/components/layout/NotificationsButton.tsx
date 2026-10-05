/**
 * NotificationsButton — the titlebar 🔔 for background operations.
 *
 * Clicking the bell opens a small POPOVER that lists what's actually happening
 * right now — transcriptions in flight / queued / failed and active downloads —
 * with an empty state ("No recent activity") when nothing is going on. A footer
 * "View all in Operations" routes to the SAME shared Operations overlay the
 * sidebar Operations badge opens (`openOperationsOverlay`), so the two entry
 * points converge on one detail surface rather than a bespoke second queue.
 *
 * Count reconciliation with the sidebar Operations badge: BOTH badges derive
 * from the identical store selectors — `useDownloadQueue` + `useTranscriptionStats`
 * — so they are one source of truth and can never diverge. We intentionally keep
 * the sidebar badge (owned by OperationsPanel) as-is and make the titlebar bell
 * the SAME source rather than a second, independent counter.
 *
 * Both also drop failures from earlier app sessions (operationHistory), which
 * the Operations overlay keeps in a collapsed "Earlier failures" group.
 */

import { TranscriptionActivity } from './TranscriptionActivity'
import { useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bell, Download, AlertCircle, RefreshCw, ArrowRight, X, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BusyIcon } from '@/components/ui/working'
import { useDownloadQueue, useUnifiedRecordings } from '@/store/useAppStore'
import type { DownloadQueueEntry } from '@/store/useAppStore'
import { useTranscriptionStats, useTranscriptionStore } from '@/store/features/useTranscriptionStore'
import type { TranscriptionItem, TranscriptionStatus } from '@/store/features/useTranscriptionStore'
import { useUIStore } from '@/store/ui/useUIStore'
import { useOperations } from '@/hooks/useOperations'
import { isRetryableDownloadItem } from '@/hooks/useDownloadOrchestrator'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { isFeatureOffThisRun } from '@/lib/bootFeatures'
import { isEarlierFailure, operationLabel, recordingForDownload } from './operationHistory'


/**
 * A running or waiting state drawn as an icon (and the percentage when known);
 * the words go to the tooltip and screen readers (owner, 2-oct-2026). The row
 * keeps the file name, so it still says WHICH file is in that state.
 */
function StateMark({ label, waiting, percent }: { label: string; waiting?: boolean; percent?: number }) {
  const name = percent !== undefined ? `${label}, ${percent}%` : label
  return (
    <span role="img" aria-label={name} title={name} className="inline-flex items-center gap-1 align-middle">
      {waiting ? (
        <Clock className="h-3 w-3 motion-safe:animate-pulse" aria-hidden="true" />
      ) : (
        <BusyIcon className="h-3 w-3" />
      )}
      {percent !== undefined && <span aria-hidden="true" className="tabular-nums">{percent}%</span>}
    </span>
  )
}

/** Status of a transcription: an icon while queued or running, words once it ends. */
function transcriptionStatus(status: TranscriptionStatus): ReactNode {
  switch (status) {
    case 'pending':
      return <StateMark label="Queued" waiting />
    case 'processing':
      return <StateMark label="Transcribing" />
    case 'completed':
      return 'Done'
    case 'cancelled':
      return 'Stopped'
    default:
      return 'Failed'
  }
}

/** Display order: active first, then queued, then failed. */
function statusRank(s: TranscriptionStatus): number {
  return s === 'processing' ? 0 : s === 'pending' ? 1 : s === 'failed' ? 2 : 3
}

/** Status of a download row: an icon (and the percentage) while it waits or runs, words once it ends. */
function downloadStatus(dl: DownloadQueueEntry): ReactNode {
  switch (dl.status) {
    case 'pending':
      return <StateMark label="Queued" waiting />
    case 'cancelling':
      return <StateMark label="Cancelling" />
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
    case 'completed':
      return 'Done'
    default:
      return dl.progress > 0
        ? <StateMark label="Downloading" percent={Math.round(dl.progress)} />
        : <StateMark label="Starting download" />
  }
}

/** A download the user can still cancel (queued or actively transferring). */
function isCancelableDownload(dl: DownloadQueueEntry): boolean {
  return dl.status === 'pending' || dl.status === 'downloading'
}

export function NotificationsButton() {
  const downloadQueue = useDownloadQueue()
  const txStats = useTranscriptionStats()
  const txQueue = useTranscriptionStore((s) => s.queue)
  const recordings = useUnifiedRecordings()
  const openOperationsOverlay = useUIStore((s) => s.openOperationsOverlay)
  const { cancelDownload, cancelAllDownloads, cancelTranscription } = useOperations()
  const retry = useTranscriptionStore((s) => s.retry)
  const dismiss = useTranscriptionStore((s) => s.dismiss)
  const prioritize = useTranscriptionStore((s) => s.prioritize)
  const deprioritize = useTranscriptionStore((s) => s.deprioritize)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [persistedDownloads, setPersistedDownloads] = useState<DownloadQueueEntry[]>([])

  // The renderer queue intentionally drops terminal download failures so a
  // failed item cannot disable a fresh Download action forever. Notifications
  // still needs the same durable failure projection as the Operations panel;
  // otherwise the two badges disagree (for example, 3 versus 4 failures).
  useEffect(() => {
    const api = window.electronAPI?.downloadService
    if (!api || isFeatureOffThisRun('device-sync')) return
    const project = (state: { queue: Array<{ filename: string; fileSize: number; progress: number; status: DownloadQueueEntry['status']; error?: string; cancelReason?: 'user' | 'interrupted'; fromPreviousSession?: boolean }> }) => {
      setPersistedDownloads(state.queue.map((item) => ({
        filename: item.filename,
        size: item.fileSize,
        progress: item.progress,
        status: item.status,
        error: item.error,
        cancelReason: item.cancelReason,
        fromPreviousSession: item.fromPreviousSession
      })))
    }
    api.getState().then((state) => project(state)).catch(() => {})
    return api.onStateUpdate(project)
  }, [])

  // Derive the popover list from the same Maps that feed the badge. Computed in a
  // memo keyed on the Map refs so we don't hand Zustand a fresh array selector.
  const transcriptions = useMemo<TranscriptionItem[]>(
    () =>
      Array.from(txQueue.values())
        .filter((i) => i.status !== 'completed' && !isEarlierFailure(i))
        .sort((a, b) => statusRank(a.status) - statusRank(b.status)),
    [txQueue]
  )
  const downloads = useMemo(() => {
    const merged = new Map(persistedDownloads.map((item) => [item.filename, item]))
    for (const item of downloadQueue.values()) merged.set(item.filename, item)
    return Array.from(merged.values()).filter((item) => item.status !== 'completed' && !isEarlierFailure(item))
  }, [downloadQueue, persistedDownloads])
  // Only pending/downloading/cancelling count as in progress. Failed downloads
  // remain actionable history and belong in the error count instead.
  const activeDownloadCount = useMemo(
    () => downloads.filter((d) => ['pending', 'downloading', 'cancelling'].includes(d.status)).length,
    [downloads]
  )
  const failedDownloadCount = useMemo(
    () => downloads.filter(isRetryableDownloadItem).length,
    [downloads]
  )
  const canCancelAllDownloads = useMemo(() => downloads.some(isCancelableDownload), [downloads])

  const active = txStats.processing + txStats.pending + activeDownloadCount
  // This session's failures only, matching the Operations badge.
  const failedTranscriptionCount = transcriptions.filter((i) => i.status === 'failed').length
  const errors = failedTranscriptionCount + failedDownloadCount
  const total = active + errors
  // Keep the popover populated while a cancelled row flashes, even if the badge count
  // has already dropped to zero.
  const hasActivity = total > 0 || downloads.length > 0 || transcriptions.length > 0

  const viewAll = () => {
    setOpen(false)
    openOperationsOverlay()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            active > 0 || errors > 0
              ? `Notifications: ${active} operation${active === 1 ? '' : 's'} in progress${errors ? `, ${errors} failed` : ''}`
              : 'Notifications'
          }
          aria-haspopup="dialog"
          title="Notifications & operations"
          className="titlebar-no-drag relative flex h-7 w-7 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-slate-700 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 data-[state=open]:bg-slate-700 data-[state=open]:text-white"
        >
          <Bell className={cn('h-4 w-4', active > 0 && 'animate-pulse motion-reduce:animate-none')} />
          {total > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                'absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none text-white ring-2 ring-slate-900',
                errors > 0 ? 'bg-red-500' : 'bg-sky-500'
              )}
            >
              {total > 99 ? '99+' : total}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0" aria-label="Notifications">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {total > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {active > 0 && errors > 0 ? `${active} active · ${errors} failed` : active > 0 ? `${active} active` : `${errors} failed`}
            </span>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {!hasActivity ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No recent activity</p>
          ) : (
            <ul className="space-y-0.5">
              {transcriptions.map((item) => (
                <li key={item.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                  {item.status === 'processing' && (
                    <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-purple-500 motion-reduce:animate-none" />
                  )}
                  {item.status === 'pending' && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-yellow-500/80" />}
                  {item.status === 'failed' && <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{operationLabel(recordings.find((r) => r.id === item.recordingId))}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {transcriptionStatus(item.status)}
                    </div>
                    <TranscriptionActivity item={item} onStop={cancelTranscription} onRetry={(id) => { void retry(id) }} onDismiss={(id) => { void dismiss(id) }} />
                    {item.status === 'pending' && <div className="flex flex-wrap gap-1 text-xs">
                      <button type="button" className="rounded px-2 py-1 hover:bg-accent" onClick={() => prioritize(item.id)}>Move up</button>
                      <button type="button" className="rounded px-2 py-1 hover:bg-accent" onClick={() => deprioritize(item.id)}>Move down</button>
                      <button type="button" className="rounded px-2 py-1 hover:bg-accent" onClick={() => { void cancelTranscription(item.recordingId) }}>Remove from queue</button>
                    </div>}
                    <button type="button" className="rounded px-2 py-1 text-xs hover:bg-accent" onClick={() => { navigate('/library', { state: { selectedId: item.recordingId, focusProcessing: true } }); setOpen(false) }}>View source</button>
                  </div>
                </li>
              ))}
              {downloads.map((dl) => {
                const dlLabel = operationLabel(recordingForDownload(recordings, dl.filename))
                return (
                <li key={`dl-${dl.filename}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                  {dl.status === 'failed' ? (
                    <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                  ) : dl.status === 'cancelling' ? (
                    <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-amber-500 motion-reduce:animate-none" />
                  ) : (
                    <Download
                      className={cn(
                        'h-4 w-4 shrink-0',
                        dl.status === 'cancelled' ? 'text-slate-400' : 'text-emerald-500'
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{dlLabel}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {downloadStatus(dl)}{dl.error ? ` · ${dl.error}` : ''}
                    </div>
                  </div>
                  {(isCancelableDownload(dl) || dl.status === 'cancelling') && (
                    <button
                      type="button"
                      onClick={() => cancelDownload(dl.filename)}
                      disabled={dl.status === 'cancelling'}
                      aria-label={`Cancel download ${dlLabel}`}
                      title="Cancel download"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-500 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
                )
              })}
            </ul>
          )}
        </div>

        {(hasActivity || canCancelAllDownloads) && (
          <div className="flex items-center gap-1.5 border-t p-1.5">
            {canCancelAllDownloads && (
              <button
                type="button"
                onClick={() => cancelAllDownloads()}
                aria-label="Cancel all downloads"
                className="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-400 dark:text-red-400"
              >
                <X className="h-3.5 w-3.5" />
                Cancel all downloads
              </button>
            )}
            <button
              type="button"
              onClick={viewAll}
              className="ml-auto flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              View all in Operations
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default NotificationsButton
