import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeviceNativeRecordingPanel } from '../DeviceNativeRecordingPanel'

const IDLE = { recording: null, duration: 0, samples: [], type: null } as const
const RECORDING_A = { recording: 'native-a', duration: 3, samples: [], type: 'recording' } as const
const RECORDING_B = { recording: 'native-b', duration: 5, samples: [], type: 'recording' } as const
const FORMAT_MP3 = { format: 'mp3', storage: 'stored' } as const
const PROFILE = { profile: 0, gainLeftQ15: 32768, gainRightQ15: 32768, storage: 'stored' } as const
const RULES = { enabled: false, lane: 2, meanMagnitudeThreshold: 1000, storage: 'stored' } as const
const ACKNOWLEDGED = { status: 'acknowledged', persistence: 'unverified', recording: 'native-a' } as const

const jensen = {
  getNativeRecordingStatus: vi.fn(),
  toggleNativeRecording: vi.fn(),
  addNativeMarker: vi.fn(),
  getCustomRecordingFormat: vi.fn(),
  setCustomRecordingFormat: vi.fn(),
  getCustomRecordingProfile: vi.fn(),
  setCustomRecordingProfile: vi.fn(),
  getCustomMarkerRules: vi.fn(),
  setCustomMarkerRules: vi.fn()
}

beforeEach(() => {
  for (const method of Object.values(jensen)) method.mockReset()
  jensen.getNativeRecordingStatus.mockResolvedValue(IDLE)
  jensen.toggleNativeRecording.mockResolvedValue(ACKNOWLEDGED)
  jensen.addNativeMarker.mockResolvedValue(ACKNOWLEDGED)
  jensen.getCustomRecordingFormat.mockResolvedValue(FORMAT_MP3)
  jensen.setCustomRecordingFormat.mockResolvedValue({ result: 'success', persistence: 'unverified' })
  jensen.getCustomRecordingProfile.mockResolvedValue(PROFILE)
  jensen.setCustomRecordingProfile.mockResolvedValue({ result: 'success', persistence: 'unverified' })
  jensen.getCustomMarkerRules.mockResolvedValue(RULES)
  jensen.setCustomMarkerRules.mockResolvedValue({ result: 'success', persistence: 'unverified' })
  window.electronAPI = { jensen } as unknown as typeof window.electronAPI
})

