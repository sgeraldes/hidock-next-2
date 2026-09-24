/**
 * With Device Sync off at launch, every device channel rejects until the next
 * launch. The device hooks must not mount, and the device cache must read as
 * empty instead of failing the Library.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const downloadOrchestrator = vi.fn()
const deviceSubscriptions = vi.fn()

vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: vi.fn() }))
vi.mock('@/hooks/useTranscriptionSync', () => ({ useTranscriptionSync: vi.fn() }))
vi.mock('@/hooks/useDownloadOrchestrator', () => ({ useDownloadOrchestrator: () => downloadOrchestrator() }))
vi.mock('@/hooks/useDeviceSubscriptions', () => ({ useDeviceSubscriptions: () => deviceSubscriptions() }))
vi.mock('@/store/useAppStore', () => ({ useAppStore: () => ({ loadMeetings: vi.fn() }) }))
vi.mock('@/store/domain/useConfigStore', () => ({ useConfigStore: (selector: any) => selector({ config: null }) }))

import { OperationController } from '../OperationController'
import { isFeatureOffThisRun } from '@/lib/bootFeatures'

beforeEach(() => {
  downloadOrchestrator.mockClear()
  deviceSubscriptions.mockClear()
})

describe('Device Sync off at launch', () => {
  it('reads the list main passed to the window', () => {
    global.window.electronAPI = { bootDisabledFeatures: ['device-sync'] } as any
    expect(isFeatureOffThisRun('device-sync')).toBe(true)
    expect(isFeatureOffThisRun('assistant')).toBe(false)
    global.window.electronAPI = {} as any
    expect(isFeatureOffThisRun('device-sync')).toBe(false)
  })

  it('does not mount the device hooks', () => {
    global.window.electronAPI = { bootDisabledFeatures: ['device-sync'] } as any
    render(<OperationController />)
    expect(downloadOrchestrator).not.toHaveBeenCalled()
    expect(deviceSubscriptions).not.toHaveBeenCalled()
  })

  it('mounts them when Device Sync runs this launch', () => {
    global.window.electronAPI = { bootDisabledFeatures: [] } as any
    render(<OperationController />)
    expect(downloadOrchestrator).toHaveBeenCalled()
    expect(deviceSubscriptions).toHaveBeenCalled()
  })
})
