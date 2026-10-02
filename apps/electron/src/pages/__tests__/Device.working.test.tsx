import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Device } from '../Device'
import { useAppStore } from '@/store/useAppStore'
import type { HiDockDeviceState } from '@/services/hidock-device'

// Loading and working states on the Device page look like work, never a sentence (owner, 2-oct-2026).

const { deviceService, unifiedRecordings } = vi.hoisted(() => ({
  deviceService: {
    getAutoConnectConfig: vi.fn(() => ({ enabled: false, intervalMs: 5000, connectOnStartup: false })),
    setAutoConnectConfig: vi.fn(),
    isConnected: vi.fn(() => false),
    isP1Device: vi.fn(() => false),
    // Never settles: the battery stays "still coming" for the whole test.
    getBatteryStatus: vi.fn(() => new Promise(() => undefined)),
    onConnectionChange: vi.fn(() => () => undefined),
    onDownloadProgress: vi.fn(() => () => undefined),
    stopAutoConnect: vi.fn(),
    disconnect: vi.fn(),
    resetDevice: vi.fn(),
    clearActivityLog: vi.fn()
  },
  unifiedRecordings: vi.fn(() => ({ recordings: [] as unknown[], loading: false, refresh: vi.fn() }))
}))

vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: () => deviceService
}))

vi.mock('@/hooks/useDeviceConnection', () => ({
  useDeviceConnection: () => ({ connect: vi.fn(), disconnect: vi.fn() })
}))

vi.mock('@/hooks/useUnifiedRecordings', () => ({
  useUnifiedRecordings: () => unifiedRecordings()
}))

vi.mock('@/hooks/useOperations', () => ({
  useOperations: () => ({ cancelAllDownloads: vi.fn() })
}))

vi.mock('@/hooks/useDownloadOrchestrator', () => ({
  requestScopedDownloads: vi.fn()
}))

// The file list is its own component with its own tests; the page only needs it out of the way.
vi.mock('@/components/DeviceFileList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/DeviceFileList')>()
  return { ...actual, DeviceFileList: () => null }
})

const connectedDevice: HiDockDeviceState = {
  connected: true,
  model: 'hidock-h1e' as HiDockDeviceState['model'],
  serialNumber: 'SN123',
  firmwareVersion: '6.2.5',
  storage: { used: 1_000_000, capacity: 32_000_000_000, freePercent: 99 },
  settings: null,
  recordingCount: 3
}

const initialStore = useAppStore.getState()

function setStore(partial: Partial<ReturnType<typeof useAppStore.getState>>) {
  useAppStore.setState(partial)
}

function spinnerIn(el: HTMLElement) {
  return el.querySelector('svg[class*="animate-spin"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  unifiedRecordings.mockImplementation(() => ({ recordings: [], loading: false, refresh: vi.fn() }))
  deviceService.isConnected.mockReturnValue(false)
  deviceService.isP1Device.mockReturnValue(false)
  global.window.electronAPI = {
    syncedFiles: { getFilenames: vi.fn().mockResolvedValue([]) },
    downloadService: {
      getPurgedFilenames: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ queue: [] }),
      onStateUpdate: vi.fn(() => () => undefined)
    },
    config: { get: vi.fn().mockResolvedValue({ success: true, data: {} }) }
  } as any
})

afterEach(() => {
  useAppStore.setState(initialStore, true)
})

describe('Device page, loading and working states', () => {
  it('shows the connection step as a spinner and a bar while connecting, with no sentence on screen', () => {
    setStore({
      deviceState: { ...initialStore.deviceState, connected: false },
      connectionStatus: { step: 'requesting', message: 'Requesting device access' }
    })

    render(<Device />)

    const status = screen.getByRole('status', { name: 'Requesting device access' })
    expect(spinnerIn(status)).not.toBeNull()
    expect(screen.queryByText(/Make sure your HiDock is connected via USB/)).toBeNull()
    expect(screen.queryByText(/Requesting device access/)).toBeNull()
    // The cancel control is still there.
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
  })

  it('shows the storage tile as a working value while storage has not arrived', () => {
    setStore({ deviceState: { ...connectedDevice, storage: null } })

    render(<Device />)

    expect(screen.getByRole('status', { name: 'Loading storage' })).toBeInTheDocument()
    expect(screen.queryByText(/Loading\.\.\./)).toBeNull()
    expect(screen.getByRole('button', { name: /Reset if stuck/ })).toBeInTheDocument()
  })

  it('shows the battery level as a working value while a P1 battery has not been read', () => {
    deviceService.isConnected.mockReturnValue(true)
    deviceService.isP1Device.mockReturnValue(true)
    setStore({ deviceState: { ...connectedDevice, model: 'hidock-p1' as HiDockDeviceState['model'] } })

    render(<Device />)

    expect(screen.getByText('Battery Status')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Reading the battery' })).toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).toBeNull()
    expect(deviceService.getBatteryStatus).toHaveBeenCalled()
  })

  it('marks the firmware line with a syncing spinner and keeps the firmware text', () => {
    setStore({ deviceState: connectedDevice, deviceSyncing: true })

    render(<Device />)

    const syncing = screen.getByRole('status', { name: 'Syncing' })
    expect(syncing).toHaveAttribute('title', 'Syncing')
    expect(spinnerIn(syncing)).not.toBeNull()
    expect(screen.getByText(/Firmware 6\.2\.5/)).toBeInTheDocument()
    expect(screen.queryByText(/Syncing\.\.\./)).toBeNull()
  })

  it('keeps the Sync Recordings label on a busy button while the file list loads', () => {
    unifiedRecordings.mockImplementation(() => ({ recordings: [], loading: true, refresh: vi.fn() }))
    setStore({ deviceState: connectedDevice, deviceSyncing: false })

    render(<Device />)

    const button = screen.getByRole('button', { name: 'Sync Recordings' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Loading file list')
    expect(button).toBeDisabled()
    expect(spinnerIn(button)).not.toBeNull()
    expect(within(button).queryByText(/Loading/)).toBeNull()
    expect(screen.queryByText(/Loading file list/)).toBeNull()
  })
})
