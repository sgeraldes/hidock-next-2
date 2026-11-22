import { stageDownload } from '../services/download-staging'
import { DeviceFileSystem } from '../services/device-file-system'
import { DeviceDrive } from '../services/device-drive'
import { createDeviceShutdown } from '../device-shutdown'
import { DeviceStorage } from '../services/device-storage'
import { DeviceScratchUploadService } from '../services/device-scratch-upload'
import { DeviceScratchJournal } from '../services/device-scratch-journal'
import { DeviceRecordingRestoreService } from '../services/device-recording-restore'
import { DeviceRecordingRestoreJournal } from '../services/device-recording-restore-journal'
import { getTrustedRecordingRestoreSource } from '../services/device-recording-restore-source'
import { OriginalRecordingBackupStore, registerHostDownloadTransfer } from '../services/original-recording-backups'
import { planDeviceRecordingBackupPreflight } from '../services/device-recording-backup-preflight'
import { readOwnedRecordingRestore } from '../services/device-recording-restore-readback'
import type { DeviceRecordingRestoreAppend, DeviceRecordingRestoreAssurance } from '../../../src/shared/device-recording-restore'
import type { DeviceScratchAppend, DeviceScratchUploadDescriptor, DeviceScratchWriteAssurance } from '../../../src/shared/device-scratch-upload'
import { downloadWithResume, forgetPublishedResume, releaseResumedDownload } from '../services/download-resume'
/**
 * Jensen IPC handlers — exposes all Jensen device commands to the renderer.
 *
 * This is a temporary migration bridge (Phase 1). In Phase 3 the renderer will
 * use useDevicePipeline instead of calling these channels directly.
 *
 * Push event patterns:
 *  - Broadcast  : BrowserWindow.getAllWindows()[0].webContents.send() — state, connect, disconnect
 *  - Targeted   : event.sender.send() — download chunks/progress, realtime data
 *
 * Security: All user-supplied values are validated with Zod before reaching the device.
 */

import { ipcMain, BrowserWindow, app, webContents, safeStorage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRecoveryMode, isFirmwareReadOnlyLaunch, isDeviceValidationLaunch, isFirmwareQualificationLaunch, isFirmwareStockRecoveryLaunch } from '../recovery-mode'
import { supportsRealtimeFirmware, isFirmwareConsoleRequest, splitRealtimeChannelsTap } from '@hidock/jensen-protocol'
import type { CustomRecordingProfile, CustomRecordingFormat, CustomMarkerRules } from '@hidock/jensen-protocol'
import { getJensenDevice, setFirmwareRecoveryChecker, setDeviceValidationChecker } from '../services/jensen'
import { FirmwareInstallJournal } from '../services/firmware-install-journal'
import { FirmwareInstallService } from '../services/firmware-install'
import { retryPendingFileCleanups } from '../services/recording-deletion-service'
import { serializeDeviceOperation } from '../services/device-operation-serializer'
import { emitActivityLog } from '../services/activity-log'
import { getDownloadService } from '../services/download-service'
import { liveTranscription } from '../services/live-transcription-coordinator'
import { RealtimeRecorder, recoverPartialLiveRecordings, type RecorderResult } from '../services/realtime-recorder'
import { DeviceAudioSession } from '../services/device-audio-session'
import { DeviceAudioDiagnostics } from '../services/device-audio-diagnostics'
import { DeviceNativeRecordingControl } from '../services/device-native-recording'
import { markNativeFileManualOnly } from '../services/device-native-file-policy'
import { isAuditedCustomRecordingFirmware, isAuditedNativeRecordingFirmware } from '../services/device-audited-firmware'
import type { NativeRecordingRequest } from '../../../src/shared/device-native-recording'
import { bindDeviceMarkerCapture } from '../services/device-recording-runtime'
import type { DeviceAudioStartOptions, DeviceRecordingCapabilities } from '../../../src/shared/device-audio'
import { getRecordingsPath } from '../services/file-storage'
import { getDatabase, getRecordingById, getRecordings, runInTransaction } from '../services/database'
import { getConfig } from '../services/config'
import { setLiveRecording, storageMoveInProgress } from '../services/storage-move-state'
import {
  trackActiveTransfer,
  cancelAllTransfers,
  abortAllTransfers,
  getActiveTransferFilename,
  hasPendingTransfer,
} from '../services/download-transfer-controller'
import {
  JensenDeleteFileSchema,
  JensenSetAutoRecordSchema,
  JensenDownloadFileSchema,
  JensenRealtimeDataSchema,
  JensenRealtimeStartSchema,
  JensenBluetoothScanSchema,
} from './jensen-validation'

