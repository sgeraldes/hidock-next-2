import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Device } from '../Device'
import { useAppStore } from '@/store/useAppStore'
import type { DeviceAudioDiagnosticsState } from '@/shared/device-audio'
import { JensenIpcClient } from '@/services/jensen-ipc-client'

const deviceService = vi.hoisted(() => ({
  getAutoConnectConfig: vi.fn(() => ({ enabled: false, intervalMs: 5000, connectOnStartup: false })), setAutoConnectConfig: vi.fn(),
  isConnected: vi.fn(() => false), isP1Device: vi.fn(() => false), onConnectionChange: vi.fn(() => () => undefined), onDownloadProgress: vi.fn(() => () => undefined),
  stopAutoConnect: vi.fn(), disconnect: vi.fn(), resetDevice: vi.fn(), clearActivityLog: vi.fn(),
  startRealtime: vi.fn(async () => true), pauseRealtime: vi.fn(async () => true), stopRealtime: vi.fn(async () => true), getRealtimeData: vi.fn(async () => null)
}))
vi.mock('@/services/hidock-device', () => ({ getHiDockDeviceService: () => deviceService }))
vi.mock('@/hooks/useDeviceConnection', () => ({ useDeviceConnection: () => ({ connect: vi.fn(), disconnect: vi.fn() }) }))
vi.mock('@/hooks/useUnifiedRecordings', () => ({ useUnifiedRecordings: () => ({ recordings: [], loading: false, refresh: vi.fn() }) }))
vi.mock('@/hooks/useOperations', () => ({ useOperations: () => ({ cancelAllDownloads: vi.fn() }) }))
vi.mock('@/hooks/useDownloadOrchestrator', () => ({ requestScopedDownloads: vi.fn() }))
vi.mock('@/components/DeviceFileList', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/DeviceFileList')>()
  return { ...actual, DeviceFileList: () => null }
})

const initialStore = useAppStore.getState()
let snapshot: DeviceAudioDiagnosticsState
let listener: ((value: DeviceAudioDiagnosticsState) => void) | undefined
const unsubscribe = vi.fn()
const unsubscribeChannels = vi.fn()
const addMarker = vi.fn()
type ChannelTap = Parameters<Parameters<typeof window.electronAPI.jensen.onRealtimeChannels>[0]>[0]
let channelListener: ((tap: ChannelTap) => void) | undefined
let identity: { connected: boolean; model: string; versionNumber: number; versionCode: string }
const lane = (amplitude: number) => new Uint8Array(new Int16Array([amplitude, -amplitude]).buffer)
const channelTap = (sessionId: string | null, amplitudes: [number, number]): ChannelTap => ({
  sessionId, receivedAtMs: Date.now(), sequenceMinusOne: 0, microphoneMuted: false, frameCount: 2, sampleRateHz: 16000,
  sampleRateEvidence: 'host-expectation', pcmFormat: 'pcm16le-mono', droppedTrailingBytes: 0,
  channels: [{ id: 'channel-0', pcm: lane(amplitudes[0]) }, { id: 'channel-1', pcm: lane(amplitudes[1]) }]
})
beforeEach(() => {
  vi.clearAllMocks(); listener = undefined; channelListener = undefined
  identity = { connected: true, model: 'hidock-h1e', versionNumber: 393986, versionCode: '6.3.2' }
  snapshot = {
    session: { sessionId: null, status: 'idle', transcribe: false, saveRecording: true, recordingError: null, transcriptionError: null }, lastSessionId: null,
    diagnostics: {
      format: { sampleRate: 16000, channels: 2, bitsPerSample: 16, encoding: 'pcm16le', provenance: 'host-expectation', physicalSourceMapping: 'unverified' }, channelIds: ['channel-0', 'channel-1'],
      packets: 8, acceptedPackets: 7, rejectedPackets: 1, rejectedBytes: 2, mutedPackets: 0, frames: 1600, sampleElapsedMs: 100, firstReceivedAtMs: 0, lastReceivedAtMs: 100,
      maximumArrivalGapMs: 30, lastRest: 0, maximumRest: 2, channels: [{ id: 'channel-0', rms: .1, peak: .8, clippedSamples: 2, activeSamples: 100 }, { id: 'channel-1', rms: .2, peak: .4, clippedSamples: 0, activeSamples: 100 }],
      correlation: .25, windowDelay: null, discontinuities: [], discontinuityCount: 1, droppedDiscontinuityDetails: 0, sourceIsolation: 'unverified'
    }
  }
  addMarker.mockResolvedValue({ status: 'accepted-local', marker: { id: 'marker-1', atMs: 100, source: 'manual', persistence: 'local-sidecar', createdAt: '2026-10-11T00:00:00Z' } })
  window.electronAPI = {
    syncedFiles: { getFilenames: vi.fn().mockResolvedValue([]) },
    downloadService: { getPurgedFilenames: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ queue: [] }), onStateUpdate: vi.fn(() => () => undefined) },
    config: { get: vi.fn().mockResolvedValue({ success: true, data: {} }) },
    jensen: {
      getAudioDiagnostics: vi.fn(async () => snapshot), onAudioDiagnostics: vi.fn(callback => { listener = callback; return unsubscribe }),
      getState: vi.fn(async () => identity), onStateChanged: vi.fn(() => () => undefined),
      onRealtimeChannels: vi.fn(callback => { channelListener = callback; return unsubscribeChannels })
    },
    deviceRecordingMarkers: { list: vi.fn(async () => []), getSettings: vi.fn(async () => ({ automationEnabled: false })), add: addMarker }
  } as unknown as typeof window.electronAPI
  useAppStore.setState({ deviceState: { ...initialStore.deviceState, connected: true, model: 'hidock-h1e', firmwareVersion: '6.3.0', serialNumber: 'test', settings: null, storage: null }, connectionStatus: { step: 'idle', message: '' } })
})
afterEach(() => useAppStore.setState(initialStore, true))

