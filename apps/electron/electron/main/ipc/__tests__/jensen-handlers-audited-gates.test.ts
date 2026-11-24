// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

const liveDir = vi.hoisted(() => ({ path: '' }))
const storageSource = vi.hoisted(() => vi.fn())
const mockHandlers: Record<string, (event: any, ...args: any[]) => any> = {}

const mockStreamService = vi.hoisted(() => ({
  beginDownload: vi.fn(() => true), updateProgress: vi.fn(),
  processDownload: vi.fn(async () => ({ success: true })), noteTransferStall: vi.fn()
}))
vi.mock('../../services/download-service', () => ({ getDownloadService: () => mockStreamService }))
vi.mock('../../services/recording-deletion-service', () => ({
  retryPendingFileCleanups: vi.fn().mockResolvedValue({ attempted: 0, cleared: 0, stillPending: {} })
}))
vi.mock('../../services/device-storage', () => ({
  DeviceStorage: class { source = storageSource; adapter = vi.fn(); catalog = vi.fn(); list = vi.fn(); page = vi.fn(); read = vi.fn(); range = vi.fn() }
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'test-path', getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: (channel: string, fn: (event: any, ...args: any[]) => any) => { mockHandlers[channel] = fn } },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => null },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: () => { throw Error('No OS crypto in IPC unit test') }, decryptString: () => { throw Error('No OS crypto in IPC unit test') } },
}))
vi.mock('usb', () => ({ WebUSB: function WebUSBMock() { return { getDevices: vi.fn().mockResolvedValue([]), requestDevice: vi.fn().mockRejectedValue(new Error('no device')), addEventListener: vi.fn(), removeEventListener: vi.fn() } } }))

const mockJensen: any = {
  isConnected: vi.fn(), isOperationInProgress: vi.fn(), getModel: vi.fn(), downloadFile: vi.fn(),
  getActiveDownloadSettlement: vi.fn().mockResolvedValue(undefined), abortInFlight: vi.fn(),
  getCustomRecordingProfile: vi.fn().mockResolvedValue({ profile: 2 }),
  setCustomRecordingProfile: vi.fn().mockResolvedValue({ result: 'success' }),
  getCustomRecordingFormat: vi.fn().mockResolvedValue({ format: 'mp3' }),
  setCustomRecordingFormat: vi.fn().mockResolvedValue({ result: 'success' }),
  getCustomMarkerRules: vi.fn().mockResolvedValue({ enabled: false }),
  setCustomMarkerRules: vi.fn().mockResolvedValue({ result: 'success' }),
  serialNumber: 'SN123', versionCode: '', versionNumber: 0,
  onconnect: undefined, ondisconnect: undefined, setupUsbConnectListener: vi.fn(),
}
vi.mock('../../services/jensen', () => ({
  getJensenDevice: () => mockJensen, setFirmwareRecoveryChecker: vi.fn(), setDeviceValidationChecker: vi.fn(),
}))
vi.mock('../../services/gemini-live-transcription', () => ({
  geminiLiveTranscription: { start: vi.fn(), pause: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), acceptDevicePacket: vi.fn() },
}))
vi.mock('../../services/file-storage', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/file-storage')>()), getRecordingsPath: () => liveDir.path,
}))
vi.mock('../../services/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/config')>()), getConfig: () => ({ transcription: {} }),
}))

import { registerJensenHandlers } from '../jensen-handlers'

const CUSTOM: ReadonlyArray<readonly [number, string]> = [[393985, '6.3.1'], [393986, '6.3.2'], [393988, '6.3.4']]
const STOCK: ReadonlyArray<readonly [number, string]> = [[393984, '6.3.0'], [393987, '6.3.3']]
const DENIED: ReadonlyArray<readonly [number, string]> = [[393989, '6.3.5'], [393988, '6.3.3'], [393986, '6.3.4'], [393984, '6.3.1']]

