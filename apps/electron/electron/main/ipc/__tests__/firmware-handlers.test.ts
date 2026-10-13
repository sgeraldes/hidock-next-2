// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, (event: any, ...args: any[]) => any> = {}
const state = vi.hoisted(() => ({
  qualification: true,
  liveRecording: false,
  moving: false,
  activeTransfer: null as string | null,
  fromWindow: true,
  pending: [] as unknown[],
  recoveryChecker: null as null | (() => boolean),
}))
const service = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ state: 'prepared' })),
  status: vi.fn(() => []),
  execute: vi.fn(async () => ({ state: 'awaiting-boot' })),
  observe: vi.fn(async () => ({ state: 'confirmed' })),
}))
const deps = vi.hoisted(() => ({ last: null as any }))
const device = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getModel: vi.fn(() => 'hidock-h1e'),
  isOperationInProgress: vi.fn(() => false),
  getFirmwareUpdatePreflight: vi.fn(async () => ({ model: 'hidock-h1e', versionNumber: 393984, serialNumber: 'SECRET-SERIAL', activeRecording: false, card: { capacityMiB: 1, freeMiB: 1, statusCode: 0x900 } })),
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => 'C:\\app', getPath: () => 'C:\\profile', isPackaged: false },
  ipcMain: { handle: (channel: string, fn: any) => { handlers[channel] = fn } },
  BrowserWindow: { fromWebContents: () => (state.fromWindow ? {} : null) },
}))
vi.mock('../../services/jensen', () => ({
  getJensenDevice: () => device,
  setFirmwareRecoveryChecker: (fn: () => boolean) => { state.recoveryChecker = fn },
}))
vi.mock('../../services/device-operation-serializer', () => ({ serializeDeviceOperation: (fn: () => Promise<unknown>) => fn() }))
vi.mock('../../services/download-transfer-controller', () => ({ getActiveTransferFilename: () => state.activeTransfer }))
vi.mock('../../services/storage-move-state', () => ({
  liveRecordingInProgress: () => state.liveRecording,
  storageMoveInProgress: () => state.moving,
}))
vi.mock('../../recovery-mode', () => ({ isFirmwareQualificationLaunch: () => state.qualification }))
vi.mock('../../services/firmware-install-journal', () => ({
  FirmwareInstallJournal: class { pending() { return state.pending } },
}))
vi.mock('../../services/firmware-install', () => ({
  FirmwareInstallService: class {
    constructor(d: any) { deps.last = d }
    prepare = service.prepare; status = service.status; execute = service.execute; observe = service.observe
  },
}))

import { registerFirmwareHandlers } from '../firmware-handlers'

const trusted = (url = 'http://localhost:5173/') => {
  const mainFrame = { url }
  return { sender: { isDestroyed: () => false, mainFrame }, senderFrame: mainFrame }
}
const CHANNELS = ['jensen:getFirmwareUpdatePreflight', 'jensen:prepareFirmwareInstall', 'jensen:getFirmwareInstallAttempts',
  'jensen:executeFirmwareInstall', 'jensen:observeFirmwareInstall']

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(state, { qualification: true, liveRecording: false, moving: false, activeTransfer: null, fromWindow: true, pending: [] })
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  for (const key of Object.keys(handlers)) delete handlers[key]
  registerFirmwareHandlers()
})