// ---------------------------------------------------------------------------
// In-flight download abort is owned by the shared download-transfer-controller
// (also used by the higher-level download-service cancel/cancel-all handlers).
// jensen:downloadFile registers the active transfer; jensen:cancelDownload aborts
// it and awaits USB settlement; jensen:disconnect aborts it for teardown.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Serialize device operations (connect / tryConnect / disconnect / reset /
// listFiles / getFileCount / deleteFile). Rapid UI clicks otherwise interleave open/setup/
// read-loop with reset/close, OR start a file-list scan during/after a
// disconnect — corrupting device state (ACCESS lock, "no recordings"). This runs
// them one-at-a-time in arrival order; a failed op never breaks the chain.
//
// disconnect/reset additionally call device.abortInFlight() *before* queueing,
// so they preempt a running (or stalled) scan/download instead of waiting behind
// it in the chain.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Broadcast helper — sends to the first available window
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload?: unknown): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return
  const win = wins[0]
  if (!win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// ---------------------------------------------------------------------------
// Live-recording poll
//
// The HiDock exposes no push notification for its physical record button, so we
// poll GET_RECORDING_FILE (CMD 18) while connected. The device answers with the
// in-progress recording's filename, or an empty body when idle. On change we
// broadcast `jensen:recording-changed` so the renderer can light up the "Recording
// now" indicators.
//
// Poll discipline (this was the source of a protocol desync — see below):
//  1. It does NOT start on connect. It starts only after the FIRST file-list
//     scan completes (startRecordingPoll() is called from jensen:listFiles), so
//     it can never fire during the connect handshake / device-info / initial
//     scan. Kicking a 5s-timeout CMD 18 into that window is what desynced the
//     command/response pairing (SN null, empty list, stalled downloads).
//  2. It is SKIPPED (not queued) whenever a transfer or scan is in flight
//     (device.isOperationInProgress() or an active download abort) — a skipped
//     poll is free; a queued one would add latency to the transfer.
//  3. On a timed-out / failed read it BACKS OFF to 60s so a slow or busy device
//     isn't hammered; a healthy read restores the 20s cadence.
// It is still issued through the shared device-operation chain, and the device's own
// command lock is the final backstop — a poll can never interleave on the bus.
//
// Inherent limit: this only works while the app is CONNECTED. A device recording
// while the app is closed/disconnected is invisible until the next connect.
// ---------------------------------------------------------------------------

const RECORDING_POLL_INTERVAL_MS = 20_000
const RECORDING_POLL_BACKOFF_MS = 60_000
const RECORDING_POLL_KICKOFF_MS = 1500

let recordingPollTimer: ReturnType<typeof setInterval> | null = null
let stopDeviceStorage: (() => Promise<unknown>) | null = null
let deviceShutdownStarted = false
let recordingPollKickoff: ReturnType<typeof setTimeout> | null = null
let recordingPollIntervalMs = RECORDING_POLL_INTERVAL_MS
// undefined = unknown (never read yet); string = actively recording; null = idle.
let lastRecordingFilename: string | null | undefined = undefined

/**
 * The device's in-progress recording as the CMD-18 poll last saw it: a
 * filename while recording, null when confirmed idle, undefined when unknown.
 * Main-process readers (truncated-download recovery) use it to keep their
 * hands off the file the device is still writing.
 */
export function getActiveDeviceRecording(): string | null | undefined {
  return lastRecordingFilename
}

function scheduleRecordingPoll(intervalMs: number): void {
  if (recordingPollTimer) clearInterval(recordingPollTimer)
  recordingPollIntervalMs = intervalMs
  recordingPollTimer = setInterval(() => {
    void pollRecordingOnce()
  }, intervalMs)
}

async function pollRecordingOnce(): Promise<void> {
  if (deviceShutdownStarted) return
  const device = getJensenDevice()
  if (!device.isConnected()) return
  // Do NOT interleave with an in-flight transfer / scan on the USB bus.
  if (device.isOperationInProgress() || getActiveTransferFilename() !== null) return

  let result: { recording: string | null } | null
  try {
    result = await serializeDeviceOperation(() => device.getRecordingFile())
  } catch {
    return
  }

  if (deviceShutdownStarted) return

  if (!result) {
    // Timeout / transient failure — back off so we don't retry a struggling
    // device every 20s (which risks repeated timeouts under heavy activity).
    if (device.isConnected() && recordingPollIntervalMs !== RECORDING_POLL_BACKOFF_MS) {
      scheduleRecordingPoll(RECORDING_POLL_BACKOFF_MS)
    }
    return // keep the last known state
  }

  // Healthy read — restore the normal cadence if we had backed off.
  if (recordingPollIntervalMs !== RECORDING_POLL_INTERVAL_MS) {
    scheduleRecordingPoll(RECORDING_POLL_INTERVAL_MS)
  }

  const filename = result.recording && result.recording.length > 0 ? result.recording : null
  if (filename !== lastRecordingFilename) {
    lastRecordingFilename = filename
    // The per-poll CMD-18 send/recv logs are suppressed in the protocol layer
    // (they printed every 20s forever) — one line per actual state CHANGE keeps
    // the console signal without the spam.
    console.log(`[Jensen] recording state: ${filename ?? 'idle'}`)
    broadcast('jensen:recording-changed', { recording: filename })
  }
}

/**
 * What the recording poll last saw, for readers that must not touch the USB bus
 * themselves. `known` is false until the first successful poll after a connect;
 * `recording` is the filename being written, or null when the device is idle.
 */
export function getLiveRecordingState(): { known: boolean; recording: string | null } {
  if (lastRecordingFilename === undefined) return { known: false, recording: null }
  return { known: true, recording: lastRecordingFilename }
}

// Idempotent — safe to call after every scan. Starts the poll the first time the
// device has fully initialized (a file-list scan has completed).
function startRecordingPoll(): void {
  if (isRecoveryMode() || deviceShutdownStarted) return
  if (recordingPollTimer) return
  lastRecordingFilename = undefined
  scheduleRecordingPoll(RECORDING_POLL_INTERVAL_MS)
  // Early first read so the indicator appears without waiting a full interval.
  // The busy-guard skips it if a follow-up op is still running.
  recordingPollKickoff = setTimeout(() => {
    void pollRecordingOnce()
  }, RECORDING_POLL_KICKOFF_MS)
}

function stopRecordingPoll(): void {
  if (recordingPollTimer) {
    clearInterval(recordingPollTimer)
    recordingPollTimer = null
  }
  if (recordingPollKickoff) {
    clearTimeout(recordingPollKickoff)
    recordingPollKickoff = null
  }
  recordingPollIntervalMs = RECORDING_POLL_INTERVAL_MS
  const wasRecording = !!lastRecordingFilename
  lastRecordingFilename = undefined
  // Clear the indicator on disconnect (a device unplugged mid-record must not
  // leave a stale "Recording now" card).
  if (wasRecording) broadcast('jensen:recording-changed', { recording: null })
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

// The realtime stream, saved as a recording while it plays (28-sep-2026).
const liveRecorder = new RealtimeRecorder({
  recordingsPath: () => getRecordingsPath(),
  enabled: () => getConfig().transcription?.liveSaveRecording !== false,
  folderMoving: () => storageMoveInProgress('recordings'),
  now: () => new Date(),
  micChannel: () => {
    const t = getConfig().transcription
    const pinned = t?.liveMicChannel
    const measured = t?.liveMicChannelMeasured
    return pinned === 0 || pinned === 1 ? pinned : measured === 0 || measured === 1 ? measured : null
  }
})

function tellWindows(result: RecorderResult | { status: 'error'; message: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('jensen:realtime-recording', result)
  }
}

/** Never throws: a recording problem must not stop the stream or its live transcript. */
function startLiveRecording(options: DeviceAudioStartOptions = {}, captureSessionId?: string): string | null {
  let why: string | null
  try {
    why = liveRecorder.start({ save: options.saveRecording, strictStereo: true, preserveMutedPayload: false, captureSessionId, automaticTranscription: false })
  } catch (err) {
    why = `Could not start the live recording: ${err instanceof Error ? err.message : String(err)}`
  }
  setLiveRecording(liveRecorder.recording)
  if (why && why !== 'off') tellWindows({ status: 'error', message: why })
  return why
}

const liveDiagnostics = new DeviceAudioDiagnostics()
const liveSenders = new Map<number, Parameters<typeof liveTranscription.start>[0]>()
const destructionObservers = new WeakSet<object>()
let lastCaptureSessionId: string | null = null
let liveRead: ReturnType<ReturnType<typeof getJensenDevice>['getRealtimeData']> | null = null
let lastDiagnosticsAt = 0
const audioSession = new DeviceAudioSession({
  startDevice: () => nativeRecordingControl.startLive(() => getJensenDevice().startRealtime(2), () => audioSession.snapshot().status === 'starting'),
  pauseDevice: () => getJensenDevice().pauseRealtime(),
  stopDevice: () => getJensenDevice().stopRealtime(),
  startTranscription: owner => {
    const sender = liveSenders.get(owner)
    if (!sender) return Promise.reject(new Error('Live window unavailable'))
    return liveTranscription.start(sender)
  },
  pauseTranscription: () => liveTranscription.pause(),
  stopTranscription: () => liveTranscription.stop(),
  startRecording: (options, sessionId) => {
    lastCaptureSessionId = sessionId
    return startLiveRecording(options, sessionId)
  },
  finishRecording: () => finishLiveRecordingFile(),
  beginDiagnostics: () => { liveDiagnostics.reset(); lastDiagnosticsAt = 0 },
  noteDiscontinuity: reason => { liveDiagnostics.noteDiscontinuity(reason); liveRecorder.noteDiscontinuity(reason) }
})
const nativeRecordingControl = new DeviceNativeRecordingControl({
  device: () => getJensenDevice(),
  busy: () => getJensenDevice().isOperationInProgress() || getActiveTransferFilename() !== null,
  liveIdle: () => audioSession.snapshot().status === 'idle',
  serialize: serializeDeviceOperation,
  directory: () => join(app.getPath('userData'), 'device-native-command-journal'),
  protectNewFile: markNativeFileManualOnly
})
bindDeviceMarkerCapture(() => ({
  sessionId: audioSession.snapshot().sessionId,
  elapsedMs: liveRecorder.recording ? liveRecorder.elapsedMs : liveDiagnostics.snapshot().sampleElapsedMs,
  filePath: liveRecorder.outputPath ?? undefined
}))

function recordingCapabilities(): DeviceRecordingCapabilities {
  const device = getJensenDevice()
  return {
    model: device.getModel(), firmwareVersion: device.versionCode ?? null,
    live: { available: supportsRealtimeFirmware(device.getModel(), device.versionNumber), evidence: 'host-version-gate', format: 'host-expectation', sampleRate: 16000, channels: 2, bitDepth: 16 },
    native: { profileControl: false, markerInsertion: isAuditedNativeRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode),
      profiles: [], sourceMapping: 'unverified',
      customRecordingControls: { available: device.isConnected() && isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode),
        evidence: 'audited-firmware-gate', totalMp3BitratesKbps: [64, 96, 128, 160], formats: ['mp3', 'wav'], channels: 2 } },
    host: { captureWithoutProvider: true, stereoWav: true, trackExport: true, localMarkers: true }
  }
}

