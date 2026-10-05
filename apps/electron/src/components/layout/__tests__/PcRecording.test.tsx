import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NewMenu, RecordingBar } from '../PcRecording'
import { usePcRecorderStore } from '@/store/usePcRecorderStore'

const start = vi.fn(async () => undefined)
const stop = vi.fn(async () => undefined)
vi.mock('@/lib/pc-audio-capture', () => ({ PcAudioCapture: class {
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
    await waitFor(() => expect(usePcRecorderStore.getState().status).toBe('idle'))
  })
  it('shows the source failure clearly and permits retry', async () => {
    start.mockRejectedValueOnce(new Error('System audio capture failed: permission denied'))
    usePcRecorderStore.getState().open()
    render(<RecordingBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('System audio capture failed')
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()
  })
})
