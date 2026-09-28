import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startUiConfigSync } from '../ui-config-sync'
import { useUIStore } from '../useUIStore'
import { useConfigStore } from '@/store/domain/useConfigStore'

const updateConfig = vi.fn().mockResolvedValue(undefined)
let stop: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ chatPlacement: 'floating', chatPosition: 'right', autoCaptureScreenshots: false })
  useConfigStore.setState({ config: null, updateConfig } as never)
})
afterEach(() => {
  stop?.()
  stop = null
})

describe('chat placement and clipboard capture live in config.json', () => {
  it('copies the choice already made in this window when config has none', () => {
    useUIStore.setState({ chatPlacement: 'embedded', autoCaptureScreenshots: true })
    stop = startUiConfigSync()
    expect(updateConfig).not.toHaveBeenCalled() // config not loaded yet
    useConfigStore.setState({ config: { ui: {}, capture: { describeImages: true } } } as never)
    expect(updateConfig).toHaveBeenCalledWith('ui', { chatPlacement: 'embedded', chatPosition: 'right' })
    expect(updateConfig).toHaveBeenCalledWith('capture', { autoClipboard: true })
  })

  it('a value saved in config wins over this window', () => {
    useConfigStore.setState({ config: { ui: { chatPlacement: 'embedded', chatPosition: 'left' }, capture: { autoClipboard: true } } } as never)
    stop = startUiConfigSync()
    const ui = useUIStore.getState()
    expect([ui.chatPlacement, ui.chatPosition, ui.autoCaptureScreenshots]).toEqual(['embedded', 'left', true])
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('a later change is saved to config, once', () => {
    useConfigStore.setState({ config: { ui: { chatPlacement: 'floating', chatPosition: 'right' }, capture: { autoClipboard: false } } } as never)
    stop = startUiConfigSync()
    useUIStore.getState().setChatPosition('left')
    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(updateConfig).toHaveBeenCalledWith('ui', { chatPosition: 'left' })
  })

  it('A, B, A before the first save returns ends with A saved', () => {
    useConfigStore.setState({ config: { ui: { chatPlacement: 'floating', chatPosition: 'right' }, capture: { autoClipboard: false } } } as never)
    stop = startUiConfigSync()
    useUIStore.getState().setChatPosition('left')
    useUIStore.getState().setChatPosition('right')
    expect(updateConfig).toHaveBeenLastCalledWith('ui', { chatPosition: 'right' })
    expect(updateConfig).toHaveBeenCalledTimes(2)
  })
})
