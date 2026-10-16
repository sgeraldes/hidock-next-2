import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/store/useUIStore'
import { useAudioPlayback } from '../useAudioPlayback'

vi.mock('@/utils/audioUtils', () => ({ getAudioMimeType: () => 'audio/mpeg' }))
vi.mock('@/services/qa-monitor', () => ({ shouldLogQa: () => false }))

const getCache = vi.fn()

function controls() {
  return (window as unknown as { __audioControls: {
    loadWaveformOnly: (id: string, path: string) => Promise<void>
    play: (id: string, path: string) => Promise<void>
  } })
    .__audioControls
}

function readyCache() {
  const peaks = new Array<number>(1000).fill(0.3)
  return { peaks, channels: [peaks], duration: 2, coarse: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({
    waveformLoadingId: null,
    waveformLoadedForId: null,
    waveformLoadingError: null,
    waveformErrorForId: null,
    playbackWaveformData: null,
    playbackWaveformChannels: null,
    waveformDuration: 0
  } as never)
  // Deliberately model an older preload bridge that has no cancellation API.
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { waveform: { getCache } }
  })
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'renderer-request') })
})

describe('waveform request cancellation', () => {
  it('uses the selected request to repair a legacy coarse cache before displaying it', async () => {
    const legacyCoarse = { ...readyCache(), coarse: true }
    getCache.mockImplementation((_id: string, _size?: number, requestId?: string) =>
      Promise.resolve(requestId ? readyCache() : legacyCoarse))
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await controls().loadWaveformOnly('legacy-row', '/legacy.mp3') })

    expect(getCache).toHaveBeenCalledWith('legacy-row', undefined, 'renderer-request')
    expect(useUIStore.getState().waveformLoadedForId).toBe('legacy-row')
    expect(useUIStore.getState().playbackWaveformChannels).toHaveLength(1)
    expect(useUIStore.getState().waveformLoadingError).toBeNull()
    unmount()
  })

  it('shows loading immediately and preserves the new selection when an older request settles', async () => {
    const pending = new Map<string, (entry: unknown) => void>()
    getCache.mockImplementation((recordingId: string) => new Promise(resolve => pending.set(recordingId, resolve)))
    const { unmount } = renderHook(() => useAudioPlayback())
    let oldRequest!: Promise<void>
    act(() => { oldRequest = controls().loadWaveformOnly('old-row', '/old.mp3') })

    await vi.waitFor(() => expect(getCache).toHaveBeenCalledTimes(1))
    expect(useUIStore.getState().waveformLoadingId).toBe('old-row')

    let newRequest!: Promise<void>
    expect(() => act(() => { newRequest = controls().loadWaveformOnly('new-row', '/new.mp3') })).not.toThrow()
    expect(useUIStore.getState().waveformLoadingId).toBe('new-row')
    expect(getCache).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.get('old-row')!(null)
      await oldRequest
    })
    await vi.waitFor(() => expect(getCache).toHaveBeenCalledTimes(2))
    expect(useUIStore.getState().waveformLoadingId).toBe('new-row')

    await act(async () => {
      pending.get('new-row')!(readyCache())
      await newRequest
    })
    expect(useUIStore.getState().waveformLoadedForId).toBe('new-row')
    expect(useUIStore.getState().waveformLoadingId).toBeNull()
    unmount()
    vi.unstubAllGlobals()
  })

  it('keeps same-row generation alive and plays when Play is pressed during loading', async () => {
    let finishGeneration!: (entry: unknown) => void
    getCache.mockImplementation((_id: string, _size?: number, requestId?: string) => {
      if (requestId) return new Promise(resolve => { finishGeneration = resolve })
      return Promise.resolve(null)
    })
    const cancelGeneration = vi.fn()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        waveform: { getCache, cancelGeneration },
        storage: { readRecording: vi.fn().mockResolvedValue({ success: true, data: btoa('synthetic audio') }) }
      }
    })
    const audioPlay = vi.fn().mockResolvedValue(undefined)
    class FakeAudio extends EventTarget {
      duration = 2
      readyState = 1
      src = ''
      playbackRate = 1
      play = audioPlay
      pause = vi.fn()
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:waveform-play')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const { unmount } = renderHook(() => useAudioPlayback())

    let load!: Promise<void>
    act(() => { load = controls().loadWaveformOnly('same-row', '/same.mp3') })
    await vi.waitFor(() => expect(getCache).toHaveBeenCalledTimes(1))
    expect(useUIStore.getState().waveformLoadingId).toBe('same-row')

    let play!: Promise<void>
    act(() => { play = controls().play('same-row', '/same.mp3') })
    expect(cancelGeneration).not.toHaveBeenCalled()
    expect(useUIStore.getState().waveformLoadingId).toBe('same-row')
    expect(useUIStore.getState().waveformLoadingError).toBeNull()

    await act(async () => {
      finishGeneration(readyCache())
      await Promise.all([load, play])
    })
    expect(audioPlay).toHaveBeenCalledOnce()
    expect(useUIStore.getState().waveformLoadedForId).toBe('same-row')
    expect(useUIStore.getState().waveformLoadingError).toBeNull()
    expect(useUIStore.getState().playbackWaveformChannels).toHaveLength(1)
    unmount()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
