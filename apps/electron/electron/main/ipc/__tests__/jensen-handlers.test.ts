// @vitest-environment node

/**
 * Unit tests for Jensen IPC handlers.
 *
 * Verifies:
 * - All 27 request/response channels are registered via ipcMain.handle
 * - Input validation rejects path traversal and malformed data
 * - cancelDownload aborts in-progress downloads
 * - Download handler sends chunk events via event.sender
 * - Scan progress events are sent during listFiles
 * - isDestroyed() guard prevents sends to closed windows
 * - Error handling returns null to renderer (never throws)
 *
 * HOISTING NOTE: vi.mock() factories are hoisted before variable declarations.
 * Shared mutable state (mockHandlers, mockJensenImpl) is declared as top-level
 * objects whose properties are mutated, not reassigned — this is safe across
 * the hoist boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { pathToFileURL } from 'node:url'

const trustedSenders = vi.hoisted(() => new Map<number, any>())

const captureWriteFailure = vi.hoisted(() => ({ enabled: false }))
vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>()
  return { ...original, writeSync: (...args: unknown[]) => {
    if (captureWriteFailure.enabled && args[4] !== undefined && Number(args[4]) >= 44) throw new Error('Injected recording disk failure')
    return Reflect.apply(original.writeSync, original, args)
  } }
})

const mockRetryPendingFileCleanups = vi.hoisted(() => vi.fn().mockResolvedValue({
  attempted: 0,
  cleared: 0,
  stillPending: {}
}))

const mockStreamService = vi.hoisted(() => ({
  beginDownload: vi.fn(() => true), updateProgress: vi.fn(),
  processDownload: vi.fn(async () => ({ success: true })), noteTransferStall: vi.fn()
}))
vi.mock('../../services/download-service', () => ({ getDownloadService: () => mockStreamService }))

vi.mock('../../services/recording-deletion-service', () => ({
  retryPendingFileCleanups: mockRetryPendingFileCleanups
}))

// ---------------------------------------------------------------------------
// Shared registries — populated by vi.mock factories at module load time
// NOTE: These must be plain object literals (not `new Map`, not `const x = ...`
// with a complex RHS) so they survive the vi.mock hoist.
// ---------------------------------------------------------------------------

/** IPC handlers registered via ipcMain.handle() */
const mockHandlers: Record<string, (event: any, ...args: any[]) => any> = {}

/** Send calls recorded on broadcast window's webContents */
const broadcastSendCalls: Array<[string, any]> = []

/** Controls whether the broadcast window appears destroyed */
const broadcastWindowState = { destroyed: false }

// ---------------------------------------------------------------------------
// Mock electron — must come before any import that transitively loads it
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  // recording-deletion-service (connect sweep) pulls config → electron app.
  app: { getPath: () => 'test-path', getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: any, ...args: any[]) => any) => {
      mockHandlers[channel] = fn
    },
  },
  BrowserWindow: {
    fromWebContents: (sender: any) => trustedSenders.get(sender.id) === sender ? { webContents: sender } : null,
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => broadcastWindowState.destroyed,
          send: (channel: string, payload: any) => {
            broadcastSendCalls.push([channel, payload])
          },
        },
      },
    ],
  },
  webContents: { fromId: (id: number) => trustedSenders.get(id) ?? null },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: () => { throw Error('No OS crypto in IPC unit test') }, decryptString: () => { throw Error('No OS crypto in IPC unit test') } },
}))

// ---------------------------------------------------------------------------
// Mock usb (transitively required by jensen.ts)
// ---------------------------------------------------------------------------

const mockWebUSBInstance = {
  getDevices: vi.fn().mockResolvedValue([]),
  requestDevice: vi.fn().mockRejectedValue(new Error('no device')),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}

vi.mock('usb', () => ({
  // Must use `function` keyword — arrow functions cannot be `new`-ed
  WebUSB: function WebUSBMock() {
    return mockWebUSBInstance
  },
}))

// ---------------------------------------------------------------------------
// Mock the Jensen service — expose a spy-able device object
// vi.mock factory cannot reference `mockJensen` (hoisting), so we use
// a stable wrapper object and reassign its inner methods in beforeEach.
// ---------------------------------------------------------------------------

const mockJensen: any = {
  connect: vi.fn().mockResolvedValue(false),
  tryConnect: vi.fn().mockResolvedValue(false),
  disconnect: vi.fn().mockResolvedValue(undefined),
  abortInFlight: vi.fn(),
  reset: vi.fn().mockResolvedValue(false),
  isConnected: vi.fn().mockReturnValue(false),
  isOperationInProgress: vi.fn().mockReturnValue(false),
  getFirmwareUpdatePreflight: vi.fn().mockResolvedValue({ model: 'hidock-h1e', versionNumber: 393984, serialNumber: 'PRIVATE', activeRecording: false, card: { capacityMiB: 32768, freeMiB: 16000, statusCode: 0x900 } }),
  getRecordingFile: vi.fn().mockResolvedValue({ recording: null }),
  getRecordingStatus: vi.fn().mockResolvedValue({ recording: null, duration: 0, samples: [], type: null }),
  addNativeMarker: vi.fn().mockResolvedValue({ result: 'success' }),
  toggleNativeRecording: vi.fn().mockResolvedValue({ result: 'success' }),
  getCustomRecordingProfile: vi.fn().mockResolvedValue({ profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768, storage: 'fallback' }),
  setCustomRecordingProfile: vi.fn().mockResolvedValue({ result: 'success', persistence: 'unverified' }),
  getCustomRecordingFormat: vi.fn().mockResolvedValue({ format: 'mp3', storage: 'fallback' }),
  setCustomRecordingFormat: vi.fn().mockResolvedValue({ result: 'success', persistence: 'unverified' }),
  getCustomMarkerRules: vi.fn().mockResolvedValue({ enabled: false, lane: 2, meanMagnitudeThreshold: 1000, storage: 'fallback' }),
  setCustomMarkerRules: vi.fn().mockResolvedValue({ result: 'success', persistence: 'unverified' }),
  getModel: vi.fn().mockReturnValue('unknown'),
  isP1Device: vi.fn().mockReturnValue(false),
  getDeviceInfo: vi.fn().mockResolvedValue(null),
  getCardInfo: vi.fn().mockResolvedValue(null),
  getFileCount: vi.fn().mockResolvedValue(null),
  getSettings: vi.fn().mockResolvedValue(null),
  setTime: vi.fn().mockResolvedValue(null),
  setAutoRecord: vi.fn().mockResolvedValue(null),
  listFiles: vi.fn().mockResolvedValue([]),
  downloadFile: vi.fn().mockResolvedValue(true),
  deleteFile: vi.fn().mockResolvedValue({ result: 'success' }),
  formatCard: vi.fn().mockResolvedValue({ result: 'success' }),
  getRealtimeSettings: vi.fn().mockResolvedValue(null),
  startRealtime: vi.fn().mockResolvedValue(null),
  pauseRealtime: vi.fn().mockResolvedValue(null),
  stopRealtime: vi.fn().mockResolvedValue(null),
  getRealtimeData: vi.fn().mockResolvedValue(null),
  getBatteryStatus: vi.fn().mockResolvedValue(null),
  startBluetoothScan: vi.fn().mockResolvedValue(null),
  stopBluetoothScan: vi.fn().mockResolvedValue(null),
  getBluetoothStatus: vi.fn().mockResolvedValue(null),
  serialNumber: 'SN123',
  versionCode: '1.0.0',
  versionNumber: 327714,
  onconnect: undefined as (() => void) | undefined,
  ondisconnect: undefined as (() => void) | undefined,
  setupUsbConnectListener: vi.fn(),
}

