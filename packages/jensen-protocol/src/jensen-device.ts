/**
 * Jensen Protocol Implementation for HiDock devices — transport-agnostic core.
 *
 * Architecture: Event-driven continuous read loop + command queue + handler dispatch
 * Direct port of the official HiDock HiNotes jensen.js reference implementation.
 *
 * Key mechanisms (matching jensen.js):
 *  1. Continuous read loop: transferIn always pending, data flows into buffer
 *  2. Command queue: one command at a time, next sent when current resolves
 *  3. Handler registry: each command type has a handler that decides when done
 *  4. Debounced parse: 10ms for simple cmds, 1000ms for file transfers
 *  5. Promise map: tag-keyed, resolved when handler returns truthy value
 *
 * Transport independence:
 *  The protocol logic is identical regardless of how USB bytes are moved. The
 *  `USB` interface (WebUSB) is injected via the constructor, so the SAME class
 *  serves both the browser (`navigator.usb`) and the Electron main process
 *  (`new WebUSB()` from the node `usb` package). No environment-specific imports
 *  live in this module — only the WebUSB *types*.
 */

// WebUSB types (USB, USBDevice, USBInTransferResult, etc.). Type-only — this
// module imports no runtime USB backend; the backend is injected.
/// <reference types="w3c-web-usb" />

import { parseNativeRecordingCommandAck, parseNativeRecordingStatusPayload } from './native-recording.js'
import type { NativeRecordingCommandAck, NativeRecordingStatus } from './native-recording.js'
import { CUSTOM_RECORDING_PROFILE_GET, CUSTOM_RECORDING_PROFILE_SET, encodeCustomRecordingProfile, parseCustomRecordingProfileResponse } from './custom-recording-profile.js'
import type { CustomRecordingProfile, CustomRecordingProfileResponse } from './custom-recording-profile.js'
import { CUSTOM_RECORDING_FORMAT_GET, CUSTOM_RECORDING_FORMAT_SET, encodeCustomRecordingFormat, parseCustomRecordingFormatResponse } from './custom-recording-format.js'
import type { CustomRecordingFormat, CustomRecordingFormatResponse } from './custom-recording-format.js'
import { CUSTOM_MARKER_RULES_GET, CUSTOM_MARKER_RULES_SET, encodeCustomMarkerRules, parseCustomMarkerRulesResponse } from './custom-marker-rules.js'
import type { CustomMarkerRules, CustomMarkerRulesResponse } from './custom-marker-rules.js'
import { FIRMWARE_CONSOLE_STATUS, encodeFirmwareConsoleRequest, isFirmwareConsoleRequest, parseFirmwareConsoleStatus } from './firmware-console.js'
import type { FirmwareConsoleFirmware, FirmwareConsoleRequest, FirmwareConsoleStatus } from './firmware-console.js'
import { OWNED_SCRATCH_UPLOAD_COMMAND, isOwnedScratchUploadDescriptor, encodeOwnedScratchUpload, isOwnedScratchStatusBody, parseOwnedScratchUploadReply } from './owned-scratch-upload.js'
import type { OwnedScratchUploadDescriptor, OwnedScratchUploadSession, OwnedScratchUploadOperation, OwnedScratchUploadReply, OwnedScratchWriteOptions, OwnedScratchWriteOutcome } from './owned-scratch-upload.js'
import { RECORDING_RESTORE_COMMAND, copyRecordingRestoreDescriptor, encodeRecordingRestore, parseRecordingRestoreCapabilities,
  isRecordingRestoreReadOnlyBody, parseRecordingRestoreReply } from './recording-restore.js'
import type { RecordingRestoreDescriptor, RecordingRestoreSession, RecordingRestoreOperation, RecordingRestoreCapabilities,
  RecordingRestoreReply, RecordingRestoreWriteOptions, RecordingRestoreWriteOutcome } from './recording-restore.js'
import { parseFirmwareUpdateCard, isFirmwareUpdateCardReady, copyFirmwareUploadArtifact, matchesAcceptedFirmwareImage, encodeFirmwareUpgradeRequest, parseFirmwareUpgradeAck, parseFirmwareUploadAck, isOrdinaryH1eVersion, permitsFirmwareVersion, ACCEPTED_H1E_FORWARD_STOCK_RESTORE } from './firmware-update.js'
import type { FirmwareUpdatePreflight, FirmwareUpdatePreflightFailure, FirmwareUploadArtifact, FirmwareUploadSession, FirmwareUploadResult, FirmwareUploadFence } from './firmware-update.js'
export { parseNativeRecordingCommandAck, parseNativeRecordingStatusPayload } from './native-recording.js'
export type { NativeRecordingCommandAck, NativeRecordingStatus } from './native-recording.js'

// USBConnectionEvent is not declared by node-usb's WebUSB shim — define locally.
interface USBConnectionEvent extends Event {
  readonly device: USBDevice
}

// Minimal shape of node-usb's native InEndpoint (poll API). Declared structurally
// so this module keeps its transport-agnostic design (no `usb` import — only the
// native endpoint reached at runtime through the WebUSB device wrapper).
//
// IMPORTANT: node-usb delivers polled data via the EventEmitter 'data' event (the
// startPoll `callback` arg only fires once, on end/cancel). The 'data' buffer is a
// view over a libusb buffer that gets reused — copy it before the next event.
type PollDataHandler = (buffer: Uint8Array) => void
type PollErrorHandler = (error: Error & { errno?: number }) => void
interface NativePollEndpoint {
  on(event: 'data', handler: PollDataHandler): void
  on(event: 'error', handler: PollErrorHandler): void
  removeListener(event: 'data' | 'error', handler: PollDataHandler | PollErrorHandler): void
  startPoll(nTransfers: number, transferSize: number): void
  stopPoll(callback?: () => void): void
}

// Shape of node-usb's native usb.Device reached via the WebUSB wrapper's private
// `device` field, used only to obtain the IN endpoint for poll-based reads.
interface NativeUsbDeviceLike {
  interface(n: number): { endpoint(address: number): NativePollEndpoint | undefined } | undefined
}

class USBAbortError extends Error {
  readonly name = 'AbortError'
  constructor(message = 'The operation was aborted') { super(message) }
}

// USBInvalidStateError not needed — disconnect detection uses error.name string check instead

// ============================================================
// Constants
// ============================================================

export const CMD = {
  GET_DEVICE_INFO: 1,
  GET_DEVICE_TIME: 2,
  SET_DEVICE_TIME: 3,
  GET_FILE_LIST: 4,
  TRANSFER_FILE: 5,
  GET_FILE_COUNT: 6,
  DELETE_FILE: 7,
  REQUEST_FIRMWARE_UPGRADE: 8,
  FIRMWARE_UPLOAD: 9,
  GET_SETTINGS: 11,
  SET_SETTINGS: 12,
  GET_FILE_BLOCK: 13,
  GET_CARD_INFO: 16,
  FORMAT_CARD: 17,
  GET_RECORDING_FILE: 18,
  RESTORE_FACTORY_SETTINGS: 19,
  /** CMD19 also erases/formats SD; it is not a reboot or harmless reset. */
  RESTORE_FACTORY_SETTINGS_AND_FORMAT_CARD: 19,
  SEND_MEETING_SCHEDULE_INFO: 20,
  TRANSFER_FILE_PARTIAL: 21,
  REQUEST_TONE_UPDATE: 22,
  TONE_UPDATE: 23,
  REQUEST_UAC_UPDATE: 24,
  UAC_UPDATE: 25,
  GET_FILE_LIST_PAGED: 26,
  SEND_KEY_CODE: 28,
  GET_RECORDING_STATUS: 29,
  REALTIME_READ_SETTING: 32,
  REALTIME_CONTROL: 33,
  REALTIME_TRANSFER: 34,
  BLUETOOTH_SCAN: 4097,
  BLUETOOTH_CMD: 4098,
  BLUETOOTH_STATUS: 4099,
  GET_BATTERY_STATUS: 4100,
  BT_SCAN: 4101,
  BT_DEV_LIST: 4102,
  BT_GET_PAIRED_DEV_LIST: 4103,
  BT_REMOVE_PAIRED_DEV: 4104,
  FACTORY_RESET: 61451,
  GET_USB_WRITE_TIMEOUT: 61457,
  /** @deprecated Historical client label; 0xf011 reads USB write timeout, not Bluetooth. */
  BLUE_B_TIMEOUT: 61457
} as const

export const USB_VENDOR_ID = 0x10d6
export const USB_ALTERNATE_VENDOR_ID = 0x3887
export const USB_VENDOR_IDS: number[] = [0x10d6, 0x3887]

export const USB_PRODUCT_IDS = {
  H1: 0xaf0c,
  H1_NEW: 0xb00c,
  H1E_OLD: 0xaf0d,
  H1E: 0xb00d,
  P1_OLD: 0xaf0e,
  P1: 0xb00e,
  P1_MINI: 0xaf0f,
  P1_MINI_NEW: 0xb00f,
  H1_ALT1: 0x0100,
  H1E_ALT1: 0x0101,
  H1_ALT2: 0x0102,
  H1E_ALT2: 0x0103,
  P1_ALT: 0x2040,
  P1_MINI_ALT: 0x2041,
  H1_LITE: 0x0104
}

export const EP_OUT = 0x01
export const EP_IN = 0x82
// Original H1E response constructor deliberately omits USB short-packet padding
// for an8192-byte frame. A larger host read can hold that entire reply indefinitely.
const USB_READ_BUFFER_BYTES = 8192

// Exact source-qualified pairs only. The6.3.3/6.3.5 images are original stock behavior
// with a forward identity; it must never enter the custom-control path. Custom pairs also pass qualifiedFileFirmware, so the existing bounded file-list/page/range reads apply to them.
const customRecordingFirmware = (version: number | null, code: string | null) =>
  version === 393985 && code === '6.3.1' || version === 393986 && code === '6.3.2' ||
  version === 393988 && code === '6.3.4' || version === 393990 && code === '6.3.6'
const originalRecordingFirmware = (version: number | null, code: string | null) =>
  version === 393984 && code === '6.3.0' || version === 393987 && code === '6.3.3' ||
  version === 393989 && code === '6.3.5'
const qualifiedFileFirmware = (version: number | null, code: string | null) =>
  customRecordingFirmware(version, code) || originalRecordingFirmware(version, code)

// ============================================================
// Types
// ============================================================

export type DeviceModel = 'hidock-h1' | 'hidock-h1e' | 'hidock-p1' | 'hidock-p1-mini' | 'hidock-h1-lite' | 'unknown'

export type ProtocolFaultCode = 'malformed-response' | 'response-envelope-exceeded' | 'byte-boundary-exceeded' |
  'short-stream' | 'stream-consumer-error' | 'listing-consumer-error' | 'listing-stalled' | 'invalid-entry-geometry' |
  'listing-count-mismatch' | 'invalid-file-stream' | 'cancelled-stream-incomplete' | 'transfer-stalled' |
  'usb-write-incomplete' | 'usb-write-failed' | 'command-timeout' | 'page-unavailable' | 'page-count-mismatch' | 'quarantine'
type ProtocolTraceBase = { atMs: number; connectionSessionId: number }
export type ProtocolDiagnosticEvent = ProtocolTraceBase & (
  { kind: 'in'; bytes: number } |
  { kind: 'out'; commandId: number; sequence: number; requestBytes: number; payloadBytes: number } |
  { kind: 'write-result'; commandId: number; sequence: number; bytesWritten: number; expectedBytes: number; status: 'ok' | 'stall' | 'other' } |
  { kind: 'frame'; commandId: number; sequence: number; logicalBytes: number; bodyBytes: number; wireBytes: number; paddingBytes: number; correlated: boolean } |
  { kind: 'fault'; code: ProtocolFaultCode } |
  { kind: 'lifecycle'; state: 'connected' | 'teardown' | 'reset' })
export interface ProtocolDiagnostics {
  connectionSessionId: number
  connected: boolean
  currentCommand: { commandId: number; sequence: number } | null
  poisoned: boolean
  readLoopRunning: boolean
  readRequest: { transport: 'native-poll' | 'webusb'; bufferBytes: number; transfers: number } | null
  teardownActive: boolean
  carryBytes: number
  queuedCommands: number
  inboundBytes: number
  fileStreamPending: boolean
  activeDownload: boolean
  stream: { commandId: number; expectedBytes: number; receivedBytes: number; phase: 'queued' | 'receiving' | 'cancelled-before-start' | 'draining' | 'quarantining' | 'standing-down'; awaitingNativeEof: boolean; cancelRequested: boolean } | null
  lastFault: { code: ProtocolFaultCode; atMs: number; connectionSessionId: number } | null
  /** Latest failed CMD26 response, retained independently of the trace ring/reconnect. No entry content. */
  lastPageFault: { atMs: number; connectionSessionId: number; versionNumber: number | null; commandId: 26; sequence: number;
    reason: 'page-unavailable' | 'page-count-mismatch' | 'invalid-entry-geometry'; firstIndex: number; requestedCount: number;
    declaredTotalCount: number | null; expectedCount: number | null; expectedBodyBytes: number | null;
    responseBodyBytes: number | null; completeRecordSlots: number | null; trailingRecordBytes: number | null;
    parsedCount: number; retainedCount: number } | null
  /** Latest marker setter invocation; no rule values, serial, filename or raw reply. */
  lastMarkerRulesAttempt: { attempt: number; atMs: number; connectionSessionId: number;
    stage: 'input' | 'queued' | 'profile' | 'rules' | 'mutation';
    outcome: 'pending' | 'invalid-input' | 'owner-unqualified' | 'preflight-unavailable' | 'malformed-reply' |
      'session-changed' | 'mutation-unavailable' | 'acknowledged' | 'rejected' | 'error';
    commandId: number | null; sequence: number | null; responseBodyBytes: number | null; ackCode: number | null;
    mutationAttempted: boolean; validationReadOnly: boolean; recoveryReadOnly: boolean; pendingUpdate: boolean } | null
  events: ProtocolDiagnosticEvent[]
}

/** Host firmware gates recovered from a dated HiNotes snapshot; see docs/devices/protocol.md. */
export function supportsRealtimeFirmware(model: DeviceModel, versionNumber: number | null): boolean {
  if (versionNumber === null || !Number.isInteger(versionNumber) || versionNumber < 0 || versionNumber > 0xffffffff) return false
  if (model === 'hidock-h1') return versionNumber >= 328448
  if (model === 'hidock-h1e') {
    // The host selects the C1 version gate at 6.16.7; live requires 6.17.0 there.
    return versionNumber >= 397319 ? versionNumber >= 397568 : versionNumber >= 393984
  }
  if (model === 'hidock-p1') return versionNumber >= 66312
  if (model === 'hidock-p1-mini') return versionNumber >= 131840
  if (model === 'hidock-h1-lite') return versionNumber >= 196864
  return false
}

export interface DeviceInfo {
  versionCode: string
  versionNumber: number
  serialNumber: string
  model: DeviceModel
}

export interface FileInfo {
  name: string
  createDate: string
  createTime: string
  time: Date | null
  duration: number
  version: number
  length: number
  /** Lowercase hex MD5 of the native first1024-byte signature helper; not a full-file hash. */
  signature: string
}

export interface FileListingResult {
  status: 'complete' | 'partial' | 'error'
  files: FileInfo[]
  expectedCount: number | null
  parsedCount: number
  reason: string | null
}

export interface FileRangeResult {
  status: 'complete' | 'cancelled' | 'error'
  offset: number
  count: number
  received: number
  reason: string | null
}

export interface FileListingPageResult extends FileListingResult {
  firstIndex: number
  requestedCount: number
  totalCount: number | null
}

export interface CardInfo {
  used: number
  capacity: number
  free: number
  status: string
}

export interface DeviceSettings {
  autoRecord: boolean
  autoPlay: boolean
  notification?: boolean
  bluetoothTone?: boolean
}

export interface RealtimeSettings {
  /** CMD32 returns encoding, not active/enabled state. */
  enabled?: boolean
  encoding?: number
  sampleRate?: number
  channels?: number
  bitDepth?: number
}

export interface RealtimeData {
  /** Exact H1E6.3 CMD34: live producer sequence minus one, not queue depth. */
  sequenceMinusOne?: number
  /** Exact H1E6.3 CMD34: system microphone mute, not whole-stream mute. */
  microphoneMuted?: boolean
  /** @deprecated Retained client alias for sequenceMinusOne. */
  rest: number
  /** @deprecated Retained client alias for microphoneMuted. */
  muted: boolean
  /** Full device payload: 8-byte metadata header followed by stereo PCM16LE. */
  data: Uint8Array
}

export function parseRealtimePayload(body: Uint8Array): RealtimeData | null {
  if (body.length < 8) return null
  const rest = ((((body[0] & 0xff) << 24) |
    ((body[1] & 0xff) << 16) |
    ((body[2] & 0xff) << 8) |
    (body[3] & 0xff)) >>> 0)
  const mutedValue = ((((body[4] & 0xff) << 24) |
    ((body[5] & 0xff) << 16) |
    ((body[6] & 0xff) << 8) |
    (body[7] & 0xff)) >>> 0)
  return { sequenceMinusOne: rest, microphoneMuted: mutedValue === 1, rest, muted: mutedValue === 1, data: body.slice() }
}

export interface BatteryStatus {
  status: 'idle' | 'charging' | 'full'
  batteryLevel: number
  voltage?: number
}

export interface BluetoothDevice {
  name: string
  address: string
  rssi?: number
  paired?: boolean
}

export interface BluetoothStatus {
  connected: boolean
  deviceName?: string
  deviceAddress?: string
}

export interface FirmwareBootExpectation {
  serialNumber: string
  versionNumber: number
  customRecording: boolean
  /** Durable journal source identity; required to distinguish a reboot on restart. */
  sourceVersionNumber?: number
}
export interface FirmwareBootVerification {
  status: 'confirmed' | 'mismatch' | 'unavailable'
  reason: string
  imageAttested: false
  deviceInfo?: DeviceInfo
  card?: FirmwareUpdatePreflight['card']
  activeRecording?: boolean
  recordingProfile?: CustomRecordingProfileResponse
  recordingFormat?: CustomRecordingFormatResponse
  markerRules?: CustomMarkerRulesResponse
}

// ============================================================
// Logging — configurable per environment.
//   Main process: defaults to always-on (terminal/log file).
//   Renderer: bind the QA-toggle predicate via setJensenLogging() so device
//   logs respect the QA Logs setting (see project QA logging rules).
// ============================================================

let shouldLogFn: () => boolean = () => true

/** Bind the predicate that decides whether Jensen logs are emitted. */
export function setJensenLogging(fn: () => boolean): void {
  shouldLogFn = fn
}

const shouldLog = (): boolean => shouldLogFn()

// ============================================================
// Duration calculation (unchanged from original)
// ============================================================

export function calculateDurationSeconds(fileLength: number, fileVersion: number): number {
  const WAV_HEADER_SIZE = 44
  const CHANNELS = 2
  const BYTES_PER_SAMPLE = 1
  const CORRECTION_FACTOR = 4

  if (fileVersion === 1) {
    return Math.round(fileLength / 8000)
  } else if (fileVersion === 2) {
    const effectiveBps = (48000 * CHANNELS * BYTES_PER_SAMPLE) / CORRECTION_FACTOR
    return fileLength > WAV_HEADER_SIZE ? Math.round((fileLength - WAV_HEADER_SIZE) / effectiveBps) : 0
  } else if (fileVersion === 3) {
    const effectiveBps = (24000 * CHANNELS * BYTES_PER_SAMPLE) / CORRECTION_FACTOR
    return fileLength > WAV_HEADER_SIZE ? Math.round((fileLength - WAV_HEADER_SIZE) / effectiveBps) : 0
  } else if (fileVersion === 5) {
    // P1 firmware 1.4.5 stores v5 recordings as 96 kbps MP3 (12,000 B/s).
    // Applying the legacy correction factor makes the displayed duration 4x too long.
    return Math.round(fileLength / 12000)
  } else {
    return Math.round(fileLength / ((16000 * CHANNELS * BYTES_PER_SAMPLE) / CORRECTION_FACTOR))
  }
}

// ============================================================
// Message builder (matches jensen.js `c` constructor)
// ============================================================

class JensenMessage {
  command: number
  msgBody: number[] | Uint8Array = []
  index: number = 0
  expireTime: number = 0
  onprogress?: (current: number, total: number) => void
  onstart?: () => boolean | void

  constructor(command: number) {
    this.command = command
  }

  body(data: number[] | Uint8Array): this {
    this.msgBody = data
    return this
  }

  sequence(seq: number): this {
    this.index = seq
    return this
  }

  expireAfter(seconds: number): void {
    this.expireTime = Date.now() + seconds * 1000
  }

  make(): Uint8Array {
    const buffer = new Uint8Array(12 + this.msgBody.length)
    let pos = 0
    buffer[pos++] = 0x12
    buffer[pos++] = 0x34
    buffer[pos++] = (this.command >> 8) & 0xff
    buffer[pos++] = this.command & 0xff
    buffer[pos++] = (this.index >> 24) & 0xff
    buffer[pos++] = (this.index >> 16) & 0xff
    buffer[pos++] = (this.index >> 8) & 0xff
    buffer[pos++] = this.index & 0xff
    const len = this.msgBody.length
    buffer[pos++] = (len >> 24) & 0xff
    buffer[pos++] = (len >> 16) & 0xff
    buffer[pos++] = (len >> 8) & 0xff
    buffer[pos++] = len & 0xff
    for (let i = 0; i < this.msgBody.length; i++) {
      buffer[pos++] = this.msgBody[i] & 0xff
    }
    return buffer
  }
}

// ============================================================
// Internal types
// ============================================================

interface ResponseMessage {
  id: number
  sequence: number
  body: Uint8Array
}

interface PendingCommand {
  tag: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

interface QueueEntry {
  msg: JensenMessage
  operationName: string
  strictWrite?: boolean
}

type CommandHandler = (msg: ResponseMessage | null, device: JensenDevice) => unknown

// Fix 3: Incremental file list parsing state — stored in device.data['filelist']
// instead of the old Uint8Array[] accumulator, eliminating O(N^2) re-parsing.
interface FileListState {
  tailBuffer: Uint8Array // Unparsed tail bytes from last parse (may be partial record)
  tailLen: number        // Valid bytes in tailBuffer
  files: FileInfo[]      // Running list of fully-parsed files
  headerTotal: number    // File count from 0xFF 0xFF header (0 if not yet seen)
  headerParsed: boolean  // Whether the optional 0xFF 0xFF header has been processed
}

// ============================================================
// JensenDevice — event-driven architecture matching jensen.js
// ============================================================

export class JensenDevice {
  // === USB device ===
  private device: USBDevice | null = null
  private sequenceId = 0

  // === Command queue (jensen.js: a[], h, n{}) ===
  private commandQueue: QueueEntry[] = []
  private currentCommandTag: string | null = null
  private currentOperationName: string | null = null
  private pendingPromises: Map<string, PendingCommand> = new Map()

  // Serializes each public command's FULL lifecycle (send + await response or
  // timeout). The queue above serializes *sends*; this additionally guarantees a
  // second caller (e.g. the live-recording poll) cannot even begin a command
  // until the first has fully settled. Without it, a command that times out
  // while its (late) response is still in flight lets that response arrive while
  // the NEXT command is current — matched against the wrong slot, it desyncs
  // every command/response pair afterwards (the "unknown device / SN null /
  // 0 files / download stuck at 0-2%" regression). Lifecycle ops (disconnect /
  // reset / abortInFlight) deliberately bypass this so they can preempt a stuck
  // command instead of waiting behind it.
  private commandLock: Promise<void> = Promise.resolve()
  private firmwareUploadFence: FirmwareUploadFence = 'none'
  private firmwareUploadRunning = false
  /** Durable pending-attempt policy set by the existing application owner. */
  firmwareRecoveryReadOnly = false
  /** Explicit owner-selected lab read policy; intersects firmware recovery guards. */
  deviceValidationReadOnly = false
  private firmwareBootVerificationRunning = false
  private firmwareUploadSourceVersion: number | null = null
  private strictWriteStates = new Map<string, { completed: boolean; reply?: unknown }>()
  private firmwarePreflightFailure: FirmwareUpdatePreflightFailure | null = null

