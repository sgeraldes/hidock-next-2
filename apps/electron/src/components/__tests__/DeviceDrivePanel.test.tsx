import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeviceDrivePanel } from '../DeviceDrivePanel'

const unmounted = { mounted: false, drive: null, readOnly: true as const, windowsFileLimitBytes: null }
const mounted = { mounted: true, drive: 'R:', readOnly: true as const, windowsFileLimitBytes: 50000000 }
const api = {
  getDeviceDriveStatus: vi.fn().mockResolvedValue(unmounted),
  mountDeviceDrive: vi.fn().mockResolvedValue(mounted),
  unmountDeviceDrive: vi.fn().mockResolvedValue(unmounted)
}
const writeText = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  vi.clearAllMocks()
  api.getDeviceDriveStatus.mockResolvedValue(unmounted)
  api.mountDeviceDrive.mockResolvedValue(mounted)
  api.unmountDeviceDrive.mockResolvedValue(unmounted)
  writeText.mockResolvedValue(undefined)
  window.electronAPI = { jensen: api } as unknown as typeof window.electronAPI
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

describe('DeviceDrivePanel', () => {
  it('collapses when disconnected without invoking a device API', () => {
    render(<DeviceDrivePanel connected={false} />)
    expect(screen.queryByRole('region', { name: 'Device drive' })).not.toBeInTheDocument()
    expect(api.getDeviceDriveStatus).not.toHaveBeenCalled()
    expect(api.mountDeviceDrive).not.toHaveBeenCalled()
  })
  it('reads status but never mounts automatically', async () => {
    render(<DeviceDrivePanel connected />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mount drive' })).not.toBeDisabled())
    expect(api.getDeviceDriveStatus).toHaveBeenCalledTimes(1)
    expect(api.mountDeviceDrive).not.toHaveBeenCalled()
  })
  it('mounts manually, shows the real letter and exact Windows limit, and copies only a drive path', async () => {
    render(<DeviceDrivePanel connected />)
    const mount = await screen.findByRole('button', { name: 'Mount drive' })
    await waitFor(() => expect(mount).not.toBeDisabled())
    fireEvent.click(mount)
    expect(await screen.findByText('Drive mounted read-only.')).toBeInTheDocument()
    expect(screen.getByLabelText('Mounted drive path')).toHaveTextContent('R:\\')
    expect(screen.getByText(/50,000,000 bytes/)).toBeInTheDocument()
    expect(screen.getByText(/For larger recordings, use Download/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy drive path' }))
    await screen.findByText(/Drive path copied/)
    expect(writeText).toHaveBeenCalledWith('R:\\')
  })
  it('restores an existing mapping and unmounts only upon explicit action', async () => {
    api.getDeviceDriveStatus.mockResolvedValue(mounted)
    const view = render(<DeviceDrivePanel connected />)
    fireEvent.click(await screen.findByRole('button', { name: 'Unmount drive' }))
    await screen.findByText('Drive unmounted.')
    expect(api.unmountDeviceDrive).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(api.unmountDeviceDrive).toHaveBeenCalledTimes(1)
  })
  it('keeps unknown limits unknown and does not invent the default limit', async () => {
    api.getDeviceDriveStatus.mockResolvedValue({ ...mounted, windowsFileLimitBytes: null })
    render(<DeviceDrivePanel connected />)
    await screen.findByRole('button', { name: 'Unmount drive' })
    expect(screen.getByText(/copy limit is unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/50,000,000/)).not.toBeInTheDocument()
  })
  it('permits only one pending mount and ignores its late state after disconnect', async () => {
    let finish!: (value: typeof mounted) => void
    api.mountDeviceDrive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<DeviceDrivePanel connected />)
    const mount = await screen.findByRole('button', { name: 'Mount drive' })
    await waitFor(() => expect(mount).not.toBeDisabled())
    fireEvent.click(mount); fireEvent.click(mount)
    expect(api.mountDeviceDrive).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Mounting…' })).toBeDisabled()
    view.rerender(<DeviceDrivePanel connected={false} />)
    finish(mounted)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Device drive' })).not.toBeInTheDocument())
    expect(api.unmountDeviceDrive).not.toHaveBeenCalled()
  })
  it('refreshes a reconnect after an earlier mount settles without remounting automatically', async () => {
    let finish!: (value: typeof mounted) => void
    api.mountDeviceDrive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<DeviceDrivePanel connected />)
    const mount = await screen.findByRole('button', { name: 'Mount drive' })
    await waitFor(() => expect(mount).not.toBeDisabled())
    fireEvent.click(mount)
    view.rerender(<DeviceDrivePanel connected={false} />)
    view.rerender(<DeviceDrivePanel connected />)
    await waitFor(() => expect(api.getDeviceDriveStatus).toHaveBeenCalledTimes(2))
    api.getDeviceDriveStatus.mockResolvedValue(mounted)
    finish(mounted)
    await screen.findByRole('button', { name: 'Unmount drive' })
    expect(api.getDeviceDriveStatus).toHaveBeenCalledTimes(3)
    expect(api.mountDeviceDrive).toHaveBeenCalledTimes(1)
  })
  it('shows sanitized known manager errors without propagating arbitrary URI/secret details', async () => {
    api.mountDeviceDrive.mockRejectedValueOnce(new Error('http://127.0.0.1:9911/private-secret Windows could not map the device drive (error 1920)'))
    render(<DeviceDrivePanel connected />)
    const mount = await screen.findByRole('button', { name: 'Mount drive' })
    await waitFor(() => expect(mount).not.toBeDisabled())
    fireEvent.click(mount)
    expect(await screen.findByRole('alert')).toHaveTextContent('Windows could not map the device drive (error 1920)')
    expect(screen.queryByText(/private-secret/)).not.toBeInTheDocument()
    api.mountDeviceDrive.mockRejectedValueOnce(new Error('unknown secret raw transport error'))
    fireEvent.click(screen.getByRole('button', { name: 'Mount drive' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not mount the device drive.'))
    expect(screen.queryByText(/raw transport/)).not.toBeInTheDocument()
  })
  it('rejects malformed drive status instead of displaying a path or claiming a successful mount', async () => {
    api.mountDeviceDrive.mockResolvedValueOnce({ ...mounted, drive: 'http://private-uri' })
    render(<DeviceDrivePanel connected />)
    const mount = await screen.findByRole('button', { name: 'Mount drive' })
    await waitFor(() => expect(mount).not.toBeDisabled())
    fireEvent.click(mount)
    await screen.findByRole('alert')
    expect(screen.queryByLabelText('Mounted drive path')).not.toBeInTheDocument()
    expect(screen.queryByText('Drive mounted read-only.')).not.toBeInTheDocument()
  })
  it('keeps the displayed path selectable if clipboard access fails', async () => {
    api.getDeviceDriveStatus.mockResolvedValue(mounted)
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    render(<DeviceDrivePanel connected />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy drive path' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Select it and copy it manually.')
    expect(screen.getByLabelText('Mounted drive path')).toHaveClass('select-text')
  })
})
