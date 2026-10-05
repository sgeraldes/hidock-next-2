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
  if (!recording) return 'Recording'
  const title = getDisplayTitle(recording)
  const date = recording.dateRecorded
  return title.source !== 'date' && date instanceof Date && !Number.isNaN(date.getTime())
    ? `${title.primaryText} · ${date.toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : title.primaryText
}