  // === Continuous read loop (jensen.js: r[], k, y) ===
  private receiveChunks: DataView[] = []
  private readLoopRunning = false
  // When set, the self-sustaining read loop stops re-issuing transferIn after the
  // current read completes. Lets a graceful teardown drain an in-flight stream and
  // close() WITHOUT a device.reset() — resetting mid-file-list-stream wedges the
  // firmware (device left mid-send → every command on the next connect times out).
  private stopReadLoopRequested = false
  // Native node-usb InEndpoint used for poll-based reads when available (Electron
  // main / Node). startPoll/stopPoll cancel pending transfers cleanly — like the
  // browser's close() — so teardown never needs a device.reset(). Null in a real
  // browser (no native endpoint), where we fall back to the WebUSB transferIn loop.
  private pollEndpoint: NativePollEndpoint | null = null
  private pollDataHandler: PollDataHandler | null = null
  private pollErrorHandler: PollErrorHandler | null = null
  private totalBytesReceived = 0

  // Inactivity threshold for the downloadFile stall watchdog (see downloadFile).
  // Configurable because real HiDock devices exhibit multi-second inter-packet
  // pauses on large files; 120s of TOTAL silence is far beyond any legitimate gap
  // while still bounding a truly dead transfer. Owner evidence: device pauses are
  // real, so this must never be short enough to trip a healthy-but-slow stream.
  private transferStallTimeoutMs = 120_000
  private fileStreamPending = false
  private activeFileStreamFailure: ((reason: string) => void) | null = null

  // POST-DRAIN settlement of the in-flight downloadFile (see getActiveDownloadSettlement).
  // downloadFile's OWN returned promise resolves false the instant a user-cancel/stall
  // abort fires — BEFORE its async byte-boundary drain (settleTransfer) completes. This
  // promise resolves only AFTER that drain has finished (releaseSlotAndAdvance /
  // quarantine / stand-down), giving a cancel caller a truthful "device has settled"
  // signal. null when no transfer is in flight or the current transfer completed
  // normally (its returned promise already WAS the settlement — no drain).
  private _activeDownloadSettlement: Promise<void> | null = null

  // Set when a transfer settlement could not safely release the serialized command
  // slot (a stall, or a cancelled transfer that never reached its protocol byte
  // boundary). A poisoned session is torn down (disconnect) and must NOT advance the
  // command queue — the only safe recovery is a clean reconnect (drain-recovery
  // pattern). Reset on setup.
  private poisoned = false

  // REFCOUNT of in-flight teardowns (disconnect / quarantine / recovery pre-connect
  // cleanup). A transfer settlement that is mid-drain checks isTearingDown() every
  // tick and STANDS DOWN the moment any teardown starts — teardown owns the FIFO
  // drain and the close, so no settlement may advance the queue (or quarantine)
  // while one is in flight. A refcount (not a boolean) so a second concurrent
  // disconnect finishing cannot clear the ownership the first one still holds.
  private teardownDepth = 0

  // Serializes teardown bodies (disconnect / quarantine / recovery cleanup) so two
  // concurrent teardowns can never interleave gracefulCloseDevice on the same handle.
  private lifecycleChain: Promise<void> = Promise.resolve()

  // Monotonic generation of the SESSION. Bumped SYNCHRONOUSLY at the entry of every
  // EXPLICIT lifecycle op (disconnect(), reset(), tryConnect()'s internal
  // disconnect). A quarantine-recovery cycle captures the generation when it starts
  // and re-checks it after EVERY await (and before scheduling, opening, setup, and
  // exhaustion-reporting): any explicit op invalidates the cycle mid-flight, so an
  // explicit disconnect can never be followed by an unwanted recovery REOPEN.
  private sessionGeneration = 0
  // Separate from recovery cancellation: automatic recovery intentionally keeps
  // sessionGeneration stable, but every teardown/reopen invalidates file checkpoints.
  private connectionSessionId = 0
  private protocolEvents: ProtocolDiagnosticEvent[] = []
  private protocolEventIndex = 0
  private protocolInboundBytes = 0
  private protocolLastFault: ProtocolDiagnostics['lastFault'] = null
  private protocolLastPageFault: ProtocolDiagnostics['lastPageFault'] = null
  private protocolLastMarkerRulesAttempt: ProtocolDiagnostics['lastMarkerRulesAttempt'] = null
  private markerRulesAttemptCount = 0
  private protocolStream: ProtocolDiagnostics['stream'] = null
  private protocolReadRequest: ProtocolDiagnostics['readRequest'] = null

  private traceProtocol(event: ProtocolDiagnosticEvent): void {
    if (this.protocolEvents.length < 64) this.protocolEvents.push(event)
    else { this.protocolEvents[this.protocolEventIndex] = event; this.protocolEventIndex = (this.protocolEventIndex + 1) % 64 }
  }

  private noteProtocolFault(code: ProtocolFaultCode): void {
    const value = { code, atMs: Date.now(), connectionSessionId: this.connectionSessionId }
    this.protocolLastFault = value
    this.traceProtocol({ kind: 'fault', ...value })
  }

  // === Quarantine recovery state machine ===
  // After a quarantine teardown the device is healthy but disconnected, and no
  // physical USB event will ever fire (the device was never unplugged) — so a
  // bounded, serialized clean-reconnect loop restores the session automatically:
  // ONE tryConnect() per backoff step (USB safety: never rapid open/close loops),
  // a hard attempt cap, then a surfaced terminal state via onrecoveryexhausted.
  private static readonly RECOVERY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000]
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryAttempt = 0

  /**
   * Fired when quarantine recovery has exhausted its attempt cap without
   * reconnecting. The session stays down; consumers surface this to the user
   * (Activity Log / UI) as "device recovery required — reconnect manually or replug".
   */
  onrecoveryexhausted?: () => void

  // Carry buffer for partial Jensen messages between processBufferedData() calls
  private carryBuffer: Uint8Array = new Uint8Array(0)
  private carryLen: number = 0

  // === Parse timing (jensen.js: decodeTimeout, timewait) ===
  private decodeTimer: ReturnType<typeof setTimeout> | null = null
  private parseDelay = 10

  // === Handler registry (jensen.js: s.handlers) ===
  private handlers: Map<number, CommandHandler> = new Map()

  // === Progress callback (jensen.js: onreceive) ===
  onreceive: ((bytes: number) => void) | null = null

  // === Device state ===
  versionCode: string | null = null
  versionNumber: number | null = null
  serialNumber: string | null = null
  model: DeviceModel = 'unknown'

  // jensen.js uses this.data = {} for listFiles accumulator
  data: Record<string, unknown> = {}

  // === Event callbacks ===
  ondisconnect?: () => void
  onconnect?: () => void
  /**
   * A download went silent for the stall window and the connection is about to be
   * quarantined. Fires BEFORE the teardown, so the consumer can tag the transfer
   * before the disconnect and the reconnect run.
   */
  ontransferstall?: (info: { filename: string; received: number; fileSize: number }) => void

  /**
   * Optional gate for the USB hot-plug auto-connect. When set and it returns
   * false, a `connect` USB event for a HiDock device is ignored instead of
   * triggering tryConnect(). Manual connect()/tryConnect() calls are unaffected.
   * Consumers wire this to their "auto-connect" preference.
   */
  autoConnectGate: (() => boolean) | null = null

  // === USB event handlers ===
  private usbDisconnectHandler: ((event: USBConnectionEvent) => void) | null = null
  private usbConnectHandler: ((event: USBConnectionEvent) => void) | null = null
  private usbListenersActive = false

  // === USB backend (WebUSB interface) ===
  // Optionally injected (Electron main / Node: new WebUSB() from the `usb`
  // package). When not injected, resolves navigator.usb lazily on each access
  // so the browser's WebUSB can be installed/replaced after construction.
  private readonly injectedUsb?: USB

  protected get usb(): USB {
    return (this.injectedUsb ?? (globalThis as { navigator?: { usb?: USB } }).navigator?.usb) as USB
  }

  constructor(usb?: USB) {
    this.injectedUsb = usb
    this.registerDefaultHandlers()
  }

  // ================================================================
  // Static
  // ================================================================

  /**
   * Whether a WebUSB backend is available. Pass the injected backend when the
   * caller binds a non-default one (e.g. node-usb's WebUSB in the main process);
   * otherwise falls back to the browser's navigator.usb.
   */
  static isSupported(usb: USB | undefined = (globalThis as { navigator?: { usb?: USB } }).navigator?.usb): boolean {
    return usb !== null && usb !== undefined
  }

  // ================================================================
  // Connection — matches jensen.js connect/tryconnect/disconnect/setup
  // ================================================================

  async connect(signal?: AbortSignal): Promise<boolean> {
    if (this.firmwareUploadFence !== 'none' && !(this.firmwareRecoveryReadOnly && !this.firmwareUploadRunning)) return false
    if (!this.usb) {
      console.error('WebUSB not supported')
      return false
    }
    if (signal?.aborted) throw new USBAbortError('Connection aborted')

    // jensen.js: if (await g.tryconnect()) return
    if (await this.tryConnect()) return true

    if (signal?.aborted) throw new USBAbortError('Connection aborted')

    // Fall back to device auto-select (node-usb with allowAllDevices bypasses browser picker)
    let picked: USBDevice
    try {
      picked = await this.usb.requestDevice({
        filters: USB_VENDOR_IDS.map(vendorId => ({ vendorId }))
      })
    } catch {
      return false
    }

    if (signal?.aborted) throw new USBAbortError('Connection aborted')

    try {
      await picked.open()
      this.device = picked
      await this.setup()
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      console.error('[Jensen] Connection failed:', error)
      return false
    }
  }

  /**
   * Auto-connect to a previously authorized HiDock device.
   * Matches jensen.js tryconnect(): disconnect first, find device, open, setup.
   */
  async tryConnect(preAuthorizedDevice?: USBDevice): Promise<boolean> {
    if (this.firmwareUploadFence !== 'none' && !(this.firmwareRecoveryReadOnly && !this.firmwareUploadRunning)) return false
    if (!this.usb) return false

    // Don't reconnect if already connected
    if (this.isConnected()) {
      if (shouldLog()) console.log('[Jensen] tryConnect: already connected')
      return true
    }

    // Don't try while operation in progress
    if (this.isOperationInProgress()) {
      if (shouldLog()) console.log(`[Jensen] tryConnect: operation in progress (${this.currentOperationName})`)
      return false
    }

    // jensen.js: await this.disconnect()
    await this.disconnect()

    try {
      let target = preAuthorizedDevice

      if (target && !this.isHiDockUsbDevice(target)) {
        if (shouldLog()) console.log('[Jensen] tryConnect: provided device is not HiDock')
        return false
      }

      if (!target) {
        const devices = await this.usb.getDevices()
        target = devices.find(d => this.isHiDockUsbDevice(d))
      }

      if (!target) return false

      if (shouldLog()) console.log('[Jensen] tryConnect: detected', target.productName)
      await target.open()
      this.device = target
      await this.setup()
      return true
    } catch {
      // Release the device on any failure (open/claim/setup) so it isn't left
      // open+claimed — otherwise the next connect's claimInterface fails ACCESS.
      await this.disconnect()
      return false
    }
  }

  /**
   * Device setup after USB open — matches jensen.js I() function.
   * Claims interface, detects model, resets state, fires onconnect.
   */
  private async setup(): Promise<void> {
    if (!this.device) return

    // Reset state (jensen.js: g.versionCode = null, g.versionNumber = null, a.length = 0)
    this.versionCode = null
    this.versionNumber = null
    this.commandQueue.length = 0

    try {
      await this.device.selectConfiguration(1)
      await this.device.claimInterface(0)
      await this.device.selectAlternateInterface(0, 0)
      this.model = this.detectModel(this.device.productId)
    } catch (error) {
      // A failed claim (e.g. LIBUSB_ERROR_ACCESS) must FAIL the connect cleanly —
      // not fall through to onconnect and report "connected" while every command
      // errors. Rethrow so tryConnect()/connect() release the device and return false.
      console.error('[Jensen] setup error:', error)
      throw error
    }

    // Reset protocol state (jensen.js: h = null, k = false)
    this.currentCommandTag = null
    this.currentOperationName = null
    this.readLoopRunning = false
    this.stopReadLoopRequested = false
    this.pollEndpoint = null
    this.pollDataHandler = null
    this.pollErrorHandler = null
    this.sequenceId = 0
    this.receiveChunks.length = 0
    this.carryLen = 0
    this.totalBytesReceived = 0
    this.poisoned = false
    // A successful (re)connect ends any quarantine recovery cycle.
    this.cancelQuarantineRecovery()
    this.recoveryAttempt = 0
    this.serialNumber = null
    this.data = {}
    this.connectionSessionId++
    this.traceProtocol({ kind: 'lifecycle', state: 'connected', atMs: Date.now(), connectionSessionId: this.connectionSessionId })

    if (shouldLog()) console.log(`[Jensen] Connected to ${this.model}`)

    // Brief stabilization delay after USB interface claim — some devices (especially H1E)
    // need time before firmware is ready to accept Jensen protocol commands
    await new Promise(resolve => setTimeout(resolve, 300))

    // Set up USB disconnect listener
    this.setupUsbDisconnectListener()

    // Fire onconnect (jensen.js fires synchronously in I())
    // Use setTimeout(0) so connect() returns before handleConnect starts commands
    setTimeout(() => this.onconnect?.(), 0)
  }

  isConnected(): boolean {
    return this.device !== null
  }

