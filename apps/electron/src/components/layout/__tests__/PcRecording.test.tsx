import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NewMenu, RecordingBar } from '../PcRecording'
import { usePcRecorderStore } from '@/store/usePcRecorderStore'

const start = vi.fn(async () => undefined)
const stop = vi.fn(async () => undefined)
const navigate = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
let captureError: ((error: string) => void) | null = null
vi.mock('@/lib/pc-audio-capture', () => ({ PcAudioCapture: class {
  constructor(_bridge: unknown, onError: (error: string) => void) { captureError = onError }
  start = start
  stop = stop
  levels = () => [0.2, 0.4]
} }))
beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = { pcRecorder: {} } as typeof window.electronAPI
  usePcRecorderStore.setState({ visible: false, status: 'idle', error: null, elapsed: 0, levels: [0, 0] })
})
describe('New menu and global recording bar', () => {
  it('does not leave the bar recording when capture fails during startup', async () => {
    start.mockImplementationOnce(async () => { captureError?.('Audio source stopped') })
    usePcRecorderStore.getState().open()
    render(<RecordingBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() => expect(usePcRecorderStore.getState().status).toBe('idle'))
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent('Audio source stopped')
  })
  it('opens Record without capturing until the explicit Record button is pressed', async () => {
    render(<><NewMenu /><RecordingBar /></>)
    expect(screen.queryByRole('region', { name: 'PC recording' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Record' }))
    expect(screen.getByRole('region', { name: 'PC recording' })).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(screen.getByRole('meter', { name: 'Mic' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'System' })).toBeInTheDocument()
    expect(screen.getByText('00:00')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
  })
  it('survives bar remounts during navigation', async () => {
    usePcRecorderStore.getState().open()
    const view = render(<RecordingBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('button', { name: 'Stop' })
    view.unmount()
    render(<RecordingBar />)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(usePcRecorderStore.getState().status).toBe('saved'))
  })
  it('shows the source failure clearly and permits retry', async () => {
    start.mockRejectedValueOnce(new Error('System audio capture failed: permission denied'))
    usePcRecorderStore.getState().open()
    render(<RecordingBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('System audio capture failed')
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()
  })
  it('shows Saved to Library with Open, then hides and resets after five seconds', async () => {
    vi.useFakeTimers()
    try {
      usePcRecorderStore.getState().open()
      render(<RecordingBar />)
      await act(async () => { await usePcRecorderStore.getState().start(); await vi.advanceTimersByTimeAsync(2000); await usePcRecorderStore.getState().stop() })
      expect(screen.getByText('Saved to Library')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Open' }))
      expect(navigate).toHaveBeenCalledWith('/library')
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.queryByRole('region', { name: 'PC recording' })).not.toBeInTheDocument()
      expect(usePcRecorderStore.getState()).toMatchObject({ status: 'idle', elapsed: 0 })
    } finally { vi.useRealTimers() }
  })
  it('can dismiss during recording without interrupting capture, and reopen to stop', async () => {
    usePcRecorderStore.getState().open()
    render(<RecordingBar />)
    await act(async () => { await usePcRecorderStore.getState().start() })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss recording bar' }))
    expect(screen.queryByRole('region', { name: 'PC recording' })).not.toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()
    act(() => usePcRecorderStore.getState().open())
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(usePcRecorderStore.getState().status).toBe('saved'))
  })
  it('renders separate visible level fills for known inputs', () => {
    usePcRecorderStore.setState({ visible: true, status: 'recording', levels: [0.2, 0.4] })
    render(<RecordingBar />)
    for (const label of ['Mic', 'System']) {
      const meter = screen.getByRole('meter', { name: label })
      expect(meter).toHaveAttribute('aria-valuenow', label === 'Mic' ? '0.2' : '0.4')
      expect(meter.firstElementChild).toHaveStyle({ width: label === 'Mic' ? '20%' : '40%' })
    }
  })
})