const makeEvent = () => ({ sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() }) })
const setDevice = (model: string, number: number, code: string) => {
  mockJensen.getModel.mockReturnValue(model)
  mockJensen.versionNumber = number
  mockJensen.versionCode = code
}
const profile = { profile: 2, gainLeftQ15: 32768, gainRightQ15: 32768 }
const rules = { enabled: false, lane: 2, meanMagnitudeThreshold: 1000 }
const invokeAllCustomControls = async () => {
  await mockHandlers['jensen:getCustomRecordingProfile'](makeEvent())
  await mockHandlers['jensen:setCustomRecordingProfile'](makeEvent(), profile)
  await mockHandlers['jensen:getCustomRecordingFormat'](makeEvent())
  await mockHandlers['jensen:setCustomRecordingFormat'](makeEvent(), 'wav')
  await mockHandlers['jensen:getCustomMarkerRules'](makeEvent())
  await mockHandlers['jensen:setCustomMarkerRules'](makeEvent(), rules)
}
const customControlCalls = () => [
  mockJensen.getCustomRecordingProfile, mockJensen.setCustomRecordingProfile, mockJensen.getCustomRecordingFormat,
  mockJensen.setCustomRecordingFormat, mockJensen.getCustomMarkerRules, mockJensen.setCustomMarkerRules
].map(fn => fn.mock.calls.length)

beforeEach(() => {
  vi.clearAllMocks()
  liveDir.path = mkdtempSync(join(tmpdir(), 'jensen-audited-'))
  mockJensen.isConnected.mockReturnValue(true)
  mockJensen.isOperationInProgress.mockReturnValue(false)
  mockJensen.downloadFile.mockResolvedValue(false)
  storageSource.mockRejectedValue(new Error('storage reached'))
  Object.keys(mockHandlers).forEach(key => delete mockHandlers[key])
  registerJensenHandlers()
})

afterEach(() => { rmSync(liveDir.path, { recursive: true, force: true }) })

describe('main-process custom recording control gate', () => {
  it.each(CUSTOM)('dispatches all six profile, format and marker-rule calls on %s/%s', async (number, code) => {
    setDevice('hidock-h1e', number, code)
    await invokeAllCustomControls()
    expect(customControlCalls()).toEqual([1, 1, 1, 1, 1, 1])
  })

  it.each([...STOCK, ...DENIED])('denies every custom control call on %s/%s before any device call', async (number, code) => {
    setDevice('hidock-h1e', number, code)
    await invokeAllCustomControls()
    expect(customControlCalls()).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('denies the candidate pair on another model', async () => {
    setDevice('hidock-p1', 393988, '6.3.4')
    await invokeAllCustomControls()
    expect(customControlCalls()).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('keeps the idle check on the candidate pair', async () => {
    setDevice('hidock-h1e', 393988, '6.3.4')
    mockJensen.isOperationInProgress.mockReturnValue(true)
    await invokeAllCustomControls()
    expect(customControlCalls()).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('main-process native recording capability and library route', () => {
  it.each([...CUSTOM, ...STOCK])('reports marker insertion and takes the resumable route on %s/%s', async (number, code) => {
    setDevice('hidock-h1e', number, code)
    const capabilities = await mockHandlers['jensen:getRecordingCapabilities'](makeEvent())
    expect(capabilities.native.markerInsertion).toBe(true)
    expect(capabilities.native.profileControl).toBe(false)
    const result = await mockHandlers['jensen:downloadToLibrary'](makeEvent(), { filename: 'REC.hda', fileSize: 4 })
    expect(storageSource).toHaveBeenCalledWith('REC.hda')
    expect(mockJensen.downloadFile).not.toHaveBeenCalled()
    expect(result).toEqual({ success: false, error: 'Resumable download interrupted' })
  })

  it.each(DENIED)('denies marker insertion and the resumable route on %s/%s', async (number, code) => {
    setDevice('hidock-h1e', number, code)
    const capabilities = await mockHandlers['jensen:getRecordingCapabilities'](makeEvent())
    expect(capabilities.native.markerInsertion).toBe(false)
    await mockHandlers['jensen:downloadToLibrary'](makeEvent(), { filename: 'REC.hda', fileSize: 4 })
    expect(storageSource).not.toHaveBeenCalled()
  })

  it('denies marker insertion and the resumable route on another model with the candidate pair', async () => {
    setDevice('hidock-p1', 393988, '6.3.4')
    expect((await mockHandlers['jensen:getRecordingCapabilities'](makeEvent())).native.markerInsertion).toBe(false)
    await mockHandlers['jensen:downloadToLibrary'](makeEvent(), { filename: 'REC.hda', fileSize: 4 })
    expect(storageSource).not.toHaveBeenCalled()
  })
})