  /**
   * Abort any in-flight command (scan / download) WITHOUT tearing down the USB
   * device. Resolves every pending command promise with null and clears the
   * command queue + scan accumulator so a waiting listFiles()/getFileCount()
   * returns immediately.
   *
   * Used so a disconnect/reset can PREEMPT a running (or stalled) scan instead of
   * queueing behind it — a 10-minute stalled scan would otherwise block disconnect.
   * Does not touch the read loop or the USB handle; the caller (disconnect/reset)
   * performs the actual teardown right after.
   */
  abortInFlight(): void {
    if (this.firmwareUploadFence !== 'none') return
    this.currentCommandTag = null
    this.currentOperationName = null
    this.commandQueue.length = 0
    this.data = {}
    for (const [, pending] of this.pendingPromises) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.resolve(null)
    }
    this.pendingPromises.clear()
    this.strictWriteStates.clear()
  }

  /**
   * Tear down the USB handle the way the browser does: cancel the in-flight read
   * instead of resetting the device.
   *
   * node-usb's close() refuses a device with a pending transfer ("Can't close
   * device with a pending request"), and its only force-cancel is device.reset() —
   * a USB port reset that wedges the firmware if the device is mid-operation.
   *
   * Native poll path (Electron/Node): stopPoll() cancels the pending transfers
   * cleanly (real libusb cancel, like the browser) and fires its callback once
   * they unwind — then close() succeeds with NO reset, for any operation.
   *
   * transferIn fallback (browser): there is no clean cancel, so we drain — if the
   * device is streaming the in-flight read completes on its own and we close
   * without reset; only a truly idle read falls back to reset() (safe — the device
   * isn't mid-operation).
   */
  /**
   * Wait for the device to stop streaming (its IN FIFO drained) before teardown or
   * before advancing the serialized command queue. Watches the raw byte counter:
   * while data keeps arriving the device is still sending; ~500ms of silence means
   * it's idle. Bounded by maxMs.
   *
   * Returns an EXPLICIT outcome instead of a bare void, because the caller uses it
   * to decide whether it may safely release the command slot:
   *   - `{ drained: true }`  — the stream reached a proven-quiet boundary (or was
   *                            never streaming): the IN FIFO is empty, so sending
   *                            the next command cannot overlap inbound packets.
   *   - `{ timedOut: true }` — the maxMs bound elapsed with bytes still (recently)
   *                            flowing: quiescence could NOT be proven, so the
   *                            caller must NOT advance — the resumed stream would
   *                            overlap the next command and wedge the firmware.
   * (Teardown callers may ignore the outcome — they drain best-effort then close.)
   */
  private async drainUntilIdle(maxMs = 20000): Promise<{ drained: true } | { timedOut: true }> {
    if (!this.readLoopRunning) return { drained: true } // nothing streaming → already quiescent
    const deadline = Date.now() + maxMs
    let lastBytes = this.totalBytesReceived
    let idleMs = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      if (this.totalBytesReceived !== lastBytes) {
        lastBytes = this.totalBytesReceived
        idleMs = 0
      } else {
        idleMs += 50
        if (idleMs >= 500) return { drained: true } // device quiet → FIFO drained
      }
    }
    return { timedOut: true } // hit the bound with data still flowing — NOT provably quiescent
  }

  // ================================================================
  // Transfer settlement — the SINGLE path a downloadFile leaves by
  // ================================================================
  //
  // A file transfer holds the one serialized command slot for its whole duration.
  // It can end four ways: normal completion, user cancel, disconnect, or a stall.
  // The dangerous ones all share one rule — the next command must NEVER be sent
  // while transfer packets can still arrive, or it overlaps the device IN FIFO and
  // wedges the firmware (the #1 forbidden failure mode). These helpers give every
  // abnormal exit ONE quiescence discipline instead of per-case shortcuts.

  /**
   * POST-DRAIN settlement of the in-flight downloadFile, or null when there is nothing
   * to await (idle, or a transfer that completed normally). downloadFile resolves its
   * OWN promise false the instant a user-cancel/stall abort fires — before the async
   * byte-boundary drain finishes — so a cancel coordinator that only awaits downloadFile
   * returns while the device may still be streaming. Await THIS to block until the drain
   * (releaseSlotAndAdvance / quarantine / stand-down) has actually completed. Additive:
   * downloadFile's own resolution value and timing are unchanged.
   */
  getActiveDownloadSettlement(): Promise<void> | null {
    return this._activeDownloadSettlement
  }

  /** Owner epoch for binding transfers/checkpoints; exposes no USB handle or identity. */
  getConnectionSessionId(): number {
    return this.connectionSessionId
  }

  /** Bounded structural telemetry only: never audio/file bytes, identity or arbitrary error text. */
  getProtocolDiagnostics(): ProtocolDiagnostics {
    const tag = this.currentCommandTag?.match(/^cmd-(\d+)-(\d+)$/)
    const events = this.protocolEvents.length === 64 ? [...this.protocolEvents.slice(this.protocolEventIndex), ...this.protocolEvents.slice(0, this.protocolEventIndex)] : this.protocolEvents
    return { connectionSessionId: this.connectionSessionId, connected: this.isConnected(),
      currentCommand: tag ? { commandId: Number(tag[1]), sequence: Number(tag[2]) } : null,
      poisoned: this.poisoned, readLoopRunning: this.readLoopRunning, teardownActive: this.isTearingDown(),
      readRequest: this.protocolReadRequest ? { ...this.protocolReadRequest } : null,
      carryBytes: this.carryLen, queuedCommands: this.commandQueue.length, inboundBytes: this.protocolInboundBytes,
      fileStreamPending: this.fileStreamPending, activeDownload: this._activeDownloadSettlement !== null,
      stream: this.protocolStream ? { ...this.protocolStream } : null,
      lastFault: this.protocolLastFault ? { ...this.protocolLastFault } : null,
      lastPageFault: this.protocolLastPageFault ? { ...this.protocolLastPageFault } : null,
      lastMarkerRulesAttempt: this.protocolLastMarkerRulesAttempt ? { ...this.protocolLastMarkerRulesAttempt } : null,
      events: events.map(event => ({ ...event })) }
  }

  /** Resolve the in-flight download's own promise with `value` (does NOT advance). */
  private resolveActiveDownload(value: unknown): void {
    if (!this.currentCommandTag) return
    const pending = this.pendingPromises.get(this.currentCommandTag)
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.resolve(value)
      this.pendingPromises.delete(this.currentCommandTag)
    }
  }

  /**
   * Release the serialized slot and run the next queued command. ONLY legal after
   * the bus has been proven quiescent (drainUntilIdle → drained) or on normal
   * completion — never speculatively mid-stream.
   */
  private releaseSlotAndAdvance(): void {
    this.currentCommandTag = null
    this.currentOperationName = null
    this.sendNextCommand()
  }

  /**
   * Quarantine the connection after a settlement that could not safely release the
   * slot (a stall, or a cancelled transfer that never reached its protocol byte
   * boundary). A stalled transfer is unrecoverable, and a stream we cannot prove
   * finished must not be raced by a new command — so the ONLY safe move is to tear
   * down and reconnect cleanly (exactly the drain-recovery pattern). Marks the
   * session poisoned, runs the normal disconnect/close path (drains best-effort,
   * stops the poll, resolves every pending/queued command with null, fires
   * ondisconnect), then starts the bounded auto-recovery machine — the device never
   * physically unplugged, so no USB hot-plug event will ever reconnect it for us.
   * Never advances the queue.
   */
  private async quarantineConnection(reason: string): Promise<void> {
    if (this.firmwareUploadFence !== 'none') return
    if (reason.startsWith('cancelled transfer stalled')) this.noteProtocolFault('cancelled-stream-incomplete')
    else if (reason.startsWith('download stalled')) this.noteProtocolFault('transfer-stalled')
    else if (reason === 'USB command write incomplete') this.noteProtocolFault('usb-write-incomplete')
    else if (reason === 'USB command write failed') this.noteProtocolFault('usb-write-failed')
    else if (reason === 'listing page response unavailable') this.noteProtocolFault('page-unavailable')
    else if (reason === 'cached listing page byte/count mismatch') this.noteProtocolFault('page-count-mismatch')
    else if (!this.protocolLastFault || reason !== 'invalid file stream; byte boundary unavailable' && !reason.startsWith('unqualified listing completion:')) this.noteProtocolFault('quarantine')
    this.poisoned = true
    // Capture the generation BEFORE the teardown await: if the user explicitly
    // disconnects while our teardown is in flight, the bump makes the post-await
    // check fail and NO recovery is scheduled — the user's disconnect is final.
    const gen = this.sessionGeneration
    console.warn(`[Jensen] quarantining connection — ${reason}; disconnecting, clean reconnect required`)
    await this.performTeardown()
    if (gen !== this.sessionGeneration) return // explicit op raced our teardown — it owns the outcome
    // Fresh recovery cycle for this quarantine event.
    this.recoveryAttempt = 0
    this.scheduleQuarantineRecovery(gen)
  }

  /**
   * Schedule the next bounded quarantine-recovery attempt, or surface the terminal
   * "recovery required" state once the cap is exhausted. ONE clean reconnect per
   * backoff step — never a rapid open/close loop (USB safety). `gen` is the cycle's
   * captured generation: a stale generation neither schedules nor reports.
   */
  private scheduleQuarantineRecovery(gen: number): void {
    if (this.firmwareUploadFence !== 'none') return
    if (gen !== this.sessionGeneration) return // cycle invalidated by an explicit op
    if (this.recoveryTimer) return // an attempt is already scheduled
    const backoffs = JensenDevice.RECOVERY_BACKOFF_MS
    if (this.recoveryAttempt >= backoffs.length) {
      console.error(
        `[Jensen] quarantine recovery exhausted after ${backoffs.length} attempts — ` +
        'manual reconnect (or replug) required')
      this.onrecoveryexhausted?.()
      return
    }
    const delay = backoffs[this.recoveryAttempt]
    this.recoveryTimer = setTimeout(() => { void this.runQuarantineRecoveryAttempt(gen) }, delay)
  }

  /**
   * One recovery attempt. Deliberately does NOT delegate to tryConnect(): the cycle's
   * generation must be re-checked after EVERY await — and BEFORE opening and BEFORE
   * setup — so an explicit disconnect mid-attempt can never be followed by an
   * unwanted reopen (tryConnect hides those awaits and its internal disconnect() is
   * an explicit-class op that would invalidate our own cycle).
   */
  private async runQuarantineRecoveryAttempt(gen: number): Promise<void> {
    this.recoveryTimer = null
    if (gen !== this.sessionGeneration) return // cancelled while the timer was pending
    if (this.isConnected()) return // reconnected externally — cycle no longer needed
    this.recoveryAttempt++
    console.warn(
      `[Jensen] quarantine recovery attempt ${this.recoveryAttempt}/${JensenDevice.RECOVERY_BACKOFF_MS.length}`)

    let target: USBDevice | undefined
    let opened = false
    try {
      // Clean slate via an INTERNAL teardown (does not bump the generation — that
      // would invalidate our own cycle the way tryConnect's disconnect() would).
      await this.performTeardown()
      if (gen !== this.sessionGeneration) return

      const devices = await this.usb.getDevices()
      if (gen !== this.sessionGeneration) return // re-check BEFORE opening — no reopen after an explicit disconnect
      target = devices.find((d) => this.isHiDockUsbDevice(d))
      if (target) {
        await target.open()
        opened = true
        if (gen !== this.sessionGeneration) {
          // Explicit disconnect raced the open — undo it, never proceed to setup.
          try { await target.close() } catch { /* ignore */ }
          return
        }
        this.device = target
        await this.setup() // success clears poisoned + recovery state, fires onconnect
        if (gen !== this.sessionGeneration) {
          // Explicit disconnect raced setup — tear the fresh session down again.
          try { await this.performTeardown() } catch { /* ignore */ }
        }
        return
      }
    } catch {
      // Release anything half-opened so the next attempt starts clean.
      if (this.device) {
        try { await this.performTeardown() } catch { /* ignore */ }
      } else if (opened && target) {
        try { await target.close() } catch { /* ignore */ }
      }
    }
    if (gen !== this.sessionGeneration) return // no rescheduling/exhaustion for a dead cycle
    if (this.isConnected()) return
    this.scheduleQuarantineRecovery(gen) // next backoff step, or terminal state at the cap
  }

  /**
   * Stop any PENDING recovery attempt (timer only). Called by explicit lifecycle ops
   * (disconnect/reset) alongside the generation bump — the bump is what cancels an
   * attempt already PAST its timer (in-flight awaits re-check the generation).
   * Deliberately does NOT reset recoveryAttempt: the counter is reset only on a
   * fresh quarantine or a successful setup(), so nothing can defeat the cap.
   */
  private cancelQuarantineRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }

  private async gracefulCloseDevice(): Promise<void> {
    if (!this.device) return

    // Native poll path — drain in-flight stream, then clean cancel, never reset.
    if (this.pollEndpoint) {
      // If a stream is in flight (e.g. a download or scan interrupted by
      // disconnect), let the poll consume the rest of the device's IN FIFO until
      // it goes idle BEFORE cancelling the poll. Cancelling mid-send leaves data
      // queued in the device and wedges the firmware — the next connect then reads
      // those stale bytes instead of the command response. This automates the
      // manual "disconnect → wait → reconnect" drain. Poll stays active (so data
      // is consumed); stopReadLoopRequested is set only after the drain so the
      // data handler keeps counting bytes while we wait.
      await this.drainUntilIdle()
      this.stopReadLoopRequested = true
      await this.stopNativePoll()
      try { await this.device.close() } catch { /* ignore */ }
      this.stopReadLoopRequested = false
      return
    }

    this.stopReadLoopRequested = true
    // transferIn fallback — drain, reset only a stuck idle read outside update recovery.
    let drainedCleanly = false
    if (this.readLoopRunning) {
      const deadline = Date.now() + 3000
      let lastBytes = this.totalBytesReceived
      let idleMs = 0
      while (Date.now() < deadline) {
        if (!this.readLoopRunning) {
          drainedCleanly = true // in-flight read completed, loop stopped, nothing pending
          break
        }
        if (this.totalBytesReceived !== lastBytes) {
          lastBytes = this.totalBytesReceived
          idleMs = 0
        } else {
          idleMs += 30
          if (idleMs >= 400) break // no data flowing → idle read, won't complete on its own
        }
        await new Promise((r) => setTimeout(r, 30))
      }
    } else {
      drainedCleanly = true // loop wasn't running (no pending transfer)
    }

    this.readLoopRunning = false
    try {
      if (!drainedCleanly && !this.deviceValidationReadOnly && !this.firmwareRecoveryReadOnly && this.firmwareUploadFence === 'none') {
        try { await this.device.reset() } catch { /* may re-enumerate / already gone */ }
      }
      try { await this.device.close() } catch { /* ignore */ }
    } finally {
      this.stopReadLoopRequested = false
    }
  }

  /** True while ANY teardown (disconnect / quarantine / recovery cleanup) is in flight. */
  private isTearingDown(): boolean {
    return this.teardownDepth > 0
  }

  /**
   * EXPLICIT disconnect (user / IPC / tryConnect's pre-connect cleanup). Bumps the
   * session generation SYNCHRONOUSLY, which invalidates any pending OR in-flight
   * quarantine-recovery cycle (every recovery await re-checks the generation) —
   * an explicit disconnect can therefore never be followed by a recovery reopen.
   */
  async disconnect(): Promise<void> {
    if (this.firmwareUploadFence !== 'none' && !(this.firmwareRecoveryReadOnly && !this.firmwareUploadRunning)) return
    this.sessionGeneration++
    // Kill a recovery attempt still waiting on its backoff timer. An attempt already
    // past the timer is killed by the generation bump above at its next await.
    this.cancelQuarantineRecovery()
    await this.performTeardown()
  }

  /**
   * INTERNAL teardown: refcounted (a concurrent teardown finishing cannot clear the
   * ownership another still holds — settlements stand down while teardownDepth > 0)
   * and serialized (two teardown bodies never interleave gracefulCloseDevice on the
   * same handle). Does NOT bump the session generation — quarantine and recovery use
   * it to clean up without invalidating their own cycle.
   */
  private performTeardown(): Promise<void> {
    this.connectionSessionId++
    this.traceProtocol({ kind: 'lifecycle', state: 'teardown', atMs: Date.now(), connectionSessionId: this.connectionSessionId })
    // Claim ownership SYNCHRONOUSLY so a settlement mid-drain stands down the moment
    // teardown is requested, not when the serialized body eventually runs.
    this.teardownDepth++
    const run = this.lifecycleChain.then(
      () => this.teardownBody(),
      () => this.teardownBody()
    )
    this.lifecycleChain = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.teardownDepth-- })
  }

  private async teardownBody(): Promise<void> {
    this.removeUsbDisconnectListener()

    if (this.device) {
      await this.gracefulCloseDevice()
      this.device = null
    }

    // Reset all state
    this.currentCommandTag = null
    this.currentOperationName = null
    this.readLoopRunning = false
    this.sequenceId = 0
    this.receiveChunks.length = 0
    this.carryLen = 0
    this.commandQueue.length = 0
    this.data = {}

    if (this.decodeTimer) {
      clearTimeout(this.decodeTimer)
      this.decodeTimer = null
    }

    // Resolve all pending promises with null
    for (const [, pending] of this.pendingPromises) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.resolve(null)
    }
    this.pendingPromises.clear()

    this.ondisconnect?.()
  }

  /**
   * Reset USB device to recover from stuck state.
   * Not in jensen.js but needed by hidock-device.ts.
   */
  async reset(): Promise<boolean> {
    if (this.deviceValidationReadOnly || this.firmwareRecoveryReadOnly || this.firmwareUploadFence !== 'none') return false
    if (!this.device) return false

    // Explicit lifecycle op: invalidate any pending/in-flight recovery cycle.
    this.sessionGeneration++
    this.connectionSessionId++
    this.traceProtocol({ kind: 'lifecycle', state: 'reset', atMs: Date.now(), connectionSessionId: this.connectionSessionId })
    this.cancelQuarantineRecovery()

    if (shouldLog()) console.log('[Jensen] Resetting device...')
    try {
      // Cancel the native poll FIRST (clean libusb cancel) — issuing device.reset()
      // while poll transfers are pending re-triggers the very wedge this avoids.
      this.stopReadLoopRequested = true
      await this.stopNativePoll()

      // Clear protocol state
      this.sequenceId = 0
      this.currentCommandTag = null
      this.currentOperationName = null
      this.readLoopRunning = false
      this.receiveChunks.length = 0
      this.carryLen = 0
      this.commandQueue.length = 0
      this.data = {}

      for (const [, pending] of this.pendingPromises) {
        if (pending.timeout) clearTimeout(pending.timeout)
        pending.resolve(null)
      }
      this.pendingPromises.clear()

      if (this.device.opened) {
        try {
          await this.device.reset()
        } catch {
          await this.device.close()
          await this.device.open()
          await this.device.selectConfiguration(1)
          await this.device.claimInterface(0)
          await this.device.selectAlternateInterface(0, 0)
        }
      }
      // Allow the read loop to start again for post-reset commands.
      this.stopReadLoopRequested = false
      return true
    } catch (error) {
      console.error('[Jensen] Reset failed:', error)
      this.stopReadLoopRequested = false
      return false
    }
  }

  // ================================================================
  // USB helpers
  // ================================================================

  private isHiDockUsbDevice(device: USBDevice): boolean {
    if (!USB_VENDOR_IDS.includes(device.vendorId)) return false
    const name = device.productName?.toLowerCase() ?? ''
    if (name.includes('hidock') || name.includes('jensen')) return true
    return Object.values(USB_PRODUCT_IDS).includes(device.productId)
  }

  private detectModel(productId: number): DeviceModel {
    switch (productId) {
      case USB_PRODUCT_IDS.H1:
      case USB_PRODUCT_IDS.H1_NEW:
      case USB_PRODUCT_IDS.H1_ALT1:
      case USB_PRODUCT_IDS.H1_ALT2:
        return 'hidock-h1'
      case USB_PRODUCT_IDS.H1E_OLD:
      case USB_PRODUCT_IDS.H1E:
      case USB_PRODUCT_IDS.H1E_ALT1:
      case USB_PRODUCT_IDS.H1E_ALT2:
        return 'hidock-h1e'
      case USB_PRODUCT_IDS.P1_OLD:
      case USB_PRODUCT_IDS.P1:
      case USB_PRODUCT_IDS.P1_ALT:
        return 'hidock-p1'
      case USB_PRODUCT_IDS.P1_MINI:
      case USB_PRODUCT_IDS.P1_MINI_NEW:
      case USB_PRODUCT_IDS.P1_MINI_ALT:
        return 'hidock-p1-mini'
      case USB_PRODUCT_IDS.H1_LITE:
        return 'hidock-h1-lite'
      default:
        return 'unknown'
    }
  }

  getModel(): DeviceModel {
    return this.model
  }

  // ================================================================
  // USB event listeners
  // ================================================================

  private handleDisconnect(): void {
    if (shouldLog()) console.log('[Jensen] USB device physically disconnected')
    // Cancel the poll best-effort (this can be reached via the WebUSB 'disconnect'
    // DOM event, racing libusb's own NO_DEVICE error) so kernel transfers aren't
    // left orphaned. The device is gone, so stopPoll may throw — ignore.
    if (this.pollEndpoint) {
      const ep = this.pollEndpoint
      this.detachPollListeners(ep)
      try { ep.stopPoll() } catch { /* device already gone */ }
    }
    this.stopReadLoopRequested = false
    this.device = null
    this.pollEndpoint = null // device gone; poll transfers already errored out
    this.sequenceId = 0
    this.readLoopRunning = false
    this.receiveChunks.length = 0
    this.carryLen = 0
    this.currentCommandTag = null
    this.currentOperationName = null
    this.commandQueue.length = 0

    for (const [, pending] of this.pendingPromises) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.resolve(null)
    }
    this.pendingPromises.clear()

    this.ondisconnect?.()
  }

  private setupUsbDisconnectListener(): void {
    if (!this.device) return
    this.usbDisconnectHandler = (event: USBConnectionEvent) => {
      if (event.device === this.device) this.handleDisconnect()
    }
    this.usb.addEventListener('disconnect', this.usbDisconnectHandler)
  }

  private removeUsbDisconnectListener(): void {
    if (this.usbDisconnectHandler) {
      this.usb.removeEventListener('disconnect', this.usbDisconnectHandler)
      this.usbDisconnectHandler = null
    }
  }

  /**
   * Set up USB connect listener for device plug-in detection.
   * Matches jensen.js: navigator.usb.onconnect = () => g.tryconnect()
   */
  setupUsbConnectListener(): void {
    if (this.usbListenersActive) return
    if (!this.usb) return

    this.usbConnectHandler = (event: USBConnectionEvent) => {
      if (this.isHiDockUsbDevice(event.device)) {
        if (this.autoConnectGate && !this.autoConnectGate()) {
          if (shouldLog()) console.log('[Jensen] USB connect event ignored (auto-connect disabled)')
          return
        }
        if (shouldLog()) console.log('[Jensen] USB connect event, triggering tryConnect')
        this.tryConnect(event.device)
      }
    }
    this.usb.addEventListener('connect', this.usbConnectHandler as EventListener)
    this.usbListenersActive = true
  }

  removeUsbConnectListener(): void {
    if (!this.usbListenersActive) return
    if (this.usbConnectHandler) {
      this.usb.removeEventListener('connect', this.usbConnectHandler as EventListener)
    }
    this.usbConnectHandler = null
    this.usbListenersActive = false
  }

  // ================================================================
  // CORE: Command queue — matches jensen.js send/sendNext/createPromise
  // ================================================================

  /**
   * Run `fn` with exclusive access to the device so concurrent callers serialize
   * instead of interleaving on the USB bus. Every public command funnels through
   * here via sendCommand(). It is a promise chain (hand-rolled p-queue), so a
   * failing/timing-out command never breaks the chain — the next command still
   * runs. Lifecycle ops must NOT use this (they need to preempt a stuck command).
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commandLock.then(fn, fn)
    this.commandLock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Public entry point for every command. Serialized through the command lock so
   * a second command awaits the first's completion/timeout before it is even
   * queued — the single-outstanding-command invariant the response matcher
   * (by command id, no sequence correlation) depends on.
   */
  private sendCommand<T>(msg: JensenMessage, timeoutSec?: number, operationName?: string): Promise<T> {
    if (this.deviceValidationReadOnly && !this.isValidationRead(msg)) return Promise.resolve(null as T)
    return this.runExclusive(async () => {
      if (msg.command === CMD.GET_DEVICE_INFO && (this.firmwareUploadFence === 'uploaded' ||
        (this.firmwareUploadFence === 'uncertain' && this.firmwareRecoveryReadOnly && !this.firmwareUploadRunning))) {
        if (!Number.isFinite(timeoutSec) || !timeoutSec || timeoutSec <= 0 || timeoutSec > 10) return null as T
        const reply = await this.dispatchFirmwareReply(msg, timeoutSec, operationName ?? 'firmwarePostUploadIdentity')
        if (!reply || reply instanceof Error || reply.body.length !== 17) return null as T
        return this.handlers.get(CMD.GET_DEVICE_INFO)?.(reply, this) as T
      }
      if ([CMD.REALTIME_READ_SETTING, CMD.REALTIME_CONTROL, CMD.REALTIME_TRANSFER].includes(msg.command as 32 | 33 | 34) && !supportsRealtimeFirmware(this.model, this.versionNumber)) return null as T
      const result = await this.dispatchCommand<T>(msg, timeoutSec, operationName)
      return result instanceof Error ? null as T : result
    })
  }

  /** Exclusive caller only. Temporary raw handler correlates exact packet sequence. */
  private async dispatchFirmwareReply(msg: JensenMessage, timeout: number, operation: string): Promise<ResponseMessage | Error | null> {
    const original = this.handlers.get(msg.command)
    this.handlers.set(msg.command, reply => {
      if (!reply) return new Error('Malformed firmware workflow response')
      if (reply.id !== msg.command || this.currentCommandTag !== `cmd-${msg.command}-${msg.index}` || (reply.sequence >>> 0) !== (msg.index >>> 0)) return undefined
      return reply
    })
    try { return await this.dispatchCommand<ResponseMessage | Error | null>(msg, timeout, operation, true) }
    finally {
      if (original) this.handlers.set(msg.command, original)
      else this.handlers.delete(msg.command)
    }
  }

  /**
   * Read-only snapshot on the existing transport owner. CMD29 empty can also be
   * an allocation failure, so CMD18 corroborates idle before reporting false.
   * No filename is returned, and no updater/reset/abort command is sent.
   */
  async getFirmwareUpdatePreflight(timeout = 5): Promise<FirmwareUpdatePreflight | null> {
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 10) { this.firmwarePreflightFailure = { stage: 'gate', reason: 'invalid-timeout' }; return null }
    return this.runExclusive(() => this.readFirmwareUpdatePreflight(timeout))
  }

  private async readFirmwareUpdatePreflight(timeout: number): Promise<FirmwareUpdatePreflight | null> {
      this.firmwarePreflightFailure = null
      const failed = (stage: FirmwareUpdatePreflightFailure['stage'], reason: FirmwareUpdatePreflightFailure['reason'], responseBytes?: number): null => { this.firmwarePreflightFailure = { stage, reason, ...(responseBytes === undefined ? {} : { responseBytes }) }; return null }
      const deadline = Date.now() + timeout * 1000
      const remaining = () => Math.max(0, (deadline - Date.now()) / 1000)
      const handle = this.device, serialNumber = this.serialNumber, versionNumber = this.versionNumber, versionCode = this.versionCode, generation = this.sessionGeneration
      const sameSession = () => this.isConnected() && this.device === handle && this.serialNumber === serialNumber && this.sessionGeneration === generation && this.model === 'hidock-h1e' && this.versionNumber === versionNumber && this.versionCode === versionCode
      if (typeof versionNumber !== 'number' || !isOrdinaryH1eVersion(versionNumber, versionCode ?? '')) return failed('gate', 'version')
      if (!sameSession() || !serialNumber?.trim()) return failed('gate', 'identity')
      // CMD29 was added in6.3.0. Older H1E uses the original CMD18 path.
      let activeRecording = false
      if (versionNumber >= 393984) {
        const statusReply = await this.dispatchFirmwareReply(new JensenMessage(CMD.GET_RECORDING_STATUS), remaining(), 'firmwareUpdatePreflightStatus')
        if (!sameSession()) return failed('status', 'session-changed')
        if (!statusReply || statusReply instanceof Error) return failed('status', statusReply instanceof Error ? 'response-error' : 'missing-reply')
        const status = parseNativeRecordingStatusPayload(statusReply.body)
        if (!status) return failed('status', 'malformed-reply', statusReply.body.length)
        activeRecording = status.recording !== null
      }
      if (!activeRecording) {
        if (!remaining()) return null
        const corroboration = await this.dispatchFirmwareReply(new JensenMessage(CMD.GET_RECORDING_FILE), remaining(), 'firmwareUpdatePreflightIdle')
        if (!sameSession()) return failed('idle', 'session-changed')
        if (!corroboration || corroboration instanceof Error) return failed('idle', corroboration instanceof Error ? 'response-error' : 'missing-reply')
        // Legacy constructor allocates32B including4B prefix and NUL; copies
        // strlen-4 filename bytes. Empty is idle. Malformed nonempty fails closed.
        const name = corroboration.body
        if (name.length > 27 || name.some(byte => byte < 32 || byte > 126)) return failed('idle', 'malformed-reply', name.length)
        activeRecording = name.length > 0
      }
      if (!remaining()) return null
      const cardReply = await this.dispatchFirmwareReply(new JensenMessage(CMD.GET_CARD_INFO), remaining(), 'firmwareUpdatePreflightCard')
      if (!sameSession()) return failed('card', 'session-changed')
      if (!cardReply || cardReply instanceof Error) return failed('card', cardReply instanceof Error ? 'response-error' : 'missing-reply')
      const card = parseFirmwareUpdateCard(cardReply.body)
      return card ? { model: 'hidock-h1e', versionNumber, serialNumber, activeRecording, card } : failed('card', 'malformed-reply', cardReply.body.length)
  }

  getFirmwareUpdatePreflightFailure(): FirmwareUpdatePreflightFailure | null { return this.firmwarePreflightFailure ? { ...this.firmwarePreflightFailure } : null }

  getFirmwareUploadFence(): FirmwareUploadFence { return this.firmwareUploadFence }

  /** Operational readback only. This does not attest flash bytes or boot recovery.
   * A durable owner releases firmwareRecoveryReadOnly only after saving confirmation. */
  async verifyFirmwareUpdateBoot(expected: FirmwareBootExpectation, timeout = 10): Promise<FirmwareBootVerification> {
    const target = expected ? { ...expected } : null
    const result = (status: FirmwareBootVerification['status'], reason: string,
      readbacks: Omit<FirmwareBootVerification, 'status' | 'reason' | 'imageAttested'> = {}): FirmwareBootVerification => ({ status, reason, imageAttested: false, ...readbacks })
    if (!target || typeof target.serialNumber !== 'string' || !target.serialNumber.trim() || target.serialNumber.length > 13 ||
      /[^\x20-\x7e]/.test(target.serialNumber) || !isOrdinaryH1eVersion(target.versionNumber) || typeof target.customRecording !== 'boolean' ||
      (target.customRecording && target.versionNumber !== 393985 && target.versionNumber !== 393986 && target.versionNumber !== 393988 && target.versionNumber !== 393990) ||
      (target.sourceVersionNumber !== undefined && !isOrdinaryH1eVersion(target.sourceVersionNumber)) ||
      !Number.isFinite(timeout) || timeout <= 0 || timeout > 30) return result('unavailable', 'invalid-expectation')
    return this.runExclusive(async () => {
      const sourceVersion = target.sourceVersionNumber ?? this.firmwareUploadSourceVersion
      if (sourceVersion === null) return result('unavailable', 'source-version-unavailable')
      if (sourceVersion === target.versionNumber) return result('mismatch', 'target-version-equals-source')
      if (this.firmwareUploadRunning || !this.isConnected() || this.model !== 'hidock-h1e') return result('unavailable', 'owner-unavailable')
      const handle = this.device, generation = this.sessionGeneration
      const sameSession = () => this.isConnected() && this.device === handle && this.sessionGeneration === generation &&
        this.model === 'hidock-h1e' && !this.poisoned && !this.isTearingDown()
      const deadline = Date.now() + timeout * 1000
      const read = async (command: number): Promise<ResponseMessage | null> => {
        const left = (deadline - Date.now()) / 1000
        if (left <= 0 || !sameSession()) return null
        const reply = await this.dispatchFirmwareReply(new JensenMessage(command), left, 'firmwarePostBootReadback')
        return sameSession() && reply && !(reply instanceof Error) ? reply : null
      }
      const values: Omit<FirmwareBootVerification, 'status' | 'reason' | 'imageAttested'> = {}
      this.firmwareBootVerificationRunning = true
      try {
        const identity = await read(CMD.GET_DEVICE_INFO)
        if (!identity || identity.body.length !== 17) return result('unavailable', 'identity-unavailable', values)
        const versionNumber = new DataView(identity.body.buffer, identity.body.byteOffset, 4).getUint32(0)
        const serialBytes = identity.body.subarray(4)
        if (serialBytes.some(byte => byte !== 0 && (byte < 32 || byte > 126))) return result('unavailable', 'malformed-identity', values)
        const zero = serialBytes.indexOf(0), serialNumber = Array.from(serialBytes.subarray(0, zero < 0 ? serialBytes.length : zero), byte => String.fromCharCode(byte)).join('')
        if (zero >= 0 && serialBytes.subarray(zero).some(byte => byte !== 0)) return result('unavailable', 'malformed-identity', values)
        if (!serialNumber) return result('unavailable', 'malformed-identity', values)
        const versionCode = `${identity.body[1]}.${identity.body[2]}.${identity.body[3]}`
        values.deviceInfo = { versionNumber, versionCode, serialNumber, model: 'hidock-h1e' }
        this.versionNumber = versionNumber; this.versionCode = versionCode; this.serialNumber = serialNumber
        if (serialNumber !== target.serialNumber) return result('mismatch', 'serial-mismatch', values)
        if (versionNumber !== target.versionNumber) return result('mismatch', versionNumber === sourceVersion ? 'source-version-observed' : 'version-mismatch', values)
        if (!isOrdinaryH1eVersion(versionNumber, versionCode)) return result('mismatch', 'version-code-mismatch', values)
        if (target.customRecording) {
          const profile = await read(CUSTOM_RECORDING_PROFILE_GET)
          const parsedProfile = profile && parseCustomRecordingProfileResponse(profile.body)
          if (!parsedProfile) return result('unavailable', 'recording-profile-unavailable', values)
          values.recordingProfile = parsedProfile
          const format = await read(CUSTOM_RECORDING_FORMAT_GET)
          const parsedFormat = format && parseCustomRecordingFormatResponse(format.body)
          if (!parsedFormat) return result('unavailable', 'recording-format-unavailable', values)
          values.recordingFormat = parsedFormat
          const rules = await read(CUSTOM_MARKER_RULES_GET)
          const parsedRules = rules && parseCustomMarkerRulesResponse(rules.body)
          if (!parsedRules) return result('unavailable', 'marker-rules-unavailable', values)
          values.markerRules = parsedRules
        }
        if (versionNumber >= 393984) {
          const reply = await read(CMD.GET_RECORDING_STATUS)
          const status = reply && parseNativeRecordingStatusPayload(reply.body)
          if (!status) return result('unavailable', 'recording-status-unavailable', values)
          values.activeRecording = status.recording !== null
          if (values.activeRecording) return result('mismatch', 'native-recording-active', values)
        }
        const corroboration = await read(CMD.GET_RECORDING_FILE)
        if (!corroboration || corroboration.body.length > 27 || corroboration.body.some(byte => byte < 32 || byte > 126)) return result('unavailable', 'recording-idle-unavailable', values)
        values.activeRecording = corroboration.body.length > 0
        if (values.activeRecording) return result('mismatch', 'native-recording-active', values)
        const cardReply = await read(CMD.GET_CARD_INFO)
        const card = cardReply && parseFirmwareUpdateCard(cardReply.body)
        if (!card) return result('unavailable', 'card-unavailable', values)
        values.card = card
        if (!isFirmwareUpdateCardReady(card)) return result('mismatch', 'card-not-ready', values)
        if (!sameSession()) return result('unavailable', 'session-changed', values)
        this.firmwareUploadFence = 'none'
        return result('confirmed', 'operational-readback-confirmed', values)
      } catch {
        return result('unavailable', 'readback-error', values)
      } finally {
        this.firmwareBootVerificationRunning = false
      }
    })
  }

  /**
   * Offline-qualified mutation primitive; no application IPC exposes it.
   * One complete CMD9 frame/full transferOut is the retained vendor sequence,
   * not a guessed chunk protocol. No automatic retry, abort, reset or reconnect.
   * A successful final ACK means uploaded, never installed or boot-verified.
   */
  async uploadFirmware(artifact: FirmwareUploadArtifact, expected: FirmwareUploadSession): Promise<FirmwareUploadResult> {
    const result = (status: FirmwareUploadResult['status'], phase: FirmwareUploadResult['phase'], reason: string, requestAccepted = false, acknowledgedImageBytes = 0): FirmwareUploadResult => ({ status, phase, reason, requestAccepted, acknowledgedImageBytes, installation: 'unverified' })
    if (this.deviceValidationReadOnly) return result('rejected', 'preflight', 'device-validation-read-only')
    if (this.firmwareRecoveryReadOnly) return result('rejected', 'preflight', 'firmware-recovery-read-only')
    const snapshot = artifact ? { model: artifact.model, versionNumber: artifact.versionNumber, sha256: artifact.sha256, image: artifact.image } : null
    const image = snapshot ? copyFirmwareUploadArtifact(snapshot) : null, targetVersion = snapshot?.versionNumber
    const session = expected ? { serialNumber: expected.serialNumber, versionNumber: expected.versionNumber, versionCode: expected.versionCode, uploadTimeoutSeconds: expected.uploadTimeoutSeconds, allowDowngrade: expected.allowDowngrade } : null
    const uploadTimeout = session?.uploadTimeoutSeconds ?? 300
    const sourceQualified = !!session && isOrdinaryH1eVersion(session.versionNumber, session.versionCode) && (session.allowDowngrade === undefined || typeof session.allowDowngrade === 'boolean') && permitsFirmwareVersion(targetVersion!, session.versionNumber, session.allowDowngrade)
    if (!image || !session?.serialNumber?.trim() || !sourceQualified || !Number.isFinite(uploadTimeout) || uploadTimeout <= 0 || uploadTimeout > 300) return result('rejected', 'validation', 'invalid-artifact-or-session')
    if (snapshot!.sha256 === ACCEPTED_H1E_FORWARD_STOCK_RESTORE.sha256 && (session.versionNumber !== 393988 || session.versionCode !== '6.3.4')) return result('rejected', 'validation', 'restore-source-version-unqualified')
    return this.runExclusive(async () => {
      if (this.deviceValidationReadOnly) return result('rejected', 'preflight', 'device-validation-read-only')
      if (this.firmwareRecoveryReadOnly) return result('rejected', 'preflight', 'firmware-recovery-read-only')
      if (this.firmwareUploadFence !== 'none') return result('rejected', 'preflight', 'firmware-session-fenced')
      let hashTimer: ReturnType<typeof setTimeout> | undefined
      try { if (!await Promise.race([matchesAcceptedFirmwareImage(image, snapshot!.sha256), new Promise<boolean>(resolve => { hashTimer = setTimeout(() => resolve(false), 5000) })])) return result('rejected', 'validation', 'artifact-hash-mismatch') }
      catch { return result('rejected', 'validation', 'artifact-hash-unavailable') }
      finally { if (hashTimer) clearTimeout(hashTimer) }
      const handle = this.device, generation = this.sessionGeneration
      const sameSession = () => this.isConnected() && this.device === handle && this.sessionGeneration === generation && this.model === 'hidock-h1e' && this.serialNumber === session.serialNumber && this.versionNumber === session.versionNumber && this.versionCode === session.versionCode
      if (!sameSession()) return result('rejected', 'preflight', 'device-identity-mismatch')
      if (snapshot!.sha256 === ACCEPTED_H1E_FORWARD_STOCK_RESTORE.sha256) {
        const capability = await this.dispatchFirmwareReply(new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), 5, 'firmwareRestoreREA1Qualification')
        if (!sameSession() || !capability || capability instanceof Error || !parseCustomRecordingProfileResponse(capability.body)) return result('rejected', 'preflight', 'restore-source-REA1-unqualified')
      }
      const ready = await this.readFirmwareUpdatePreflight(5)
      if (!sameSession() || !ready) return result('rejected', 'preflight', 'readiness-unavailable')
      if (ready.activeRecording) return result('rejected', 'preflight', 'native-recording-active')
      if (!isFirmwareUpdateCardReady(ready.card) || ready.card.freeMiB < Math.ceil(image.length / 1048576)) return result('rejected', 'preflight', 'card-unavailable-or-full')
      // Latch BEFORE CMD8 could change device update state. Only a correlated,
      // exact known rejection can release this session without new authority.
      this.firmwareUploadSourceVersion = session.versionNumber
      this.firmwareUploadFence = 'uncertain'; this.firmwareUploadRunning = true
      this.cancelQuarantineRecovery()
      let phase: 'request' | 'upload' = 'request', requestAccepted = false
      try {
        const request = await this.dispatchFirmwareReply(new JensenMessage(CMD.REQUEST_FIRMWARE_UPGRADE).body(encodeFirmwareUpgradeRequest(targetVersion!, image.length)), 5, 'requestFirmwareUpgrade')
        if (!sameSession() || !request || request instanceof Error) return result('uncertain', 'request', request instanceof Error ? 'request-transport-error' : 'request-timeout-or-session-changed')
        const accepted = parseFirmwareUpgradeAck(request.body)
        if (!accepted) return result('uncertain', 'request', 'malformed-request-ack')
        if (accepted !== 'accepted') { this.firmwareUploadFence = 'none'; return result('rejected', 'request', accepted) }
        phase = 'upload'; requestAccepted = true
        const upload = await this.dispatchFirmwareReply(new JensenMessage(CMD.FIRMWARE_UPLOAD).body(image), uploadTimeout, 'uploadFirmware')
        if (!sameSession() || !upload || upload instanceof Error) return result('uncertain', 'upload', upload instanceof Error ? 'upload-transport-error' : 'upload-timeout-or-session-changed', true)
        const ack = parseFirmwareUploadAck(upload.body)
        if (ack !== 'success') return result('uncertain', 'upload', ack === null ? 'malformed-upload-ack' : 'upload-rejected', true)
        this.firmwareUploadFence = 'uploaded'
        return result('uploaded', 'upload', 'upload-acknowledged-boot-unverified', true, image.length)
      } catch { return result('uncertain', phase, 'firmware-workflow-error', requestAccepted) }
      finally { this.firmwareUploadRunning = false }
    })
  }

  /**
   * Queue a command and return a promise for its result.
   * Matches jensen.js send(): assign seq, push to queue, call sendNext, return promise.
   */
  private isValidationRead(message: JensenMessage): boolean {
    if (message.command === RECORDING_RESTORE_COMMAND) return isRecordingRestoreReadOnlyBody(message.msgBody)
    if (message.command === OWNED_SCRATCH_UPLOAD_COMMAND) return isOwnedScratchStatusBody(message.msgBody)
    return [1, 2, 4, 5, 6, 11, 13, 16, 18, 21, 26, 29, 32, 34, 0xf001, 0xf006, 0xf00e, 0xf011,
      CUSTOM_RECORDING_PROFILE_GET, CUSTOM_RECORDING_FORMAT_GET, CUSTOM_MARKER_RULES_GET, FIRMWARE_CONSOLE_STATUS].includes(message.command)
  }

  private dispatchCommand<T>(msg: JensenMessage, timeoutSec?: number, operationName?: string, strictWrite = true): Promise<T> {
    if (this.deviceValidationReadOnly && !this.isValidationRead(msg)) return Promise.resolve(null as T)
    if (this.poisoned || this.isTearingDown()) return Promise.resolve(null as T)
    if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 3600)) return Promise.resolve(null as T)
    const recoveryRead = [CMD.GET_DEVICE_INFO, CMD.GET_CARD_INFO, CMD.GET_RECORDING_FILE, CMD.GET_RECORDING_STATUS,
      CUSTOM_RECORDING_PROFILE_GET, CUSTOM_RECORDING_FORMAT_GET, CUSTOM_MARKER_RULES_GET].includes(msg.command) ||
      msg.command === OWNED_SCRATCH_UPLOAD_COMMAND && isOwnedScratchStatusBody(msg.msgBody)
      || msg.command === RECORDING_RESTORE_COMMAND && isRecordingRestoreReadOnlyBody(msg.msgBody)
    if (this.firmwareRecoveryReadOnly && !recoveryRead) return Promise.resolve(null as T)
    if (this.firmwareUploadFence !== 'none' && !((this.firmwareBootVerificationRunning || (this.firmwareRecoveryReadOnly && !this.firmwareUploadRunning)) && recoveryRead) &&
      !(this.firmwareUploadFence === 'uploaded' && msg.command === CMD.GET_DEVICE_INFO) &&
      !(this.firmwareUploadRunning && (msg.command === CMD.REQUEST_FIRMWARE_UPGRADE || msg.command === CMD.FIRMWARE_UPLOAD))) return Promise.resolve(null as T)
    // Original H1E continuation construction shifts the low16 sequence into the
    // high16 reply bytes. Zero is the only safe fixed point of both encodings.
    // Restrict this wire override to CMD9 in the exclusive upload workflow;
    // CMD8 and ordinary requests keep monotonic sequence correlation.
    if (this.firmwareUploadRunning && msg.command === CMD.FIRMWARE_UPLOAD) msg.sequence(0)
    else {
      msg.sequence(this.sequenceId >>> 0)
      this.sequenceId = (this.sequenceId + 1) >>> 0
    }
    if (timeoutSec) msg.expireAfter(timeoutSec)
    if (strictWrite) this.strictWriteStates.set(`cmd-${msg.command}-${msg.index}`, { completed: false })

    this.commandQueue.push({
      msg,
      operationName: operationName ?? `cmd-${msg.command}`,
      strictWrite,
    })

    // Register before transport callbacks can reply synchronously.
    const pending = this.createPromise<T>(msg, timeoutSec)
    this.sendNextCommand()
    return pending
  }

  /**
   * Pop next command from queue and send it.
   * Matches jensen.js j(): if (h) return; pop queue; set h; transferOut; start read loop.
   */
  private sendNextCommand(): void {
    // One command at a time (jensen.js: if (h) return)
    if (this.currentCommandTag) return
    if (!this.device) return
    if (this.poisoned || this.isTearingDown()) return

    // Pop from queue, skip expired commands
    const now = Date.now()
    let entry: QueueEntry | undefined
    while (this.commandQueue.length > 0) {
      entry = this.commandQueue.shift()!
      if (entry.msg.expireTime > 0 && entry.msg.expireTime < now) {
        if (shouldLog()) console.log(`[Jensen] expired: cmd-${entry.msg.command}-${entry.msg.index}`)
        this.expireCommand(`cmd-${entry.msg.command}-${entry.msg.index}`)
        entry = undefined
        continue
      }
      break
    }
    if (!entry) return

    const tag = `cmd-${entry.msg.command}-${entry.msg.index}`
    this.currentCommandTag = tag
    this.currentOperationName = entry.operationName

    // GET_RECORDING_FILE is a 20s background poll (live-recording detection) —
    // logging every probe drowns the console; state CHANGES are logged by the
    // poll's owner instead.
    if (shouldLog() && entry.msg.command !== CMD.GET_RECORDING_FILE) {
      console.log(`[Jensen] sendNext: ${entry.operationName} (${tag})`)
    }

    // Set parse delay based on command type
    // jensen.js: g.timewait = d.command == 5 || d.command == G ? 1e3 : 10
    this.parseDelay =
      (entry.msg.command === CMD.TRANSFER_FILE || entry.msg.command === CMD.GET_FILE_BLOCK)
        ? 1000 : 10

    // Send command
    const data = entry.msg.make()
    const sendHandle = this.device, stateAtSend = this.strictWriteStates.get(tag)
    let write: Promise<USBOutTransferResult>
    try {
      if (entry.msg.onstart?.() === false) {
        if (stateAtSend) stateAtSend.completed = true
        this.triggerResolve(false, entry.msg.command)
        return
      }
      this.traceProtocol({ kind: 'out', commandId: entry.msg.command, sequence: entry.msg.index >>> 0, requestBytes: data.length,
        payloadBytes: data.length - 12, atMs: Date.now(), connectionSessionId: this.connectionSessionId })
      write = this.device.transferOut(EP_OUT, data as BufferSource)
    }
    catch (error) { write = Promise.reject(error) }
    write.then(
      (result) => {
        this.traceProtocol({ kind: 'write-result', commandId: entry!.msg.command, sequence: entry!.msg.index >>> 0,
          bytesWritten: result.bytesWritten, expectedBytes: data.length, status: result.status === 'ok' ? 'ok' : result.status === 'stall' ? 'stall' : 'other',
          atMs: Date.now(), connectionSessionId: this.connectionSessionId })
        const strictState = this.strictWriteStates.get(tag)
        if (entry!.strictWrite && (!strictState || strictState !== stateAtSend || this.device !== sendHandle || this.currentCommandTag !== tag)) return
        if (strictState) strictState.completed = true
        if (entry!.strictWrite && (result.status !== 'ok' || result.bytesWritten !== data.length)) {
          this.noteProtocolFault('usb-write-incomplete')
          if (this.firmwareUploadFence === 'none') {
            void this.quarantineConnection('USB command write incomplete')
          }
          this.triggerResolve(new Error('Firmware workflow USB write incomplete'), entry!.msg.command)
          return
        }
        if (entry!.msg.onprogress) entry!.msg.onprogress(1, 1)
        // Reset byte counter
        this.totalBytesReceived = 0
        // Start read loop if not running (jensen.js: k == 0 ? R() : (k = !0))
        if (!this.readLoopRunning) {
          this.startReadLoop()
        }
        if (strictState && Object.prototype.hasOwnProperty.call(strictState, 'reply')) this.triggerResolve(strictState.reply, entry!.msg.command)
      },
      (error) => {
        this.noteProtocolFault('usb-write-failed')
        if (entry!.strictWrite) {
          const state = this.strictWriteStates.get(tag)
          if (!state || state !== stateAtSend || this.device !== sendHandle || this.currentCommandTag !== tag) return
          state.completed = true
          if (this.firmwareUploadFence === 'none') {
            void this.quarantineConnection('USB command write failed')
          }
          this.triggerResolve(error instanceof Error ? error : new Error('Firmware workflow USB write failed'), entry!.msg.command)
          return
        }
        console.error('[Jensen] transferOut failed:', error)
        this.versionCode = null
        this.versionNumber = null
        // Clear command tag to unblock queue (was missing — caused permanent stall)
        this.currentCommandTag = null
        this.currentOperationName = null
        this.sendNextCommand()
      }
    )
  }

  /**
   * Create a promise for a queued command.
   * Matches jensen.js B(): tag-keyed promise stored in map, optional timeout.
   */
  private createPromise<T>(msg: JensenMessage, timeoutSec?: number): Promise<T> {
    const tag = `cmd-${msg.command}-${msg.index}`
    const timer = timeoutSec
      ? setTimeout(() => this.expireCommand(tag), timeoutSec * 1000)
      : null

    return new Promise<T>((resolve, reject) => {
      this.pendingPromises.set(tag, {
        tag,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timer
      })
    })
  }

  /**
   * Expire a command by resolving its promise with null.
   *
   * Beyond jensen.js x() (resolve null + delete), this also UNBLOCKS the queue
   * when the timed-out command is the one in flight: it clears currentCommandTag
   * and drops any partially received bytes, then advances. Without this a timeout
   * left currentCommandTag set forever — every later command queued behind it and
   * never sent (the permanent-wedge half of the poll desync). Dropping the read
   * buffer also discards a late response for THIS command so it can't be parsed
   * against the next command's slot. (Only short single-response commands set a
   * timeout; listFiles uses its own watchdog, while downloadFile uses this
   * bounded command timeout.)
   */
  private expireCommand(tag: string): void {
    this.noteProtocolFault('command-timeout')
    this.strictWriteStates.delete(tag)
    if (shouldLog()) console.log(`[Jensen] timeout: ${tag}`)
    const pending = this.pendingPromises.get(tag)
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.resolve(null)
      this.pendingPromises.delete(tag)
    }

    if (this.currentCommandTag === tag) {
      this.currentCommandTag = null
      this.currentOperationName = null
      this.receiveChunks.length = 0
      this.carryLen = 0
      if (this.decodeTimer) {
        clearTimeout(this.decodeTimer)
        this.decodeTimer = null
      }
      this.sendNextCommand()
    }
  }

  // ================================================================
  // CORE: Continuous read loop — matches jensen.js R/N/E
  // ================================================================

  /**
   * Reach node-usb's native IN endpoint (poll API) through the WebUSB wrapper.
   * Returns null in a real browser or if the native handle isn't exposed — the
   * caller then falls back to the WebUSB transferIn loop.
   */
  private getNativeInEndpoint(): NativePollEndpoint | null {
    try {
      const native = (this.device as unknown as { device?: NativeUsbDeviceLike })?.device
      const ep = native?.interface?.(0)?.endpoint?.(EP_IN)
      if (ep && typeof ep.startPoll === 'function' && typeof ep.stopPoll === 'function') {
        return ep
      }
    } catch { /* fall back to transferIn */ }
    return null
  }

  /** Remove the 'data'/'error' listeners attached for poll-based reading. */
  private detachPollListeners(ep: NativePollEndpoint): void {
    try {
      if (this.pollDataHandler) ep.removeListener('data', this.pollDataHandler)
      if (this.pollErrorHandler) ep.removeListener('error', this.pollErrorHandler)
    } catch { /* ignore */ }
    this.pollDataHandler = null
    this.pollErrorHandler = null
  }

  /**
   * Cancel the native poll cleanly: detach listeners, stopPoll() (real libusb
   * cancel — no device.reset()), and wait for the transfers to unwind. Safe to
   * call when not polling (no-op). Used by both teardown and reset() so a USB
   * port reset never fires with poll transfers still pending.
   */
  private async stopNativePoll(): Promise<void> {
    const ep = this.pollEndpoint
    if (!ep) return
    this.pollEndpoint = null
    this.detachPollListeners(ep)
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => { if (!done) { done = true; resolve() } }
      try { ep.stopPoll(finish) } catch { finish() }
      setTimeout(finish, 2000) // safety: never hang on a missing callback
    })
    this.readLoopRunning = false
  }

  /**
   * Start (or continue) the continuous USB read loop.
   *
   * Preferred path (Electron main / Node): native startPoll(3, 8192). libusb
   * keeps 3 transfers pending in its event thread (continuous flow even when the
   * JS thread is busy), and stopPoll() cancels them cleanly on teardown — so we
   * never device.reset() (which wedges the firmware mid-operation). Matches the
   * approach prescribed in CLAUDE.md.
   *
   * Fallback path (real browser): self-sustaining transferIn(2, 8192) loop, as
   * in jensen.js R(); onDataReceived re-issues it.
   */
  private startReadLoop(): void {
    if (!this.device || this.stopReadLoopRequested) return
    if (this.readLoopRunning) return // already reading (poll is continuous)

    if (!this.pollEndpoint) this.pollEndpoint = this.getNativeInEndpoint()

    if (this.pollEndpoint) {
      this.readLoopRunning = true
      const ep = this.pollEndpoint

      this.pollDataHandler = (buffer: Uint8Array) => {
        if (this.stopReadLoopRequested) return // teardown — ignore
        if (buffer && buffer.byteLength > 0) {
          // The 'data' buffer is a view over a reused libusb buffer — copy it out
          // before the next transfer overwrites it.
          const copy = new Uint8Array(buffer.byteLength)
          copy.set(buffer)
          this.ingestReadChunk(new DataView(copy.buffer))
        }
      }
      this.pollErrorHandler = (error: Error) => {
        if (this.stopReadLoopRequested) return // cancellation during teardown
        const msg = error?.message || String(error)
        if (/NO_DEVICE|NOT_FOUND|LIBUSB_TRANSFER_NO_DEVICE|LIBUSB_ERROR_NO_DEVICE/.test(msg)) {
          this.readLoopRunning = false
          this.detachPollListeners(ep)
          this.pollEndpoint = null
          this.handleDisconnect()
        } else {
          console.warn('[Jensen] USB poll error (non-disconnect):', msg)
        }
      }

      ep.on('data', this.pollDataHandler)
      ep.on('error', this.pollErrorHandler)
      // Match the source-defined frame exception so exact-sized replies reach JS
      // without requiring a subsequent packet/ZLP. Assembly still spans reads.
      this.protocolReadRequest = { transport: 'native-poll', bufferBytes: USB_READ_BUFFER_BYTES, transfers: 3 }
      ep.startPoll(3, USB_READ_BUFFER_BYTES)
      return
    }

    // Fallback: WebUSB transferIn loop (browser).
    this.readLoopRunning = true
    this.protocolReadRequest = { transport: 'webusb', bufferBytes: USB_READ_BUFFER_BYTES, transfers: 1 }
    this.device.transferIn(2, USB_READ_BUFFER_BYTES).then(
      (result) => this.onDataReceived(result),
      (error) => {
        this.readLoopRunning = false
        const isDisconnect =
          (error instanceof Error && error.name === 'InvalidStateError') ||
          (error instanceof Error && /NO_DEVICE|NOT_FOUND|LIBUSB_TRANSFER_NO_DEVICE|LIBUSB_ERROR_NO_DEVICE/.test(error.message))
        if (isDisconnect) {
          this.handleDisconnect()
        } else {
          // Log non-disconnect USB errors (previously swallowed silently)
          console.warn('[Jensen] USB read error (non-disconnect):', error instanceof Error ? error.message : error)
        }
      }
    )
  }

  /**
   * Buffer a received chunk and schedule a parse. Shared by the poll callback and
   * the transferIn fallback (onDataReceived).
   */
  private ingestReadChunk(chunk: DataView): void {
    this.protocolInboundBytes += chunk.byteLength
    this.traceProtocol({ kind: 'in', bytes: chunk.byteLength, atMs: Date.now(), connectionSessionId: this.connectionSessionId })
    this.totalBytesReceived += chunk.byteLength
    this.receiveChunks.push(chunk)

    // THROTTLE (not debounce) the parse. Resetting the timer on every chunk means
    // a continuous stream — startPoll keeps transfers pending with no gaps — never
    // triggers a parse until it stops, which buffered the whole file in memory and
    // froze download/scan progress until the end. Scheduling at most one parse per
    // parseDelay makes it fire on schedule during continuous flow; the carry buffer
    // already handles messages split across parse boundaries.
    if (!this.decodeTimer) {
      this.decodeTimer = setTimeout(() => {
        this.decodeTimer = null
        this.processBufferedData()
      }, this.parseDelay)
    }

    if (this.onreceive) {
      try { this.onreceive(this.totalBytesReceived) } catch { /* ignore */ }
    }
  }

  /**
   * Handle data received from USB.
   * Matches jensen.js N(): push data, restart loop, debounce parse, fire onreceive.
   */
  private onDataReceived(result: USBInTransferResult): void {
    // Restart read loop immediately (perpetual — matches jensen.js: R() in N()),
    // unless a graceful teardown asked us to stop. Stopping here (rather than
    // re-issuing) means no transferIn is left pending, so close() succeeds without
    // a device reset.
    if (this.stopReadLoopRequested) {
      this.readLoopRunning = false
    } else {
      this.readLoopRunning = false // allow startReadLoop to re-issue (guards on readLoopRunning)
      this.startReadLoop()
    }

    if (result.data && result.data.byteLength > 0) {
      this.ingestReadChunk(result.data)
    }
  }

  /**
   * Parse all buffered data and dispatch to handlers.
   * Matches jensen.js E(): concatenate chunks, parse packets, call handlers.
   */
  private processBufferedData(): void {
    // 100KB work buffer (matches jensen.js: new ArrayBuffer(102400))
    let workBuffer = new Uint8Array(Math.max(102400, this.carryLen))
    let workLen = 0
    let decodeError = false

    // Prepend carry bytes from previous call (partial Jensen messages)
    if (this.carryLen > 0) {
      workBuffer.set(this.carryBuffer.subarray(0, this.carryLen), 0)
      workLen = this.carryLen
      this.carryLen = 0
    }

    const chunkCount = this.receiveChunks.length
    for (let qi = 0; qi < chunkCount; qi++) {
      const chunk = this.receiveChunks.shift()!

      const required = workLen + chunk.byteLength
      if (required > 0xffffff + 12 + 255 + 65536) {
        this.receiveChunks.length = 0
        this.carryLen = 0
        const tag = this.currentCommandTag
        if (this.activeFileStreamFailure) this.activeFileStreamFailure('response-envelope-exceeded')
        else if (tag) this.expireCommand(tag)
        return
      }
      if (required > workBuffer.length) {
        // A fragmented frame can exceed the former 100KiB buffer. Copying past
        // its end silently lost bytes and fabricated a truncated reply.
        const expanded = new Uint8Array(required)
        expanded.set(workBuffer.subarray(0, workLen))
        workBuffer = expanded
      }

      // Copy chunk to flat buffer (jensen.js uses getInt8 — bit pattern preserved in Uint8Array)
      for (let i = 0; i < chunk.byteLength; i++) {
        workBuffer[i + workLen] = chunk.getInt8(i)
      }
      workLen += chunk.byteLength

      // Parse all complete messages
      let consumed = 0
      for (;;) {
        let parsed: { message: ResponseMessage; length: number } | null = null
        try {
          parsed = this.parsePacket(workBuffer, consumed, workLen)
        } catch {
          this.noteProtocolFault('malformed-response')
          decodeError = true
          break
        }
        if (!parsed) break

        consumed += parsed.length
        const msg = parsed.message
        this.traceProtocol({ kind: 'frame', commandId: msg.id, sequence: msg.sequence >>> 0, logicalBytes: msg.body.length,
          bodyBytes: msg.body.length, wireBytes: parsed.length, paddingBytes: parsed.length - 12 - msg.body.length,
          correlated: this.currentCommandTag === `cmd-${msg.id}-${msg.sequence >>> 0}`, atMs: Date.now(), connectionSessionId: this.connectionSessionId })
        // Correlate before any handler mutates cached identity or stream state.
        // A late reply to the same opcode must not settle a newer request.
        if (this.currentCommandTag !== `cmd-${msg.id}-${msg.sequence >>> 0}`) continue

        if (shouldLog() && msg.id !== CMD.TRANSFER_FILE && msg.id !== CMD.GET_RECORDING_FILE) {
          console.log(`[Jensen] recv: cmd=${msg.id}, seq=${msg.sequence}, bodyLen=${msg.body.length}`)
        }

        // Dispatch to handler (jensen.js: s.handlers[S.id](S, g))
        try {
          const handler = this.handlers.get(msg.id)
          if (handler) {
            const result = handler(msg, this)
            // If handler returns truthy → resolve promise (jensen.js: A && m(A, S.id))
            if (result !== undefined) {
              this.triggerResolve(result, msg.id)
            }
          }
        } catch (error) {
          // Handler threw — matches jensen.js: m(A) with no cmdId
          if (this.activeFileStreamFailure) this.activeFileStreamFailure('stream-consumer-error')
          else this.triggerResolve(error instanceof Error ? error : new Error(String(error)), msg.id)
        }

        // Try to send next command after each message (matches jensen.js: j() in E loop)
        this.sendNextCommand()
      }

      // Decode error recovery (matches jensen.js decode error handling in E())
      if (decodeError) {
        if (this.activeFileStreamFailure) {
          this.activeFileStreamFailure('malformed-response')
          this.receiveChunks.length = 0
          this.carryLen = 0
          break
        }
        if (this.currentCommandTag) {
          const cmdIdMatch = this.currentCommandTag.match(/^cmd-(\d+)-/)
          const cmdId = cmdIdMatch ? parseInt(cmdIdMatch[1]) : -1
          let resolved = false
          if (cmdId >= 0) {
            try {
              const handler = this.handlers.get(cmdId)
              if (handler) {
                const partialResult = handler(null, this)
                // Use partial results if handler returned them (e.g., partially parsed file list)
                if (partialResult !== undefined && partialResult !== null) {
                  this.triggerResolve(partialResult, cmdId)
                  resolved = true
                }
              }
            } catch (error) {
              this.triggerResolve(error instanceof Error ? error : new Error(String(error)), cmdId)
              resolved = true
            }
          }
          if (!resolved) {
            this.triggerResolve(null, cmdId >= 0 ? cmdId : undefined)
          }
          // Unblock the command queue (was missing — caused permanent stall after decode error)
          this.sendNextCommand()
        }
        this.receiveChunks.length = 0
        this.carryLen = 0
        break
      }

      // Shift consumed data out of work buffer
      for (let i = 0; i < workLen - consumed; i++) {
        workBuffer[i] = workBuffer[i + consumed]
      }
      workLen -= consumed
    }

    // Save any remaining unparsed bytes for the next call
    if (workLen > 0 && !decodeError) {
      if (this.carryBuffer.length < workLen) {
        this.carryBuffer = new Uint8Array(workLen * 2)
      }
      this.carryBuffer.set(workBuffer.subarray(0, workLen), 0)
      this.carryLen = workLen
    }
  }

  // ================================================================
  // CORE: Packet parser — matches jensen.js Z()
  // ================================================================

  /**
   * Parse one Jensen protocol message from buffer at offset.
   * Returns null if not enough data. Throws on invalid header.
   * Matches jensen.js Z() exactly.
   */
  private parsePacket(
    buffer: Uint8Array,
    offset: number,
    totalLength: number
  ): { message: ResponseMessage; length: number } | null {
    const available = totalLength - offset
    if (available < 12) return null

    // Check sync marker (jensen.js: d[u+0] !== 18 || d[u+1] !== 52)
    if (buffer[offset] !== 0x12 || buffer[offset + 1] !== 0x34) {
      throw new Error('invalid header')
    }

    // Command ID — 16-bit big-endian (jensen.js: F(d[u+C], d[u+C+1]))
    const cmdId = ((buffer[offset + 2] & 0xff) << 8) | (buffer[offset + 3] & 0xff)

    // Sequence — 32-bit big-endian
    const seqId =
      ((buffer[offset + 4] & 0xff) << 24) |
      ((buffer[offset + 5] & 0xff) << 16) |
      ((buffer[offset + 6] & 0xff) << 8) |
      (buffer[offset + 7] & 0xff)

    // Body length — bottom 24 bits; top byte is padding (jensen.js: M = ..., L = (M >> 24) & 255, M &= 16777215)
    const raw =
      ((buffer[offset + 8] & 0xff) << 24) |
      ((buffer[offset + 9] & 0xff) << 16) |
      ((buffer[offset + 10] & 0xff) << 8) |
      (buffer[offset + 11] & 0xff)
    const padding = (raw >> 24) & 0xff
    const bodyLen = raw & 0xffffff

    // Check if full message available
    if (available < 12 + bodyLen + padding) return null

    // Extract body (jensen.js: d.slice(u + H, u + H + M))
    let pos = 12
    const body = buffer.slice(offset + pos, offset + pos + bodyLen)
    pos += bodyLen
    pos += padding

    return { message: { id: cmdId, sequence: seqId >>> 0, body }, length: pos }
  }

  // ================================================================
  // CORE: Promise resolution — matches jensen.js m()
  // ================================================================

  /**
   * Resolve the current command's promise.
   * Matches jensen.js m(d, u): check tag matches cmdId, resolve, clear h.
   */
  private triggerResolve(value: unknown, cmdId?: number): void {
    if (!this.currentCommandTag) return

    if (cmdId !== undefined) {
      // Check if current command's cmdId matches (jensen.js: h.substring(0, h.lastIndexOf("-")) != "cmd-" + u)
      const lastDash = this.currentCommandTag.lastIndexOf('-')
      const prefix = this.currentCommandTag.substring(0, lastDash)
      if (prefix !== `cmd-${cmdId}`) {
        // Stale/late response whose command id doesn't match the in-flight
        // command — typically the response to a command that already timed out.
        // DISCARD it and keep the current tag intact. jensen.js cleared the tag
        // here, which made the NEXT genuine response match the wrong (now-empty)
        // slot and desynced every command/response pair afterwards. Because
        // commands are strictly serialized (see commandLock), the in-flight
        // command's own response is the only one we should ever act on.
        if (shouldLog()) {
          console.log(`[Jensen] discarding stale response cmd=${cmdId} (in flight: ${this.currentCommandTag})`)
        }
        return
      }
    } else {
      // No cmdId provided (handler threw) — always mismatch (matches jensen.js: m(A) with undefined u)
      this.currentCommandTag = null
      this.currentOperationName = null
      return
    }

    const strictState = this.strictWriteStates.get(this.currentCommandTag)
    if (strictState && !strictState.completed) { strictState.reply = value; return }
    const pending = this.pendingPromises.get(this.currentCommandTag)
    if (!pending) return

    if (pending.timeout) clearTimeout(pending.timeout)
    pending.resolve(value)
    this.pendingPromises.delete(this.currentCommandTag)
    this.strictWriteStates.delete(this.currentCommandTag)
    this.currentCommandTag = null
    this.currentOperationName = null
  }

  // ================================================================
  // Lock compatibility (for hidock-device.ts)
  // ================================================================

  isOperationInProgress(): boolean {
    return this.currentCommandTag !== null
  }

  /**
   * True after a transfer settlement had to quarantine the connection (a stall, or a
   * cancel that couldn't prove the stream quiesced). The session was torn down and a
   * clean reconnect is required; reset on the next setup().
   */
  isPoisoned(): boolean {
    return this.poisoned
  }

  getLockHolder(): string | null {
    return this.currentOperationName
  }

  // ================================================================
  // Default handlers — matches jensen.js s.registerHandler() calls
  // ================================================================

  private registerDefaultHandlers(): void {
    // GET_DEVICE_INFO (1)
    this.handlers.set(CMD.GET_DEVICE_INFO, (msg, device) => {
      if (!msg || msg.body.length < 17 || msg.body.length > 20) return null
      const body = msg.body
      // Exact H1E has 13 serial bytes. Older client fixtures include up to
      // three zero fill bytes; they must never become part of its identity.
      if (device.model === 'hidock-h1e' && body.subarray(17).some(byte => byte !== 0)) return null
      const versionParts: number[] = []
      let versionNumber = 0
      for (let i = 0; i < 4; i++) {
        const byte = body[i] & 0xff
        if (i > 0) versionParts.push(byte)
        versionNumber |= byte << (8 * (3 - i))
      }
      const snChars: string[] = []
      for (let i = 0; i < (device.model === 'hidock-h1e' ? 13 : body.length - 4); i++) {
        const byte = body[i + 4]
        if (byte === 0) break
        snChars.push(String.fromCharCode(byte))
      }
      device.versionCode = versionParts.join('.')
      device.versionNumber = versionNumber >>> 0
      device.serialNumber = snChars.join('')
      return {
        versionCode: device.versionCode,
        versionNumber: device.versionNumber,
        serialNumber: device.serialNumber,
        model: device.model
      }
    })

    // GET_DEVICE_TIME (2)
    this.handlers.set(CMD.GET_DEVICE_TIME, (msg, device) => {
      if (!msg || msg.body.length !== 7 || msg.body.some(byte => (byte & 15) > 9 || (byte >>> 4) > 9)) return null
      const bcd = device.fromBcd(msg.body[0], msg.body[1], msg.body[2], msg.body[3], msg.body[4], msg.body[5], msg.body[6])
      if (bcd !== '00000000000000') {
        const year = Number(bcd.slice(0, 4)), month = Number(bcd.slice(4, 6)), day = Number(bcd.slice(6, 8))
        if (year < 100 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
          Number(bcd.slice(8, 10)) > 23 || Number(bcd.slice(10, 12)) > 59 || Number(bcd.slice(12, 14)) > 59) return null
      }
      return {
        time: bcd === '00000000000000'
          ? 'unknown'
          : bcd.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/gi, '$1-$2-$3 $4:$5:$6')
      }
    })

    // GET_FILE_COUNT (6)
    this.handlers.set(CMD.GET_FILE_COUNT, (msg) => {
      if (!msg || msg.body.length !== 4) return null
      const count =
        ((msg.body[0] & 0xff) << 24) |
        ((msg.body[1] & 0xff) << 16) |
        ((msg.body[2] & 0xff) << 8) |
        (msg.body[3] & 0xff)
      return { count: count >>> 0 }
    })

    // GET_SETTINGS (11)
    this.handlers.set(CMD.GET_SETTINGS, (msg) => {
      if (!msg || ![8, 12, 16].includes(msg.body.length)) return null
      return {
        autoRecord: msg.body[3] === 1,
        autoPlay: msg.body[7] === 1,
        // Retained client polarity; physical option21 meaning is unqualified.
        bluetoothTone: msg.body.length >= 16 ? msg.body[15] !== 1 : undefined,
        notification: msg.body.length >= 12 ? msg.body[11] === 1 : undefined
      }
    })

    // GET_CARD_INFO (16)
    this.handlers.set(CMD.GET_CARD_INFO, (msg) => {
      if (!msg || msg.body.length < 12 || msg.body.length > 28) return null
      let pos = 0
      const freeMiB =
        ((msg.body[pos++] & 0xff) << 24) |
        ((msg.body[pos++] & 0xff) << 16) |
        ((msg.body[pos++] & 0xff) << 8) |
        (msg.body[pos++] & 0xff)
      const capacityMiB =
        ((msg.body[pos++] & 0xff) << 24) |
        ((msg.body[pos++] & 0xff) << 16) |
        ((msg.body[pos++] & 0xff) << 8) |
        (msg.body[pos++] & 0xff)
      const statusRaw =
        ((msg.body[pos++] & 0xff) << 24) |
        ((msg.body[pos++] & 0xff) << 16) |
        ((msg.body[pos++] & 0xff) << 8) |
        (msg.body[pos] & 0xff)
      if ((freeMiB >>> 0) > (capacityMiB >>> 0)) return null
      return {
        used: (capacityMiB >>> 0) - (freeMiB >>> 0),
        capacity: capacityMiB >>> 0,
        free: freeMiB >>> 0,
        status: (statusRaw >>> 0).toString(16)
      }
    })

    // DELETE_FILE (7)
    this.handlers.set(CMD.DELETE_FILE, (msg) => {
      if (!msg || msg.body.length !== 1) return null
      let result = 'failed'
      if (msg.body[0] === 0) result = 'success'
      else if (msg.body[0] === 1) result = 'not-exists'
      return { result }
    })

    // Generic result handler for simple success/fail commands
    const resultHandler: CommandHandler = (msg) => {
      if (!msg || msg.body.length !== 1) return null
      return { result: msg.body[0] === 0 ? 'success' : 'failed' }
    }

    this.handlers.set(CMD.SET_DEVICE_TIME, resultHandler)
    this.handlers.set(CMD.SET_SETTINGS, resultHandler)
    this.handlers.set(CMD.FORMAT_CARD, resultHandler)
    this.handlers.set(CMD.RESTORE_FACTORY_SETTINGS, resultHandler)
    this.handlers.set(CMD.FACTORY_RESET, resultHandler)
    this.handlers.set(CMD.REALTIME_CONTROL, resultHandler)
    this.handlers.set(CMD.FIRMWARE_UPLOAD, msg => {
      if (!msg) return null
      const result = parseFirmwareUploadAck(msg.body)
      return result === null ? null : { result }
    })
    this.handlers.set(CMD.TONE_UPDATE, resultHandler)
    this.handlers.set(CMD.UAC_UPDATE, resultHandler)
    this.handlers.set(CMD.SEND_MEETING_SCHEDULE_INFO, resultHandler)
    this.handlers.set(CMD.BLUETOOTH_CMD, resultHandler)
    this.handlers.set(CMD.BLUETOOTH_SCAN, resultHandler)
    this.handlers.set(CMD.BT_SCAN, resultHandler)
    this.handlers.set(CMD.BT_REMOVE_PAIRED_DEV, resultHandler)
    // CMD13 is a file-byte stream, not an acknowledgement. readFilePrefix
    // installs its bounded stream handler for the duration of the operation.
    this.handlers.set(CMD.GET_FILE_BLOCK, msg => msg ? msg.body.slice() : null)

    // REALTIME_READ_SETTING (32) — return raw
    this.handlers.set(CMD.REALTIME_READ_SETTING, (msg) => {
      if (!msg) return null
      return msg
    })

    // REALTIME_TRANSFER (34)
    this.handlers.set(CMD.REALTIME_TRANSFER, (msg) => {
      if (!msg) return null
      return parseRealtimePayload(msg.body)
    })

    // GET_BATTERY_STATUS (4100)
    this.handlers.set(CMD.GET_BATTERY_STATUS, (msg) => {
      if (!msg || (msg.body.length !== 2 && msg.body.length !== 6)) return null
      const statusByte = msg.body[0] & 0xff
      let status: 'idle' | 'charging' | 'full' = 'idle'
      if (statusByte === 1) status = 'charging'
      else if (statusByte === 2) status = 'full'
      const batteryLevel = msg.body[1] & 0xff
      const voltage = msg.body.length >= 6
        ? ((((msg.body[2] & 0xff) << 24) | ((msg.body[3] & 0xff) << 16) | ((msg.body[4] & 0xff) << 8) | (msg.body[5] & 0xff)) >>> 0)
        : undefined
      return { status, batteryLevel, voltage }
    })

    // BLUETOOTH_STATUS (4099)
    this.handlers.set(CMD.BLUETOOTH_STATUS, (msg) => {
      if (!msg || msg.body.length === 0) return null
      return { connected: msg.body[0] === 1, raw: msg.body }
    })

    // BT_DEV_LIST / BT_GET_PAIRED_DEV_LIST — return raw
    this.handlers.set(CMD.BT_DEV_LIST, (msg) => {
      if (!msg) return null
      return { raw: msg.body }
    })
    this.handlers.set(CMD.BT_GET_PAIRED_DEV_LIST, (msg) => {
      if (!msg) return null
      return { raw: msg.body }
    })

    // REQUEST_FIRMWARE_UPGRADE (8)
    this.handlers.set(CMD.REQUEST_FIRMWARE_UPGRADE, (msg) => {
      if (!msg) return null
      const result = parseFirmwareUpgradeAck(msg.body)
      return result === null ? null : { result }
    })

    // Tone/UAC update request handlers
    const updateRequestHandler: CommandHandler = (msg) => {
      if (!msg || msg.body.length !== 1) return null
      const code = msg.body[0]
      // Unlike CMD8, the exact target emits only a boolean ACK here. Tone
      // selector rejection must not be mislabeled as a size mismatch.
      return { code, result: code === 0 ? 'success' : 'failed' }
    }
    this.handlers.set(CMD.REQUEST_TONE_UPDATE, updateRequestHandler)
    this.handlers.set(CMD.REQUEST_UAC_UPDATE, updateRequestHandler)

    // TRANSFER_FILE_PARTIAL (21)
    this.handlers.set(CMD.TRANSFER_FILE_PARTIAL, (msg) => {
      if (!msg) return null
      const data = new Uint8Array(msg.body.length)
      for (let i = 0; i < msg.body.length; i++) data[i] = msg.body[i] & 0xff
      return data
    })

    // GET_RECORDING_FILE (18)
    this.handlers.set(CMD.GET_RECORDING_FILE, (msg) => {
      if (!msg) return null
      if (msg.body.length === 0) return { recording: null }
      const chars: string[] = []
      for (let i = 0; i < msg.body.length; i++) {
        chars.push(String.fromCharCode(msg.body[i]))
      }
      return { recording: chars.join(''), name: chars.join('') }
    })

    // Return a truthy error sentinel so malformed replies settle the current
    // command immediately. A null handler result means "keep waiting" here.
    this.handlers.set(CMD.GET_RECORDING_STATUS, (msg) => {
      if (!msg) return new Error('Missing native recording-status reply')
      return parseNativeRecordingStatusPayload(msg.body) ?? new Error('Malformed native recording-status reply')
    })
    this.handlers.set(CMD.SEND_KEY_CODE, (msg) => {
      if (!msg) return new Error('Missing native recording-control acknowledgement')
      return parseNativeRecordingCommandAck(msg.body) ?? new Error('Malformed native recording-control acknowledgement')
    })
    this.handlers.set(CUSTOM_RECORDING_PROFILE_GET, msg => {
      return msg ? parseCustomRecordingProfileResponse(msg.body) ?? new Error('Malformed experimental profile reply') : new Error('Missing experimental profile reply')
    })
    this.handlers.set(CUSTOM_RECORDING_PROFILE_SET, msg => {
      if (!msg || msg.body.length !== 1) return new Error('Malformed experimental profile ACK')
      return { result: msg.body[0] === 0 ? 'success' : 'failed', persistence: 'unverified' }
    })
    this.handlers.set(CUSTOM_RECORDING_FORMAT_GET, msg => msg
      ? parseCustomRecordingFormatResponse(msg.body) ?? new Error('Malformed experimental format reply')
      : new Error('Missing experimental format reply'))
    this.handlers.set(CUSTOM_RECORDING_FORMAT_SET, msg => {
      if (!msg || msg.body.length !== 1) return new Error('Malformed experimental format ACK')
      return { result: msg.body[0] === 0 ? 'success' : 'failed', persistence: 'unverified' }
    })
    this.handlers.set(CUSTOM_MARKER_RULES_GET, msg => msg
      ? parseCustomMarkerRulesResponse(msg.body) ?? new Error('Malformed experimental rules reply')
      : new Error('Missing experimental rules reply'))
    this.handlers.set(CUSTOM_MARKER_RULES_SET, msg => {
      if (!msg || msg.body.length !== 1) return new Error('Malformed experimental rules ACK')
      return { result: msg.body[0] === 0 ? 'success' : 'failed', persistence: 'unverified' }
    })
  }

  // ================================================================
  // Public API — simple commands
  // ================================================================

  async getDeviceInfo(timeout = 10): Promise<DeviceInfo | null> {
    try {
      return await this.sendCommand<DeviceInfo | null>(
        new JensenMessage(CMD.GET_DEVICE_INFO), timeout, 'getDeviceInfo')
    } catch {
      return null
    }
  }

  async getTime(timeout = 5): Promise<{ time: string } | null> {
    try {
      return await this.sendCommand<{ time: string } | null>(
        new JensenMessage(CMD.GET_DEVICE_TIME), timeout, 'getTime')
    } catch {
      return null
    }
  }

  async setTime(date: Date, timeout = 5): Promise<{ result: string } | null> {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < 100 || date.getFullYear() > 9999) return null
    const dateStr = [
      String(date.getFullYear()).padStart(4, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
      String(date.getSeconds()).padStart(2, '0')
    ].join('')
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.SET_DEVICE_TIME).body(this.toBcd(dateStr)), timeout, 'setTime')
    } catch {
      return null
    }
  }

  async getFileCount(timeout = 15): Promise<{ count: number } | null> {
    try {
      return await this.sendCommand<{ count: number } | null>(
        new JensenMessage(CMD.GET_FILE_COUNT), timeout, 'getFileCount')
    } catch {
      return null
    }
  }

  async getSettings(timeout = 5): Promise<DeviceSettings | null> {
    if (this.versionNumber && this.versionNumber < 327714) {
      return { autoRecord: false, autoPlay: false }
    }
    try {
      return await this.sendCommand<DeviceSettings | null>(
        new JensenMessage(CMD.GET_SETTINGS), timeout, 'getSettings')
    } catch {
      return null
    }
  }

  async setAutoRecord(enabled: boolean, timeout = 5): Promise<{ result: string } | null> {
    if (typeof enabled !== 'boolean') return null
    if (this.versionNumber && this.versionNumber < 327714) {
      return { result: 'unsupported' }
    }
    try {
      // CMD12 always reads both complete words at offsets3 and7. The second
      // zero word preserves autoPlay; an8-byte body also omits notification
      // and Bluetooth-prompt fields. A4-byte request reads beyond its body on
      // original firmware and is rejected by the guarded custom firmware.
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.SET_SETTINGS).body([0, 0, 0, enabled ? 1 : 2, 0, 0, 0, 0]), timeout, 'setAutoRecord')
    } catch {
      return null
    }
  }

  /**
   * Query the file the device is CURRENTLY recording (CMD 18). Resolves with the
   * in-progress recording's filename, or `{ recording: null }` when the device is
   * idle (not capturing). This is a passive status read — safe to poll while the
   * device sits idle — but it MUST NOT be issued during a file transfer or list
   * scan (it would interleave on the USB bus); the caller is responsible for that
   * guard. Returns `null` only on timeout or when no device is connected.
   */
  async getRecordingFile(timeout = 5): Promise<{ recording: string | null } | null> {
    if (!this.device) return null
    try {
      return await this.sendCommand<{ recording: string | null } | null>(
        new JensenMessage(CMD.GET_RECORDING_FILE), timeout, 'getRecordingFile')
    } catch {
      return null
    }
  }

  /**
   * Exact-target native controls share the existing command lock. Recheck
   * identity when the lock is acquired: an earlier queued operation may have
   * changed the connection/version. Never retry a marker or recording toggle.
   * App-level recording/live ownership and mutation authorization are separate.
   */
  private async sendQualifiedNativeRecordingCommand<T>(msg: JensenMessage, timeout: number, operation: string): Promise<T | null> {
    try {
      const reply = await this.runExclusive(async () => {
        const stock = this.isConnected() && this.model === 'hidock-h1e' && originalRecordingFirmware(this.versionNumber, this.versionCode)
        if ((!stock && !this.qualifiedCustomRecordingProfile(timeout)) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30) return null
        if (!stock) {
          const generation = this.sessionGeneration, identity = this.serialNumber
          const capabilities = await this.dispatchCommand<CustomRecordingProfileResponse | Error | null>(
            new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), timeout, 'qualifyCustomNativeControl')
          if (!capabilities || capabilities instanceof Error || !this.qualifiedCustomRecordingProfile(timeout) || this.sessionGeneration !== generation || this.serialNumber !== identity) return null
        }
        return this.dispatchCommand<T | Error | null>(msg, timeout, operation)
      })
      return reply instanceof Error ? null : reply
    } catch {
      return null
    }
  }

  /**
   * Read bounded CMD29 status on the qualified H1E 6.3.0 target only.
   * Null means unknown/unsupported/failed, never idle. Empty successful replies
   * also occur on native allocation failure; corroborate inactive with CMD18.
   */
  async getRecordingStatus(timeout = 5): Promise<NativeRecordingStatus | null> {
    return this.sendQualifiedNativeRecordingCommand<NativeRecordingStatus>(
      new JensenMessage(CMD.GET_RECORDING_STATUS), timeout, 'getRecordingStatus')
  }

  /** Queue a mark at the device's current recording time. ACK does not prove persistence. */
  async addNativeMarker(timeout = 5): Promise<NativeRecordingCommandAck | null> {
    return this.sendQualifiedNativeRecordingCommand<NativeRecordingCommandAck>(
      new JensenMessage(CMD.SEND_KEY_CODE).body([1, 3]), timeout, 'addNativeMarker')
  }

  /** Toggle native recording once. The app must establish/guard the current state. */
  async toggleNativeRecording(timeout = 5): Promise<NativeRecordingCommandAck | null> {
    return this.sendQualifiedNativeRecordingCommand<NativeRecordingCommandAck>(
      new JensenMessage(CMD.SEND_KEY_CODE).body([2, 3]), timeout, 'toggleNativeRecording')
  }

  private qualifiedCustomRecordingProfile(timeout: number): boolean {
    return this.isConnected() && this.model === 'hidock-h1e' && customRecordingFirmware(this.versionNumber, this.versionCode) &&
      Number.isFinite(timeout) && timeout > 0 && timeout <= 30
  }

  /** Read experimental REA1 capabilities/configuration; official firmware sends nothing. */
  async getCustomRecordingProfile(timeout = 5): Promise<CustomRecordingProfileResponse | null> {
    try {
      const response = await this.runExclusive(() => this.qualifiedCustomRecordingProfile(timeout)
        ? this.dispatchCommand<CustomRecordingProfileResponse | Error>(new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), timeout, 'getCustomRecordingProfile')
        : Promise.resolve(null))
      return response instanceof Error ? null : response
    } catch { return null }
  }

  /** Idle-only target setter, preceded by a strict REA1 response; never retries. */
  async setCustomRecordingProfile(profile: CustomRecordingProfile, timeout = 5): Promise<{ result: 'success' | 'failed'; persistence: 'unverified' } | null> {
    try {
      const body = encodeCustomRecordingProfile(profile)
      const response = await this.runExclusive(async () => {
        if (!this.qualifiedCustomRecordingProfile(timeout)) return null
        const identity = this.serialNumber, generation = this.sessionGeneration
        const capabilities = await this.dispatchCommand<CustomRecordingProfileResponse | Error | null>(
          new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), timeout, 'qualifyCustomRecordingProfile')
        if (!capabilities || capabilities instanceof Error || !this.qualifiedCustomRecordingProfile(timeout) || this.serialNumber !== identity || this.sessionGeneration !== generation) return null
        return this.dispatchCommand<{ result: 'success' | 'failed'; persistence: 'unverified' } | Error | null>(
          new JensenMessage(CUSTOM_RECORDING_PROFILE_SET).body(Array.from(body)), timeout, 'setCustomRecordingProfile')
      })
      return response instanceof Error ? null : response
    } catch { return null }
  }

  /** Called only inside runExclusive; both extensions must qualify on this session. */
  private async queryCustomRecordingExtension<T>(command: number, timeout: number, operation: string): Promise<T | null> {
    if (!this.qualifiedCustomRecordingProfile(timeout)) return null
    const identity = this.serialNumber, generation = this.sessionGeneration
    const sameSession = () => this.qualifiedCustomRecordingProfile(timeout) && this.serialNumber === identity && this.sessionGeneration === generation
    const profile = await this.dispatchCommand<CustomRecordingProfileResponse | Error | null>(
      new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), timeout, 'qualifyCustomRecordingExtension')
    if (!profile || profile instanceof Error || !sameSession()) return null
    const extension = await this.dispatchCommand<T | Error | null>(new JensenMessage(command), timeout, operation)
    return !extension || extension instanceof Error || !sameSession() ? null : extension
  }

  async getCustomRecordingFormat(timeout = 5): Promise<CustomRecordingFormatResponse | null> {
    try { return await this.runExclusive(() => this.queryCustomRecordingExtension<CustomRecordingFormatResponse>(CUSTOM_RECORDING_FORMAT_GET, timeout, 'getCustomRecordingFormat')) }
    catch { return null }
  }

  /** The earlier REA1-only image has no REF1 support and cannot pass this guard. */
  async setCustomRecordingFormat(format: CustomRecordingFormat, timeout = 5): Promise<{ result: 'success' | 'failed'; persistence: 'unverified' } | null> {
    try {
      const body = encodeCustomRecordingFormat(format)
      const response = await this.runExclusive(async () => {
        if (!await this.queryCustomRecordingExtension<CustomRecordingFormatResponse>(CUSTOM_RECORDING_FORMAT_GET, timeout, 'qualifyCustomRecordingFormat')) return null
        return this.dispatchCommand<{ result: 'success' | 'failed'; persistence: 'unverified' } | Error | null>(
          new JensenMessage(CUSTOM_RECORDING_FORMAT_SET).body(Array.from(body)), timeout, 'setCustomRecordingFormat')
      })
      return response instanceof Error ? null : response
    } catch { return null }
  }

  async getCustomMarkerRules(timeout = 5): Promise<CustomMarkerRulesResponse | null> {
    try { return await this.runExclusive(() => this.queryCustomRecordingExtension<CustomMarkerRulesResponse>(CUSTOM_MARKER_RULES_GET, timeout, 'getCustomMarkerRules')) }
    catch { return null }
  }

  /** Candidate-literal read-only bridge. No stock probing, setter gate expansion or image attestation.
   * Cancellation discards sent-command results after their bounded settlement; it
   * never releases the serialized slot while an already sent response may arrive.
   */
  async getFirmwareConsoleStatus(request: FirmwareConsoleRequest, timeout = 5, signal?: AbortSignal): Promise<FirmwareConsoleStatus | null> {
    if (!isFirmwareConsoleRequest(request) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 10 || signal?.aborted) return null
    return this.runExclusive(async () => {
      const qualified = () => this.model === 'hidock-h1e' &&
        (this.versionNumber === 393986 && this.versionCode === '6.3.2' || this.versionNumber === 393988 && this.versionCode === '6.3.4' ||
          this.versionNumber === 393990 && this.versionCode === '6.3.6') &&
        !!this.serialNumber?.trim() && this.isConnected() && !this.poisoned && !this.isTearingDown()
      if (!qualified() || signal?.aborted) return null
      const identity = this.serialNumber, handle = this.device, epoch = this.getConnectionSessionId(), version = this.versionNumber,
        code = this.versionCode as FirmwareConsoleFirmware, deadline = Date.now() + timeout * 1000
      const sameSession = () => qualified() && this.versionNumber === version && this.versionCode === code &&
        this.device === handle && this.serialNumber === identity && this.getConnectionSessionId() === epoch
      const remaining = () => Math.max(0, (deadline - Date.now()) / 1000)
      const capabilitiesRequest = new JensenMessage(CUSTOM_RECORDING_PROFILE_GET)
      capabilitiesRequest.onstart = () => !signal?.aborted && sameSession()
      const capabilities = await this.dispatchFirmwareReply(capabilitiesRequest, remaining(), 'qualifyFirmwareConsoleStatus')
      if (!capabilities || capabilities instanceof Error || !parseCustomRecordingProfileResponse(capabilities.body) || !sameSession() || signal?.aborted || remaining() <= 0) return null
      const message = new JensenMessage(FIRMWARE_CONSOLE_STATUS).body(encodeFirmwareConsoleRequest(request))
      message.onstart = () => !signal?.aborted && sameSession()
      const reply = await this.dispatchFirmwareReply(message, remaining(), 'getFirmwareConsoleStatus')
      return !reply || reply instanceof Error || !sameSession() || signal?.aborted ? null : parseFirmwareConsoleStatus(request, reply.body, code)
    }).catch(() => null)
  }

  /** Captures owner metadata only. It performs no capability probe or disk/USB write. */
  createOwnedScratchUploadSession(uploadId: number, ownerToken: number, totalBytes: number, wholeCrc32: number): OwnedScratchUploadSession | null {
    const descriptor = { uploadId, ownerToken, totalBytes, wholeCrc32 }
    if (!isOwnedScratchUploadDescriptor(descriptor) || !this.qualifiedOwnedScratchUpload()) return null
    return Object.freeze({ ...descriptor, serialNumber: this.serialNumber!, connectionSessionId: this.getConnectionSessionId(), versionNumber: this.versionNumber as 393986 | 393988 })
  }

  private qualifiedOwnedScratchUpload(): boolean {
    return this.isConnected() && this.model === 'hidock-h1e' &&
      (this.versionNumber === 393986 && this.versionCode === '6.3.2' || this.versionNumber === 393988 && this.versionCode === '6.3.4') &&
      !!this.serialNumber?.trim() && !this.poisoned && !this.isTearingDown()
  }

  private sameOwnedScratchSession(session: OwnedScratchUploadSession): boolean {
    return isOwnedScratchUploadDescriptor(session) && session.versionNumber === this.versionNumber && typeof session.serialNumber === 'string' &&
      session.serialNumber === this.serialNumber && Number.isSafeInteger(session.connectionSessionId) &&
      session.connectionSessionId === this.getConnectionSessionId() && this.qualifiedOwnedScratchUpload()
  }

  /** FA_READ1 journal/stat lookup only; no implicit create/sync/truncate/unlink. */
  async getOwnedScratchUploadStatus(session: OwnedScratchUploadSession, timeout = 5, signal?: AbortSignal): Promise<OwnedScratchUploadReply | null> {
    if (!session || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30 || signal?.aborted) return null
    const bound = { ...session }
    if (!this.sameOwnedScratchSession(bound)) return null
    return this.runExclusive(async () => {
      if (!this.sameOwnedScratchSession(bound) || signal?.aborted || this.fileStreamPending || this.currentCommandTag !== null) return null
      const deadline = Date.now() + timeout * 1000, remaining = () => Math.max(0, (deadline - Date.now()) / 1000)
      const valid = () => this.sameOwnedScratchSession(bound) && !signal?.aborted
      const read = async (message: JensenMessage, operation: string) => {
        if (!valid() || remaining() <= 0) return null
        message.onstart = valid
        const reply = await this.dispatchFirmwareReply(message, remaining(), operation)
        return reply && !(reply instanceof Error) && valid() ? reply : null
      }
      const capabilities = await read(new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), 'qualifyOwnedScratchUploadStatus')
      if (!capabilities || !parseCustomRecordingProfileResponse(capabilities.body)) return null
      const request = { operation: 'status' as const }, body = encodeOwnedScratchUpload(bound, request)
      const reply = await read(new JensenMessage(OWNED_SCRATCH_UPLOAD_COMMAND).body(body), 'getOwnedScratchUploadStatus')
      return reply ? parseOwnedScratchUploadReply(bound, request, reply.body) : null
    }).catch(() => null)
  }

  /** One explicitly owned scratch mutation. Missing/malformed ACK is uncertain; never retry or loop. */
  async applyOwnedScratchUpload(session: OwnedScratchUploadSession, request: OwnedScratchUploadOperation, options: OwnedScratchWriteOptions): Promise<OwnedScratchWriteOutcome> {
    const rejected = (reason: string): OwnedScratchWriteOutcome => ({ status: 'rejected-before-dispatch', reason, commandAttempted: false })
    const timeout = options?.timeout ?? 5, signal = options?.signal
    const consent = () => options?.ownedScratchWriteConsent === true && options.normalJensen === true && options.massStorageInactive === true && options.audioQuiescent === true
    const policy = () => !this.deviceValidationReadOnly && !this.firmwareRecoveryReadOnly && this.firmwareUploadFence === 'none'
    if (!consent()) return rejected('explicit-owner-assurance-required')
    if (!policy()) return rejected('read-only-or-update-policy')
    if (!session || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30 || signal?.aborted) return rejected('invalid-or-cancelled-operation')
    const bound = { ...session }
    if (!this.sameOwnedScratchSession(bound)) return rejected('session-unqualified')
    let body: Uint8Array, copied: OwnedScratchUploadOperation
    try {
      copied = request.operation === 'append' ? { operation: 'append', offset: request.offset, data: request.data.slice() } : { operation: request.operation }
      if (!['begin', 'append', 'commit', 'abort'].includes(copied.operation)) return rejected('invalid-operation')
      body = encodeOwnedScratchUpload(bound, copied)
    } catch { return rejected('invalid-operation') }
    let attempted = false
    return this.runExclusive<OwnedScratchWriteOutcome>(async () => {
      if (!consent() || !policy() || !this.sameOwnedScratchSession(bound) || signal?.aborted || this.fileStreamPending || this.currentCommandTag !== null) return rejected('owner-unavailable')
      const deadline = Date.now() + timeout * 1000, remaining = () => Math.max(0, (deadline - Date.now()) / 1000)
      const valid = () => consent() && policy() && this.sameOwnedScratchSession(bound) && !signal?.aborted
      const read = async (message: JensenMessage, operation: string) => {
        if (!valid() || remaining() <= 0) return null
        message.onstart = valid
        const reply = await this.dispatchFirmwareReply(message, remaining(), operation)
        return reply && !(reply instanceof Error) && valid() ? reply : null
      }
      const capabilities = await read(new JensenMessage(CUSTOM_RECORDING_PROFILE_GET), 'qualifyOwnedScratchMutation')
      if (!capabilities || !parseCustomRecordingProfileResponse(capabilities.body)) return rejected('capability-unavailable')
      const recordingReply = await read(new JensenMessage(CMD.GET_RECORDING_STATUS), 'ownedScratchNativeIdle')
      const recording = recordingReply && parseNativeRecordingStatusPayload(recordingReply.body)
      if (!recording || recording.recording !== null) return rejected('native-idle-unavailable')
      const corroboration = await read(new JensenMessage(CMD.GET_RECORDING_FILE), 'ownedScratchIdleCorroboration')
      if (!corroboration || corroboration.body.length !== 0) return rejected('native-idle-unavailable')
      if (!valid() || remaining() <= 0) return rejected('session-or-deadline-changed')
      const message = new JensenMessage(OWNED_SCRATCH_UPLOAD_COMMAND).body(body)
      message.onstart = () => { if (!valid()) return false; attempted = true; return true }
      const reply = await this.dispatchFirmwareReply(message, remaining(), `ownedScratch:${copied.operation}`)
      if (!attempted) return rejected('cancelled-before-dispatch')
      if (!reply || reply instanceof Error || !valid()) return { status: 'uncertain', reason: 'reply-or-session-unavailable', commandAttempted: true }
      const parsed = parseOwnedScratchUploadReply(bound, copied, reply.body)
      return parsed ? { status: 'reply', commandAttempted: true, reply: parsed } : { status: 'uncertain', reason: 'malformed-reply', commandAttempted: true }
    }).catch((): OwnedScratchWriteOutcome => attempted ? { status: 'uncertain', reason: 'operation-error', commandAttempted: true } : rejected('preflight-error'))
  }

  async setCustomMarkerRules(rules: CustomMarkerRules, timeout = 5): Promise<{ result: 'success' | 'failed'; persistence: 'unverified' } | null> {
    const attempt: NonNullable<ProtocolDiagnostics['lastMarkerRulesAttempt']> = { attempt: ++this.markerRulesAttemptCount,
      atMs: Date.now(), connectionSessionId: this.connectionSessionId, stage: 'input', outcome: 'pending',
      commandId: null, sequence: null, responseBodyBytes: null, ackCode: null, mutationAttempted: false,
      validationReadOnly: this.deviceValidationReadOnly, recoveryReadOnly: this.firmwareRecoveryReadOnly,
      pendingUpdate: this.firmwareUploadFence !== 'none' }
    this.protocolLastMarkerRulesAttempt = attempt
    let body: Uint8Array
    try { body = encodeCustomMarkerRules(rules) }
    catch { attempt.outcome = 'invalid-input'; return null }
    attempt.stage = 'queued'
    try {
      return await this.runExclusive(async () => {
        attempt.connectionSessionId = this.connectionSessionId
        attempt.validationReadOnly = this.deviceValidationReadOnly; attempt.recoveryReadOnly = this.firmwareRecoveryReadOnly
        attempt.pendingUpdate = this.firmwareUploadFence !== 'none'
        if (!this.qualifiedCustomRecordingProfile(timeout)) { attempt.outcome = 'owner-unqualified'; return null }
        const identity = this.serialNumber, epoch = this.connectionSessionId, handle = this.device
        const sameSession = () => this.qualifiedCustomRecordingProfile(timeout) && this.serialNumber === identity &&
          this.connectionSessionId === epoch && this.device === handle
        const read = async (command: number, stage: 'profile' | 'rules' | 'mutation', operation: string): Promise<ResponseMessage | null> => {
          attempt.stage = stage; attempt.commandId = command; attempt.sequence = null; attempt.responseBodyBytes = null
          if (!sameSession()) { attempt.outcome = 'session-changed'; return null }
          const message = new JensenMessage(command)
          if (stage === 'mutation') message.body(body)
          message.onstart = () => {
            if (!sameSession()) { attempt.outcome = 'session-changed'; return false }
            attempt.sequence = message.index >>> 0
            if (stage === 'mutation') attempt.mutationAttempted = true
            return true
          }
          const reply = await this.dispatchFirmwareReply(message, timeout, operation)
          if (!sameSession()) { attempt.outcome = 'session-changed'; return null }
          if (!reply || reply instanceof Error) {
            attempt.outcome = stage === 'mutation' ? 'mutation-unavailable' : 'preflight-unavailable'; return null
          }
          attempt.responseBodyBytes = reply.body.length
          return reply
        }
        const profile = await read(CUSTOM_RECORDING_PROFILE_GET, 'profile', 'qualifyCustomRecordingExtension')
        if (!profile) return null
        if (!parseCustomRecordingProfileResponse(profile.body)) { attempt.outcome = 'malformed-reply'; return null }
        const supportedRules = await read(CUSTOM_MARKER_RULES_GET, 'rules', 'qualifyCustomMarkerRules')
        if (!supportedRules) return null
        if (!parseCustomMarkerRulesResponse(supportedRules.body)) { attempt.outcome = 'malformed-reply'; return null }
        const acknowledgement = await read(CUSTOM_MARKER_RULES_SET, 'mutation', 'setCustomMarkerRules')
        if (!acknowledgement) return null
        if (acknowledgement.body.length !== 1) { attempt.outcome = 'malformed-reply'; return null }
        attempt.ackCode = acknowledgement.body[0]
        attempt.outcome = attempt.ackCode === 0 ? 'acknowledged' : 'rejected'
        return { result: attempt.ackCode === 0 ? 'success' as const : 'failed' as const, persistence: 'unverified' as const }
      })
    } catch { attempt.outcome = 'error'; return null }
  }

  private qualifiedRecordingRestore(): boolean {
    return this.isConnected() && this.model === 'hidock-h1e' && this.versionNumber === 393988 && this.versionCode === '6.3.4' &&
      !!this.serialNumber?.trim() && !this.poisoned && !this.isTearingDown()
  }

  /** Prospective binding only. No request is sent and current393986 is unsupported. */
  createRecordingRestoreSession(descriptor: RecordingRestoreDescriptor): RecordingRestoreSession | null {
    const copy = copyRecordingRestoreDescriptor(descriptor)
    if (!copy || !this.qualifiedRecordingRestore()) return null
    return Object.freeze({ ...copy, serialNumber: this.serialNumber!, connectionSessionId: this.connectionSessionId, versionNumber: 393988 as const })
  }

  private sameRecordingRestoreSession(session: RecordingRestoreSession): boolean {
    return this.qualifiedRecordingRestore() && session.versionNumber === 393988 && session.serialNumber === this.serialNumber &&
      session.connectionSessionId === this.connectionSessionId
  }

  private async readRestoreWire(body: Uint8Array, deadline: number, valid: () => boolean, operation: string): Promise<ResponseMessage | null> {
    const remaining = (deadline - Date.now()) / 1000
    if (!valid() || remaining <= 0) return null
    const message = new JensenMessage(RECORDING_RESTORE_COMMAND).body(body)
    message.onstart = valid
    const reply = await this.dispatchFirmwareReply(message, remaining, operation)
    return valid() && reply && !(reply instanceof Error) ? reply : null
  }

  async getRecordingRestoreCapabilities(timeout = 5, signal?: AbortSignal): Promise<RecordingRestoreCapabilities | null> {
    if (!this.qualifiedRecordingRestore() || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30 || signal?.aborted) return null
    const epoch = this.connectionSessionId, handle = this.device, serial = this.serialNumber
    return this.runExclusive(async () => {
      const valid = () => this.qualifiedRecordingRestore() && this.connectionSessionId === epoch && this.device === handle && this.serialNumber === serial && !signal?.aborted
      if (!valid() || this.fileStreamPending || this.currentCommandTag !== null) return null
      const reply = await this.readRestoreWire(Uint8Array.of(5), Date.now() + timeout * 1000, valid, 'recordingRestoreCapabilities')
      return reply ? parseRecordingRestoreCapabilities(reply.body) : null
    }).catch(() => null)
  }

  async getRecordingRestoreStatus(session: RecordingRestoreSession, timeout = 5, signal?: AbortSignal): Promise<RecordingRestoreReply | null> {
    const descriptor = copyRecordingRestoreDescriptor(session)
    if (!descriptor || !this.sameRecordingRestoreSession(session) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30 || signal?.aborted) return null
    const bound = { ...session, ...descriptor }, handle = this.device
    return this.runExclusive(async () => {
      const valid = () => this.sameRecordingRestoreSession(bound) && this.device === handle && !signal?.aborted
      if (!valid() || this.fileStreamPending || this.currentCommandTag !== null) return null
      const deadline = Date.now() + timeout * 1000
      const capability = await this.readRestoreWire(Uint8Array.of(5), deadline, valid, 'qualifyRecordingRestoreStatus')
      if (!capability || !parseRecordingRestoreCapabilities(capability.body)) return null
      const request = { operation: 'status' as const }, reply = await this.readRestoreWire(encodeRecordingRestore(bound, request), deadline, valid, 'recordingRestoreStatus')
      return reply ? parseRecordingRestoreReply(bound, request, reply.body) : null
    }).catch(() => null)
  }

  /** One owner-consented step; recover and commit never loop or retry internally. */
  async applyRecordingRestore(session: RecordingRestoreSession, request: RecordingRestoreOperation, options: RecordingRestoreWriteOptions): Promise<RecordingRestoreWriteOutcome> {
    const rejected = (reason: string): RecordingRestoreWriteOutcome => ({ status: 'rejected-before-dispatch', commandAttempted: false, reason })
    const timeout = options?.timeout ?? 5, signal = options?.signal
    const consent = () => options?.ownedRecordingRestoreConsent === true && options.normalJensen === true && options.massStorageInactive === true && options.audioQuiescent === true
    const policy = () => !this.deviceValidationReadOnly && !this.firmwareRecoveryReadOnly && this.firmwareUploadFence === 'none'
    if (!consent() || !policy()) return rejected('explicit-owner-consent-or-policy')
    const descriptor = copyRecordingRestoreDescriptor(session)
    if (!descriptor || !this.sameRecordingRestoreSession(session) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30 || signal?.aborted) return rejected('binding-or-owner-unqualified')
    const bound = { ...session, ...descriptor }, handle = this.device
    let body: Uint8Array, copied: RecordingRestoreOperation
    try {
      if (!['begin', 'append', 'verify-commit-step', 'abort', 'recover-step'].includes(request.operation)) return rejected('invalid-operation')
      copied = request.operation === 'append' ? { operation: 'append', offset: request.offset, data: request.data.slice() } : { operation: request.operation }
      body = encodeRecordingRestore(bound, copied)
    } catch { return rejected('invalid-operation') }
    let attempted = false
    return this.runExclusive<RecordingRestoreWriteOutcome>(async () => {
      const valid = () => consent() && policy() && this.sameRecordingRestoreSession(bound) && this.device === handle && !signal?.aborted
      if (!valid() || this.fileStreamPending || this.currentCommandTag !== null) return rejected('owner-unavailable')
      const deadline = Date.now() + timeout * 1000, capability = await this.readRestoreWire(Uint8Array.of(5), deadline, valid, 'qualifyRecordingRestoreMutation')
      if (!capability || !parseRecordingRestoreCapabilities(capability.body)) return rejected('capability-unavailable')
      const readNative = async (command: number) => {
        if (!valid() || Date.now() >= deadline) return null
        const message = new JensenMessage(command); message.onstart = valid
        const reply = await this.dispatchFirmwareReply(message, (deadline - Date.now()) / 1000, 'recordingRestoreNativeIdle')
        return reply && !(reply instanceof Error) && valid() ? reply : null
      }
      const status = await readNative(CMD.GET_RECORDING_STATUS), parsedStatus = status && parseNativeRecordingStatusPayload(status.body)
      if (!parsedStatus || parsedStatus.recording !== null) return rejected('native-idle-unavailable')
      const file = await readNative(CMD.GET_RECORDING_FILE)
      if (!file || file.body.length !== 0 || !valid() || Date.now() >= deadline) return rejected('native-idle-unavailable')
      const message = new JensenMessage(RECORDING_RESTORE_COMMAND).body(body)
      message.onstart = () => { if (!valid()) return false; attempted = true; return true }
      const reply = await this.dispatchFirmwareReply(message, (deadline - Date.now()) / 1000, `recordingRestore:${copied.operation}`)
      if (!attempted) return rejected('cancelled-before-dispatch')
      if (!reply || reply instanceof Error || !valid()) return { status: 'uncertain', commandAttempted: true, reason: 'reply-or-session-unavailable' }
      const parsed = parseRecordingRestoreReply(bound, copied, reply.body)
      return parsed ? { status: 'reply', commandAttempted: true, reply: parsed } : { status: 'uncertain', commandAttempted: true, reason: 'malformed-reply' }
    }).catch(() => attempted ? { status: 'uncertain' as const, commandAttempted: true as const, reason: 'operation-error' } : rejected('preflight-error'))
  }

  /** 0 is unknown: custom profiles/WAV cannot use the vendor's fixed byte-rate estimate. */
  private listedFileDuration(fileLength: number, fileVersion: number): number {
    if (this.model === 'hidock-h1e' && customRecordingFirmware(this.versionNumber, this.versionCode)) return 0
    return calculateDurationSeconds(fileLength, fileVersion)
  }

  async getCardInfo(timeout = 10): Promise<CardInfo | null> {
    if (this.versionNumber !== null && this.versionNumber < 327733) return null
    try {
      return await this.sendCommand<CardInfo | null>(
        new JensenMessage(CMD.GET_CARD_INFO), timeout, 'getCardInfo')
    } catch {
      return null
    }
  }

  async formatCard(timeout = 300): Promise<{ result: string } | null> {
    if (this.versionNumber && this.versionNumber < 327733) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.FORMAT_CARD).body([1, 2, 3, 4]), timeout, 'formatCard')
    } catch {
      return null
    }
  }

  async deleteFile(filename: string, timeout = 10): Promise<{ result: string } | null> {
    if (!this.validDeviceFilename(filename)) return null
    const body: number[] = []
    for (let i = 0; i < filename.length; i++) body.push(filename.charCodeAt(i))
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.DELETE_FILE).body(body), timeout, `deleteFile:${filename}`)
    } catch {
      return null
    }
  }

  // ================================================================
  // Public API — listFiles (handler-based, matching jensen.js)
  // ================================================================

  /**
   * List files on device. Uses dynamic handler that accumulates multi-packet response.
   * Matches jensen.js s.prototype.listFiles exactly:
   * - Checks filelist lock
   * - Gets file count for old firmware
   * - Fix 3: Uses incremental stateful parser — each packet only parses NEW data,
   *   eliminating the O(N^2) re-parse-everything behaviour of the old implementation.
   * - Handler returns file array when complete, undefined when waiting
   */
  async listFiles(
    onProgress?: (filesFound: number, expectedFiles: number) => void,
    expectedFileCount?: number,
    onNewFiles?: (files: FileInfo[]) => void
  ): Promise<FileInfo[] | null> {
    const result = await this.listFilesDetailed(onProgress, expectedFileCount, onNewFiles)
    return result.status === 'complete' ? result.files : null
  }

  /** A missing/interrupted listing is never a confirmed empty directory. */
  async listFilesDetailed(
    onProgress?: (filesFound: number, expectedFiles: number) => void,
    expectedFileCount?: number,
    onNewFiles?: (files: FileInfo[]) => void
  ): Promise<FileListingResult> {
    const key = 'filelist'
    const failure = (reason: string): FileListingResult => ({ status: 'error', files: [], expectedCount: null, parsedCount: 0, reason })
    if (this.data[key] != null) return failure('listing-busy')
    if (this.fileStreamPending || this.firmwareRecoveryReadOnly || this.firmwareUploadFence !== 'none') return failure('owner-unavailable')
    if (expectedFileCount !== undefined && (!Number.isSafeInteger(expectedFileCount) || expectedFileCount < 0 || expectedFileCount > 0xffffffff)) return failure('invalid-expected-count')
    // Reserve before the legacy count await so overlapping callers cannot race.
    this.data[key] = { pending: true }
    let oldCount: number | undefined
    if (this.versionNumber == null || this.versionNumber <= 327722) {
      const count = await this.getFileCount(5)
      if (!count) { this.data[key] = null; return failure('file-count-unavailable') }
      oldCount = count.count
      if (oldCount === 0) { this.data[key] = null; return { status: 'complete', files: [], expectedCount: 0, parsedCount: 0, reason: null } }
    }
    const files: FileInfo[] = []
    const namesSeen = new Set<string>()
    let parsedCount = 0, tail = new Uint8Array(), headerParsed = false
    let expected: number | null = expectedFileCount ?? oldCount ?? null
    let invalidReason: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let started = false, tag: string | null = null
    const result = (status: FileListingResult['status'], reason: string | null): FileListingResult => ({ status, files: files.slice(), expectedCount: expected, parsedCount, reason })
    const incomplete = (reason: string): FileListingResult => result(parsedCount > 0 ? 'partial' : 'error', reason)
    const failListing = (reason: string): void => {
      this.noteProtocolFault(reason === 'listing-stalled' || reason === 'listing-consumer-error' || reason === 'invalid-entry-geometry' || reason === 'listing-count-mismatch' ? reason : 'malformed-response')
      this.data[key] = null
      this.handlers.set(CMD.GET_FILE_LIST, () => undefined)
      if (tag && this.currentCommandTag === tag) this.resolveActiveDownload(incomplete(reason))
      void this.quarantineConnection(`unqualified listing completion: ${reason}`)
    }
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        failListing('listing-stalled')
      }, 600000)
    }
    this.data[key] = { files }
    this.handlers.set(CMD.GET_FILE_LIST, (msg) => {
      if (!msg) { failListing('malformed-listing-response'); return undefined }
      if (!started) return undefined
      arm()
      if (msg.body.length === 0) {
        this.data[key] = null
        if (!headerParsed && parsedCount === 0) return failure('unqualified-empty-response')
        if (tail.length || invalidReason || expected !== null && parsedCount !== expected) return incomplete(invalidReason ?? 'listing-ended-before-count')
        if (expected === null) return incomplete('listing-count-unavailable')
        return result('complete', null)
      }
      const work = new Uint8Array(tail.length + msg.body.length)
      work.set(tail); work.set(msg.body, tail.length)
      let pos = 0
      if (!headerParsed) {
        if (work.length < 2 || work[0] === 0xff && work[1] === 0xff && work.length < 6) { tail = work; return undefined }
        headerParsed = true
        if (work[0] === 0xff && work[1] === 0xff) { expected = new DataView(work.buffer).getUint32(2, false); pos = 6 }
      }
      const previous = files.length
      while (pos + 4 <= work.length) {
        const begin = pos, version = work[pos]
        const nameLength = (work[pos + 1] << 16) | (work[pos + 2] << 8) | work[pos + 3]
        if (nameLength < 1 || nameLength > 32) { failListing('invalid-entry-geometry'); return undefined }
        const entryLength = 4 + nameLength + 4 + 6 + 16
        if (begin + entryLength > work.length) break
        pos += 4
        const nameBytes = work.subarray(pos, pos + nameLength)
        const nul = nameBytes.indexOf(0)
        const badPadding = nul >= 0 && nameBytes.subarray(nul).some(byte => byte !== 0)
        const name = Array.from(nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes).map(byte => String.fromCharCode(byte)).join('')
        pos += nameLength
        const length = new DataView(work.buffer, work.byteOffset + pos, 4).getUint32(0, false)
        pos += 10
        const signature = Array.from(work.subarray(pos, pos + 16), byte => byte.toString(16).padStart(2, '0')).join('')
        pos += 16; parsedCount++
        if (badPadding || !this.validDeviceFilename(name)) { invalidReason = 'invalid-file-name'; continue }
        if (namesSeen.has(name)) { invalidReason = 'duplicate-file-name'; continue }
        namesSeen.add(name)
        const { createDate, createTime, time } = this.parseFilenameDateTime(name)
        // A valid non-date filename remains a real file; time:null is truthful.
        files.push({ name, createDate, createTime, time, length, version, signature, duration: this.listedFileDuration(length, version) })
      }
      tail = work.slice(pos)
      try { if (files.length > previous) onNewFiles?.(files.slice(previous)); onProgress?.(parsedCount, expected ?? parsedCount) }
      catch { failListing('listing-consumer-error'); return undefined }
      if (expected !== null && parsedCount >= expected) {
        this.data[key] = null
        if (parsedCount !== expected || tail.length) { failListing('listing-count-mismatch'); return undefined }
        if (invalidReason) return incomplete(invalidReason)
        return result('complete', null)
      }
      return undefined
    })
    const message = new JensenMessage(CMD.GET_FILE_LIST)
    message.onstart = () => { started = true; tag = this.currentCommandTag; this.activeFileStreamFailure = failListing; arm() }
    try {
      const value = await this.sendCommand<FileListingResult>(message, undefined, 'listFiles')
      return value ?? incomplete('listing-unavailable')
    } finally {
      if (timer) clearTimeout(timer)
      this.data[key] = null
      if (this.activeFileStreamFailure === failListing) this.activeFileStreamFailure = null
    }
  }

  // ================================================================
  // Public API — downloadFile (handler-based, matching jensen.js streaming/getFile)
  // ================================================================

  /**
   * Download exactly the trusted listed size. Progress counts payload bytes only.
   * Native capacity-aligned CMD5 files also require their empty EOF frame.
   * onStarted runs at actual serialized dispatch, before OUT.
   */
  async downloadFile(
    filename: string,
    fileSize: number,
    onChunk: (data: Uint8Array) => void,
    onProgress?: (received: number) => void,
    signal?: AbortSignal,
    onStarted?: () => void
  ): Promise<boolean> {
    return this.receiveFileBytes(filename, fileSize, onChunk, onProgress, signal, CMD.TRANSFER_FILE, undefined, onStarted)
  }

  /** Read an exact, bounded range from a trusted closed-file snapshot; no inferred resume. */
  async readFileRange(
    filename: string,
    trustedFileSize: number,
    offset: number,
    count: number,
    onChunk: (data: Uint8Array) => void,
    onProgress?: (received: number) => void,
    signal?: AbortSignal,
    onStarted?: () => void
  ): Promise<FileRangeResult> {
    return this.readBoundedFileSegment(CMD.TRANSFER_FILE_PARTIAL, filename, trustedFileSize, offset, count, onChunk, onProgress, signal, onStarted)
  }

  /** CMD13 is a prefix read from zero, never an offset/resume request. */
  async readFilePrefix(
    filename: string,
    trustedFileSize: number,
    count: number,
    onChunk: (data: Uint8Array) => void,
    onProgress?: (received: number) => void,
    signal?: AbortSignal,
    onStarted?: () => void
  ): Promise<FileRangeResult> {
    return this.readBoundedFileSegment(CMD.GET_FILE_BLOCK, filename, trustedFileSize, 0, count, onChunk, onProgress, signal, onStarted)
  }

  /** CMD26 uses entry index/count, not a byte offset. One bounded native page. */
  async listFilesPage(firstIndex: number, count: number, timeout = 5): Promise<FileListingPageResult> {
    const result: FileListingPageResult = { status: 'error', files: [], expectedCount: null, parsedCount: 0, reason: 'page-unavailable', firstIndex, requestedCount: count, totalCount: null }
    if (this.model !== 'hidock-h1e' || !qualifiedFileFirmware(this.versionNumber, this.versionCode)) return { ...result, reason: 'page-capability-unqualified' }
    if (!Number.isSafeInteger(firstIndex) || firstIndex < 0 || !Number.isSafeInteger(count) || count < 1 || count > 128 || firstIndex > Math.floor(0x7fffffff / 57) - count || !Number.isFinite(timeout) || timeout <= 0 || timeout > 30) return { ...result, reason: 'invalid-page' }
    const body = new Uint8Array(8), view = new DataView(body.buffer)
    view.setUint32(0, firstIndex, false); view.setUint32(4, count, false)
    return this.runExclusive(async () => {
      if (this.fileStreamPending || this.data.filelist != null || this.poisoned) return { ...result, reason: 'owner-unavailable' }
      let dispatched = false
      const message = new JensenMessage(CMD.GET_FILE_LIST_PAGED).body(body)
      let requestEpoch = this.connectionSessionId, requestVersion = this.versionNumber
      message.onstart = () => { dispatched = true; requestEpoch = this.connectionSessionId; requestVersion = this.versionNumber }
      const reply = await this.dispatchFirmwareReply(message, timeout, 'listFilesPage')
      const notePageFault = (reason: NonNullable<ProtocolDiagnostics['lastPageFault']>['reason']) => {
        const responseBodyBytes = reply && !(reply instanceof Error) ? reply.body.length : null
        const recordBytes = responseBodyBytes !== null && responseBodyBytes >= 4 ? responseBodyBytes - 4 : null
        this.protocolLastPageFault = { atMs: Date.now(), connectionSessionId: requestEpoch, versionNumber: requestVersion,
          commandId: 26, sequence: message.index >>> 0, reason, firstIndex, requestedCount: count,
          declaredTotalCount: result.totalCount, expectedCount: result.expectedCount,
          expectedBodyBytes: result.expectedCount === null ? null : 4 + result.expectedCount * 57,
          responseBodyBytes, completeRecordSlots: recordBytes === null ? null : Math.floor(recordBytes / 57),
          trailingRecordBytes: recordBytes === null ? null : recordBytes % 57,
          parsedCount: result.parsedCount, retainedCount: result.files.length }
      }
      if (dispatched && (!reply || reply instanceof Error || reply.body.length < 4)) notePageFault('page-unavailable')
      if ((!reply || reply instanceof Error) && dispatched && !this.poisoned) await this.quarantineConnection('listing page response unavailable')
      if (!reply || reply instanceof Error || reply.body.length < 4) return result
      const total = new DataView(reply.body.buffer, reply.body.byteOffset, 4).getUint32(0, false)
      const expected = Math.min(count, Math.max(0, total - firstIndex))
      result.totalCount = total; result.expectedCount = expected
      if (reply.body.length !== 4 + expected * 57) { notePageFault('page-count-mismatch'); await this.quarantineConnection('cached listing page byte/count mismatch'); return { ...result, reason: 'page-count-mismatch' } }
      for (let i = 0; i < expected; i++) {
        result.parsedCount++
        const record = reply.body.subarray(4 + i * 57, 4 + (i + 1) * 57)
        if (record[1] !== 0 || record[2] !== 0 || record[3] !== 27) { notePageFault('invalid-entry-geometry'); await this.quarantineConnection('invalid cached listing entry geometry'); return { ...result, status: 'partial', reason: 'invalid-entry-geometry' } }
        const names = record.subarray(4, 31), nul = names.indexOf(0)
        const name = Array.from(nul >= 0 ? names.subarray(0, nul) : names, byte => String.fromCharCode(byte)).join('')
        if (!this.validDeviceFilename(name) || nul >= 0 && names.subarray(nul).some(byte => byte !== 0)) return { ...result, status: 'partial', reason: 'invalid-file-name' }
        if (result.files.some(file => file.name === name)) return { ...result, status: 'partial', reason: 'duplicate-file-name' }
        const parsed = this.parseFileListFlat(record)
        if (parsed.files.length !== 1) return { ...result, status: 'partial', reason: 'invalid-entry-geometry' }
        result.files.push(parsed.files[0])
      }
      return { ...result, status: 'complete', reason: null }
    })
  }

  private async readBoundedFileSegment(
    command: number, filename: string, trustedFileSize: number, offset: number, count: number,
    onChunk: (data: Uint8Array) => void, onProgress?: (received: number) => void, signal?: AbortSignal, onStarted?: () => void
  ): Promise<FileRangeResult> {
    let received = 0, reason: string | null = null
    const result = (status: FileRangeResult['status'], why: string | null): FileRangeResult => ({ status, offset, count, received, reason: why })
    if (this.model !== 'hidock-h1e' || !qualifiedFileFirmware(this.versionNumber, this.versionCode)) return result('error', 'range-capability-unqualified')
    if (!this.validDeviceFilename(filename) || filename.length > 27 || !Number.isSafeInteger(trustedFileSize) || trustedFileSize < 0 || trustedFileSize > 0xffffffff ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > trustedFileSize || offset > 0x7fffffff || !Number.isSafeInteger(count) || count < 0 || count > 1048576 || count > trustedFileSize - offset || count > 0x7fffffff - offset || typeof onChunk !== 'function') return result('error', 'invalid-range')
    if (signal?.aborted) return result('cancelled', 'cancelled-before-start')
    if (!this.device || this.poisoned || this.firmwareRecoveryReadOnly || this.firmwareUploadFence !== 'none') return result('error', 'owner-unavailable')
    if (count === 0) return offset === trustedFileSize ? result('complete', 'known-eof-no-request') : result('error', 'zero-count-before-eof')
    const prefix = command === CMD.GET_FILE_BLOCK ? 4 : 8
    const body = new Uint8Array(prefix + filename.length), view = new DataView(body.buffer)
    if (prefix === 8) view.setUint32(0, offset, false)
    view.setUint32(prefix - 4, count, false)
    for (let i = 0; i < filename.length; i++) body[prefix + i] = filename.charCodeAt(i)
    const complete = await this.receiveFileBytes(filename, count, bytes => { onChunk(bytes); received += bytes.length }, onProgress, signal,
      command, body, onStarted, why => { reason = why })
    return result(complete ? 'complete' : signal?.aborted ? 'cancelled' : 'error', complete ? null : reason ?? 'range-unavailable')
  }

  private async receiveFileBytes(
    filename: string,
    fileSize: number,
    onChunk: (data: Uint8Array) => void,
    onProgress?: (received: number) => void,
    signal?: AbortSignal,
    command: number = CMD.TRANSFER_FILE,
    requestBody?: Uint8Array,
    onStarted?: () => void,
    onFailure?: (reason: string) => void
  ): Promise<boolean> {
    if (!this.validDeviceFilename(filename) || !Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > 0xffffffff || typeof onChunk !== 'function') return false
    // Clear any stale settlement handle up front so the two early returns below (which
    // never start a transfer, hence never drain) leave nothing for a caller to await.
    if (this.fileStreamPending || this.data.filelist != null) { onFailure?.('transfer-busy'); return false }
    this._activeDownloadSettlement = null
    if (!this.device) return false
    if (signal?.aborted) return false
    if (this.fileStreamPending || this.poisoned || this.firmwareRecoveryReadOnly || this.firmwareUploadFence !== 'none') { onFailure?.('owner-unavailable'); return false }
    if (this.model === 'hidock-h1e' && filename.length > 27) { onFailure?.('unqualified-filename-length'); return false }
    this.fileStreamPending = true
    const diagnosticStream: NonNullable<ProtocolDiagnostics['stream']> = { commandId: command, expectedBytes: fileSize, receivedBytes: 0,
      phase: 'queued', awaitingNativeEof: false, cancelRequested: false }
    this.protocolStream = diagnosticStream

    let received = 0
    let boundaryInvalid = false
    // The unchanged 6.3 response constructor fills an 8192-byte native output
    // buffer (12-byte header +8180 data), then reads again for CMD5 EOF. This
    // is source-qualified native capacity, independent of USB endpoint geometry.
    const nativeFullFileEof = command === CMD.TRANSFER_FILE && this.model === 'hidock-h1e' &&
      qualifiedFileFirmware(this.versionNumber, this.versionCode)
    let awaitingNativeEof = false
    const notePayloadBoundary = (length: number): void => {
      if (received === fileSize) awaitingNativeEof = nativeFullFileEof && length === 8180
      diagnosticStream.receivedBytes = received
      diagnosticStream.awaitingNativeEof = awaitingNativeEof
    }
    let aborted = false
    let settled = false
    let started = false
    const failStream = (reason: string): void => {
      this.noteProtocolFault(reason === 'byte-boundary-exceeded' || reason === 'short-stream' || reason === 'stream-consumer-error' || reason === 'response-envelope-exceeded' ? reason : 'malformed-response')
      onFailure?.(reason)
      if (settled) { boundaryInvalid = true; return }
      settleAndFinish('protocol-error')
    }

    // POST-DRAIN settlement (see getActiveDownloadSettlement). Resolved either by the
    // main try/finally on a NON-draining exit (normal completion, null-msg fail), or by
    // `finishSettlement` after settleTransfer's async drain on an abort/stall exit. A
    // draining abort sets `settlementDraining` so the main finally does NOT resolve it
    // early (that would defeat the whole point). Resolving twice is a harmless no-op.
    let settlementDraining = false
    let markSettled!: () => void
    const settlement = new Promise<void>((resolve) => { markSettled = resolve })
    this._activeDownloadSettlement = settlement
    const finishSettlement = (): void => {
      markSettled()
      if (this._activeDownloadSettlement === settlement) this._activeDownloadSettlement = null
      this.fileStreamPending = false
      if (this.protocolStream === diagnosticStream) this.protocolStream = null
      if (this.activeFileStreamFailure === failStream) this.activeFileStreamFailure = null
    }

    // Inactivity watchdog. A transfer holds the single serialized command slot for
    // its ENTIRE duration, so it must NOT use the command-level timeout: expireCommand
    // advances the queue the instant it fires WITHOUT stopping the still-streaming
    // transfer, so the next command would be sent while transfer packets are still
    // arriving — overlapping the device's IN FIFO and wedging the firmware (the #1
    // forbidden failure mode). Instead we watch for prolonged silence (refreshed by
    // every inbound byte). See settleTransfer for what a genuine stall does.
    const TRANSFER_STALL_TIMEOUT_MS = this.transferStallTimeoutMs
    let stallTimerId: ReturnType<typeof setTimeout> | null = null

    const clearStall = (): void => {
      if (stallTimerId) { clearTimeout(stallTimerId); stallTimerId = null }
    }

    // ------------------------------------------------------------------
    // The SINGLE settlement path for every abnormal end of this transfer
    // ------------------------------------------------------------------
    // reason:
    //   'disconnect'  — the disconnect IPC fired the abort. Teardown (disconnect →
    //                   gracefulCloseDevice) OWNS the FIFO drain + close, so this
    //                   must NOT drain OR advance the queue — advancing would send a
    //                   command into a still-streaming device before the close path
    //                   drains it. Just resolve false and stand down.
    //   'user-cancel' — user cancelled one download; the device keeps streaming the
    //                   file regardless (the protocol has no cancel command). The
    //                   ONLY protocol-proven end of a TRANSFER_FILE stream is its
    //                   BYTE BOUNDARY: the device sends exactly fileSize body bytes
    //                   (the same proof normal completion advances on). So keep
    //                   absorbing AND counting; advance only at the exact byte boundary and any source-qualified
    //                   native empty EOF. Silence is never proof — this device documents
    //                   multi-second legitimate inter-packet pauses, so a
    //                   silence-based drain would advance into a resuming stream.
    //                   If the stream stalls before the boundary → quarantine. If
    //                   teardown starts mid-drain → stand down (teardown owns it).
    //   'stall'       — prolonged silence → the transfer is dead and unrecoverable.
    //                   Quarantine unconditionally (drain best-effort, then tear down
    //                   for a clean reconnect). NEVER advance on a stall: silence is
    //                   not proof of quiescence, and a stalled transfer can't resume
    //                   safely — the drain-recovery pattern prescribes reconnect.
    // Guarded by `settled` so stall/abort/completion can only settle once (no double
    // resolve, no double advance).

    // Drain a cancelled transfer to its protocol byte boundary. Ticks every 50ms:
    //   'complete'  — received >= fileSize (proven end; safe to advance)
    //   'stalled'   — no progress toward the boundary for the stall window
    //   'standdown' — teardown started / device gone / slot externally cleared;
    //                 whoever did that owns the bus — do nothing further.
    const drainToByteBoundary = async (): Promise<'complete' | 'stalled' | 'standdown'> => {
      let lastReceived = received
      let idleMs = 0
      for (;;) {
        if (this.isTearingDown() || !this.device || this.currentCommandTag === null) return 'standdown'
        if (boundaryInvalid) return 'stalled'
        if (received === fileSize && !awaitingNativeEof) return 'complete'
        await new Promise((r) => setTimeout(r, 50))
        if (received !== lastReceived) {
          lastReceived = received
          idleMs = 0
        } else {
          idleMs += 50
          if (idleMs >= TRANSFER_STALL_TIMEOUT_MS) return 'stalled'
        }
      }
    }

    const settleTransfer = async (reason: 'disconnect' | 'user-cancel' | 'stall' | 'protocol-error'): Promise<void> => {
      if (settled) return
      settled = true
      aborted = true // makes the TRANSFER_FILE handler absorb any late/in-flight packets
      clearStall()
      if (!started) return
      diagnosticStream.phase = reason === 'user-cancel' ? 'draining' : reason === 'disconnect' ? 'standing-down' : 'quarantining'
      diagnosticStream.cancelRequested = reason === 'user-cancel' || reason === 'disconnect'
      this.handlers.set(command, () => undefined) // no-op absorber
      this.onreceive = null
      signal?.removeEventListener('abort', abortHandler)

      // The download's own promise settles false in every abnormal path so the
      // awaiting caller returns immediately (synchronously, before any drain).
      this.resolveActiveDownload(false)

      if (reason === 'protocol-error') {
        await this.quarantineConnection('invalid file stream; byte boundary unavailable')
        return
      }

      if (reason === 'disconnect') {
        // Disconnect teardown owns the drain + close; suppress queue advancement.
        return
      }

      if (reason === 'user-cancel') {
        // Counting absorber: the chunks are discarded but the byte position in the
        // stream keeps advancing so the boundary check has the protocol-level truth.
        this.handlers.set(command, (msg) => {
          if (!msg || msg.body.length > fileSize - received || msg.body.length === 0 && received !== fileSize) boundaryInvalid = true
          else { received += msg.body.length; notePayloadBoundary(msg.body.length) }
          return undefined
        })
        const outcome = await drainToByteBoundary()
        if (this.isTearingDown() || !this.device) return // teardown raced us — it owns the bus
        if (outcome === 'complete') {
          this.releaseSlotAndAdvance() // stream ended at its proven byte boundary
        } else if (outcome === 'stalled') {
          await this.quarantineConnection(
            `cancelled transfer stalled before its byte boundary (${received}/${fileSize} bytes)`)
        }
        // 'standdown': whoever cleared the slot / started teardown owns everything.
        return
      }

      // reason === 'stall'
      try { this.ontransferstall?.({ filename, received, fileSize }) } catch { /* a consumer bug must not block the teardown */ }
      console.warn(
        `[Jensen] downloadFile stalled for ${TRANSFER_STALL_TIMEOUT_MS / 1000}s ` +
        `(${received}/${fileSize} bytes) — draining IN FIFO, then quarantining for reconnect`)
      await this.drainUntilIdle() // best-effort drain so teardown closes on a quiet-ish bus
      if (this.isTearingDown() || !this.device) return // teardown raced the drain — stand down
      await this.quarantineConnection(`download stalled (${received}/${fileSize} bytes)`)
    }

    // Owns the POST-DRAIN settlement for every abort/stall exit: settleTransfer runs
    // its (possibly async) drain, then finishSettlement resolves the settlement promise.
    // `settlementDraining` tells the main finally to leave settlement resolution to us.
    const settleAndFinish = (reason: 'disconnect' | 'user-cancel' | 'stall' | 'protocol-error'): void => {
      if (settled) return
      if (!started) { aborted = true; diagnosticStream.phase = 'cancelled-before-start'; diagnosticStream.cancelRequested = true; onFailure?.('cancelled-before-start'); return }
      settlementDraining = true
      void settleTransfer(reason).catch(() => undefined).finally(finishSettlement)
    }

    // Abort handling (disconnect / user cancel). The AbortController's reason string
    // distinguishes them: the disconnect IPC aborts with 'disconnect' (see
    // jensen-handlers); anything else is treated as a user cancel.
    const abortHandler = (): void => {
      const reason = signal?.reason === 'disconnect' ? 'disconnect' : 'user-cancel'
      onFailure?.(reason === 'disconnect' ? 'disconnected' : 'cancelled')
      settleAndFinish(reason)
    }
    signal?.addEventListener('abort', abortHandler, { once: true })

    const armStall = (): void => {
      if (settled) return
      if (stallTimerId) clearTimeout(stallTimerId)
      stallTimerId = setTimeout(() => { settleAndFinish('stall') }, TRANSFER_STALL_TIMEOUT_MS)
    }

    // Raw transport bytes refresh only inactivity. User progress is emitted by
    // the correlated payload handler, excluding headers, padding and stale frames.
    const receiveActivity = (_bytes: number): void => {
      armStall()
    }

    if (shouldLog()) console.log(`[Jensen] downloadFile: ${filename}, size=${fileSize}`)

    // Register handler for TRANSFER_FILE (matches jensen.js: s.registerHandler(5, ...))
    this.handlers.set(command, (msg) => {
      if (aborted) return undefined // Absorb stale data after abort/stall

      // A parsed packet is also proof of life — refresh the stall watchdog.
      armStall()

      // null msg = transfer fail (jensen.js: if (b == null) ... return "fail")
      if (!msg) {
        if (shouldLog()) console.log('[Jensen] downloadFile: transfer fail (null msg)')
        failStream('malformed-response')
        return undefined
      }

      if (msg.body.length > fileSize - received) { failStream('byte-boundary-exceeded'); return undefined }
      if (msg.body.length === 0 && received !== fileSize) { failStream('short-stream'); return undefined }

      // Accumulate data (jensen.js: a += b.body.length, n(b.body))
      received += msg.body.length
      notePayloadBoundary(msg.body.length)
      try { if (msg.body.length) onChunk(new Uint8Array(msg.body)); onProgress?.(received) }
      catch { failStream('stream-consumer-error'); return undefined }
      if (aborted) return undefined

      // Check if complete (jensen.js: if (h >= t) return "OK"). The device finished
      // sending, so the bus is already quiet — the normal handler→triggerResolve→
      // sendNextCommand machinery advances the queue with no drain needed. Mark
      // settled so a disconnect/stall racing the final packet becomes a no-op.
      if (received === fileSize && !awaitingNativeEof) {
        if (shouldLog()) console.log(`[Jensen] downloadFile: complete, ${received}/${fileSize}`)
        settled = true
        clearStall()
        signal?.removeEventListener('abort', abortHandler)
        this.onreceive = null
        return true
      }

      return undefined // Keep waiting
    })

    // Build command body (jensen.js: filename as char codes)
    const body: number[] = []
    for (let i = 0; i < filename.length; i++) body.push(filename.charCodeAt(i))

    // Dispatch owns the watchdog; queued work must not time out another slot.
    try {
      // No command-level timeout: the inactivity watchdog owns stall handling and
      // drains the stream before releasing the slot. A fixed command timeout would
      // advance the queue mid-stream and wedge the device (see comment above).
      const message = new JensenMessage(command).body(requestBody ?? body)
      message.onstart = () => {
        if (signal?.aborted || aborted) { onFailure?.('cancelled-before-start'); return false }
        started = true
        diagnosticStream.phase = 'receiving'
        this.activeFileStreamFailure = failStream
        this.onreceive = receiveActivity
        armStall()
        onStarted?.()
      }
      const result = await this.sendCommand<boolean>(message, undefined, `downloadFile:${filename}`)
      clearStall()
      this.onreceive = null
      signal?.removeEventListener('abort', abortHandler)
      return result ?? false
    } catch {
      clearStall()
      this.onreceive = null
      signal?.removeEventListener('abort', abortHandler)
      return false
    } finally {
      // Non-draining exit (normal completion, null-msg fail, or a synchronous return):
      // this promise resolving IS the settlement, so resolve now. A draining abort/stall
      // exit set `settlementDraining` and owns settlement via settleAndFinish's drain —
      // resolving here would defeat the post-drain guarantee, so skip it.
      if (!settlementDraining) finishSettlement()
    }
  }

  // ================================================================
  // Public API — Realtime streaming
  // ================================================================

  async getRealtimeSettings(timeout = 5): Promise<RealtimeSettings | null> {
    try {
      const result = await this.sendCommand<ResponseMessage | null>(
        new JensenMessage(CMD.REALTIME_READ_SETTING), timeout, 'getRealtimeSettings')
      if (!result) return null
      if (result.body.length !== 4) return null
      return { encoding: new DataView(result.body.buffer, result.body.byteOffset, 4).getUint32(0, false) }
    } catch {
      return null
    }
  }

  async startRealtime(mode = 2, timeout = 5): Promise<{ result: string } | null> {
    // Exact 6.3 dispatcher stores this as a channel count; values >2 can stall
    // its capture loop. Zero defaults to mono; 1 mixes A+B; 2 preserves A/B.
    if (!Number.isInteger(mode) || mode < 0 || mode > 2) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.REALTIME_CONTROL).body([0, 0, 0, 1, 0, 0, 0, mode & 0x03]), timeout, 'startRealtime')
    } catch {
      return null
    }
  }

  async pauseRealtime(timeout = 5): Promise<{ result: string } | null> {
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.REALTIME_CONTROL).body([0, 0, 0, 2, 0, 0, 0, 0]), timeout, 'pauseRealtime')
    } catch {
      return null
    }
  }

  async stopRealtime(timeout = 5): Promise<{ result: string } | null> {
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.REALTIME_CONTROL).body([0, 0, 0, 0, 0, 0, 0, 0]), timeout, 'stopRealtime')
    } catch {
      return null
    }
  }

  async getRealtimeData(_offset = 0, timeout = 5): Promise<RealtimeData | null> {
    try {
      return await this.sendCommand<RealtimeData | null>(
        new JensenMessage(CMD.REALTIME_TRANSFER), timeout, 'getRealtimeData')
    } catch {
      return null
    }
  }

  // ================================================================
  // Public API — Battery (P1 only)
  // ================================================================

  isP1Device(): boolean {
    return this.model === 'hidock-p1' || this.model === 'hidock-p1-mini'
  }

  async getBatteryStatus(timeout = 5): Promise<BatteryStatus | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<BatteryStatus | null>(
        new JensenMessage(CMD.GET_BATTERY_STATUS), timeout, 'getBatteryStatus')
    } catch {
      return null
    }
  }

  // ================================================================
  // Public API — Bluetooth (P1 only)
  // ================================================================

  async scanBluetoothDevices(timeout = 35): Promise<{ result: string } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BLUETOOTH_SCAN), timeout, 'scanBluetoothDevices')
    } catch {
      return null
    }
  }

  async startBluetoothScan(duration = 30, timeout = 35): Promise<{ result: string } | null> {
    if (!this.isP1Device() || !Number.isInteger(duration) || duration < 1 || duration > 255) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BT_SCAN).body([1, duration & 0xff]), timeout, 'startBluetoothScan')
    } catch {
      return null
    }
  }

  async stopBluetoothScan(timeout = 5): Promise<{ result: string } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BT_SCAN).body([0]), timeout, 'stopBluetoothScan')
    } catch {
      return null
    }
  }

  async getBluetoothDeviceList(timeout = 10): Promise<{ raw: Uint8Array } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ raw: Uint8Array } | null>(
        new JensenMessage(CMD.BT_DEV_LIST), timeout, 'getBluetoothDeviceList')
    } catch {
      return null
    }
  }

  async getPairedDevices(timeout = 10): Promise<{ raw: Uint8Array } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ raw: Uint8Array } | null>(
        new JensenMessage(CMD.BT_GET_PAIRED_DEV_LIST), timeout, 'getPairedDevices')
    } catch {
      return null
    }
  }

  async removePairedDevices(timeout = 10): Promise<{ result: string } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BT_REMOVE_PAIRED_DEV).body([0]), timeout, 'removePairedDevices')
    } catch {
      return null
    }
  }

  async connectBluetoothDevice(timeout = 10): Promise<{ result: string } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BLUETOOTH_CMD).body([1]), timeout, 'connectBluetoothDevice')
    } catch {
      return null
    }
  }

  async disconnectBluetoothDevice(timeout = 10): Promise<{ result: string } | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<{ result: string } | null>(
        new JensenMessage(CMD.BLUETOOTH_CMD).body([0]), timeout, 'disconnectBluetoothDevice')
    } catch {
      return null
    }
  }

  async getBluetoothStatus(timeout = 5): Promise<BluetoothStatus | null> {
    if (!this.isP1Device()) return null
    try {
      return await this.sendCommand<BluetoothStatus | null>(
        new JensenMessage(CMD.BLUETOOTH_STATUS), timeout, 'getBluetoothStatus')
    } catch {
      return null
    }
  }

  // ================================================================
  // Helpers — BCD, file parsing
  // ================================================================

  private toBcd(str: string): number[] {
    const result: number[] = []
    for (let i = 0; i < str.length; i += 2) {
      const high = (str.charCodeAt(i) - 48) & 0xf
      const low = (str.charCodeAt(i + 1) - 48) & 0xf
      result.push((high << 4) | low)
    }
    return result
  }

  private validDeviceFilename(filename: string): boolean {
    return typeof filename === 'string' && filename.length > 0 && filename.length <= (this.model === 'hidock-h1e' ? 27 : 32) &&
      filename.trim().length > 0 && filename !== '.' && filename !== '..' && !/[\\/:\x00-\x1f\x7f-\uffff]/.test(filename)
  }

  fromBcd(...bytes: number[]): string {
    let result = ''
    for (const byte of bytes) {
      result += ((byte >> 4) & 0xf).toString()
      result += (byte & 0xf).toString()
    }
    return result
  }

  /**
   * Parse file list from flat byte buffer.
   * Matches jensen.js file parsing in the GET_FILE_LIST handler.
   */
  parseFileListFlat(buffer: Uint8Array): { files: FileInfo[]; headerTotal: number } {
    const files: FileInfo[] = []
    let pos = 0
    let headerTotal = 0

    // Check for header (0xFF 0xFF + 4 byte count)
    if (buffer.length >= 6 && (buffer[0] & 0xff) === 0xff && (buffer[1] & 0xff) === 0xff) {
      headerTotal =
        ((buffer[2] & 0xff) << 24) |
        ((buffer[3] & 0xff) << 16) |
        ((buffer[4] & 0xff) << 8) |
        (buffer[5] & 0xff)
      pos = 6
    }

    // Parse file entries (matches jensen.js parse loop)
    while (pos < buffer.length) {
      const startPos = pos

      if (pos + 4 > buffer.length) break

      // File version (1 byte)
      const fileVersion = buffer[pos++] & 0xff

      // Filename length (3 bytes big-endian)
      if (pos + 3 > buffer.length) { pos = startPos; break }
      const nameLen =
        ((buffer[pos] & 0xff) << 16) |
        ((buffer[pos + 1] & 0xff) << 8) |
        (buffer[pos + 2] & 0xff)
      pos += 3

      // Filename
      if (pos + nameLen > buffer.length) { pos = startPos; break }
      const nameChars: string[] = []
      for (let i = 0; i < nameLen; i++) {
        const ch = buffer[pos++] & 0xff
        if (ch > 0) nameChars.push(String.fromCharCode(ch))
      }

      // File length (4 bytes big-endian)
      if (pos + 4 > buffer.length) { pos = startPos; break }
      const fileLength =
        ((buffer[pos] & 0xff) << 24) |
        ((buffer[pos + 1] & 0xff) << 16) |
        ((buffer[pos + 2] & 0xff) << 8) |
        (buffer[pos + 3] & 0xff)
      pos += 4

      // Skip 6 bytes padding
      if (pos + 6 > buffer.length) { pos = startPos; break }
      pos += 6

      // Signature (16 bytes)
      if (pos + 16 > buffer.length) { pos = startPos; break }
      const sigParts: string[] = []
      for (let i = 0; i < 16; i++) {
        const hex = (buffer[pos++] & 0xff).toString(16)
        sigParts.push(hex.length === 1 ? '0' + hex : hex)
      }

      const filename = nameChars.join('')
      const { createDate, createTime, time } = this.parseFilenameDateTime(filename)
      const duration = this.listedFileDuration(fileLength >>> 0, fileVersion)

      files.push({
        name: filename,
        createDate,
        createTime,
        time,
        duration,
        version: fileVersion,
        length: fileLength >>> 0,
        signature: sigParts.join('')
      })
    }

    return { files, headerTotal: headerTotal >>> 0 }
  }

  /**
   * Parse date/time from HiDock recording filename.
   * Handles all known formats from H1, H1E, P1 devices.
   */
  parseFilenameDateTime(filename: string): { createDate: string; createTime: string; time: Date | null } {
    const monthNames: Record<string, number> = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
      'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    }

    // Format 1: 2025May13-160405-Rec59.hda (YYYYMonDD-HHMMSS)
    const monthNameMatch = filename.match(/(\d{4})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{1,2})-(\d{2})(\d{2})(\d{2})/)
    if (monthNameMatch) {
      const [, year, monthName, day, hour, minute, second] = monthNameMatch
      const month = monthNames[monthName]
      const createDate = `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
      const createTime = `${hour}:${minute}:${second}`
      const time = new Date(parseInt(year), month, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second))
      return { createDate, createTime, time }
    }

    // Format 2: YYYYMMDDHHMMSS pattern (e.g., 20250513160405REC001.wav)
    const oldWavMatch = filename.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})REC/)
    if (oldWavMatch) {
      const [, year, month, day, hour, minute, second] = oldWavMatch
      const createDate = `${year}-${month}-${day}`
      const createTime = `${hour}:${minute}:${second}`
      const time = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second))
      return { createDate, createTime, time }
    }

    // Format 3: HDA_YYYYMMDD_HHMMSS or generic numeric
    const numericMatch = filename.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_](\d{2})(\d{2})(\d{2})?/)
    if (numericMatch) {
      const [, year, month, day, hour, minute, second = '00'] = numericMatch
      const createDate = `${year}-${month}-${day}`
      const createTime = `${hour}:${minute}:${second}`
      const time = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second))
      return { createDate, createTime, time }
    }

    return { createDate: '', createTime: '', time: null }
  }
}

// NOTE: The process-wide singleton (getJensenDevice) lives in the consuming
// adapter, not here — the application binds its USB backend before
// constructing the shared JensenDevice. See the Electron Jensen service.