describe('firmware IPC', () => {
  it('registers exactly the five firmware channels', () => {
    expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort())
  })
  it('turns qualification on only for a qualification launch, with no stock target', () => {
    expect(deps.last.qualificationEnabled).toBe(true)
    state.qualification = false
    registerFirmwareHandlers()
    expect(deps.last.qualificationEnabled).toBe(false)
    expect(deps.last.forwardStockArtifactPath).toBeUndefined()
    expect(deps.last.stockRecoveryEnabled).toBeUndefined()
  })
  it.each(CHANNELS)('%s refuses a sender that is not the main frame of the app window', async channel => {
    const other = { isDestroyed: () => false, mainFrame: { url: 'http://localhost:5173/' } }
    const subframe = { sender: other, senderFrame: { url: 'http://localhost:5173/' } }
    expect(() => handlers[channel](subframe, 'a', 'b')).toThrow('trusted application window')
    expect(() => handlers[channel](trusted('https://example.com/'), 'a', 'b')).toThrow('trusted application window')
    state.fromWindow = false
    expect(() => handlers[channel](trusted(), 'a', 'b')).toThrow('trusted application window')
    expect(service.prepare).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
    expect(service.observe).not.toHaveBeenCalled()
    expect(device.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
  })
  it('passes a trusted sender to the install service and validates its arguments', async () => {
    await handlers['jensen:prepareFirmwareInstall'](trusted())
    expect(service.prepare).toHaveBeenCalledWith('hardened')
    expect(() => handlers['jensen:prepareFirmwareInstall'](trusted(), 'stock-forward')).toThrow('Unknown firmware target')
    expect(() => handlers['jensen:executeFirmwareInstall'](trusted(), 5, 'x')).toThrow('digest required')
    expect(() => handlers['jensen:observeFirmwareInstall'](trusted(), 5)).toThrow('attempt required')
    await handlers['jensen:executeFirmwareInstall'](trusted(), 'id', 'sha')
    await handlers['jensen:observeFirmwareInstall'](trusted(), 'id')
    await handlers['jensen:getFirmwareInstallAttempts'](trusted())
    expect(service.execute).toHaveBeenCalledWith('id', 'sha')
    expect(service.observe).toHaveBeenCalledWith('id')
    expect(service.status).toHaveBeenCalledTimes(1)
  })
  it('the preflight answers without the serial number, and only when the owner is idle', async () => {
    expect(await handlers['jensen:getFirmwareUpdatePreflight'](trusted())).toEqual({
      model: 'hidock-h1e', versionNumber: 393984, activeRecording: false, card: { capacityMiB: 1, freeMiB: 1, statusCode: 0x900 } })
    device.getFirmwareUpdatePreflight.mockClear()
    for (const busy of [() => { state.liveRecording = true }, () => { state.moving = true }, () => { state.activeTransfer = 'a.hda' }]) {
      Object.assign(state, { liveRecording: false, moving: false, activeTransfer: null }); busy()
      expect(await handlers['jensen:getFirmwareUpdatePreflight'](trusted())).toBeNull()
    }
    Object.assign(state, { liveRecording: false, moving: false, activeTransfer: null })
    device.isOperationInProgress.mockReturnValueOnce(true)
    expect(await handlers['jensen:getFirmwareUpdatePreflight'](trusted())).toBeNull()
    expect(device.getFirmwareUpdatePreflight).not.toHaveBeenCalled()
  })
  it('the owner is idle only without live audio, a folder move, a transfer or an open attempt', () => {
    expect(deps.last.idle()).toBe(true)
    state.liveRecording = true; expect(deps.last.idle()).toBe(false); state.liveRecording = false
    state.moving = true; expect(deps.last.idle()).toBe(false); state.moving = false
    state.activeTransfer = 'a.hda'; expect(deps.last.idle()).toBe(false); state.activeTransfer = null
    state.pending = [{}]; expect(deps.last.idle()).toBe(false); state.pending = []
    device.isOperationInProgress.mockReturnValueOnce(true); expect(deps.last.idle()).toBe(false)
  })
  it('reports the storage owner as unresolved while any write owner is active', async () => {
    expect(await deps.last.hasUnresolvedStorageOwnership()).toBe(false)
    state.liveRecording = true; expect(await deps.last.hasUnresolvedStorageOwnership()).toBe(true); state.liveRecording = false
    state.moving = true; expect(await deps.last.hasUnresolvedStorageOwnership()).toBe(true); state.moving = false
    state.activeTransfer = 'a.hda'; expect(await deps.last.hasUnresolvedStorageOwnership()).toBe(true)
  })
  it('keeps the shared owner read-only while an attempt is open or its journal cannot be read', () => {
    expect(state.recoveryChecker!()).toBe(false)
    state.pending = [{}]
    expect(state.recoveryChecker!()).toBe(true)
  })
})