vi.mock('../../services/jensen', () => ({
  getJensenDevice: () => mockJensen,
  setFirmwareRecoveryChecker: vi.fn(),
  setDeviceValidationChecker: vi.fn(),
}))

const mockLiveTranscription = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  acceptDevicePacket: vi.fn(),
}))

vi.mock('../../services/gemini-live-transcription', () => ({
  geminiLiveTranscription: mockLiveTranscription,
}))

// The live recorder writes into the recordings folder: a temp one here.
const liveDir = vi.hoisted(() => ({ path: '' }))
vi.mock('../../services/file-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/file-storage')>()),
  getRecordingsPath: () => liveDir.path,
}))
vi.mock('../../services/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/config')>()),
  getConfig: () => ({ transcription: {} }),
}))

// ---------------------------------------------------------------------------
// Import and register handlers under test
// ---------------------------------------------------------------------------

import { endLiveAudioLocally, finishLiveRecording, registerJensenHandlers, shutdownJensenResources } from '../jensen-handlers'


// ---------------------------------------------------------------------------
// Helper to build a fake IPC event with a spy-able sender
// ---------------------------------------------------------------------------

let nextSenderId = 1
function makeEvent(destroyed = false) {
  const sender = Object.assign(new EventEmitter(), { id: nextSenderId++, isDestroyed: vi.fn(() => destroyed), send: vi.fn() })
  return { sender }
}

function makeTrustedRestoreEvent() {
  const event = makeEvent() as any
  event.sender.mainFrame = { url: pathToFileURL(join(process.cwd(), 'out', 'renderer', 'index.html')).href }
  event.senderFrame = event.sender.mainFrame
  trustedSenders.set(event.sender.id, event.sender)
  return event
}

