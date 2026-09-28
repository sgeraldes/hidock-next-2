import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RecordingSection } from '../RecordingSection'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { useAppStore } from '@/store/useAppStore'

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }))
const device = vi.hoisted(() => ({
  setAutoRecord: vi.fn(async () => true),
  getAutoConnectConfig: vi.fn(() => ({ enabled: true, intervalMs: 5000, connectOnStartup: true })),
  setAutoConnectConfig: vi.fn()
}))
vi.mock('@/services/hidock-device', () => ({ getHiDockDeviceService: () => device }))

const updateConfig = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({
    config: { device: { autoDownload: true }, transcription: { autoTranscribe: true }, storage: { recordingsPath: 'F:\\Audios' } } as never,
    updateConfig
  })
})

describe('RecordingSection', () => {
  it('auto-record is locked while the HiDock is disconnected', () => {
    useAppStore.setState({ deviceState: { connected: false } } as never)
    render(<RecordingSection />)
    expect(screen.getByRole('switch', { name: 'Record meetings automatically' })).toBeDisabled()
    expect(screen.getByText(/connect it to see or change this/)).toBeInTheDocument()
  })

  it('changes auto-record on the connected device', () => {
    useAppStore.setState({ deviceState: { connected: true, settings: { autoRecord: false } } } as never)
    render(<RecordingSection />)
    fireEvent.click(screen.getByRole('switch', { name: 'Record meetings automatically' }))
    expect(device.setAutoRecord).toHaveBeenCalledWith(true)
  })

  it('the other switches save the same keys as the Device page', () => {
    useAppStore.setState({ deviceState: { connected: false } } as never)
    render(<RecordingSection />)
    fireEvent.click(screen.getByRole('switch', { name: 'Download new recordings automatically' }))
    expect(updateConfig).toHaveBeenCalledWith('device', { autoDownload: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Transcribe new recordings automatically' }))
    expect(updateConfig).toHaveBeenCalledWith('transcription', { autoTranscribe: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Connect to the HiDock when HiDock Next starts' }))
    expect(device.setAutoConnectConfig).toHaveBeenCalledWith({ enabled: false, connectOnStartup: false })
    expect(screen.getByText('F:\\Audios')).toBeInTheDocument()
  })
})