/** Close the live file, if one is open. Every way a stream ends comes through here, quitting included. */
function finishLiveRecordingFile(): void {
  let result: RecorderResult | null
  try {
    result = liveRecorder.finish()
  } catch (err) {
    result = { status: 'error', message: err instanceof Error ? err.message : String(err) }
  } finally {
    setLiveRecording(false)
  }
  if (result && result.status !== 'empty') tellWindows(result)
}

/** Shutdown invalidates pending reads/starts immediately, saves audio and ends optional AI. */
export function finishLiveRecording(): void {
  void endLiveAudioLocally('shutdown')
}

/** Await transfer drain, audio finalization and temporary drive cleanup at quit. */
export const shutdownJensenResources = createDeviceShutdown({
  cancelTransfers: reason => {
    deviceShutdownStarted = true
    stopRecordingPoll()
    return cancelAllTransfers(reason)
  },
  finishAudio: reason => endLiveAudioLocally(reason),
  unmountStorage: async () => { await stopDeviceStorage?.() }
})

export function endLiveAudioLocally(reason: string): Promise<void> {
  liveSenders.clear()
  return audioSession.endLocally(reason)
}

export function registerJensenHandlers(): void {
  setDeviceValidationChecker(() => isDeviceValidationLaunch())
  const firmwareJournal = new FirmwareInstallJournal(join(app.getPath('userData'), 'firmware-install-attempts'))
  setFirmwareRecoveryChecker(() => {
    try { return isFirmwareReadOnlyLaunch() || firmwareJournal.pending().length > 0 } catch { return true }
  })
  const firmwareInstall = new FirmwareInstallService({
    device: getJensenDevice, journal: firmwareJournal,
    maintenanceReadOnly: isFirmwareReadOnlyLaunch() || isDeviceValidationLaunch(),
    qualificationEnabled: isFirmwareQualificationLaunch(),
    stockRecoveryEnabled: isFirmwareStockRecoveryLaunch(),
    hasUnresolvedStorageOwnership: async () =>
      await scratch.hasUnresolvedOwnership() || await restore.hasUnresolvedOwnership(),
    artifactPath: app.isPackaged ? join(process.resourcesPath, 'firmware', 'h1e-rea-hardened.bin') : join(app.getAppPath(), 'resources', 'firmware', 'h1e-rea-hardened.bin'),
    forwardStockArtifactPath: app.isPackaged ? join(process.resourcesPath, 'firmware', 'h1e-stock-forward.bin') : join(app.getAppPath(), 'resources', 'firmware', 'h1e-stock-forward.bin'),
    serialize: serializeDeviceOperation,
    idle: () => audioSession.snapshot().status === 'idle' && !getJensenDevice().isOperationInProgress() && !hasPendingTransfer(),
  })
  const firmwareSender = (event: Electron.IpcMainInvokeEvent): void => {
    const url = event.senderFrame?.url
    const expected = pathToFileURL(join(app.getAppPath(), 'out', 'renderer', 'index.html')).href
    const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender) ||
      !url || !(url.split('#')[0] === expected || (dev && new URL(url).origin === new URL(dev).origin))) throw new Error('Firmware operation requires the trusted application window')
  }
  const storage = new DeviceStorage(getJensenDevice, serializeDeviceOperation)
  const originalBackupStores = new WeakMap<ReturnType<typeof getDatabase>, OriginalRecordingBackupStore>()
  const originalBackups = (): OriginalRecordingBackupStore => {
    const database = getDatabase()
    let receipts = originalBackupStores.get(database)
    if (!receipts) {
      receipts = new OriginalRecordingBackupStore({ db: database, transaction: runInTransaction })
      originalBackupStores.set(database, receipts)
    }
    return receipts
  }
  let scratchRequests = 0
  const invokeScratch = async <T>(event: Electron.IpcMainInvokeEvent, operation: () => Promise<T>): Promise<T> => {
    firmwareSender(event)
    if (scratchRequests >= 32) throw Error('Scratch operation queue is full')
    scratchRequests++
    try { return await operation() } finally { scratchRequests-- }
  }
  const scratch = new DeviceScratchUploadService({
    device: getJensenDevice, serialize: serializeDeviceOperation,
    journal: new DeviceScratchJournal(join(app.getPath('userData'), 'device-scratch-ownership'), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: plaintext => safeStorage.encryptString(plaintext),
      decryptString: ciphertext => safeStorage.decryptString(ciphertext),
    }),
    idle: () => audioSession.snapshot().status === 'idle' && !hasPendingTransfer() && !getJensenDevice().isOperationInProgress() && firmwareJournal.pending().length === 0,
    normalJensen: () => getJensenDevice().isConnected() && getJensenDevice().getModel() === 'hidock-h1e',
    // This owner only opens the normal Jensen interface and exposes no native
    // MSC transition. The mapped read-only WebDAV drive does not enter MSC.
    massStorageInactive: () => getJensenDevice().isConnected(),
    ownerAvailable: ownerId => {
      const sender = webContents.fromId(ownerId)
      if (!sender || sender.isDestroyed()) return false
      try { firmwareSender({ sender, senderFrame: sender.mainFrame } as Electron.IpcMainInvokeEvent); return true } catch { return false }
    },
  })
  const scratchAssurance = (value: unknown): DeviceScratchWriteAssurance => {
    const input = value as Record<string, unknown> | null
    if (!input || input.ownedScratchWriteConsent !== true || input.audioQuiescent !== true ||
      Object.keys(input).some(key => !['ownedScratchWriteConsent', 'audioQuiescent'].includes(key))) throw Error('Explicit scratch consent and physical audio assurance required')
    return { ownedScratchWriteConsent: true, audioQuiescent: true }
  }
  ipcMain.handle('jensen:beginOwnedScratchUpload', (event, descriptor: DeviceScratchUploadDescriptor, assurance: unknown) => {
    return invokeScratch(event, () => scratch.begin(event.sender.id, descriptor, scratchAssurance(assurance)))
  })
  ipcMain.handle('jensen:appendOwnedScratchUpload', (event, id: string, request: DeviceScratchAppend, assurance: unknown) => {
    return invokeScratch(event, () => scratch.append(event.sender.id, id, request, scratchAssurance(assurance)))
  })
  ipcMain.handle('jensen:commitOwnedScratchUpload', (event, id: string, assurance: unknown) => {
    return invokeScratch(event, () => scratch.commit(event.sender.id, id, scratchAssurance(assurance)))
  })
  ipcMain.handle('jensen:abortOwnedScratchUpload', (event, id: string, assurance: unknown) => {
    return invokeScratch(event, () => scratch.abort(event.sender.id, id, scratchAssurance(assurance)))
  })
  ipcMain.handle('jensen:getOwnedScratchUploadStatus', (event, id: string) => {
    return invokeScratch(event, () => scratch.status(event.sender.id, id))
  })
  // A restore readback holds the sole serialized device owner. Exclude only
  // its own transfer from the idle predicate used during streamed callbacks.
  let restoreReadbackActive = false
  const restoreJournal = new DeviceRecordingRestoreJournal(join(app.getPath('userData'), 'device-recording-restore-ownership'), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: plaintext => safeStorage.encryptString(plaintext),
    decryptString: ciphertext => safeStorage.decryptString(ciphertext),
  })
  const restore = new DeviceRecordingRestoreService({
    device: getJensenDevice, serialize: serializeDeviceOperation,
    journal: restoreJournal,
    idle: () => audioSession.snapshot().status === 'idle' && !storageMoveInProgress('recordings') &&
      (restoreReadbackActive || (!hasPendingTransfer() && !getJensenDevice().isOperationInProgress())) && firmwareJournal.pending().length === 0,
    normalJensen: () => getJensenDevice().isConnected() && getJensenDevice().getModel() === 'hidock-h1e',
    massStorageInactive: () => getJensenDevice().isConnected(),
    ownerAvailable: ownerId => {
      const sender = webContents.fromId(ownerId)
      if (!sender || sender.isDestroyed()) return false
      try { firmwareSender({ sender, senderFrame: sender.mainFrame } as Electron.IpcMainInvokeEvent); return true } catch { return false }
    },
    getTrustedSource: recordingId => getTrustedRecordingRestoreSource(recordingId, {
      getRecordingById, getRecordingsPath,
      getOriginalBackup: id => originalBackups().latest(id),
    }),
    readback: async (session, onChunk, signal) => {
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      restoreReadbackActive = true
      try { return await trackActiveTransfer(session.filename, controller, async (activate, deactivate) => {
        try { return await readOwnedRecordingRestore(getJensenDevice(), session, onChunk, controller.signal, activate) }
        finally { deactivate() }
      }, { deferActivation: true }) }
      finally { restoreReadbackActive = false; signal?.removeEventListener('abort', abort) }
    },
  })
  const restoreAssurance = (value: unknown): DeviceRecordingRestoreAssurance => {
    const input = value as Record<string, unknown> | null
    if (!input || input.ownedRecordingRestoreConsent !== true || input.audioQuiescent !== true ||
      Object.keys(input).some(key => !['ownedRecordingRestoreConsent', 'audioQuiescent'].includes(key))) throw Error('Explicit recording restore consent and physical audio assurance required')
    return { ownedRecordingRestoreConsent: true, audioQuiescent: true }
  }
  ipcMain.handle('jensen:beginOwnedRecordingRestore', (event, recordingId: string, assurance: unknown) =>
    invokeScratch(event, () => restore.begin(event.sender.id, recordingId, restoreAssurance(assurance))))
  ipcMain.handle('jensen:appendOwnedRecordingRestore', (event, id: string, request: DeviceRecordingRestoreAppend, assurance: unknown) =>
    invokeScratch(event, () => restore.append(event.sender.id, id, request, restoreAssurance(assurance))))
  ipcMain.handle('jensen:verifyOwnedRecordingRestoreStep', (event, id: string, assurance: unknown) =>
    invokeScratch(event, () => restore.verifyCommitStep(event.sender.id, id, restoreAssurance(assurance))))
  ipcMain.handle('jensen:recoverOwnedRecordingRestoreStep', (event, id: string, assurance: unknown) =>
    invokeScratch(event, () => restore.recoverStep(event.sender.id, id, restoreAssurance(assurance))))
  ipcMain.handle('jensen:abortOwnedRecordingRestore', (event, id: string, assurance: unknown) =>
    invokeScratch(event, () => restore.abort(event.sender.id, id, restoreAssurance(assurance))))
  ipcMain.handle('jensen:getOwnedRecordingRestoreStatus', (event, id: string) =>
    invokeScratch(event, () => restore.status(event.sender.id, id)))
  ipcMain.handle('jensen:verifyOwnedRecordingRestoreReadback', (event, id: string) =>
    invokeScratch(event, () => restore.verifyReadback(event.sender.id, id)))
  const filesystem = new DeviceFileSystem(storage)
  const drive = new DeviceDrive(filesystem)
  stopDeviceStorage = () => drive.unmount()
  const readSegment = async (filename: unknown, offset: unknown, count: unknown, prefix: boolean): Promise<Uint8Array> => {
    if (typeof filename !== 'string' || !filename || filename.length > 27 || /[\\/]/.test(filename) || [...filename].some(value => value.charCodeAt(0) < 32) ||
      !Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 1048576) throw Error('Invalid bounded read')
    const controller = new AbortController()
    return trackActiveTransfer(filename, controller, async (activate, deactivate) => {
      try {
        const source = await storage.source(filename)
        const data = new Uint8Array(Number(count)); let received = 0
        const result = await storage.range(filename, source.size, Number(offset), Number(count), chunk => {
          if (received + chunk.length > data.length) throw Error('Read exceeds its exact boundary')
          data.set(chunk, received); received += chunk.length
        }, controller.signal, activate, deactivate, prefix)
        if (result.status !== 'complete' || received !== data.length) throw Error(`Bounded read did not complete: ${result.reason}`)
        return data
      } finally { deactivate() }
    }, { deferActivation: true })
  }
  ipcMain.handle('jensen:startFileSystem', event => { firmwareSender(event); return filesystem.start() })
  ipcMain.handle('jensen:stopFileSystem', async event => { firmwareSender(event); await drive.unmount(); return filesystem.status() })
  ipcMain.handle('jensen:mountDeviceDrive', event => { firmwareSender(event); return drive.mount() })
  ipcMain.handle('jensen:unmountDeviceDrive', event => { firmwareSender(event); return drive.unmount() })
  ipcMain.handle('jensen:getDeviceDriveStatus', event => { firmwareSender(event); return drive.status() })
  ipcMain.handle('jensen:getFileSystemStatus', event => { firmwareSender(event); return filesystem.status() })
  ipcMain.handle('jensen:getFileSystemDiagnostics', event => { firmwareSender(event); return filesystem.telemetry() })
  ipcMain.handle('jensen:getProtocolDiagnostics', event => { firmwareSender(event); return getJensenDevice().getProtocolDiagnostics() })
  ipcMain.handle('jensen:getValidationMemory', event => {
    firmwareSender(event)
    if (!isDeviceValidationLaunch() && !isFirmwareQualificationLaunch()) return null
    return { main: process.memoryUsage(), processes: app.getAppMetrics().map(value => ({
      pid: value.pid, type: value.type, workingSetKB: value.memory.workingSetSize,
      privateKB: value.memory.privateBytes
    })) }
  })
  ipcMain.handle('jensen:getTime', event => {
    firmwareSender(event)
    return serializeDeviceOperation(() => getJensenDevice().getTime())
  })
  ipcMain.handle('jensen:getFirmwareConsoleStatus', (event, request: unknown) => {
    firmwareSender(event)
    if (!isFirmwareConsoleRequest(request)) throw Error('Only help, version or uptime is supported')
    return serializeDeviceOperation(() => getJensenDevice().getFirmwareConsoleStatus(request))
  })
  ipcMain.handle('jensen:listFilesDetailed', event => { firmwareSender(event); return storage.list() })
  ipcMain.handle('jensen:getRecordingBackupPreflight', async event => {
    firmwareSender(event)
    const plan = await planDeviceRecordingBackupPreflight({
      getCompleteCatalog: async () => {
        if (audioSession.snapshot().status !== 'idle' || hasPendingTransfer() || storageMoveInProgress('recordings')) {
          throw Error('Backup planning requires an idle storage owner')
        }
        return storage.closedCatalog()
      },
      listLocalRows: async () => getRecordings().map(row => ({
        id: row.id, original_filename: row.original_filename ?? null, file_path: row.file_path ?? null,
        on_local: row.on_local ?? null, location: row.location ?? null, deleted_at: row.deleted_at ?? null,
      })),
      getLatestReceipt: id => originalBackups().latest(id),
      getTrustedBackupRoots: async () => [{ name: 'recordings', path: getRecordingsPath() }],
      remainingAuthorityCapacity: () => restoreJournal.remainingAuthorityCapacity(),
      remainingDestinationBytes: () => serializeDeviceOperation(async () => {
        const card = await getJensenDevice().getCardInfo()
        if (!card || !Number.isSafeInteger(card.free) || card.free < 0 || !Number.isSafeInteger(card.capacity) ||
          card.capacity <= 0 || card.free > card.capacity) throw Error('Destination storage capacity is unknown')
        // Jensen CMD16 reports MiB. Arithmetic multiplication avoids signed 32-bit truncation.
        const bytes = card.free * 1024 * 1024
        if (!Number.isSafeInteger(bytes)) throw Error('Destination storage capacity is out of bounds')
        return bytes
      }),
    })
    return { compatibility: plan.compatibility, executionReadiness: plan.executionReadiness,
      incompatibilities: plan.incompatibilities, destinationCollisions: plan.destinationCollisions,
      summary: plan.summary, baselineEvidence: plan.baselineEvidence,
      deviceMutationAuthorized: plan.deviceMutationAuthorized, diagnostics: plan.diagnostics }
  })
  ipcMain.handle('jensen:listFilesPage', (event, firstIndex: unknown, count: unknown) => {
    firmwareSender(event)
    if (!Number.isSafeInteger(firstIndex) || Number(firstIndex) < 0 || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 128) throw Error('Invalid entry page')
    return storage.page(Number(firstIndex), Number(count))
  })
  ipcMain.handle('jensen:readFilePrefix', async (event, filename: unknown, count: unknown) => {
    firmwareSender(event)
    return readSegment(filename, 0, count, true)
  })
  ipcMain.handle('jensen:readFileRange', async (event, args: unknown) => {
    firmwareSender(event)
    const input = args as { filename?: unknown; offset?: unknown; count?: unknown }
    if (!input) throw Error('Invalid bounded range')
    return readSegment(input.filename, input.offset, input.count, false)
  })
  const resumeToLibrary = async (filename: string, fileSize: number): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    if (storageMoveInProgress('recordings')) throw Error('Recording storage is moving')
    const controller = new AbortController()
    const service = getDownloadService()
    try { return await trackActiveTransfer(filename, controller, async (activate, deactivate) => {
      let staged: Awaited<ReturnType<typeof downloadWithResume>> | undefined
      try {
        const expected = await storage.source(filename)
        if (expected.size !== fileSize || !service.beginDownload(filename)) throw Error('Source changed or download cancelled')
        staged = await downloadWithResume({ directory: getRecordingsPath(), expected, adapter: storage.adapter(filename, deactivate),
          signal: controller.signal, onStarted: activate, onProgress: received => service.updateProgress(filename, received) })
        // The source is the same main-owned observation validated by the resume
        // transfer; renderer buffers and legacy imports never reach this registration.
        registerHostDownloadTransfer(staged, expected)
        const result = await service.processDownload(filename, staged)
        if (result.success) await forgetPublishedResume(staged)
        return result
      } finally { if (staged) releaseResumedDownload(staged); deactivate() }
    }, { deferActivation: true }) }
    catch { return { success: false, error: controller.signal.aborted ? 'Download cancelled' : 'Resumable download interrupted' } }
  }
  ipcMain.handle('jensen:downloadResumableToLibrary', async (event, args) => {
    firmwareSender(event)
    const { filename, fileSize } = JensenDownloadFileSchema.parse(args)
    return resumeToLibrary(filename, fileSize)
  })
  ipcMain.handle('jensen:prepareFirmwareInstall', (event, target: unknown = 'hardened') => {
    firmwareSender(event)
    if (target !== 'hardened' && target !== 'stock-forward') throw Error('Unknown firmware target')
    return firmwareInstall.prepare(target)
  })
  ipcMain.handle('jensen:getFirmwareInstallAttempts', event => { firmwareSender(event); return firmwareInstall.status() })
  ipcMain.handle('jensen:executeFirmwareInstall', (event, id: unknown, sha256: unknown) => {
    firmwareSender(event)
    if (typeof id !== 'string' || typeof sha256 !== 'string') throw new Error('Prepared attempt and digest required')
    return firmwareInstall.execute(id, sha256)
  })
  ipcMain.handle('jensen:observeFirmwareInstall', (event, id: unknown) => {
    firmwareSender(event)
    if (typeof id !== 'string') throw new Error('Prepared attempt required')
    return firmwareInstall.observe(id)
  })
  // A stream cut off by a crash is still audio worth keeping.
  try {
    const recovered = isRecoveryMode() ? [] : recoverPartialLiveRecordings(getRecordingsPath())
    if (recovered.length > 0) console.log('[Jensen] Recovered live recordings:', recovered)
  } catch (err) {
    console.error('[Jensen] Could not check for unfinished live recordings:', err)
  }
  // -------------------------------------------------------------------------
  // Connection-state push events
  //
  // The renderer (JensenIpcClient) keeps no device state of its own — it relies
  // on these broadcasts to know whether the device is connected and to fire the
  // renderer-side onconnect/ondisconnect callbacks. The device fires onconnect
  // after a successful (auto-)connect and ondisconnect on disconnect / physical
  // unplug; explicit operations also push state below.
  // -------------------------------------------------------------------------

  const device = getJensenDevice()

  const sendState = (): void => {
    broadcast('jensen:state-changed', {
      connected: device.isConnected(),
      model: device.getModel(),
      serialNumber: device.serialNumber,
      versionCode: device.versionCode,
      versionNumber: device.versionNumber,
    })
  }
  // NOTE: device.onconnect/ondisconnect are wired once below (the canonical
  // registration). sendState() is used by the operation handlers' finally blocks.

  // -------------------------------------------------------------------------
  // Core device operations
  // -------------------------------------------------------------------------

  ipcMain.handle('jensen:connect', async () => {
    try {
      const result = await serializeDeviceOperation(() => getJensenDevice().connect())
      // 2026-07-22 — device-connect cleanup sweep: queued 'device' deletions
      // (from "Also delete from device" while disconnected) complete on any
      // successful connect, not just on Trash entry / hard purges.
      // Keep the connection handshake exclusive until the sweep finishes. A
      // fire-and-forget sweep raced the renderer's first scan/auto-download and
      // could put DELETE_FILE and TRANSFER_FILE onto the same response stream.
      if (result && !isRecoveryMode()) await retryPendingFileCleanups()
      return result
    } catch {
      return null
    } finally {
      sendState()
    }
  })

  // 2026-07-22 — STATE PULL for fresh renderers. The renderer client caches
  // `_connected=false` until a state-changed broadcast fires; after a reload
  // (or HMR) that leaves the UI reporting "device not connected" while main
  // still holds the USB connection. A fresh client pulls the truth once here.
  ipcMain.handle('jensen:getState', () => ({
    connected: device.isConnected(),
    model: device.getModel(),
    serialNumber: device.serialNumber,
    versionCode: device.versionCode,
    versionNumber: device.versionNumber,
    // Active recording from the CMD-18 poll (null = idle, undefined = never
    // read). A reloaded renderer missed the change broadcast and needs this
    // to seed its recording indicator + dirty-mark reconciliation.
    recording: lastRecordingFilename ?? null,
  }))

  ipcMain.handle('jensen:tryConnect', async () => {
    try {
      const result = await serializeDeviceOperation(() => getJensenDevice().tryConnect())
      if (result && !isRecoveryMode()) await retryPendingFileCleanups()
      return result
    } catch {
      return null
    } finally {
      sendState()
    }
  })


  ipcMain.handle('jensen:disconnect', async () => {
    try {
      await endLiveAudioLocally('disconnect')
      // Abort an in-flight download so it stops being saved. The device keeps
      // streaming the rest of the file regardless; gracefulCloseDevice then drains
      // that out of the IN FIFO before closing (see below). The 'disconnect' reason
      // tells downloadFile's settlement that TEARDOWN owns the drain — so it resolves
      // false and stands down instead of advancing the command queue mid-stream.
      // Fire-and-forget (do NOT await settlement): teardown owns the drain, and the
      // disconnect is serialized behind any in-flight scan below.
      abortAllTransfers('disconnect')
      await drive.unmount()

      // Do NOT preempt an in-flight scan: disconnect is serialized, so it waits
      // for the running listFiles/getFileCount to finish first. That lets the
      // device stream its file list to the end-of-list marker and empty its USB
      // FIFO before we close — otherwise the leftover bytes are read on the NEXT
      // connect instead of the device-info response ("Failed to get device info",
      // recovered only after a second disconnect/connect). For downloads (not
      // serialized) the abort above + the drain in gracefulCloseDevice play the
      // same role. Teardown then runs on an idle device and closes cleanly via
      // stopPoll (no reset).
      await serializeDeviceOperation(() => getJensenDevice().disconnect())
      return null
    } catch {
      return null
    } finally {
      sendState()
    }
  })

  ipcMain.handle('jensen:reset', async () => {
    try {
      await endLiveAudioLocally('reset')
      abortAllTransfers('disconnect')
      await drive.unmount()
      getJensenDevice().abortInFlight()
      return await serializeDeviceOperation(() => getJensenDevice().reset())
    } catch {
      return null
    } finally {
      sendState()
    }
  })

  ipcMain.handle('jensen:isConnected', async () => {
    try {
      return getJensenDevice().isConnected()
    } catch {
      return false
    }
  })

  ipcMain.handle('jensen:getModel', async () => {
    try {
      return getJensenDevice().getModel()
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:isP1Device', async () => {
    try {
      return getJensenDevice().isP1Device()
    } catch {
      return false
    }
  })

  // -------------------------------------------------------------------------
  // Device info & settings
  // -------------------------------------------------------------------------

  ipcMain.handle('jensen:getDeviceInfo', async () => {
    try {
      // The connect broadcast goes out before this reply fills in the firmware version. Compare the
      // identity inside the serialized read and publish once more only when a successful reply changed it.
      return await serializeDeviceOperation(async () => {
        const identity = (): string => [device.getModel(), device.serialNumber, device.versionCode, device.versionNumber].join('|')
        const before = identity()
        const info = await getJensenDevice().getDeviceInfo()
        if (info && identity() !== before) sendState()
        return info
      })
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:getCardInfo', async () => {
    try {
      return await serializeDeviceOperation(() => getJensenDevice().getCardInfo())
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:getFileCount', async () => {
    try {
      const device = getJensenDevice()
      if (!device.isConnected()) return null
      // A file transfer owns the IN stream until its exact byte boundary has
      // settled. The renderer's periodic reconciliation probe used to issue
      // GET_FILE_COUNT in the middle of that stream, consume transfer bytes as
      // the count response, report a false zero, and disconnect the device.
      // Skip (do not queue) background probes while a transfer/scan owns the bus.
      if (device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
      return await serializeDeviceOperation(async () => {
        // Re-check after waiting in the serializer: a download is intentionally
        // not held in deviceOpChain, so it may have started since the first guard.
        if (!device.isConnected()) return null
        if (device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
        return device.getFileCount()
      })
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:getSettings', async () => {
    try {
      return await serializeDeviceOperation(() => getJensenDevice().getSettings())
    } catch {
      return null
    }
  })

  // Uses main process time (design decision: prevents renderer from setting arbitrary device time)
  ipcMain.handle('jensen:setTime', async () => {
    try {
      return await serializeDeviceOperation(() => getJensenDevice().setTime(new Date()))
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:setAutoRecord', async (_event, args) => {
    try {
      const { enabled } = JensenSetAutoRecordSchema.parse(args)
      return await serializeDeviceOperation(() => getJensenDevice().setAutoRecord(enabled))
    } catch {
      return null
    }
  })

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  ipcMain.handle('jensen:listFiles', async (event) => {
    try {
      // Never scan a device that isn't connected (e.g. a scan requested during or
      // right after a disconnect) — returning null lets the renderer keep its
      // cached list instead of mistaking an interrupted scan for an empty device.
      const device = getJensenDevice()
      if (!device.isConnected()) return null
      // A list scan cannot share the USB response stream with a file download.
      // Periodic/recording-triggered reconciliation must stand down and retry on
      // its next signal instead of corrupting the active transfer.
      if (device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
      const onProgress = (filesFound: number, expectedFiles: number) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('jensen:scan-progress', { current: filesFound, total: expectedFiles })
        }
      }
      const result = await serializeDeviceOperation(async () => {
        if (!device.isConnected()) return null
        if (device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
        return device.listFiles(onProgress)
      })
      // Device has now fully initialized (device-info handshake + a completed
      // file-list scan). Only NOW is it safe to start the live-recording poll —
      // starting it during the connect handshake is what desynced the protocol.
      // Idempotent: no-op on subsequent rescans.
      if (result !== null && device.isConnected()) startRecordingPoll()
      return result
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:downloadToLibrary', async (_event, args) => {
    const { filename, fileSize } = JensenDownloadFileSchema.parse(args)
    const sourceDevice = getJensenDevice()
    if (isAuditedNativeRecordingFirmware(sourceDevice.getModel(), sourceDevice.versionNumber, sourceDevice.versionCode)) return resumeToLibrary(filename, fileSize)
    if (storageMoveInProgress('recordings')) throw new Error('Recording storage is moving')
    const service = getDownloadService()
    const controller = new AbortController()
    let staging: ReturnType<typeof stageDownload> | undefined
    try {
      return await trackActiveTransfer(filename, controller, (activate, deactivate) => serializeDeviceOperation(async () => {
        if (controller.signal.aborted || !service.beginDownload(filename)) return { success: false, error: 'Download cancelled' }
        staging = stageDownload(getRecordingsPath(), fileSize, () => controller.abort())
        let lastProgress = 0
        const device = getJensenDevice()
        try {
        const success = await device.downloadFile(filename, fileSize, staging.write, (received) => {
          const now = Date.now()
          if (now - lastProgress >= 250) {
            lastProgress = now
            service.updateProgress(filename, received)
          }
        }, controller.signal, activate)
        await device.getActiveDownloadSettlement?.()
        if (!success || controller.signal.aborted) return { success: false, error: 'Download interrupted' }
        const staged = await staging.finish()
        return await service.processDownload(filename, staged)
        } finally {
          await device.getActiveDownloadSettlement?.()
          deactivate()
        }
      }), { deferActivation: true })
    } finally {
      await staging?.discard()
    }
  })

  ipcMain.handle('jensen:downloadFile', async (event, args) => {
    try {
      const { filename, fileSize } = JensenDownloadFileSchema.parse(args)

      const abortController = new AbortController()

      const BATCH_SIZE = 262144 // 256 KB
      let pendingBuffer: Buffer[] = []
      let pendingSize = 0
      let lastProgressAt = 0

      const flushChunks = (): void => {
        if (pendingBuffer.length === 0) return
        if (event.sender.isDestroyed()) {
          pendingBuffer = []
          pendingSize = 0
          abortController.abort('renderer-destroyed')
          return
        }
        const merged = Buffer.concat(pendingBuffer, pendingSize)
        event.sender.send('jensen:download-chunk', { filename, data: merged })
        pendingBuffer = []
        pendingSize = 0
      }

      const onChunk = (data: Uint8Array): void => {
        if (event.sender.isDestroyed() || abortController.signal.aborted) {
          pendingBuffer = []
          pendingSize = 0
          abortController.abort('renderer-destroyed')
          return
        }
        pendingBuffer.push(Buffer.from(data))
        pendingSize += data.length
        if (pendingSize >= BATCH_SIZE) flushChunks()
      }

      const onProgress = (received: number): void => {
        const now = Date.now()
        if (received < fileSize && now - lastProgressAt < 250) return
        lastProgressAt = now
        if (!event.sender.isDestroyed()) {
          event.sender.send('jensen:download-progress', {
            filename,
            bytesReceived: received,
            totalBytes: fileSize,
          })
        }
      }

      // Register with the shared controller for the lifetime of the transfer so
      // jensen:cancelDownload and download-service cancel/cancel-all can find and
      // abort it (and await its settlement).
      // Register the transfer before joining deviceOpChain. This closes both
      // directions of the old race:
      //   * a count/list already in flight finishes before TRANSFER_FILE starts;
      //   * a later count/list sees the active transfer and skips immediately.
      // Cancellation still works while the transfer waits for the chain because
      // the AbortController is already registered.
      const result = await trackActiveTransfer(filename, abortController, (activate, deactivate) =>
        serializeDeviceOperation(async () => {
          const device = getJensenDevice()
          try {
          const r = await device.downloadFile(filename, fileSize, onChunk, onProgress, abortController.signal, activate)
          // Phase-2 settlement contract: downloadFile resolves the instant a
          // user-cancel/stall abort fires — BEFORE its async byte-boundary drain
          // completes. Await the device's POST-DRAIN settlement so the tracked transfer
          // (and thus cancelActiveTransfer / cancelActiveTransferByName) stays registered,
          // and the active pointer stays set, until the device has truly settled. Resolves
          // immediately on normal completion (no drain) or if the device lacks the
          // accessor (older build / test stub).
          await device.getActiveDownloadSettlement?.()
          return r
          } finally {
            await device.getActiveDownloadSettlement?.()
            deactivate()
          }
        }), { deferActivation: true }
      )
      flushChunks() // flush any remaining buffered chunks
      return result
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:cancelDownload', async () => {
    try {
      // 'user-cancel' reason: downloadFile's settlement drains to quiescence and,
      // only once the bus is proven quiet, releases the slot so the connection stays
      // usable (unlike the 'disconnect' reason, which stands down for teardown).
      // Await settlement so the renderer/UI can treat resolution as "cancel done".
      await cancelAllTransfers('user-cancel')
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:deleteFile', async (_event, args) => {
    try {
      const { filename } = JensenDeleteFileSchema.parse(args)
      return await serializeDeviceOperation(() => getJensenDevice().deleteFile(filename))
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:formatCard', async () => {
    try {
      return await getJensenDevice().formatCard()
    } catch {
      return null
    }
  })

  // -------------------------------------------------------------------------
  // Realtime streaming: one owner, provider-independent capture.
  // -------------------------------------------------------------------------

  ipcMain.handle('jensen:getRealtimeSettings', async () => {
    try {
      return await getJensenDevice().getRealtimeSettings()
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:getRecordingCapabilities', () => recordingCapabilities())
  // Read-only update prerequisites through the existing USB owner. This does
  // not request an update, send an image, reboot or alter recording settings.
  ipcMain.handle('jensen:getFirmwareUpdatePreflight', event => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    const result = await device.getFirmwareUpdatePreflight()
    if (!result || event.sender.isDestroyed() || !device.isConnected() || audioSession.snapshot().status !== 'idle') return null
    return { model: result.model, versionNumber: result.versionNumber, activeRecording: result.activeRecording, card: result.card }
  }))
  ipcMain.handle('jensen:getNativeRecordingStatus', () => nativeRecordingControl.status())
  ipcMain.handle('jensen:startNativeVerificationRecording', (event, request: NativeRecordingRequest) => {
    if (event.sender.isDestroyed()) throw new Error('The requesting window is closed')
    return nativeRecordingControl.startVerification(request)
  })
  ipcMain.handle('jensen:protectNativeVerificationRecording', async (event, expectedRecording: unknown) => {
    if (event.sender.isDestroyed() || typeof expectedRecording !== 'string' || !expectedRecording || expectedRecording.length > 255) throw new Error('Invalid active native recording identity')
    const status = await nativeRecordingControl.status()
    if (status.recording !== expectedRecording) throw new Error('The native recording changed; no file policy was registered')
    await markNativeFileManualOnly(status.recording)
    return { manualOnly: true }
  })
  ipcMain.handle('jensen:addNativeMarker', (event, request: NativeRecordingRequest) => {
    if (event.sender.isDestroyed()) throw new Error('The requesting window is closed')
    return nativeRecordingControl.dispatch('marker', request)
  })
  ipcMain.handle('jensen:toggleNativeRecording', (event, request: NativeRecordingRequest) => {
    if (event.sender.isDestroyed()) throw new Error('The requesting window is closed')
    return nativeRecordingControl.dispatch('toggle', request)
  })
  ipcMain.handle('jensen:getRecordingProfile', () => ({ status: 'unsupported', reason: 'The current firmware has no verified native recording-profile API.' }))
  ipcMain.handle('jensen:getCustomRecordingProfile', event => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    return device.getCustomRecordingProfile()
  }))
  ipcMain.handle('jensen:getCustomRecordingFormat', event => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    return device.getCustomRecordingFormat()
  }))
  ipcMain.handle('jensen:setCustomRecordingFormat', (event, format: CustomRecordingFormat) => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    return device.setCustomRecordingFormat(format)
  }))
  ipcMain.handle('jensen:getCustomMarkerRules', event => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    return device.getCustomMarkerRules()
  }))
  ipcMain.handle('jensen:setCustomMarkerRules', (event, rules: CustomMarkerRules) => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    return device.setCustomMarkerRules(rules)
  }))
  ipcMain.handle('jensen:setCustomRecordingProfile', (event, profile: CustomRecordingProfile) => serializeDeviceOperation(async () => {
    const device = getJensenDevice()
    if (event.sender.isDestroyed() || !device.isConnected() || device.getModel() !== 'hidock-h1e' || !isAuditedCustomRecordingFirmware(device.getModel(), device.versionNumber, device.versionCode) || audioSession.snapshot().status !== 'idle' || device.isOperationInProgress() || getActiveTransferFilename() !== null) return null
    // The protocol validates every field, rechecks exact custom identity and
    // queries its strict REA1 capability before sending a mutation. The target
    // itself rejects active native/live recording and malformed requests.
    return device.setCustomRecordingProfile(profile)
  }))
  ipcMain.handle('jensen:setRecordingProfile', (_event, profileId: unknown) => {
    if (typeof profileId !== 'string' || !profileId || profileId.length > 80) throw new Error('Invalid recording profile')
    return { status: 'unsupported', reason: 'Native profile changes require verified firmware capability.' }
  })
  ipcMain.handle('jensen:getAudioDiagnostics', event => ({ session: audioSession.snapshot(), diagnostics: liveDiagnostics.snapshot(), lastSessionId: lastCaptureSessionId, owned: audioSession.owns(event.sender.id ?? 0) }))
  ipcMain.handle('jensen:startRealtime', async (event, args) => {
    try {
      const realtimeDevice = getJensenDevice()
      if (!supportsRealtimeFirmware(realtimeDevice.getModel(), realtimeDevice.versionNumber)) {
        return { result: 'failed', error: 'This HiDock firmware does not support realtime audio. Update it in HiNotes first.' }
      }
      const options = JensenRealtimeStartSchema.parse(args ?? {})
      const owner = event.sender.id ?? 0
      if (event.sender.isDestroyed()) return { result: 'failed', error: 'The live window is closed.' }
      if (!destructionObservers.has(event.sender)) {
        destructionObservers.add(event.sender)
        event.sender.once('destroyed', () => {
          if (liveSenders.get(owner) !== event.sender) return
          liveSenders.delete(owner)
          void audioSession.stop(owner).catch(() => undefined)
        })
      }
      liveSenders.set(owner, event.sender)
      const result = await audioSession.start(owner, options)
      if (!audioSession.owns(owner)) liveSenders.delete(owner)
      return result
    } catch (error) {
      return { result: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('jensen:pauseRealtime', async event => {
    try {
      return await audioSession.pause(event.sender.id ?? 0)
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:stopRealtime', async event => {
    const owner = event.sender.id ?? 0
    try {
      const result = await audioSession.stop(owner)
      return result
    } catch {
      return null
    } finally {
      if (!audioSession.owns(owner)) liveSenders.delete(owner)
    }
  })

  ipcMain.handle('jensen:getRealtimeData', async (event, args) => {
    try {
      const { offset } = JensenRealtimeDataSchema.parse(args)
      const owner = event.sender.id ?? 0
      if (!audioSession.canRead(owner)) return null
      // Duplicate renderer requests share one dequeue; only its creator fans out.
      if (liveRead) return null
      const sessionId = audioSession.snapshot().sessionId
      const generation = audioSession.readGeneration
      liveRead = getJensenDevice().getRealtimeData(offset)
      const result = await liveRead.finally(() => { liveRead = null })
      if (!audioSession.canRead(owner) || audioSession.snapshot().sessionId !== sessionId || generation !== audioSession.readGeneration) return null
      if (result && !event.sender.isDestroyed()) {
        // Not awaited, and `acceptDevicePacket` does not await the provider
        // either: this handler is the renderer's realtime poll, and the device
        // buffer it drains is finite. Waiting on a WebSocket here is what made
        // `rest` grow and packets disappear on the device.
        const valid = liveDiagnostics.observe(result, Date.now())
        const previousRecordingError = audioSession.snapshot().recordingError
        liveRecorder.write(result)
        if (liveRecorder.errorMessage) audioSession.noteRecordingFailure(liveRecorder.errorMessage)
        const recordingFailureChanged = audioSession.snapshot().recordingError !== previousRecordingError
        if (valid && audioSession.snapshot().transcribe && !audioSession.snapshot().transcriptionError) liveTranscription.acceptDevicePacket(result)
        if (recordingFailureChanged || Date.now() - lastDiagnosticsAt >= 1000) {
          event.sender.send('jensen:audio-diagnostics', { session: audioSession.snapshot(), diagnostics: liveDiagnostics.snapshot(), lastSessionId: lastCaptureSessionId, owned: true })
          lastDiagnosticsAt = Date.now()
        }
        event.sender.send('jensen:realtime-data', {
          rest: result.rest,
          muted: result.muted,
          sequenceMinusOne: result.sequenceMinusOne,
          microphoneMuted: result.microphoneMuted,
          data: Buffer.from(result.data),
        })
        // Two independent mono lanes for the owning renderer, from this same CMD34 packet.
        // Isolated: a split failure must never replace the poll's result with null.
        try {
          const tap = splitRealtimeChannelsTap(result)
          if (tap) event.sender.send('jensen:realtime-channels', { sessionId, receivedAtMs: Date.now(), ...tap })
        } catch (error) {
          console.error('[Jensen] Live channel tap failed:', error)
        }
      }
      return result
    } catch {
      return null
    }
  })

  // -------------------------------------------------------------------------
  // Battery & Bluetooth (P1 only)
  // -------------------------------------------------------------------------

  ipcMain.handle('jensen:getBatteryStatus', async () => {
    try {
      return await getJensenDevice().getBatteryStatus()
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:startBluetoothScan', async (_event, args) => {
    try {
      const { duration } = JensenBluetoothScanSchema.parse(args ?? {})
      return await getJensenDevice().startBluetoothScan(duration)
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:stopBluetoothScan', async () => {
    try {
      return await getJensenDevice().stopBluetoothScan()
    } catch {
      return null
    }
  })

  ipcMain.handle('jensen:getBluetoothStatus', async () => {
    try {
      return await getJensenDevice().getBluetoothStatus()
    } catch {
      return null
    }
  })

  // -------------------------------------------------------------------------
  // Wire up push event callbacks on the singleton Jensen device
  // -------------------------------------------------------------------------

  const jensen = getJensenDevice()

  jensen.onconnect = () => {
    broadcast('jensen:connect-event')
    broadcast('jensen:state-changed', {
      connected: true,
      model: jensen.getModel(),
      serialNumber: jensen.serialNumber,
      versionCode: jensen.versionCode,
      versionNumber: jensen.versionNumber,
    })
    // NOTE: the live-recording poll is intentionally NOT started here. It starts
    // only after the first file-list scan completes (see the jensen:listFiles
    // handler) so a CMD 18 poll can never fire during the connect handshake and
    // desync the protocol.
  }

  // A download that went silent: the queue decides whether the reconnect retries it.
  jensen.ontransferstall = ({ filename, received, fileSize }) => {
    getDownloadService().noteTransferStall(filename, received, fileSize)
  }

  jensen.ondisconnect = () => {
    void drive.unmount().catch(() => undefined)
    stopRecordingPoll()
    // The stream ended with the cable: save it now, or the next stream would
    // be appended to this file.
    void endLiveAudioLocally('disconnected')
    broadcast('jensen:disconnect-event')
    broadcast('jensen:state-changed', {
      connected: false,
      model: jensen.getModel(),
      serialNumber: null,
      versionCode: null,
      versionNumber: null,
    })
  }

  // Quarantine recovery exhausted its bounded reconnect attempts: the session is
  // terminally down until the user acts. Surface it (Activity Log + push event) —
  // without this the still-plugged device would silently stay disconnected forever
  // (no physical USB event ever fires for a quarantine teardown).
  jensen.onrecoveryexhausted = () => {
    emitActivityLog(
      'error',
      'Device recovery required',
      'Automatic reconnect after a transfer fault failed — use Connect, or unplug and replug the HiDock.'
    )
    broadcast('jensen:recovery-exhausted')
  }

  console.log('Jensen IPC handlers registered (27 channels)')
}