describe('DeviceNativeRecordingPanel failure behavior', () => {
  it('requires an explicit Refresh after a missing write acknowledgement before another Apply', async () => {
    let deviceFormat: { format: 'mp3' | 'wav'; storage: 'stored' | 'fallback' } = FORMAT_MP3
    jensen.getCustomRecordingFormat.mockImplementation(async () => deviceFormat)
    jensen.setCustomRecordingFormat
      .mockImplementationOnce(async () => {
        deviceFormat = { format: 'wav', storage: 'stored' }
        return null
      })
      .mockImplementationOnce(async () => {
        deviceFormat = FORMAT_MP3
        return { result: 'success', persistence: 'unverified' }
      })

    render(<DeviceNativeRecordingPanel connected />)
    await screen.findByText('No native recording in progress.')
    fireEvent.change(screen.getByTestId('native-format'), { target: { value: 'wav' } })
    fireEvent.click(screen.getByTestId('native-apply'))

    expect(await screen.findByText(/no acknowledgement.*Current readback matches/i)).toBeInTheDocument()
    expect(screen.getByTestId('native-apply')).toBeDisabled()
    fireEvent.change(screen.getByTestId('native-format'), { target: { value: 'mp3' } })
    expect(screen.getByTestId('native-apply')).toBeDisabled()
    fireEvent.click(screen.getByTestId('native-apply'))
    expect(jensen.setCustomRecordingFormat).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('native-refresh'))
    await waitFor(() => expect(screen.queryByText(/setting change is uncertain/i)).not.toBeInTheDocument())
    fireEvent.change(screen.getByTestId('native-format'), { target: { value: 'mp3' } })
    expect(screen.getByTestId('native-apply')).toBeEnabled()
    fireEvent.click(screen.getByTestId('native-apply'))

    expect(await screen.findByText(/written and read back with exact match/i)).toBeInTheDocument()
    expect(jensen.setCustomRecordingFormat).toHaveBeenCalledTimes(2)
  })

  it('does not accept a matching fallback readback as a saved setting', async () => {
    jensen.getCustomRecordingFormat
      .mockResolvedValueOnce(FORMAT_MP3)
      .mockResolvedValueOnce({ format: 'wav', storage: 'fallback' })
    render(<DeviceNativeRecordingPanel connected />)
    await screen.findByText('No native recording in progress.')
    fireEvent.change(screen.getByTestId('native-format'), { target: { value: 'wav' } })
    fireEvent.click(screen.getByTestId('native-apply'))

    expect(await screen.findByText(/Treat as not saved/i)).toBeInTheDocument()
    expect(screen.getByText('The device reports its fallback value, not a stored one.')).toBeInTheDocument()
    expect(screen.queryByText(/written and read back with exact match/i)).not.toBeInTheDocument()
  })

  it('does not describe a rejected or inconclusive marker response as acknowledged', async () => {
    jensen.getNativeRecordingStatus.mockResolvedValue(RECORDING_A)
    jensen.addNativeMarker.mockResolvedValue({
      status: 'inconclusive',
      persistence: 'unverified',
      recording: 'native-a',
      error: 'status query failed'
    })
    render(<DeviceNativeRecordingPanel connected />)
    await screen.findByText(/Recording: native-a/)
    fireEvent.click(screen.getByTestId('native-marker'))

    expect(await screen.findByText(/Marker insertion is not confirmed/i)).toBeInTheDocument()
    expect(screen.queryByText(/Acknowledged by the device/i)).not.toBeInTheDocument()
    expect(jensen.addNativeMarker).toHaveBeenCalledTimes(1)
  })

  it('disables recording controls after post-dispatch status failure until manual Refresh, without retrying', async () => {
    let reads = 0
    jensen.getNativeRecordingStatus.mockImplementation(async () => {
      reads++
      if (reads === 3) throw new Error('status read failed')
      return reads >= 4 ? RECORDING_A : IDLE
    })
    render(<DeviceNativeRecordingPanel connected />)
    const toggle = await screen.findByTestId('native-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    fireEvent.click(toggle)

    expect(await screen.findByText(/No toggle was automatically retried/i)).toBeInTheDocument()
    expect(screen.getByTestId('native-toggle')).toBeDisabled()
    expect(jensen.toggleNativeRecording).toHaveBeenCalledTimes(1)
    expect(jensen.getNativeRecordingStatus).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByTestId('native-refresh'))
    expect(await screen.findByRole('button', { name: 'Stop recording' })).toBeEnabled()
    expect(jensen.getNativeRecordingStatus).toHaveBeenCalledTimes(4)
    expect(jensen.toggleNativeRecording).toHaveBeenCalledTimes(1)
  })

  it('blocks Stop and Marker when fresh status shows the recording changed', async () => {
    const statuses = [RECORDING_A, RECORDING_B, IDLE]
    jensen.getNativeRecordingStatus.mockImplementation(async () => statuses.shift() ?? IDLE)
    render(<DeviceNativeRecordingPanel connected />)
    const stop = await screen.findByRole('button', { name: 'Stop recording' })
    fireEvent.click(stop)

    expect(await screen.findByText(/Stop not sent: the recording changed/i)).toBeInTheDocument()
    expect(jensen.toggleNativeRecording).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('native-marker'))

    expect(await screen.findByText(/Marker not sent: the recording changed/i)).toBeInTheDocument()
    expect(jensen.addNativeMarker).not.toHaveBeenCalled()
    expect(jensen.getNativeRecordingStatus).toHaveBeenCalledTimes(3)
  })
})
