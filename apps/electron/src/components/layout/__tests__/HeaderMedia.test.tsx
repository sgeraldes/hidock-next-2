/**
 * The header's media area: whatever plays or records, with its controls; the
 * Record control when nothing does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { HeaderMedia, LIVE_SECTION_ID } from '../HeaderMedia'
import { useUIStore } from '@/store/useUIStore'
import { useAppStore } from '@/store/useAppStore'
import { usePcRecorderStore } from '@/store/usePcRecorderStore'
import { registerElementMedia, useMediaSessionStore } from '@/store/useMediaSessionStore'
import { useDeviceConnection } from '@/hooks/useDeviceConnection'
import type { DeviceAudioDiagnosticsState } from '@/shared/device-audio'

vi.mock('@/hooks/useDeviceConnection', () => ({ useDeviceConnection: vi.fn() }))
vi.mock('@/lib/pc-audio-capture', () => ({ PcAudioCapture: class {
  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)
  levels = () => [0, 0]
} }))

const controls = { play: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), seek: vi.fn(), setPlaybackRate: vi.fn(), loadWaveformOnly: vi.fn() }
let diagnostics: DeviceAudioDiagnosticsState
const stopRealtime = vi.fn(async () => ({ result: 'success' }))

function liveState(status: DeviceAudioDiagnosticsState['session']['status'], transcribe = true, elapsedMs = 0): DeviceAudioDiagnosticsState {
  return {
    owned: true,
    session: { sessionId: status === 'idle' ? null : 's1', status, transcribe, saveRecording: true, transcriptionError: null, recordingError: null },
    lastSessionId: null,
    diagnostics: { sampleElapsedMs: elapsedMs } as DeviceAudioDiagnosticsState['diagnostics']
  }
}

function setConnected(connected: boolean) {
  vi.mocked(useDeviceConnection).mockReturnValue({ status: connected ? 'connected' : 'disconnected' } as ReturnType<typeof useDeviceConnection>)
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname} {JSON.stringify(location.state ?? null)}</output>
}

function renderMedia(path = '/library') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderMedia />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setConnected(false)
  diagnostics = liveState('idle')
  window.__audioControls = controls as unknown as typeof window.__audioControls
  window.electronAPI = {
    pcRecorder: {},
    jensen: { getAudioDiagnostics: vi.fn(async () => diagnostics), onAudioDiagnostics: vi.fn(() => () => undefined), stopRealtime }
  } as unknown as typeof window.electronAPI
  useUIStore.setState({ currentlyPlayingId: null, currentlyPlayingPath: null, isPlaying: false, playbackCurrentTime: 0, playbackDuration: 0 })
  useMediaSessionStore.setState({ active: null, isPlaying: false, currentTime: 0, duration: 0 })
  usePcRecorderStore.setState({ visible: false, status: 'idle', error: null, elapsed: 0, levels: [0, 0] })
  useAppStore.setState({ unifiedRecordings: [] } as never)
})

afterEach(() => {
  delete window.__audioControls
})

describe('HeaderMedia when nothing plays', () => {
  it('offers only the Record control', () => {
    renderMedia()
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pause|play/i })).not.toBeInTheDocument()
  })

  it('starts a PC recording from the Record menu and shows the recording bar', async () => {
    renderMedia()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Record' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /record on this pc/i }))
    await waitFor(() => expect(usePcRecorderStore.getState().status).toBe('recording'))
    expect(usePcRecorderStore.getState().visible).toBe(true)
  })

  it('opens live transcription on the Device page when the HiDock is connected', async () => {
    setConnected(true)
    renderMedia()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Record' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /live transcription/i }))
    expect(screen.getByTestId('where')).toHaveTextContent('/sync {"focus":"live"}')
  })

  it('brings the Device page live controls into view once they render', async () => {
    setConnected(true)
    renderMedia()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Record' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /live transcription/i }))
    const section = document.createElement('section')
    section.id = LIVE_SECTION_ID
    section.tabIndex = -1
    document.body.appendChild(section)
    await waitFor(() => expect(section).toHaveFocus())
    section.remove()
  })

  it('says live transcription needs the HiDock when it is not connected', async () => {
    renderMedia()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Record' }), { key: 'Enter' })
    const item = await screen.findByRole('menuitem', { name: /live transcription/i })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent(/connect the hidock/i)
  })
})

describe('HeaderMedia during recording playback', () => {
  beforeEach(() => {
    useAppStore.setState({ unifiedRecordings: [{ id: 'rec-1', filename: 'a.mp3', meetingSubject: 'Weekly sync', location: 'local-only', dateRecorded: new Date() }] } as never)
    useUIStore.setState({ currentlyPlayingId: 'rec-1', currentlyPlayingPath: '/a.mp3', isPlaying: true, playbackCurrentTime: 65, playbackDuration: 190 })
  })

  it('shows the title, elapsed and total time, and a position bar', () => {
    renderMedia()
    expect(screen.getByText('Weekly sync')).toBeInTheDocument()
    expect(screen.getByText('1:05')).toBeInTheDocument()
    expect(screen.getByText('3:10')).toBeInTheDocument()
    const slider = screen.getByRole('slider', { name: 'Playback position' })
    expect(slider).toHaveValue('65')
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument()
  })

  it('pauses, resumes, seeks and stops through the shared player', () => {
    renderMedia()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(controls.pause).toHaveBeenCalledOnce()
    act(() => useUIStore.setState({ isPlaying: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(controls.resume).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), { target: { value: '120' } })
    expect(controls.seek).toHaveBeenCalledWith(120)
    fireEvent.click(screen.getByRole('button', { name: 'Stop playback' }))
    expect(controls.stop).toHaveBeenCalledOnce()
  })

  it('reflects a seek made in the page (Ctrl+F, Fix times) through the shared store', () => {
    renderMedia()
    act(() => useUIStore.setState({ playbackCurrentTime: 150 }))
    expect(screen.getByRole('slider', { name: 'Playback position' })).toHaveValue('150')
    expect(screen.getByText('2:30')).toBeInTheDocument()
  })

  it('opens the recording in the Library', () => {
    renderMedia('/calendar')
    fireEvent.click(screen.getByRole('button', { name: 'Open Weekly sync' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/library {"selectedId":"rec-1"}')
  })

  it('goes back to the meeting page a recording was started from', () => {
    renderMedia('/meeting/m-7')
    fireEvent.click(screen.getByRole('button', { name: 'Open Weekly sync' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/meeting/m-7')
  })

  it('names an unknown recording "Recording" rather than its file', () => {
    act(() => useUIStore.setState({ currentlyPlayingId: 'other', currentlyPlayingPath: '/x/2026sep24-rec52.mp3' }))
    renderMedia()
    expect(screen.getByText('Recording')).toBeInTheDocument()
  })
})

describe('HeaderMedia during page video playback', () => {
  it('shows and drives the page video', async () => {
    const video = document.createElement('video')
    let paused = true
    Object.defineProperty(video, 'paused', { get: () => paused })
    Object.defineProperty(video, 'duration', { get: () => 30 })
    video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new Event('play')) })
    video.pause = vi.fn(() => { if (!paused) { paused = true; video.dispatchEvent(new Event('pause')) } })
    const off = registerElementMedia(video, () => ({ kind: 'video', title: 'Demo clip', sourceId: 'clip-1' }))
    renderMedia()
    await act(async () => { await video.play() })

    expect(screen.getByText('Demo clip')).toBeInTheDocument()
    expect(screen.getByText('0:30')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(video.pause).toHaveBeenCalled()
    fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), { target: { value: '12' } })
    expect(video.currentTime).toBe(12)
    fireEvent.click(screen.getByRole('button', { name: 'Open Demo clip' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/library {"selectedId":"clip-1"}')
    await act(async () => { await video.play() })
    fireEvent.click(screen.getByRole('button', { name: 'Stop playback' }))
    expect(video.paused).toBe(true)
    expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument()
    off()
  })
})

describe('HeaderMedia during a recording', () => {
  it('shows the PC recording indicator, elapsed time and Stop', async () => {
    usePcRecorderStore.setState({ visible: true, status: 'recording', elapsed: 75 })
    const stop = vi.spyOn(usePcRecorderStore.getState(), 'stop').mockResolvedValue(undefined)
    renderMedia()
    const region = screen.getByRole('group', { name: 'Recording on this PC' })
    expect(region).toHaveTextContent('1:15')
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument()
  })

  it('shows a live device session with its elapsed time and stops it', async () => {
    setConnected(true)
    diagnostics = liveState('streaming', true, 125_000)
    renderMedia('/sync')
    const region = await screen.findByRole('group', { name: 'Live transcription' })
    expect(region).toHaveTextContent('2:05')
    fireEvent.click(screen.getByRole('button', { name: 'Stop live transcription' }))
    await waitFor(() => expect(stopRealtime).toHaveBeenCalledOnce())
  })

  it('names a live session without transcription as live audio', async () => {
    setConnected(true)
    diagnostics = liveState('paused', false, 0)
    renderMedia('/sync')
    expect(await screen.findByRole('group', { name: 'Live audio' })).toHaveTextContent(/paused/i)
  })

  it('does not ask the device anything while it is disconnected', () => {
    renderMedia()
    expect(window.electronAPI.jensen.getAudioDiagnostics).not.toHaveBeenCalled()
  })
})
