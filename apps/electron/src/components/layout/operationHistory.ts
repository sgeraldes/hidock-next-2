/**
 * Operations history helpers shared by the Operations panel and the titlebar
 * bell, so both count and name the same rows.
 *
 * A failure written by an earlier app session (the main process flags it:
 * download rows reloaded at boot, transcription rows stamped before this
 * process started) is "earlier". Queued and running work, and this session's
 * failures, are "current". Badges and the default list show current rows; the
 * earlier ones sit in one collapsed group that clears in one click.
 */

import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'
import type { UnifiedRecording } from '@/types/unified-recording'
import type { DownloadQueueEntry } from '@/store/useAppStore'

const ACTIVE_DOWNLOAD_STATUSES = new Set(['pending', 'downloading', 'cancelling'])

/**
 * Merge renderer progress hints into the main-process queue. Once a main queue
 * snapshot exists, its membership and statuses are authoritative; renderer-only
 * rows may be stale after a missed terminal update.
 */
export function mergeDownloadQueues(
  rendererItems: Iterable<DownloadQueueEntry>,
  mainItems: readonly DownloadQueueEntry[],
  mainIsAuthoritative = true
): DownloadQueueEntry[] {
  const rendererByFilename = new Map<string, DownloadQueueEntry>()
  for (const item of rendererItems) rendererByFilename.set(item.filename, item)

  const mergeItem = (mainItem: DownloadQueueEntry): DownloadQueueEntry => {
    const rendererItem = rendererByFilename.get(mainItem.filename)
    const preserveFastProgress = rendererItem?.status === 'downloading' && mainItem.status === 'downloading'
    return {
      ...(rendererItem ?? {}),
      ...mainItem,
      progress: preserveFastProgress
        ? Math.max(rendererItem!.progress, mainItem.progress)
        : mainItem.progress
    }
  }

  if (mainIsAuthoritative) return mainItems.map(mergeItem)

  const merged = new Map<string, DownloadQueueEntry>(rendererByFilename)
  for (const item of mainItems) merged.set(item.filename, mergeItem(item))
  return Array.from(merged.values())
}

/** Count only queue rows that are actually pending, transferring, or cancelling. */
export function countActiveDownloads(items: readonly Pick<DownloadQueueEntry, 'status'>[]): number {
  return items.filter((item) => ACTIVE_DOWNLOAD_STATUSES.has(item.status)).length
}

export interface SessionTagged {
  status: string
  fromPreviousSession?: boolean
}

/**
 * Failures only. A user-cancelled download from an earlier session stays in
 * the normal list: its row is the durable marker that stops reconciliation
 * from queuing the file again, so it must never go in a one-click Clear.
 */
export function isEarlierFailure(item: SessionTagged): boolean {
  return item.fromPreviousSession === true && item.status === 'failed'
}

export function splitBySession<T extends SessionTagged>(items: readonly T[]): { current: T[]; earlier: T[] } {
  const current: T[] = []
  const earlier: T[] = []
  for (const item of items) (isEarlierFailure(item) ? earlier : current).push(item)
  return { current, earlier }
}

/** The Library source a download row refers to (device or local file name). */
export function recordingForDownload(
  recordings: readonly UnifiedRecording[],
  filename: string
): UnifiedRecording | undefined {
  return recordings.find((r) => r.filename === filename || ('deviceFilename' in r && r.deviceFilename === filename))
}

/** How an operation row names its recording: the display title, never the file name. */
export function operationLabel(recording: UnifiedRecording | undefined): string {
  return recording ? getDisplayTitle(recording).primaryText : 'Recording'
}
