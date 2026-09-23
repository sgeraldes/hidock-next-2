/**
 * Library copy for recordings the HiDock still holds a larger file of than the
 * copy on disk. That size difference is the evidence of a short download.
 *
 * A transcript running past the end of its file used to be read as lost audio.
 * It usually is not: transcribers get their timestamps wrong (measured on
 * 23-sep-2026, 924 of 2,049 transcripts repeat a start time), and the
 * transcript integrity labels report that case. This copy is only used when
 * there is audio to recover. The counts come from the main process
 * (download-service:truncated-recovery-plan); this only turns them into words.
 */

export interface TruncatedRecoveryCounts {
  truncated: number
  recoverable: number
  deviceNotLarger: number
  notOnDevice: number
  heldBack: number
  deviceListKnown?: boolean
}

function recordings(n: number): string {
  return `${n} recording${n === 1 ? '' : 's'}`
}

/** Toast body: what the device can give back, and that nothing is lost by asking. */
export function describeTruncatedRecovery(counts: TruncatedRecoveryCounts | null, _truncated: number): string {
  const recoverable = counts?.recoverable ?? 0
  const lines = [
    `The HiDock holds a larger file than the copy on disk for ${recordings(recoverable)}.`,
    'Downloading it again replaces the shorter copy.',
  ]
  if (counts && counts.heldBack > 0) {
    lines.push(`${counts.heldBack} is being recorded right now and was left alone.`)
  }
  lines.push('Nothing is deleted.')
  return lines.join(' ')
}

/** Label for the toast action that queues the recovery. */
export function recoverActionLabel(recoverable: number): string {
  return `Recover ${recoverable} from the device`
}