async function startCapture(event = makeEvent(), options = {}) {
  mockJensen.getModel.mockReturnValue('hidock-h1e')
  mockJensen.versionNumber = 393984
  mockJensen.startRealtime.mockResolvedValue({ result: 'success' })
  return mockHandlers['jensen:startRealtime'](event, options)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerJensenHandlers', () => {
  it('registers all caller-paced restore stages without starting them', () => {
    for (const name of ['beginOwnedRecordingRestore', 'appendOwnedRecordingRestore', 'verifyOwnedRecordingRestoreStep', 'recoverOwnedRecordingRestoreStep', 'abortOwnedRecordingRestore', 'getOwnedRecordingRestoreStatus', 'verifyOwnedRecordingRestoreReadback']) {
      expect(mockHandlers[`jensen:${name}`]).toBeTypeOf('function')
    }
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
  })
  it('rejects an untrusted restore sender before any device access', async () => {
    await expect(mockHandlers['jensen:beginOwnedRecordingRestore'](makeEvent(), 'owned', { ownedRecordingRestoreConsent: true, audioQuiescent: true })).rejects.toThrow('trusted application window')
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
  })
  it('admits only the trusted diagnostic/VAD install targets and rejects arbitrary target paths before device I/O', async () => {
    const event = makeTrustedRestoreEvent()
    for (const target of ['diagnostic', 'vad'] as const) {
      await expect(mockHandlers['jensen:prepareFirmwareInstall'](event, target)).rejects.toThrow('qualification is not enabled')
    }
    expect(() => mockHandlers['jensen:prepareFirmwareInstall'](event, 'C:/renderer-selected.bin')).toThrow('Unknown firmware target')
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
    expect(mockJensen.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
  })
  it('rejects extra renderer path authority in restore assurance', async () => {
    await expect(mockHandlers['jensen:beginOwnedRecordingRestore'](makeTrustedRestoreEvent(), 'owned', { ownedRecordingRestoreConsent: true, audioQuiescent: true, filePath: 'C:/outside.wav' })).rejects.toThrow('Explicit recording restore')
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
  })
  it('keeps current393986 restore closed at the actual main handler before SDK IO', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393986
    mockJensen.versionCode = '6.3.2'
    const reply = await mockHandlers['jensen:beginOwnedRecordingRestore'](makeTrustedRestoreEvent(), 'owned', { ownedRecordingRestoreConsent: true, audioQuiescent: true })
    expect(reply.status).toBe('rejected-before-dispatch')
    expect(reply.commandAttempted).toBe(false)
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
  })
  describe('jensen:getFirmwareConsoleStatus request validation', () => {
    const slotsStatus = { request: 'slots', slotAddress: 0xef5c, targetWord: 1, pllWord: 2, imageAttested: false }
    const refusedBeforeDevice = [
      ['unknown string', 'reboot'],
      ['upper case', 'SLOTS'],
      ['mixed case', 'Slots'],
      ['trailing newline', 'slots\n'],
      ['leading space', ' slots'],
      ['address argument', 'slots 0000ef5c'],
      ['address equals form', 'slots=0000ef5c'],
      ['length argument', 'slots 40'],
      ['empty string', ''],
      ['object value', { request: 'slots' }],
      ['object with address', { request: 'slots', address: 0xef5c, length: 40 }],
      ['array value', ['slots']],
      ['null', null],
      ['number', 0xef5c],
    ] as const

    it('delegates the literal slots request from a trusted sender to the serialized device call', async () => {
      mockJensen.getFirmwareConsoleStatus = vi.fn().mockResolvedValue(slotsStatus)
      const result = await mockHandlers['jensen:getFirmwareConsoleStatus'](makeTrustedRestoreEvent(), 'slots')
      expect(result).toEqual(slotsStatus)
      expect(mockJensen.getFirmwareConsoleStatus).toHaveBeenCalledTimes(1)
      expect(mockJensen.getFirmwareConsoleStatus).toHaveBeenCalledWith('slots')
    })

    it('runs the slots device call inside the device operation serializer', async () => {
      const { serializeDeviceOperation } = await import('../../services/device-operation-serializer')
      let releaseOwner!: () => void
      const owner = serializeDeviceOperation(() => new Promise<void>(resolve => { releaseOwner = resolve }))
      mockJensen.getFirmwareConsoleStatus = vi.fn().mockResolvedValue(slotsStatus)
      const pending = mockHandlers['jensen:getFirmwareConsoleStatus'](makeTrustedRestoreEvent(), 'slots')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(mockJensen.getFirmwareConsoleStatus).not.toHaveBeenCalled()
      releaseOwner()
      await owner
      expect(await pending).toEqual(slotsStatus)
      expect(mockJensen.getFirmwareConsoleStatus).toHaveBeenCalledTimes(1)
    })

    it.each(refusedBeforeDevice)('refuses %s from a trusted sender before any device call', async (_name, request) => {
      mockJensen.getFirmwareConsoleStatus = vi.fn().mockResolvedValue(slotsStatus)
      await expect(
        Promise.resolve().then(() => mockHandlers['jensen:getFirmwareConsoleStatus'](makeTrustedRestoreEvent(), request)),
      ).rejects.toThrow('supported literal requests')
      expect(mockJensen.getFirmwareConsoleStatus).not.toHaveBeenCalled()
    })

    it('refuses an untrusted sender before validating or scheduling the device call', async () => {
      mockJensen.getFirmwareConsoleStatus = vi.fn().mockResolvedValue(slotsStatus)
      for (const request of ['slots', 'reboot', { request: 'slots' }]) {
        await expect(
          Promise.resolve().then(() => mockHandlers['jensen:getFirmwareConsoleStatus'](makeEvent(), request)),
        ).rejects.toThrow('trusted application window')
      }
      expect(mockJensen.getFirmwareConsoleStatus).not.toHaveBeenCalled()
    })
  })

  it('returns read-only update prerequisites without exposing the device serial', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    const result = await mockHandlers['jensen:getFirmwareUpdatePreflight'](makeEvent())
    expect(mockJensen.getFirmwareUpdatePreflight).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ model: 'hidock-h1e', versionNumber: 393984, activeRecording: false, card: { capacityMiB: 32768, freeMiB: 16000, statusCode: 0x900 } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })

  it('does not run update preflight during another operation or for a closed caller', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    expect(await mockHandlers['jensen:getFirmwareUpdatePreflight'](makeEvent(true))).toBeNull()
    mockJensen.isOperationInProgress.mockReturnValue(true)
    expect(await mockHandlers['jensen:getFirmwareUpdatePreflight'](makeEvent())).toBeNull()
    expect(mockJensen.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
  })

  it('rejects a lost connection after read-only update preflight', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.getFirmwareUpdatePreflight.mockImplementationOnce(async () => {
      mockJensen.isConnected.mockReturnValue(false)
      return { model: 'hidock-h1e', versionNumber: 393984, activeRecording: false, card: {} }
    })
    expect(await mockHandlers['jensen:getFirmwareUpdatePreflight'](makeEvent())).toBeNull()
  })

  it('keeps custom profile controls unavailable on official firmware without a device query or mutation', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    expect(await mockHandlers['jensen:getCustomRecordingProfile'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomRecordingProfile'](makeEvent(), { profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).toBeNull()
    expect(mockJensen.getCustomRecordingProfile).not.toHaveBeenCalled()
    expect(mockJensen.setCustomRecordingProfile).not.toHaveBeenCalled()
    expect(await mockHandlers['jensen:getCustomRecordingFormat'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomRecordingFormat'](makeEvent(), 'wav')).toBeNull()
    expect(await mockHandlers['jensen:getCustomMarkerRules'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomMarkerRules'](makeEvent(), { enabled: false, lane: 2, meanMagnitudeThreshold: 1000 })).toBeNull()
    expect(mockJensen.getCustomRecordingFormat).not.toHaveBeenCalled()
    expect(mockJensen.setCustomRecordingFormat).not.toHaveBeenCalled()
    expect(mockJensen.getCustomMarkerRules).not.toHaveBeenCalled()
    expect(mockJensen.setCustomMarkerRules).not.toHaveBeenCalled()
  })

  it('refuses custom profile operations during a transfer on the qualified version', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393985
    mockJensen.versionCode = '6.3.1'
    mockJensen.isOperationInProgress.mockReturnValue(true)
    expect(await mockHandlers['jensen:getCustomRecordingFormat'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomRecordingFormat'](makeEvent(), 'wav')).toBeNull()
    expect(await mockHandlers['jensen:getCustomMarkerRules'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomMarkerRules'](makeEvent(), { enabled: false, lane: 2, meanMagnitudeThreshold: 1000 })).toBeNull()
    expect(await mockHandlers['jensen:getCustomRecordingProfile'](makeEvent())).toBeNull()
    expect(await mockHandlers['jensen:setCustomRecordingProfile'](makeEvent(), { profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 })).toBeNull()
    expect(mockJensen.setCustomRecordingProfile).not.toHaveBeenCalled()
  })
describe('main-process library transfer', () => {
  it('persists downloading before the USB command and never sends audio through IPC', async () => {
    const event = makeEvent()
    let storedBytes: Buffer | undefined
    mockStreamService.beginDownload.mockReturnValue(true)
    mockStreamService.processDownload.mockImplementationOnce(async (...args: any[]) => {
      storedBytes = readFileSync(args[1].path)
      return { success: true }
    })
    mockJensen.downloadFile.mockImplementationOnce(async (_name: string, _size: number, chunk: any, progress: any) => {
      expect(mockStreamService.beginDownload).toHaveBeenCalledWith('stream.hda')
      chunk(new Uint8Array([1, 2, 3, 4]))
      for (let n = 0; n < 100; n++) progress(4)
      return true
    })
    const result = await mockHandlers['jensen:downloadToLibrary'](event, { filename: 'stream.hda', fileSize: 4 })
    expect(result.success).toBe(true)
    expect(storedBytes).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(event.sender.send).not.toHaveBeenCalled()
    expect(mockStreamService.updateProgress.mock.calls.length).toBeLessThanOrEqual(1)
    expect(readdirSync(liveDir.path)).toEqual([])
  })
})

  beforeEach(() => {
    vi.clearAllMocks()
    captureWriteFailure.enabled = false
    liveDir.path = mkdtempSync(join(tmpdir(), 'jensen-live-'))
    mockRetryPendingFileCleanups.mockResolvedValue({ attempted: 0, cleared: 0, stillPending: {} })
    mockJensen.getModel.mockReturnValue('unknown')
    mockJensen.versionNumber = 327714
    mockJensen.versionCode = '6.3.0'
    mockJensen.isConnected.mockReturnValue(true)
    mockJensen.isOperationInProgress.mockReturnValue(false)
    mockJensen.getRecordingFile.mockResolvedValue({ recording: null })
    mockJensen.getRecordingStatus.mockResolvedValue({ recording: null, duration: 0, samples: [], type: null })
    mockJensen.startRealtime.mockResolvedValue(null)
    broadcastSendCalls.length = 0
    broadcastWindowState.destroyed = false
    // Re-register handlers so mockHandlers is fully populated
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k])
    registerJensenHandlers()
  })

  afterEach(async () => {
    // Stop the module-level recording poll between tests (ondisconnect clears its
    // interval/kickoff timers) so a leaked timer can't fire in a later test.
    mockJensen.ondisconnect?.()
    await endLiveAudioLocally('test-cleanup')
    vi.useRealTimers()
    // A test that starts a stream and never stops it leaves the recorder open.
    finishLiveRecording()
    rmSync(liveDir.path, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Channel registration
  // -------------------------------------------------------------------------

  const expectedChannels = [
    'jensen:connect',
    'jensen:tryConnect',
    'jensen:disconnect',
    'jensen:reset',
    'jensen:isConnected',
    'jensen:getModel',
    'jensen:isP1Device',
    'jensen:getDeviceInfo',
    'jensen:getCardInfo',
    'jensen:getFileCount',
    'jensen:getSettings',
    'jensen:setTime',
    'jensen:setAutoRecord',
    'jensen:listFiles',
    'jensen:downloadFile',
    'jensen:cancelDownload',
    'jensen:deleteFile',
    'jensen:formatCard',
    'jensen:getRealtimeSettings',
    'jensen:startRealtime',
    'jensen:pauseRealtime',
    'jensen:stopRealtime',
    'jensen:getRealtimeData',
    'jensen:getBatteryStatus',
    'jensen:startBluetoothScan',
    'jensen:stopBluetoothScan',
    'jensen:getBluetoothStatus',
  ]

  it('registers all 27 request/response channels', () => {
    expect(expectedChannels).toHaveLength(27)
    for (const channel of expectedChannels) {
      expect(mockHandlers[channel], `Missing handler for ${channel}`).toBeDefined()
    }
  })

  // -------------------------------------------------------------------------
  // Core operations
  // -------------------------------------------------------------------------

  it('jensen:connect delegates to jensen.connect()', async () => {
    mockJensen.connect.mockResolvedValue(true)
    const result = await mockHandlers['jensen:connect'](makeEvent())
    expect(mockJensen.connect).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
    expect(mockRetryPendingFileCleanups).toHaveBeenCalledTimes(1)
  })

  it('jensen:connect does not finish until queued device erases have been swept', async () => {
    let releaseCleanup!: () => void
    let reportCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>((resolve) => { reportCleanupStarted = resolve })
    mockJensen.connect.mockResolvedValue(true)
    mockRetryPendingFileCleanups.mockImplementation(() => new Promise((resolve) => {
      reportCleanupStarted()
      releaseCleanup = () => resolve({ attempted: 1, cleared: 1, stillPending: {} })
    }))

    let settled = false
    const connect = mockHandlers['jensen:connect'](makeEvent()).then((result) => {
      settled = true
      return result
    })
    await cleanupStarted

    expect(mockRetryPendingFileCleanups).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    releaseCleanup()
    await expect(connect).resolves.toBe(true)
  })

  it('jensen:isConnected returns boolean', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    const result = await mockHandlers['jensen:isConnected'](makeEvent())
    expect(result).toBe(true)
  })

  it('jensen:disconnect returns null', async () => {
    const result = await mockHandlers['jensen:disconnect'](makeEvent())
    expect(mockJensen.disconnect).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
  })

  it('jensen:getModel returns model string', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1')
    const result = await mockHandlers['jensen:getModel'](makeEvent())
    expect(result).toBe('hidock-h1')
  })

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('jensen:deleteFile rejects path traversal filenames', async () => {
    const result = await mockHandlers['jensen:deleteFile'](makeEvent(), { filename: '../secret.hda' })
    expect(result).toBeNull()
    expect(mockJensen.deleteFile).not.toHaveBeenCalled()
  })

  it('jensen:deleteFile rejects filenames with null bytes', async () => {
    const result = await mockHandlers['jensen:deleteFile'](makeEvent(), { filename: 'file\0name.hda' })
    expect(result).toBeNull()
    expect(mockJensen.deleteFile).not.toHaveBeenCalled()
  })

  it('jensen:deleteFile rejects absolute paths', async () => {
    const result = await mockHandlers['jensen:deleteFile'](makeEvent(), { filename: '/etc/passwd' })
    expect(result).toBeNull()
    expect(mockJensen.deleteFile).not.toHaveBeenCalled()
  })

  it('jensen:deleteFile accepts valid filenames', async () => {
    mockJensen.deleteFile.mockResolvedValue({ result: 'success' })
    const result = await mockHandlers['jensen:deleteFile'](makeEvent(), { filename: 'recording.hda' })
    expect(mockJensen.deleteFile).toHaveBeenCalledWith('recording.hda')
    expect(result).toEqual({ result: 'success' })
  })

  it('jensen:deleteFile waits behind an in-flight serialized device operation', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    let releaseCount!: () => void
    let reportCountStarted!: () => void
    const countStarted = new Promise<void>((resolve) => { reportCountStarted = resolve })
    mockJensen.getFileCount.mockImplementation(() => new Promise((resolve) => {
      reportCountStarted()
      releaseCount = () => resolve({ count: 1 })
    }))

    const countPromise = mockHandlers['jensen:getFileCount'](makeEvent())
    await countStarted
    const deletePromise = mockHandlers['jensen:deleteFile'](makeEvent(), { filename: 'recording.hda' })
    await Promise.resolve()

    expect(mockJensen.deleteFile).not.toHaveBeenCalled()
    releaseCount()
    await countPromise
    await expect(deletePromise).resolves.toEqual({ result: 'success' })
    expect(mockJensen.deleteFile).toHaveBeenCalledWith('recording.hda')
  })

  it('jensen:downloadFile rejects path traversal filenames', async () => {
    const result = await mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: '../../secret.hda',
      fileSize: 1000,
    })
    expect(result).toBeNull()
    expect(mockJensen.downloadFile).not.toHaveBeenCalled()
  })

  it('jensen:downloadFile rejects negative fileSize', async () => {
    const result = await mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: 'recording.hda',
      fileSize: -1,
    })
    expect(result).toBeNull()
    expect(mockJensen.downloadFile).not.toHaveBeenCalled()
  })

  it('jensen:downloadFile rejects fileSize exceeding 2GB', async () => {
    const result = await mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: 'recording.hda',
      fileSize: 3_000_000_000,
    })
    expect(result).toBeNull()
    expect(mockJensen.downloadFile).not.toHaveBeenCalled()
  })

  it('jensen:setAutoRecord rejects non-boolean', async () => {
    const result = await mockHandlers['jensen:setAutoRecord'](makeEvent(), { enabled: 'yes' })
    expect(result).toBeNull()
    expect(mockJensen.setAutoRecord).not.toHaveBeenCalled()
  })

  it('jensen:setAutoRecord accepts boolean', async () => {
    mockJensen.setAutoRecord.mockResolvedValue({ result: 'success' })
    const result = await mockHandlers['jensen:setAutoRecord'](makeEvent(), { enabled: true })
    expect(mockJensen.setAutoRecord).toHaveBeenCalledWith(true)
    expect(result).toEqual({ result: 'success' })
  })

  it('jensen:getRealtimeData rejects negative offset', async () => {
    const result = await mockHandlers['jensen:getRealtimeData'](makeEvent(), { offset: -5 })
    expect(result).toBeNull()
    expect(mockJensen.getRealtimeData).not.toHaveBeenCalled()
  })

  it('jensen:getRealtimeData accepts zero offset', async () => {
    const event = makeEvent()
    await startCapture(event)
    mockJensen.getRealtimeData.mockResolvedValue(null)
    await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    expect(mockJensen.getRealtimeData).toHaveBeenCalledWith(0)
  })

  it('starts capture without Gemini and sends exactly one device start command in room/call mode', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    mockJensen.startRealtime.mockResolvedValue({ result: 'success' })
    const event = makeEvent()

    await expect(mockHandlers['jensen:startRealtime'](event)).resolves.toMatchObject({ result: 'success', transcribe: false })

    expect(mockLiveTranscription.start).not.toHaveBeenCalled()
    expect(mockJensen.startRealtime).toHaveBeenCalledTimes(1)
    expect(mockJensen.startRealtime).toHaveBeenCalledWith(2)
  })

  it('fresh native status blocks live start even when the recording poll has not observed it', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    mockJensen.getRecordingStatus.mockResolvedValueOnce({ recording: 'active.mp3', duration: 12, samples: [], type: 'recording' })
    expect(await mockHandlers['jensen:startRealtime'](makeEvent())).toMatchObject({ result: 'failed', error: expect.stringContaining('native recording is active') })
    expect(mockJensen.startRealtime).not.toHaveBeenCalled()
    expect(mockLiveTranscription.start).not.toHaveBeenCalled()
  })

  it('shutdown during native-status read prevents a delayed live control write', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    let release!: (value: any) => void
    mockJensen.getRecordingStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = mockHandlers['jensen:startRealtime'](makeEvent())
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    finishLiveRecording()
    release({ recording: null, duration: 0, samples: [], type: null })
    expect(await pending).toMatchObject({ result: 'failed' })
    expect(mockJensen.startRealtime).not.toHaveBeenCalled()
  })

  it('starts Gemini only when requested and keeps the owned capture available', async () => {
    const event = makeEvent()
    await startCapture(event, { transcribe: true })
    await vi.waitFor(() => expect(mockLiveTranscription.start).toHaveBeenCalledWith(event.sender))
    expect(mockHandlers['jensen:getAudioDiagnostics'](event).session.transcribe).toBe(true)
  })

  it('saves the realtime stream as a recording and says so when it stops', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    mockJensen.startRealtime.mockResolvedValue({ result: 'success' })
    const packet = { rest: 0, muted: false, data: new Uint8Array(8 + 16000 * 4) }
    mockJensen.getRealtimeData.mockResolvedValueOnce(packet)
    const event = makeEvent()

    const started = await mockHandlers['jensen:startRealtime'](event)
    expect(readdirSync(liveDir.path)[0]).toMatch(/-Live\.wav\.partial$/)
    await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    await mockHandlers['jensen:stopRealtime'](event)

    const files = readdirSync(liveDir.path), wav = files.find((file) => file.endsWith('.wav'))!
    expect(files).toHaveLength(2)
    expect(wav).toMatch(/^\d{4}[A-Z][a-z]{2}\d{2}-\d{6}-Capture-Live\.wav$/)
    expect(broadcastSendCalls).toContainEqual(['jensen:realtime-recording', { status: 'saved', filename: wav, seconds: 1 }])
    const note = JSON.parse(readFileSync(join(liveDir.path, wav.replace(/\.wav$/, '.live.json')), 'utf8'))
    expect(note.captureSessionId).toBe(started.sessionId)
    expect(note.capture.automaticTranscription).toBe(false)
    expect(note.capture.framesWritten).toBe(16000)
  })

  it('an unplugged device saves the stream, and the next stream gets its own file', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    mockJensen.startRealtime.mockResolvedValue({ result: 'success' })
    mockJensen.getRealtimeData.mockResolvedValueOnce({ rest: 0, muted: false, data: new Uint8Array(8 + 64) })
    const event = makeEvent()
    await mockHandlers['jensen:startRealtime'](event)
    await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    mockJensen.ondisconnect?.()
    const files = readdirSync(liveDir.path)
    expect(files).toHaveLength(2)
    expect(files.some((file) => /-Live\.wav$/.test(file))).toBe(true)
    expect(broadcastSendCalls.some(([c, p]) => c === 'jensen:realtime-recording' && p.status === 'saved')).toBe(true)
  })

  it('rejects realtime streaming before Gemini or USB when firmware is too old', async () => {
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393983

    const result = await mockHandlers['jensen:startRealtime'](makeEvent())

    expect(result).toMatchObject({ result: 'failed', error: expect.stringContaining('firmware') })
    expect(mockLiveTranscription.start).not.toHaveBeenCalled()
    expect(mockJensen.startRealtime).not.toHaveBeenCalled()
  })

  it('rejects unowned reads and competing starts without stopping the current provider', async () => {
    const owner = makeEvent(), other = makeEvent()
    await startCapture(owner, { transcribe: true })
    await vi.waitFor(() => expect(mockLiveTranscription.start).toHaveBeenCalledOnce())
    mockLiveTranscription.stop.mockClear()
    expect(await mockHandlers['jensen:startRealtime'](other, { transcribe: true })).toMatchObject({ result: 'failed' })
    expect(await mockHandlers['jensen:startRealtime'](other, { transcribe: 'bad-value' })).toMatchObject({ result: 'failed' })
    expect(await mockHandlers['jensen:getRealtimeData'](other, { offset: 0 })).toBeNull()
    expect(mockJensen.getRealtimeData).not.toHaveBeenCalled()
    expect(mockLiveTranscription.stop).not.toHaveBeenCalled()
    expect(mockHandlers['jensen:getAudioDiagnostics'](owner).session.status).toBe('streaming')
  })

  it('dequeues and fans out a packet once when the renderer submits duplicate reads', async () => {
    const event = makeEvent()
    await startCapture(event)
    let resolve!: (value: any) => void
    mockJensen.getRealtimeData.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const first = mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    expect(await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })).toBeNull()
    expect(mockJensen.getRealtimeData).toHaveBeenCalledOnce()
    const packet = { rest: 0, muted: false, data: new Uint8Array(12) }
    resolve(packet)
    expect(await first).toBe(packet)
    expect(mockHandlers['jensen:getAudioDiagnostics'](event).diagnostics.frames).toBe(1)
    expect(event.sender.send.mock.calls.filter(([name]) => name === 'jensen:realtime-data')).toHaveLength(1)
    expect(event.sender.send.mock.calls.find(([name]) => name === 'jensen:audio-diagnostics')?.[1].lastSessionId).toEqual(expect.any(String))
  })

  it('taps two mono lanes from the one accepted packet with no ASR, file or extra read', async () => {
    const event = makeEvent()
    const started = await startCapture(event, { transcribe: false, saveRecording: false })
    const raw = new Uint8Array(8 + 8)
    raw.set([0, 0, 0, 4, 0, 0, 0, 0], 0)
    new DataView(raw.buffer).setInt16(8, -32768, true)
    new DataView(raw.buffer).setInt16(10, 32767, true)
    new DataView(raw.buffer).setInt16(12, 1, true)
    new DataView(raw.buffer).setInt16(14, -2, true)
    const packet = { rest: 4, muted: false, sequenceMinusOne: 4, microphoneMuted: false, data: raw }
    const before = Array.from(raw)
    mockJensen.getRealtimeData.mockResolvedValueOnce(packet)
    expect(await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })).toBe(packet)
    expect(mockJensen.getRealtimeData).toHaveBeenCalledOnce()
    const taps = event.sender.send.mock.calls.filter(([name]) => name === 'jensen:realtime-channels')
    expect(taps).toHaveLength(1)
    const tap = taps[0][1]
    expect(tap).toMatchObject({ sessionId: started.sessionId, sequenceMinusOne: 4, microphoneMuted: false, frameCount: 2, sampleRateHz: 16000, sampleRateEvidence: 'host-expectation' })
    expect(tap.channels.map((channel: any) => channel.id)).toEqual(['channel-0', 'channel-1'])
    expect(Array.from(tap.channels[0].pcm)).toEqual([0x00, 0x80, 0x01, 0x00])
    expect(Array.from(tap.channels[1].pcm)).toEqual([0xff, 0x7f, 0xfe, 0xff])
    expect(Array.from(raw)).toEqual(before)
    expect(mockLiveTranscription.acceptDevicePacket).not.toHaveBeenCalled()
    expect(readdirSync(liveDir.path)).toEqual([])
  })

  it('sends no lane tap for a packet without a whole frame, and none to a non-owner', async () => {
    const owner = makeEvent(), other = makeEvent()
    await startCapture(owner, { transcribe: false, saveRecording: false })
    mockJensen.getRealtimeData.mockResolvedValueOnce({ rest: 0, muted: false, data: new Uint8Array(11) })
    await mockHandlers['jensen:getRealtimeData'](owner, { offset: 0 })
    expect(await mockHandlers['jensen:getRealtimeData'](other, { offset: 0 })).toBeNull()
    expect(owner.sender.send.mock.calls.filter(([name]) => name === 'jensen:realtime-channels')).toHaveLength(0)
    expect(other.sender.send.mock.calls.filter(([name]) => name === 'jensen:realtime-channels')).toHaveLength(0)
  })

  it('drops an old read when pause/resume reuses the same session ID', async () => {
    const event = makeEvent()
    await startCapture(event)
    let resolve!: (value: any) => void
    mockJensen.getRealtimeData.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    mockJensen.pauseRealtime.mockResolvedValueOnce({ result: 'success' })
    const pending = mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    await mockHandlers['jensen:pauseRealtime'](event)
    await mockHandlers['jensen:startRealtime'](event)
    resolve({ rest: 0, muted: false, data: new Uint8Array(12) })
    expect(await pending).toBeNull()
    expect(mockHandlers['jensen:getAudioDiagnostics'](event).diagnostics.frames).toBe(0)
    expect(event.sender.send.mock.calls.filter(([name]) => name === 'jensen:realtime-data')).toHaveLength(0)
  })

  it('owner destruction stops the stream and saves its completed sample sequence', async () => {
    const event = makeEvent()
    await startCapture(event)
    mockJensen.getRealtimeData.mockResolvedValueOnce({ rest: 0, muted: false, data: new Uint8Array(12) })
    await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    event.sender.isDestroyed.mockReturnValue(true)
    event.sender.emit('destroyed')
    await vi.waitFor(() => expect(mockHandlers['jensen:getAudioDiagnostics'](event).session.status).toBe('idle'))
    expect(mockJensen.stopRealtime).toHaveBeenCalledOnce()
    expect(readdirSync(liveDir.path).filter(file => file.endsWith('.wav'))).toHaveLength(1)
  })

  it('reset invalidates pending reads before calling the device reset', async () => {
    const event = makeEvent()
    await startCapture(event)
    let resolve!: (value: any) => void
    mockJensen.getRealtimeData.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const pending = mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    await mockHandlers['jensen:reset'](event)
    resolve({ rest: 0, muted: false, data: new Uint8Array(12) })
    expect(await pending).toBeNull()
    expect(mockHandlers['jensen:getAudioDiagnostics'](event).session.status).toBe('idle')
    expect(mockJensen.reset).toHaveBeenCalledOnce()
    expect(readdirSync(liveDir.path)).toEqual([])
  })

  it('shutdown cancels a start that is waiting on the device', async () => {
    const event = makeEvent()
    mockJensen.getModel.mockReturnValue('hidock-h1e')
    mockJensen.versionNumber = 393984
    let resolve!: (value: any) => void
    mockJensen.startRealtime.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const pending = mockHandlers['jensen:startRealtime'](event, { transcribe: true })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    finishLiveRecording()
    resolve({ result: 'success' })
    expect(await pending).toMatchObject({ result: 'failed' })
    expect(mockHandlers['jensen:getAudioDiagnostics'](event).session.status).toBe('idle')
    expect(mockLiveTranscription.start).not.toHaveBeenCalled()
    expect(readdirSync(liveDir.path)).toEqual([])
  })

  it('reports a recording write failure immediately while diagnostics/provider continue and preserves saved audio', async () => {
    const event = makeEvent()
    await startCapture(event, { transcribe: true })
    await vi.waitFor(() => expect(mockLiveTranscription.start).toHaveBeenCalledOnce())
    const packet = { rest: 0, muted: false, data: new Uint8Array(12) }
    mockJensen.getRealtimeData.mockResolvedValueOnce(packet)
    await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })
    captureWriteFailure.enabled = true
    mockJensen.getRealtimeData.mockResolvedValueOnce(packet)
    expect(await mockHandlers['jensen:getRealtimeData'](event, { offset: 0 })).toBe(packet)
    const state = mockHandlers['jensen:getAudioDiagnostics'](event)
    expect(state.session).toMatchObject({ status: 'streaming', saveRecording: false, recordingError: 'Injected recording disk failure' })
    expect(state.diagnostics.frames).toBe(2)
    const diagnosticEvents = event.sender.send.mock.calls.filter(([channel]) => channel === 'jensen:audio-diagnostics')
    expect(diagnosticEvents.at(-1)?.[1].session.recordingError).toBe('Injected recording disk failure')
    expect(mockLiveTranscription.acceptDevicePacket).toHaveBeenCalledTimes(2)
    await mockHandlers['jensen:stopRealtime'](event)
    const wav = readdirSync(liveDir.path).find(file => file.endsWith('.wav'))!
    const bytes = readFileSync(join(liveDir.path, wav))
    expect(bytes.readUInt32LE(40)).toBe(4)
    expect(bytes.length).toBe(48)
    expect(broadcastSendCalls.some(([channel, result]) => channel === 'jensen:realtime-recording' && result.status === 'error' && result.filename === wav)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Download handler — chunk batching and progress events
  // -------------------------------------------------------------------------

  it('jensen:downloadFile sends chunk events via event.sender', async () => {
    const event = makeEvent(false)
    const chunkData = new Uint8Array(100).fill(0xaa)

    mockJensen.downloadFile.mockImplementation(
      async (_filename: string, _size: number, onChunk: (d: Uint8Array) => void) => {
        onChunk(chunkData)
        return true
      }
    )

    const result = await mockHandlers['jensen:downloadFile'](event, {
      filename: 'test.hda',
      fileSize: 100,
    })

    expect(result).toBe(true)
    // chunk should have been flushed on completion
    const chunkCalls = (event.sender.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'jensen:download-chunk'
    )
    expect(chunkCalls.length).toBeGreaterThan(0)
    expect(chunkCalls[0][1]).toMatchObject({ filename: 'test.hda' })
  })

  it('jensen:downloadFile sends progress events via event.sender', async () => {
    const event = makeEvent(false)

    mockJensen.downloadFile.mockImplementation(
      async (_filename: string, _size: number, _onChunk: any, onProgress: (n: number) => void) => {
        onProgress(512)
        return true
      }
    )

    await mockHandlers['jensen:downloadFile'](event, {
      filename: 'test.hda',
      fileSize: 1024,
    })

    expect(event.sender.send).toHaveBeenCalledWith('jensen:download-progress', {
      filename: 'test.hda',
      bytesReceived: 512,
      totalBytes: 1024,
    })
  })

  it('jensen:downloadFile does not send progress to destroyed window', async () => {
    const event = makeEvent(true) // isDestroyed = true

    mockJensen.downloadFile.mockImplementation(
      async (_filename: string, _size: number, _onChunk: any, onProgress: (n: number) => void) => {
        onProgress(100)
        return true
      }
    )

    await mockHandlers['jensen:downloadFile'](event, {
      filename: 'test.hda',
      fileSize: 1000,
    })

    const progressCalls = (event.sender.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'jensen:download-progress'
    )
    expect(progressCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // cancelDownload
  // -------------------------------------------------------------------------

  it('jensen:cancelDownload is safe when no download is in progress', async () => {
    const result = await mockHandlers['jensen:cancelDownload'](makeEvent())
    expect(result).toBeNull()
  })

  it('jensen:cancelDownload aborts an in-progress download', async () => {
    let capturedSignal: AbortSignal | undefined

    mockJensen.downloadFile.mockImplementation(
      async (
        _filename: string,
        _size: number,
        _onChunk: any,
        _onProgress: any,
        signal: AbortSignal
      ) => {
        capturedSignal = signal
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve())
          setTimeout(resolve, 5000) // fallback so test doesn't hang
        })
        return false
      }
    )

    // Start download without awaiting — let it run asynchronously
    const downloadPromise = mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: 'big.hda',
      fileSize: 100_000_000,
    })

    // Let the download handler start and register the AbortController
    await new Promise((r) => setTimeout(r, 20))

    // Cancel the download
    await mockHandlers['jensen:cancelDownload'](makeEvent())

    // Verify signal was aborted
    expect(capturedSignal?.aborted).toBe(true)

    // Download promise should resolve now
    const result = await downloadPromise
    expect(result).toBe(false)
  })

  // -------------------------------------------------------------------------
  // listFiles — scan progress events
  // -------------------------------------------------------------------------

  it('jensen:listFiles sends scan-progress events during file listing', async () => {
    const event = makeEvent(false)
    mockJensen.isConnected.mockReturnValue(true)

    mockJensen.listFiles.mockImplementation(
      async (onProgress: (found: number, expected: number) => void) => {
        onProgress(1, 10)
        onProgress(5, 10)
        onProgress(10, 10)
        return []
      }
    )

    await mockHandlers['jensen:listFiles'](event)

    const progressCalls = (event.sender.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'jensen:scan-progress'
    )
    expect(progressCalls).toHaveLength(3)
    expect(progressCalls[0][1]).toEqual({ current: 1, total: 10 })
    expect(progressCalls[2][1]).toEqual({ current: 10, total: 10 })
  })

  it('jensen:listFiles does not send scan-progress to destroyed window', async () => {
    const event = makeEvent(true) // isDestroyed = true
    mockJensen.isConnected.mockReturnValue(true)

    mockJensen.listFiles.mockImplementation(
      async (onProgress: (found: number, expected: number) => void) => {
        onProgress(1, 5)
        return []
      }
    )

    await mockHandlers['jensen:listFiles'](event)

    const progressCalls = (event.sender.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'jensen:scan-progress'
    )
    expect(progressCalls).toHaveLength(0)
  })

  it('jensen:listFiles returns null without scanning when the device is disconnected', async () => {
    mockJensen.isConnected.mockReturnValue(false)
    const result = await mockHandlers['jensen:listFiles'](makeEvent())
    expect(result).toBeNull()
    expect(mockJensen.listFiles).not.toHaveBeenCalled()
  })

  it('jensen:getFileCount returns null without querying when the device is disconnected', async () => {
    mockJensen.isConnected.mockReturnValue(false)
    const result = await mockHandlers['jensen:getFileCount'](makeEvent())
    expect(result).toBeNull()
    expect(mockJensen.getFileCount).not.toHaveBeenCalled()
  })

  it('does not issue file-count or list commands while a download owns the USB stream', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    let releaseDownload!: () => void
    mockJensen.downloadFile.mockImplementation(async (_filename, _size, _chunk, _progress, _signal, onStarted) => {
      onStarted?.()
      await new Promise<void>((resolve) => { releaseDownload = resolve })
      return true
    })

    const downloadPromise = mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: 'active.hda',
      fileSize: 1024,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(mockHandlers['jensen:getFileCount'](makeEvent())).resolves.toBeNull()
    await expect(mockHandlers['jensen:listFiles'](makeEvent())).resolves.toBeNull()
    expect(mockJensen.getFileCount).not.toHaveBeenCalled()
    expect(mockJensen.listFiles).not.toHaveBeenCalled()

    releaseDownload()
    await expect(downloadPromise).resolves.toBe(true)
  })

  it('does not start a download until an already-running count command has settled', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    mockJensen.downloadFile.mockResolvedValue(true)
    let releaseCount!: () => void
    mockJensen.getFileCount.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseCount = resolve })
      return { count: 330 }
    })

    const countPromise = mockHandlers['jensen:getFileCount'](makeEvent())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const downloadPromise = mockHandlers['jensen:downloadFile'](makeEvent(), {
      filename: 'after-count.hda',
      fileSize: 38_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockJensen.downloadFile).not.toHaveBeenCalled()
    releaseCount()
    await expect(countPromise).resolves.toEqual({ count: 330 })
    await expect(downloadPromise).resolves.toBe(true)
    expect(mockJensen.downloadFile).toHaveBeenCalledTimes(1)
  })

  it('jensen:disconnect does NOT preempt in-flight work (waits for it via the serializer)', async () => {
    // Disconnect must let a running scan finish so the device empties its USB FIFO
    // before close — preempting it leaves stale bytes that wedge the next connect.
    await mockHandlers['jensen:disconnect'](makeEvent())
    expect(mockJensen.disconnect).toHaveBeenCalledTimes(1)
    expect(mockJensen.abortInFlight).not.toHaveBeenCalled()
  })

  it('jensen:reset preempts in-flight work via abortInFlight() before resetting', async () => {
    await mockHandlers['jensen:reset'](makeEvent())
    expect(mockJensen.abortInFlight).toHaveBeenCalledTimes(1)
    expect(mockJensen.reset).toHaveBeenCalledTimes(1)
    expect(mockJensen.abortInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      mockJensen.reset.mock.invocationCallOrder[0]
    )
  })

  // -------------------------------------------------------------------------
  // Error handling — all handlers return null on error, never throw
  // -------------------------------------------------------------------------

  it('jensen:connect returns null when jensen throws', async () => {
    mockJensen.connect.mockRejectedValue(new Error('USB error'))
    const result = await mockHandlers['jensen:connect'](makeEvent())
    expect(result).toBeNull()
  })

  it('jensen:getDeviceInfo returns null when jensen throws', async () => {
    mockJensen.getDeviceInfo.mockRejectedValue(new Error('USB error'))
    const result = await mockHandlers['jensen:getDeviceInfo'](makeEvent())
    expect(result).toBeNull()
  })
  it('initial information/card/settings reads wait for the shared owner operation to settle', async () => {
    const { serializeDeviceOperation } = await import('../../services/device-operation-serializer')
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const owner = serializeDeviceOperation(() => barrier)
    const info = mockHandlers['jensen:getDeviceInfo'](makeEvent())
    const card = mockHandlers['jensen:getCardInfo'](makeEvent())
    const settings = mockHandlers['jensen:getSettings'](makeEvent())
    await Promise.resolve(); await Promise.resolve()
    expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
    expect(mockJensen.getCardInfo).not.toHaveBeenCalled()
    expect(mockJensen.getSettings).not.toHaveBeenCalled()
    release(); await owner; await Promise.all([info, card, settings])
    expect(mockJensen.getDeviceInfo).toHaveBeenCalledOnce()
    expect(mockJensen.getCardInfo).toHaveBeenCalledOnce()
    expect(mockJensen.getSettings).toHaveBeenCalledOnce()
    expect(mockJensen.getDeviceInfo.mock.invocationCallOrder[0]).toBeLessThan(mockJensen.getCardInfo.mock.invocationCallOrder[0])
    expect(mockJensen.getCardInfo.mock.invocationCallOrder[0]).toBeLessThan(mockJensen.getSettings.mock.invocationCallOrder[0])
  })

  it('jensen:listFiles returns null when jensen throws', async () => {
    mockJensen.isConnected.mockReturnValue(true)
    mockJensen.listFiles.mockRejectedValue(new Error('USB error'))
    const result = await mockHandlers['jensen:listFiles'](makeEvent())
    expect(result).toBeNull()
  })

  it('jensen:deleteFile returns null when jensen throws', async () => {
    mockJensen.deleteFile.mockRejectedValue(new Error('USB error'))
    const result = await mockHandlers['jensen:deleteFile'](makeEvent(), { filename: 'file.hda' })
    expect(result).toBeNull()
  })

  // -------------------------------------------------------------------------
  // setTime uses main process time (no args required)
  // -------------------------------------------------------------------------

  it('jensen:setTime calls jensen.setTime() with a Date (main process time)', async () => {
    mockJensen.setTime.mockResolvedValue({ result: 'success' })
    await mockHandlers['jensen:setTime'](makeEvent())
    expect(mockJensen.setTime).toHaveBeenCalledTimes(1)
    const passedDate = mockJensen.setTime.mock.calls[0][0]
    expect(passedDate).toBeInstanceOf(Date)
  })

  // -------------------------------------------------------------------------
  // Connection-state broadcasts (consumed by the renderer JensenIpcClient)
  // -------------------------------------------------------------------------

  describe('connection-state push events', () => {
    it('wires device.onconnect / device.ondisconnect on registration', () => {
      expect(typeof mockJensen.onconnect).toBe('function')
      expect(typeof mockJensen.ondisconnect).toBe('function')
    })

    it('device connect fires jensen:connect-event + jensen:state-changed', () => {
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.onconnect()
      const channels = broadcastSendCalls.map(([c]) => c)
      expect(channels).toContain('jensen:connect-event')
      const state = broadcastSendCalls.find(([c]) => c === 'jensen:state-changed')
      expect(state?.[1]).toMatchObject({ connected: true })
    })

    it('device disconnect fires jensen:disconnect-event + jensen:state-changed', () => {
      mockJensen.isConnected.mockReturnValue(false)
      mockJensen.ondisconnect()
      const channels = broadcastSendCalls.map(([c]) => c)
      expect(channels).toContain('jensen:disconnect-event')
      const state = broadcastSendCalls.find(([c]) => c === 'jensen:state-changed')
      expect(state?.[1]).toMatchObject({ connected: false })
    })

    it('jensen:connect handler broadcasts state afterwards', async () => {
      mockJensen.connect.mockResolvedValue(true)
      mockJensen.isConnected.mockReturnValue(true)
      await mockHandlers['jensen:connect'](makeEvent())
      const channels = broadcastSendCalls.map(([c]) => c)
      expect(channels).toContain('jensen:state-changed')
    })

    it('jensen:getDeviceInfo publishes the qualified identity from inside the serialized read, once', async () => {
      const { serializeDeviceOperation } = await import('../../services/device-operation-serializer')
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.getModel.mockReturnValue('hidock-h1e')
      mockJensen.versionNumber = null
      mockJensen.versionCode = null
      mockJensen.onconnect()
      const states = () => broadcastSendCalls.filter(([c]) => c === 'jensen:state-changed').map(([, p]) => p)
      expect(states()).toEqual([expect.objectContaining({ connected: true, versionNumber: null, versionCode: null })])
      mockJensen.getDeviceInfo.mockImplementation(async () => {
        mockJensen.versionNumber = 393988
        mockJensen.versionCode = '6.3.4'
        return { versionCode: '6.3.4', versionNumber: 393988, sn: 'SN123' }
      })
      let release!: () => void
      const barrier = new Promise<void>(resolve => { release = resolve })
      const owner = serializeDeviceOperation(() => barrier)
      const info = mockHandlers['jensen:getDeviceInfo'](makeEvent())
      await Promise.resolve(); await Promise.resolve()
      expect(mockJensen.getDeviceInfo).not.toHaveBeenCalled()
      expect(states()).toHaveLength(1)
      release(); await owner
      expect(await info).toMatchObject({ versionNumber: 393988 })
      expect(states().at(-1)).toMatchObject({ connected: true, model: 'hidock-h1e', versionCode: '6.3.4', versionNumber: 393988 })
      const published = states().length
      await mockHandlers['jensen:getDeviceInfo'](makeEvent())
      expect(states()).toHaveLength(published)
    })

    it('jensen:disconnect handler broadcasts state even though it returns null', async () => {
      await mockHandlers['jensen:disconnect'](makeEvent())
      const channels = broadcastSendCalls.map(([c]) => c)
      expect(channels).toContain('jensen:state-changed')
    })

    it('jensen:getState includes the active recording for fresh renderers (reload mid-record seed)', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      mockJensen.getRecordingFile.mockResolvedValue({ recording: '2026Jul22-120145-Rec26.hda' })
      await mockHandlers['jensen:listFiles'](makeEvent())
      await vi.advanceTimersByTimeAsync(2000) // kickoff poll reads the active recording

      const state = await mockHandlers['jensen:getState'](makeEvent())
      expect(state).toMatchObject({ connected: true, recording: '2026Jul22-120145-Rec26.hda' })
    })

    it('jensen:getState reports recording: null when the device is idle', async () => {
      const state = await mockHandlers['jensen:getState'](makeEvent())
      expect(state).toMatchObject({ recording: null })
    })
  })

  // -------------------------------------------------------------------------
  // Live-recording poll discipline (regression: the CMD 18 poll that desynced
  // the protocol). The poll must NOT run during the connect handshake, must
  // skip while the bus is busy, and must back off after a timed-out read.
  // -------------------------------------------------------------------------

  describe('live-recording poll discipline', () => {
    it('does NOT start the poll on connect — only after the first file-list scan', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)

      // Device connects → handshake. The poll must stay dormant here (this window
      // is exactly where a CMD 18 poll desynced the command/response pairing).
      mockJensen.onconnect()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockJensen.getRecordingFile).not.toHaveBeenCalled()

      // First file-list scan completes → poll is now allowed to start.
      mockJensen.listFiles.mockResolvedValue([])
      await mockHandlers['jensen:listFiles'](makeEvent())
      await vi.advanceTimersByTimeAsync(2000) // past the ~1.5s kickoff
      expect(mockJensen.getRecordingFile).toHaveBeenCalled()
    })

    it('skips the poll while the device is busy (mid-init / mid-scan)', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      await mockHandlers['jensen:listFiles'](makeEvent())

      // Busy → the kickoff and interval ticks must not issue getRecordingFile.
      mockJensen.isOperationInProgress.mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(25_000)
      expect(mockJensen.getRecordingFile).not.toHaveBeenCalled()

      // Bus free → the next tick polls.
      mockJensen.isOperationInProgress.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mockJensen.getRecordingFile).toHaveBeenCalled()
    })

    it('skips the poll while a download is in flight', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      await mockHandlers['jensen:listFiles'](makeEvent())

      // Start a download that stays pending → currentDownloadAbort is set.
      let releaseDownload: (() => void) | undefined
      mockJensen.downloadFile.mockImplementation(
        () => new Promise<boolean>((resolve) => { releaseDownload = () => resolve(false) })
      )
      const dl = mockHandlers['jensen:downloadFile'](makeEvent(), { filename: 'a.hda', fileSize: 1000 })
      await Promise.resolve() // let the handler set currentDownloadAbort

      await vi.advanceTimersByTimeAsync(25_000)
      expect(mockJensen.getRecordingFile).not.toHaveBeenCalled()

      releaseDownload?.()
      await dl
    })

    it('emits jensen:recording-changed when the active recording changes', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      mockJensen.getRecordingFile.mockResolvedValue({ recording: '2025May13-160405-Rec59.hda' })

      await mockHandlers['jensen:listFiles'](makeEvent())
      await vi.advanceTimersByTimeAsync(2000)

      const changed = broadcastSendCalls.find(([c]) => c === 'jensen:recording-changed')
      expect(changed?.[1]).toEqual({ recording: '2025May13-160405-Rec59.hda' })
    })

    it('backs off to 60s after a timed-out read, then polls again at the longer interval', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      mockJensen.getRecordingFile.mockResolvedValue(null) // simulate timeout

      await mockHandlers['jensen:listFiles'](makeEvent())
      await vi.advanceTimersByTimeAsync(2000) // kickoff fires → null → back off to 60s
      expect(mockJensen.getRecordingFile).toHaveBeenCalledTimes(1)

      // At the OLD 20s cadence a second poll would already have fired — it must not.
      await vi.advanceTimersByTimeAsync(25_000)
      expect(mockJensen.getRecordingFile).toHaveBeenCalledTimes(1)

      // The backed-off 60s interval fires the next poll.
      await vi.advanceTimersByTimeAsync(40_000)
      expect(mockJensen.getRecordingFile).toHaveBeenCalledTimes(2)
    })

    it('awaited shutdown stops polling and a late poll cannot rearm it', async () => {
      vi.useFakeTimers()
      mockJensen.isConnected.mockReturnValue(true)
      mockJensen.listFiles.mockResolvedValue([])
      let finishRead!: (value: null) => void
      mockJensen.getRecordingFile.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
      await mockHandlers['jensen:listFiles'](makeEvent())
      await vi.advanceTimersByTimeAsync(2000)
      expect(mockJensen.getRecordingFile).toHaveBeenCalledTimes(1)
      await shutdownJensenResources()
      finishRead(null) // Would normally schedule timeout backoff after the timer was stopped.
      await vi.advanceTimersByTimeAsync(180000)
      await mockHandlers['jensen:listFiles'](makeEvent()) // A late completed scan must not start polling.
      await vi.advanceTimersByTimeAsync(180000)
      expect(mockJensen.getRecordingFile).toHaveBeenCalledTimes(1)
    })
  })
})
