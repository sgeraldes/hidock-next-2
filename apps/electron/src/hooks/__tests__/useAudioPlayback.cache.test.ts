/**
 * useAudioPlayback waveform-cache contract.
 *
 * The renderer may display only a complete, current cache entry returned by
 * main. A selected miss/legacy entry asks main to repair it; renderer code
 * never reads the recording or decodes whole-file PCM to draw the waveform.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAudioPlayback } from '../useAudioPlayback'
import { useUIStore } from '@/store/useUIStore'

const generateWaveformData = vi.fn()
const decodeAudioData = vi.fn()

vi.mock('@/utils/audioUtils', () => ({
  generateWaveformData: (...args: unknown[]) => generateWaveformData(...args),
  decodeAudioData: (...args: unknown[]) => decodeAudioData(...args),
  getAudioMimeType: (_filePath?: string, _base64?: string) => 'audio/mpeg',
  formatTimestamp: (seconds: number) => String(seconds)
}))

const getCache = vi.fn()
const setCache = vi.fn().mockResolvedValue(true)
const cancelGeneration = vi.fn().mockResolvedValue(undefined)
const readRecording = vi.fn()
const updateDuration = vi.fn().mockResolvedValue({ success: true })

const PEAK_COUNT = 1000

function waveformEntry(options: {
  channels?: number[][]
  duration?: number
  peaks?: number[]
  coarse?: boolean
} = {}) {
  const channels = options.channels ?? [new Array<number>(PEAK_COUNT).fill(0.25)]
  return {
    version: 2,
    recordingId: 'recording',
    peaks: options.peaks ?? channels[0],
    channels,
    sampleCount: PEAK_COUNT,
    duration: options.duration ?? 12.5,
    fileSize: 128,
    createdAt: 'test-fixture',
    coarse: options.coarse ?? false
  }
}

function installElectronApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      waveform: { getCache, setCache, cancelGeneration, clearCache: vi.fn() },
      storage: { readRecording },
      recordings: { updateDuration }
    }
  })
}

function waveformControls() {
  return (window as unknown as {
    __audioControls: { loadWaveformOnly: (recordingId: string, filePath: string) => Promise<void> }
  }).__audioControls
}

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({
    playbackWaveformData: null,
    playbackWaveformChannels: null,
    waveformDuration: 0,
    waveformLoadingId: null,
    waveformLoadedForId: null,
    waveformLoadingError: null,
    waveformErrorForId: null,
    currentlyPlayingId: null,
    isPlaying: false
  } as never)
  installElectronApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useAudioPlayback — main-process waveform cache', () => {
  it.each([
    [Infinity, 118], [NaN, 118], [Infinity, 0], [NaN, NaN], [Infinity, Infinity]
  ])('rejects non-finite seeks with WebM duration %s and cache duration %s', async (duration, cachedDuration) => {
    const assigned: number[] = []
    class WebMAudio extends EventTarget {
      private time = 0
      get currentTime() { return this.time }
      set currentTime(value: number) {
        if (!Number.isFinite(value)) throw new TypeError('currentTime non-finite')
        assigned.push(value)
        this.time = value
      }
      duration = duration
      readyState = 1
      src = ''
      playbackRate = 1
      play = vi.fn().mockResolvedValue(undefined)
      pause = vi.fn()
    }
    vi.stubGlobal('Audio', WebMAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:webm')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    getCache.mockResolvedValue(waveformEntry({ duration: cachedDuration }))
    readRecording.mockResolvedValue({ success: true, data: btoa('synthetic-webm') })
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.play('webm', '/headerless.webm', 42) })
    expect(assigned).toEqual([42])
    act(() => {
      window.__audioControls!.pause()
      window.__audioControls!.seek(NaN)
      window.__audioControls!.seek(Infinity)
      window.__audioControls!.seek(-Infinity)
      window.__audioControls!.seek(-5)
      window.__audioControls!.seek(200)
      window.__audioControls!.resume()
    })
    expect(assigned).toEqual([42, 0, cachedDuration === 118 ? 118 : 200])
    unmount()
  })

  it('does not start playback after Stop while its audio read is pending', async () => {
    let finishRead!: (value: { success: boolean; data: string }) => void
    readRecording.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => {
      const pending = window.__audioControls!.play('leaving', '/x/leaving.mp3')
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
      window.__audioControls!.stop()
      finishRead({ success: true, data: btoa('synthetic-audio') })
      await pending
    })

    expect(getCache).not.toHaveBeenCalled()
    expect(useUIStore.getState().currentlyPlayingId).toBeNull()
    expect(useUIStore.getState().isPlaying).toBe(false)
    unmount()
  })

  it('loads a complete exact cache entry without reading or decoding the recording', async () => {
    const peaks = Array.from({ length: PEAK_COUNT }, (_, index) => index / PEAK_COUNT)
    getCache.mockResolvedValue(waveformEntry({ peaks, channels: [peaks], duration: 10 }))
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.loadWaveformOnly('rec-1', '/x/rec-1.mp3') })

    expect(getCache).toHaveBeenCalledTimes(1)
    expect(getCache.mock.calls[0][0]).toBe('rec-1')
    expect(getCache.mock.calls[0][2]).toEqual(expect.any(String))
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(generateWaveformData).not.toHaveBeenCalled()
    expect(readRecording).not.toHaveBeenCalled()
    expect(setCache).not.toHaveBeenCalled()

    const state = useUIStore.getState()
    expect(Array.from(state.playbackWaveformData!)).toHaveLength(PEAK_COUNT)
    expect(state.playbackWaveformData![500]).toBeCloseTo(0.5, 5)
    expect(state.waveformLoadedForId).toBe('rec-1')
    expect(state.waveformLoadingId).toBeNull()
    expect(state.waveformDuration).toBe(10)
    unmount()
  })

  it('repairs a selected legacy coarse entry through main and displays only the exact result', async () => {
    const legacy = waveformEntry({ peaks: [0.01], channels: [[0.01]], coarse: true })
    const repairedPeaks = new Array<number>(PEAK_COUNT).fill(0).map((_, index) => index % 2 ? 0.8 : 0.2)
    const repaired = waveformEntry({ peaks: repairedPeaks, channels: [repairedPeaks], duration: 42 })
    // Main owns the upgrade. A request with an owner ID returns its generated
    // exact entry; the renderer never receives/displays the legacy fallback.
    getCache.mockImplementation((_id: string, _size?: number, requestId?: string) =>
      Promise.resolve(requestId ? repaired : legacy))
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.loadWaveformOnly('legacy-row', '/legacy.mp3') })

    expect(getCache).toHaveBeenCalledTimes(1)
    expect(getCache).toHaveBeenCalledWith('legacy-row', undefined, expect.any(String))
    expect(Array.from(useUIStore.getState().playbackWaveformData!)).toHaveLength(PEAK_COUNT)
    expect(useUIStore.getState().playbackWaveformData![1]).toBeCloseTo(0.8, 5)
    expect(useUIStore.getState().waveformDuration).toBe(42)
    expect(useUIStore.getState().waveformLoadedForId).toBe('legacy-row')
    expect(readRecording).not.toHaveBeenCalled()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(generateWaveformData).not.toHaveBeenCalled()
    expect(setCache).not.toHaveBeenCalled()
    unmount()
  })

  it('restores two channel arrays and measured duration from the selected main-process result', async () => {
    const left = Array.from({ length: PEAK_COUNT }, (_, index) => index / PEAK_COUNT)
    const right = Array.from({ length: PEAK_COUNT }, (_, index) => 1 - index / PEAK_COUNT)
    getCache.mockResolvedValue(waveformEntry({ channels: [left, right], peaks: left, duration: 118 }))
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.loadWaveformOnly('stereo', '/synthetic-stereo.mp3') })

    expect(getCache).toHaveBeenCalledWith('stereo', undefined, expect.any(String))
    expect(useUIStore.getState().playbackWaveformChannels).toHaveLength(2)
    expect(useUIStore.getState().playbackWaveformChannels?.[0]).toHaveLength(PEAK_COUNT)
    expect(useUIStore.getState().playbackWaveformChannels?.[1]).toHaveLength(PEAK_COUNT)
    expect(useUIStore.getState().playbackWaveformChannels?.[0][250]).toBeCloseTo(0.25, 5)
    expect(useUIStore.getState().playbackWaveformChannels?.[1][250]).toBeCloseTo(0.75, 5)
    expect(useUIStore.getState().waveformDuration).toBe(118)
    expect(readRecording).not.toHaveBeenCalled()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(setCache).not.toHaveBeenCalled()
    unmount()
  })

  it.each([
    ['coarse entry', waveformEntry({ peaks: [0.2], channels: [[0.2]], coarse: true })],
    ['short arrays', waveformEntry({ peaks: [0.2], channels: [[0.2]] })],
    ['missing channel data', { ...waveformEntry(), channels: undefined }],
    ['zero duration', waveformEntry({ duration: 0 })],
    ['non-finite duration', waveformEntry({ duration: NaN })],
    ['missing cache', null]
  ])('refuses %s without renderer-side full-file decoding', async (_label, entry) => {
    getCache.mockResolvedValue(entry)
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.loadWaveformOnly('unknown', '/unknown.mp3') })

    expect(getCache).toHaveBeenCalledWith('unknown', undefined, expect.any(String))
    expect(readRecording).not.toHaveBeenCalled()
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(generateWaveformData).not.toHaveBeenCalled()
    expect(setCache).not.toHaveBeenCalled()
    expect(useUIStore.getState().playbackWaveformData).toBeNull()
    expect(useUIStore.getState().waveformLoadedForId).toBeNull()
    expect(useUIStore.getState().waveformLoadingError).toBeTruthy()
    expect(useUIStore.getState().waveformLoadingId).toBeNull()
    unmount()
  })

  it('cancels the prior owner on selection change without clearing the newer loading state', async () => {
    const pending = new Map<string, (entry: ReturnType<typeof waveformEntry> | null) => void>()
    getCache.mockImplementation((recordingId: string) =>
      new Promise(resolve => pending.set(recordingId, resolve)))
    const uuid = vi.fn().mockReturnValueOnce('request-old').mockReturnValueOnce('request-new')
    vi.stubGlobal('crypto', { randomUUID: uuid })
    const { unmount } = renderHook(() => useAudioPlayback())
    let oldRequest!: Promise<void>
    await act(async () => { oldRequest = waveformControls().loadWaveformOnly('old-row', '/old.mp3') })
    await vi.waitFor(() => expect(getCache).toHaveBeenCalledTimes(1))

    let newRequest!: Promise<void>
    await act(async () => { newRequest = waveformControls().loadWaveformOnly('new-row', '/new.mp3') })
    expect(useUIStore.getState().waveformLoadingId).toBe('new-row')
    expect(cancelGeneration).toHaveBeenCalledWith('request-old')
    expect(getCache).toHaveBeenCalledTimes(1) // queued behind the still-settling old request

    await act(async () => {
      pending.get('old-row')!(null)
      await oldRequest
    })
    await vi.waitFor(() => expect(getCache).toHaveBeenCalledTimes(2))
    expect(useUIStore.getState().waveformLoadingId).toBe('new-row')

    await act(async () => {
      pending.get('new-row')!(waveformEntry())
      await newRequest
    })
    expect(getCache).toHaveBeenNthCalledWith(1, 'old-row', undefined, 'request-old')
    expect(getCache).toHaveBeenNthCalledWith(2, 'new-row', undefined, 'request-new')
    expect(useUIStore.getState().waveformLoadedForId).toBe('new-row')
    expect(useUIStore.getState().waveformLoadingId).toBeNull()
    expect(useUIStore.getState().waveformLoadingError).toBeNull()
    unmount()
  })

  it('continues audio playback if a requestless cache probe misses, without generating a waveform', async () => {
    const audioPlay = vi.fn().mockResolvedValue(undefined)
    class FakeAudio extends EventTarget {
      currentTime = 0
      duration = 100
      readyState = 1
      src = ''
      playbackRate = 1
      play = audioPlay
      pause = vi.fn()
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:playback-fallback')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    getCache.mockResolvedValue(null)
    readRecording.mockResolvedValue({ success: true, data: btoa('synthetic-playback-audio') })
    const { unmount } = renderHook(() => useAudioPlayback())

    await act(async () => { await window.__audioControls!.play('missing-waveform', '/missing.mp3') })

    expect(readRecording).toHaveBeenCalledWith('/missing.mp3') // required for playback itself
    expect(getCache).toHaveBeenCalledWith('missing-waveform', undefined, undefined)
    expect(audioPlay).toHaveBeenCalledOnce()
    expect(cancelGeneration).not.toHaveBeenCalled() // playback never starts selected generation
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(generateWaveformData).not.toHaveBeenCalled()
    expect(useUIStore.getState().waveformLoadingError).toBe('Waveform preview unavailable')
    unmount()
  })
})
