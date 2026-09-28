/**
 * Download orchestrator x owner pause (DownloadService.state.isPaused).
 *
 * Pausing stops the loop BEFORE the next dequeue: the in-flight item finishes,
 * the rest stay pending (never mark-failed, renderer queue mirror not cleared),
 * and the loop reports "Downloads paused". While paused nothing starts, neither
 * from a drain nor from the state-update auto-start; the state-update echo
 * mirrors the flag into the store.
 *
 * Drives the REAL hook (renderHook) with a mocked device service + electronAPI,
 * same harness shape as useDownloadOrchestrator-feature-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type MainItem = {
  id: string
  filename: string
  fileSize: number
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  recordingDate?: string
}

const harness = vi.hoisted(() => {
  const appState: Record<string, unknown> = {}
  return {
    appState,
    useAppStoreMock: Object.assign((selector: (s: unknown) => unknown) => selector(appState), {
      getState: () => appState,
    }),
    deviceService: {
      isConnected: vi.fn(() => true),
      log: vi.fn(),
      downloadRecording: vi.fn(
        async (_filename: string, _size?: unknown, _onChunk?: unknown, _signal?: unknown) => true
      ),
      cancelAllDownloads: vi.fn(),
      onStatusChange: vi.fn(),
    },
    toast: vi.fn(),
  }
})

vi.mock('@/services/hidock-device', () => ({
  getHiDockDeviceService: () => harness.deviceService,
}))
vi.mock('@/store/useAppStore', () => ({ useAppStore: harness.useAppStoreMock }))
vi.mock('@/components/ui/toaster', () => ({ toast: harness.toast }))
vi.mock('@/features/library/utils/errorHandling', () => ({
  parseError: (e: unknown) => ({ type: 'unknown', message: e instanceof Error ? e.message : String(e) }),
  getErrorMessage: () => 'error',
}))
vi.mock('@/services/qa-monitor', () => ({ shouldLogQa: () => false }))

import {
  useDownloadOrchestrator,
  drainDownloadQueue,
  cancelDownloadsComplete,
  clearAllDownloadBookkeeping,
} from '../useDownloadOrchestrator'
import { useFeatureStore } from '@/store/useFeatureStore'

let mainQueue: MainItem[]
let paused: boolean
let stateUpdateCb: ((state: { queue: MainItem[]; isPaused?: boolean }) => void) | null

const downloadService = {
  getState: vi.fn(async () => ({ queue: mainQueue.map((i) => ({ ...i })), isPaused: paused })),
  markFailed: vi.fn(async () => {}),
  processDownload: vi.fn(async (filename: string) => {
    const item = mainQueue.find((i) => i.filename === filename)
    if (item) item.status = 'completed'
    return { success: true }
  }),
  updateProgress: vi.fn(),
  retryFailed: vi.fn(),
  cancelAll: vi.fn(),
  notifyCompletion: vi.fn(),
  onStateUpdate: vi.fn((cb: (state: { queue: MainItem[]; isPaused?: boolean }) => void) => {
    stateUpdateCb = cb
    return () => {}
  }),
}

const ITEM_A: MainItem = { id: 'a', filename: 'A.hda', fileSize: 100, status: 'pending', recordingDate: '2026-07-14T10:00:00Z' }
const ITEM_B: MainItem = { id: 'b', filename: 'B.hda', fileSize: 100, status: 'pending', recordingDate: '2026-07-13T10:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  clearAllDownloadBookkeeping()
  cancelDownloadsComplete()
  mainQueue = [{ ...ITEM_A }, { ...ITEM_B }]
  paused = false
  stateUpdateCb = null
  useFeatureStore.getState().setFromConfig(undefined)
  useFeatureStore.getState().setPendingRestart([])

  Object.assign(harness.appState, {
    connectionStatus: { step: 'ready' },
    deviceSyncing: true,
    downloadQueue: new Map(),
    setDeviceSyncState: vi.fn(),
    clearDeviceSyncState: vi.fn(),
    addToDownloadQueue: vi.fn(),
    updateDownloadProgress: vi.fn(),
    removeFromDownloadQueue: vi.fn(),
    clearDownloadQueue: vi.fn(),
    cancelDeviceSync: vi.fn(),
    syncDownloadQueue: vi.fn(),
    setDownloadsPaused: vi.fn(),
  })

  harness.deviceService.isConnected.mockReturnValue(true)
  harness.deviceService.downloadRecording.mockImplementation(async () => true)
  harness.deviceService.onStatusChange.mockImplementation(() => () => {})

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    downloadService,
    config: {
      get: vi.fn(async () => ({ success: true, data: { device: { autoDownload: true } } })),
    },
  }
})

const clearSync = () => harness.appState.clearDeviceSyncState as ReturnType<typeof vi.fn>
const clearQueue = () => harness.appState.clearDownloadQueue as ReturnType<typeof vi.fn>

describe('owner pause', () => {
  it('pause mid-queue: in-flight finishes, the rest stay pending and visible, no mark-failed', async () => {
    // The owner pauses while A (newest, dequeued first) is on the USB bus.
    harness.deviceService.downloadRecording.mockImplementation(async (filename: string) => {
      if (filename === 'A.hda') paused = true
      return true
    })

    renderHook(() => useDownloadOrchestrator())
    drainDownloadQueue()
    await waitFor(() => expect(clearSync()).toHaveBeenCalled())

    expect(harness.deviceService.downloadRecording).toHaveBeenCalledTimes(1)
    expect(mainQueue.find((i) => i.filename === 'A.hda')?.status).toBe('completed')
    expect(mainQueue.find((i) => i.filename === 'B.hda')?.status).toBe('pending')
    expect(downloadService.markFailed).not.toHaveBeenCalled()
    // Not a cancel: the renderer mirror keeps B visible as queued.
    expect(clearQueue()).not.toHaveBeenCalled()
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Downloads paused' }))
    expect(harness.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Sync cancelled' }))
  })

  it('while paused a drain starts nothing', async () => {
    paused = true
    renderHook(() => useDownloadOrchestrator())

    drainDownloadQueue()
    await waitFor(() => expect(downloadService.getState).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.deviceService.downloadRecording).not.toHaveBeenCalled()
    expect(harness.appState.setDeviceSyncState).not.toHaveBeenCalled()
  })

  it('the state-update echo mirrors the flag and a paused echo does not auto-start', async () => {
    paused = true
    renderHook(() => useDownloadOrchestrator())
    expect(stateUpdateCb).toBeTypeOf('function')

    stateUpdateCb!({ queue: mainQueue.map((i) => ({ ...i })), isPaused: true })

    expect(harness.appState.setDownloadsPaused).toHaveBeenCalledWith(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(downloadService.getState).not.toHaveBeenCalled()
    expect(harness.deviceService.downloadRecording).not.toHaveBeenCalled()
  })

  it('resume: an unpaused echo with pending items restarts the drain', async () => {
    renderHook(() => useDownloadOrchestrator())

    stateUpdateCb!({ queue: mainQueue.map((i) => ({ ...i })), isPaused: false })

    expect(harness.appState.setDownloadsPaused).toHaveBeenCalledWith(false)
    await waitFor(() => expect(harness.deviceService.downloadRecording).toHaveBeenCalledTimes(2))
    expect(mainQueue.every((i) => i.status === 'completed')).toBe(true)
  })
})