describe('Device capture controls', () => {
  it('starts provider-free WAV capture with explicit options and neutral diagnostics', async () => {
    render(<Device />)
    await screen.findByText(/channel-0: RMS 0.1000/)
    expect(screen.getByRole('checkbox', { name: 'Save stereo WAV locally' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Enable live transcription' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(deviceService.startRealtime).toHaveBeenCalledWith({ transcribe: false, saveRecording: true }))
    expect(screen.getByText(/Packets 8 · rejected 1 · discontinuities 1/)).toBeInTheDocument()
    expect(screen.queryByText('Live transcript')).not.toBeInTheDocument()
  })
  it('forwards optional cloud opt-in and local recording selection independently', async () => {
    render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable live transcription' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save stereo WAV locally' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(deviceService.startRealtime).toHaveBeenCalledWith({ transcribe: true, saveRecording: false }))
  })
  it('passes capture selections through the actual IPC facade without changing wire data', async () => {
    const startRealtime = vi.fn(async () => ({ result: 'success' }))
    window.electronAPI.jensen.startRealtime = startRealtime
    const options = { transcribe: false, saveRecording: true }
    await expect(JensenIpcClient.prototype.startRealtime(options)).resolves.toEqual({ result: 'success' })
    expect(startRealtime).toHaveBeenCalledWith(options)
  })
  it('uses the active session ID and owner clock for annotations, and tears down diagnostics', async () => {
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    await act(async () => {
      snapshot = { ...snapshot, session: { ...snapshot.session, status: 'streaming', sessionId: 'session-1' } }
      listener?.(snapshot)
    })
    fireEvent.click(within(await screen.findByRole('region', { name: 'Recording markers' })).getByRole('button', { name: 'Add marker' }))
    await waitFor(() => expect(addMarker).toHaveBeenCalled())
    expect(addMarker.mock.calls[0][0]).toMatchObject({ subject: { kind: 'session', id: 'session-1' }, target: 'local' })
    expect(addMarker.mock.calls[0][0]).not.toHaveProperty('atMs')
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('keeps another window capture read-only and never polls or stops it', async () => {
    snapshot = { ...snapshot, owned: false, session: { ...snapshot.session, status: 'streaming', sessionId: 'other-window' } }
    const { unmount } = render(<Device />)
    await screen.findByText('Another window owns this capture. Diagnostics are read-only.')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: 'Recording markers' })).not.toBeInTheDocument()
    expect(deviceService.getRealtimeData).not.toHaveBeenCalled()
    unmount()
    expect(deviceService.stopRealtime).not.toHaveBeenCalled()
  })
  it('stops a locally started capture exactly once when leaving the page', async () => {
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('button', { name: 'Stop' })
    unmount()
    await waitFor(() => expect(deviceService.stopRealtime).toHaveBeenCalledOnce())
  })
  it('finalizes a pending start after unmount without starting hidden polling', async () => {
    let finish!: (success: boolean) => void
    deviceService.startRealtime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    unmount()
    expect(deviceService.stopRealtime).not.toHaveBeenCalled()
    await act(async () => { finish(true) })
    expect(deviceService.stopRealtime).toHaveBeenCalledOnce()
    expect(deviceService.getRealtimeData).not.toHaveBeenCalled()
  })
  it('defers unmount cleanup until a pending resume finishes, and stops only once', async () => {
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    const resume = await screen.findByRole('button', { name: 'Resume' })
    let finish!: (success: boolean) => void
    deviceService.startRealtime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(resume)
    unmount()
    expect(deviceService.stopRealtime).not.toHaveBeenCalled()
    await act(async () => { finish(true) })
    expect(deviceService.stopRealtime).toHaveBeenCalledOnce()
  })
  it('monitors both channels listen-only through pause and resume, ignores other sessions, and unsubscribes', async () => {
    identity = { connected: true, model: 'hidock-h1e', versionNumber: 393988, versionCode: '6.3.4' }
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    const stream = async (status: 'streaming' | 'paused') => act(async () => {
      snapshot = { ...snapshot, session: { ...snapshot.session, status, sessionId: 'session-1', transcribe: false, saveRecording: false } }
      listener?.(snapshot)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Monitor channels' }))
    await waitFor(() => expect(deviceService.startRealtime).toHaveBeenNthCalledWith(1, { transcribe: false, saveRecording: false }))
    await stream('streaming')
    expect(screen.getByRole('checkbox', { name: 'Save stereo WAV locally' })).toBeChecked()

    await act(async () => { channelListener?.(channelTap('old-session', [30000, 30000])) })
    expect(screen.queryByText(/received 4 B/)).not.toBeInTheDocument()
    await act(async () => { channelListener?.(channelTap('session-1', [1000, 16000])) })
    expect(await screen.findByText('Microphone')).toBeInTheDocument()
    expect(screen.getByText('System audio')).toBeInTheDocument()
    expect(screen.getAllByText(/received 4 B/)).toHaveLength(2)
    expect(screen.getByRole('meter', { name: 'System audio level' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(deviceService.pauseRealtime).toHaveBeenCalledOnce())
    await stream('paused')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(deviceService.startRealtime).toHaveBeenNthCalledWith(2, { transcribe: false, saveRecording: false }))
    unmount()
    expect(unsubscribeChannels).toHaveBeenCalledOnce()
  })
  it('keeps neutral channel names on other firmware and ignores channel audio from another window', async () => {
    snapshot = { ...snapshot, owned: false, session: { ...snapshot.session, status: 'streaming', sessionId: 'session-1' } }
    render(<Device />)
    await screen.findByText('Another window owns this capture. Diagnostics are read-only.')
    await act(async () => { channelListener?.(channelTap('session-1', [1000, 16000])) })
    expect(screen.queryByText('Microphone')).not.toBeInTheDocument()
    expect(screen.queryByText(/received 4 B/)).not.toBeInTheDocument()
    expect(screen.getByText('Which source each channel carries is not confirmed for this device or firmware.')).toBeInTheDocument()
  })
  it('does not send an extra stop on unmount after the explicit stop button', async () => {
    const { unmount } = render(<Device />)
    await screen.findByText(/channel-0: RMS/)
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await screen.findByRole('button', { name: 'Start' })
    unmount()
    expect(deviceService.stopRealtime).toHaveBeenCalledOnce()
  })
})
