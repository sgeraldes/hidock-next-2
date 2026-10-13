/**
 * Firmware install IPC for the pinned H1E 6.3.4 image: read-only preflight, prepare,
 * attempt journal, explicit execute, boot observation. Every call comes from the
 * app's own main frame and goes through the one shared USB owner and its
 * serializer; nothing here opens a second USB client.
 */

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { getJensenDevice, setFirmwareRecoveryChecker } from '../services/jensen'
import { serializeDeviceOperation } from '../services/device-operation-serializer'
import { getActiveTransferFilename } from '../services/download-transfer-controller'
import { liveRecordingInProgress, storageMoveInProgress } from '../services/storage-move-state'
import { FirmwareInstallJournal } from '../services/firmware-install-journal'
import { FirmwareInstallService } from '../services/firmware-install'
import { isFirmwareQualificationLaunch } from '../recovery-mode'

/** Only the app's own renderer, in its main frame, may reach a firmware channel. */
export function assertTrustedFirmwareSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url
  const expected = pathToFileURL(join(app.getAppPath(), 'out', 'renderer', 'index.html')).href
  const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender) ||
    !url || !(url.split('#')[0] === expected || (dev && new URL(url).origin === new URL(dev).origin))) {
    throw new Error('Firmware operation requires the trusted application window')
  }
}

export function registerFirmwareHandlers(): void {
  const journal = new FirmwareInstallJournal(join(app.getPath('userData'), 'firmware-install-attempts'))
  // A corrupt or unresolved journal keeps the shared USB owner read-only across restarts.
  setFirmwareRecoveryChecker(() => {
    try { return journal.pending().length > 0 } catch { return true }
  })
  const owner = () => getJensenDevice()
  const idle = (): boolean =>
    !liveRecordingInProgress() && !storageMoveInProgress('recordings') &&
    getActiveTransferFilename() === null && !owner().isOperationInProgress() && journal.pending().length === 0
  const install = new FirmwareInstallService({
    device: owner, journal, idle, serialize: serializeDeviceOperation,
    qualificationEnabled: isFirmwareQualificationLaunch(),
    artifactPath: app.isPackaged
      ? join(process.resourcesPath, 'firmware', 'h1e-rea-hardened.bin')
      : join(app.getAppPath(), 'resources', 'firmware', 'h1e-rea-hardened.bin'),
    // This build has no scratch-upload or recording-restore writer, so no durable
    // storage journal can be unresolved. The live-audio, transfer and move checks
    // above are the real owners. A later writer must report its own journal here.
    hasUnresolvedStorageOwnership: async () =>
      liveRecordingInProgress() || storageMoveInProgress('recordings') || getActiveTransferFilename() !== null,
  })

  ipcMain.handle('jensen:getFirmwareUpdatePreflight', (event: IpcMainInvokeEvent) => {
    assertTrustedFirmwareSender(event)
    return serializeDeviceOperation(async () => {
      const device = owner()
      if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !idle()) return null
      const result = await device.getFirmwareUpdatePreflight()
      if (!result || event.sender.isDestroyed() || !device.isConnected()) return null
      return { model: result.model, versionNumber: result.versionNumber, activeRecording: result.activeRecording, card: result.card }
    })
  })
  ipcMain.handle('jensen:prepareFirmwareInstall', (event: IpcMainInvokeEvent, target: unknown = 'hardened') => {
    assertTrustedFirmwareSender(event)
    if (target !== 'hardened') throw new Error('Unknown firmware target')
    return install.prepare(target)
  })
  ipcMain.handle('jensen:getFirmwareInstallAttempts', (event: IpcMainInvokeEvent) => {
    assertTrustedFirmwareSender(event)
    return install.status()
  })
  ipcMain.handle('jensen:executeFirmwareInstall', (event: IpcMainInvokeEvent, id: unknown, sha256: unknown) => {
    assertTrustedFirmwareSender(event)
    if (typeof id !== 'string' || typeof sha256 !== 'string') throw new Error('Prepared attempt and digest required')
    return install.execute(id, sha256)
  })
  ipcMain.handle('jensen:observeFirmwareInstall', (event: IpcMainInvokeEvent, id: unknown) => {
    assertTrustedFirmwareSender(event)
    if (typeof id !== 'string') throw new Error('Prepared attempt required')
    return install.observe(id)
  })
}
