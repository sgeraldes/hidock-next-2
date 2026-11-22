import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeviceRecordingMarkers, DeviceRecordingTrackExport } from '../DeviceRecordingMarkers'
import type { DeviceRecordingMarkersAPI, RecordingMarker } from '../../shared/device-recording-markers'

const marker: RecordingMarker = { id: 'native-1', atMs: 12345, source: 'native-file', persistence: 'native-file', createdAt: '2026-10-11T00:00:00Z' }
const subject = { kind: 'recording' as const, id: 'recording-1' }
const api = {
  list: vi.fn<DeviceRecordingMarkersAPI['list']>(),
  importNative: vi.fn<DeviceRecordingMarkersAPI['importNative']>(),
  getSettings: vi.fn<DeviceRecordingMarkersAPI['getSettings']>(),
  setAutomation: vi.fn<DeviceRecordingMarkersAPI['setAutomation']>(),
  add: vi.fn<DeviceRecordingMarkersAPI['add']>()
}
beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue([])
  api.importNative.mockResolvedValue({ status: 'imported', markers: [marker] })
  api.getSettings.mockResolvedValue({ automationEnabled: false })
  api.setAutomation.mockImplementation(async (_subject, enabled) => ({ enabled }))
  api.add.mockImplementation(async request => ({ status: 'accepted-local', marker: { id: 'local-1', requestId: request.requestId, atMs: request.atMs ?? 5000, source: request.source ?? 'manual', persistence: 'local-sidecar', createdAt: '2026-10-11T00:00:00Z', label: request.label } }))
  window.electronAPI = { deviceRecordingMarkers: api } as unknown as typeof window.electronAPI
})

describe('DeviceRecordingMarkers', () => {
  it('loads distinct native/local provenance and seeks without losing milliseconds', async () => {
    api.list.mockResolvedValue([marker, { ...marker, id: 'local-1', atMs: 14001, source: 'manual', persistence: 'local-sidecar', label: 'Follow up' }])
    const onSeek = vi.fn()
    render(<DeviceRecordingMarkers subject={subject} atMs={0} durationMs={20000} onSeek={onSeek} />)
    const seek = await screen.findByRole('button', { name: 'Seek to marker at 0:12.345' })
    expect(screen.getByText(/Imported native file/)).toBeInTheDocument()
    expect(screen.getByText(/Local annotation/)).toBeInTheDocument()
    fireEvent.click(seek)
    expect(onSeek).toHaveBeenCalledWith(12345)
    expect(screen.getByRole('checkbox', { name: 'Automatic annotations' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Import device markers' })).toBeDisabled()
  })
  it('adds a local annotation at the playhead with optional label', async () => {
    render(<DeviceRecordingMarkers subject={subject} atMs={12345} durationMs={20000} />)
    const add = await screen.findByRole('button', { name: 'Add marker' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Marker label' }), { target: { value: 'Follow up' } })
    fireEvent.click(add)
    expect(await screen.findByText('Marker saved locally.')).toBeInTheDocument()
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ subject, atMs: 12345, label: 'Follow up', source: 'manual', target: 'local', requestId: expect.any(String) }))
    expect(screen.getByText('0:12.345')).toBeInTheDocument()
  })
  it('reuses a submission UUID and payload after uncertain save failure', async () => {
    api.add.mockRejectedValueOnce(new Error('connection interrupted'))
    render(<DeviceRecordingMarkers subject={subject} atMs={1000} durationMs={20000} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add marker' }))
    const retry = await screen.findByRole('button', { name: 'Retry marker' })
    await waitFor(() => expect(retry).not.toBeDisabled())
    fireEvent.click(retry)
    await screen.findByText('Marker saved locally.')
    expect(api.add.mock.calls[0][0]).toEqual(api.add.mock.calls[1][0])
  })
  it('imports read-only native markers and reports absence explicitly', async () => {
    api.importNative.mockResolvedValue({ status: 'absent', markers: [] })
    render(<DeviceRecordingMarkers subject={subject} nativeImportAvailable atMs={0} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import device markers' }))
    expect(await screen.findByText('No native marker trailer found.')).toBeInTheDocument()
    expect(api.importNative).toHaveBeenCalledWith(subject)
  })
  it('scopes shortcut to panel events and lets an active session use the owner clock', async () => {
    const session = { kind: 'session' as const, id: 'session-1' }
    render(<DeviceRecordingMarkers subject={session} />)
    await screen.findByRole('button', { name: 'Add marker' })
    fireEvent.keyDown(document, { key: 'm', ctrlKey: true, shiftKey: true })
    expect(api.add).not.toHaveBeenCalled()
    const section = screen.getByRole('region', { name: 'Recording markers' })
    section.focus()
    fireEvent.keyDown(section, { key: 'm', ctrlKey: true, shiftKey: true })
    await screen.findByText('Marker saved locally.')
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ subject: session, source: 'shortcut', target: 'local' }))
    expect(api.add.mock.calls[0][0]).not.toHaveProperty('atMs')
    expect(screen.queryByRole('button', { name: 'Import device markers' })).not.toBeInTheDocument()
  })
  it('persists explicit automation opt-in and displays policy limits', async () => {
    api.setAutomation.mockImplementationOnce(async (_subject, enabled) => {
      api.list.mockResolvedValue([{ ...marker, id: 'auto-1', source: 'action', persistence: 'local-sidecar', label: 'Cached action' }])
      return { enabled }
    })
    render(<DeviceRecordingMarkers subject={subject} atMs={0} />)
    const checkbox = await screen.findByRole('checkbox', { name: 'Automatic annotations' })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
    expect(api.setAutomation).toHaveBeenCalledWith(subject, true)
    expect(await screen.findByText('Cached action')).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/at least 10 seconds apart, up to 80/)).toBeInTheDocument()
  })
  it('disables timestamp addition without a known recording playhead', async () => {
    render(<DeviceRecordingMarkers subject={subject} durationMs={20000} />)
    expect(await screen.findByRole('button', { name: 'Add marker' })).toBeDisabled()
    expect(screen.getByText('Choose a playback position to add a marker.')).toBeInTheDocument()
  })
  it('exports WAV tracks through recording ID only and reports neutral channel identity', async () => {
    const exportTracks = vi.fn().mockResolvedValue({ sampleRate: 16000, frames: 32000, seconds: 2, physicalSourceMapping: 'unverified', tracks: [{ channelId: 'channel-0', channelIndex: 0, path: 'output-0.wav' }, { channelId: 'channel-1', channelIndex: 1, path: 'output-1.wav' }] })
    window.electronAPI = { ...window.electronAPI, deviceAudio: { exportTracks } }
    render(<DeviceRecordingTrackExport recordingId={subject.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export WAV tracks' }))
    expect(await screen.findByText(/Exported 2 synchronized channel tracks at 16000 Hz/)).toBeInTheDocument()
    expect(exportTracks).toHaveBeenCalledWith(subject.id)
    expect(screen.getByText(/Source identities remain unverified/)).toBeInTheDocument()
    expect(screen.getByText('output-0.wav')).toHaveClass('select-text')
    expect(screen.getByText('output-1.wav')).toHaveClass('select-text')
  })
})
