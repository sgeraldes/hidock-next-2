import { ipcMain } from 'electron'
import { getActiveDeviceRecording } from './jensen-handlers'
import { planTruncatedRecovery, queueTruncatedRecovery } from '../services/truncated-recovery'

/** Counts the Library shows for truncated recordings; no paths leave the main process. */
export interface TruncatedRecoverySummary {
  truncated: number
  recoverable: number
  deviceNotLarger: number
  notOnDevice: number
  heldBack: number
  deviceListKnown: boolean
}

/**
 * Truncated-download recovery IPC. Both channels live in the download-service
 * namespace so the Device Sync feature gate covers them: with sync off there
 * is no USB path to recover through.
 *
 * Nothing here runs by itself. The Library asks for the plan when the duration
 * backfill reports truncated files, and the owner queues the recovery from the
 * toast that shows the counts.
 */
export function registerTruncatedRecoveryHandlers(): void {
  ipcMain.handle('download-service:truncated-recovery-plan', (): TruncatedRecoverySummary => {
    const plan = planTruncatedRecovery(getActiveDeviceRecording())
    return {
      truncated: plan.truncated,
      recoverable: plan.recoverable.length,
      deviceNotLarger: plan.deviceNotLarger,
      notOnDevice: plan.notOnDevice,
      heldBack: plan.heldBack,
      deviceListKnown: plan.deviceListKnown,
    }
  })

  ipcMain.handle('download-service:recover-truncated', () => {
    const { plan, queued, skipped } = queueTruncatedRecovery(getActiveDeviceRecording())
    return {
      queued,
      skipped,
      truncated: plan.truncated,
      recoverable: plan.recoverable.length,
      deviceNotLarger: plan.deviceNotLarger,
      notOnDevice: plan.notOnDevice,
      heldBack: plan.heldBack,
    }
  })
}
