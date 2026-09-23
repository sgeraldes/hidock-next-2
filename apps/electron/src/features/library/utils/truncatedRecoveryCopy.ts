/**
 * Library copy for recordings whose file on disk is shorter than their
 * transcript. The counts come from the main process
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

function files(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`
}

/** Toast body: what was found, what the device can give back, what is gone. */
export function describeTruncatedRecovery(counts: TruncatedRecoveryCounts | null, truncated: number): string {
  const lines = [
    `${files(truncated)} on disk hold${truncated === 1 ? 's' : ''} less audio than was transcribed from ${truncated === 1 ? 'it' : 'them'}.`,
  ]
  if (counts) {
    if (counts.recoverable > 0) {
      lines.push(`The HiDock still has a complete copy of ${counts.recoverable}.`)
    }
    if (counts.deviceNotLarger > 0) {
      lines.push(
        `${counts.deviceNotLarger} match${counts.deviceNotLarger === 1 ? 'es' : ''} the HiDock's copy in size, so downloading again would not bring anything back.`
      )
    }
    if (counts.deviceListKnown === false) {
      lines.push('Connect the HiDock to check which of them it still holds.')
    } else if (counts.notOnDevice > 0) {
      lines.push(
        `${counts.notOnDevice} ${counts.notOnDevice === 1 ? 'is' : 'are'} no longer on the HiDock, so the missing audio cannot be recovered.`
      )
    }
    if (counts.heldBack > 0) {
      lines.push(`${counts.heldBack} is being recorded right now and was left alone.`)
    }
  }
  lines.push('Nothing was deleted and their stored length is unchanged.')
  return lines.join(' ')
}

/** Label for the toast action that queues the recovery. */
export function recoverActionLabel(recoverable: number): string {
  return `Recover ${recoverable} from the device`
}
