/**
 * useAudioPlayback — H5 disk-cache behaviour.
 *
 * Verifies that waveform peaks load from the disk cache WITHOUT recomputing
 * (no decode, no read, no "loading" state) on a cache hit, and that a cache miss
 * computes the peaks and persists them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAudioPlayback } from '../useAudioPlayback'
import { useUIStore } from '@/store/useUIStore'

const generateWaveformData = vi.fn()
const decodeAudioData = vi.fn()

vi.mock('@/utils/audioUtils', () => ({
  generateWaveformData: (...a: unknown[]) => generateWaveformData(...a),
  decodeAudioData: (...a: unknown[]) => decodeAudioData(...a),
  getAudioMimeType: () => 'audio/mpeg',
  formatTimestamp: (s: number) => String(s)
}))

const getCache = vi.fn()
const setCache = vi.fn().mockResolvedValue(true)
const readRecording = vi.fn()
const updateDuration = vi.fn().mockResolvedValue({ success: true })

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({
    playbackWaveformData: null,
    waveformLoadingId: null,
    waveformLoadedForId: null,
    waveformLoadingError: null
  } as never)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    waveform: { getCache, setCache, clearCache: vi.fn() },
    storage: { readRecording },
    recordings: { updateDuration }
  }
})

describe('useAudioPlayback — H5 disk cache', () => {
  it.each([
    [Infinity, 118], [NaN, 118], [Infinity, 0], [NaN, NaN], [Infinity, Infinity]
  ])('rejects non-finite seeks with WebM duration %s and decoded duration %s and resumes safely', async (duration, cachedDuration) => {
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
    getCache.mockResolvedValue({ peaks: [0.2], duration: cachedDuration })
    readRecording.mockResolvedValue({ success: true, data: btoa('webm') })
    const { unmount } = renderHook(() => useAudioPlayback())
    try {
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
    } finally {
      unmount()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
  it('does not start a recording after Stop while its audio read is pending', async () => {
    let finishRead!: (value: { success: boolean; data: string }) => void
    readRecording.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const { unmount } = renderHook(() => useAudioPlayback())
    await act(async () => {
      const pending = window.__audioControls!.play('leaving', '/x/leaving.mp3')
      window.__audioControls!.stop()
      finishRead({ success: true, data: btoa('audio-bytes') })
      await pending
    })
    expect(getCache).not.toHaveBeenCalled()
    expect(useUIStore.getState().currentlyPlayingId).toBeNull()
    expect(useUIStore.getState().isPlaying).toBe(false)
    unmount()
  })
  it('loads peaks from cache WITHOUT recomputing (no decode, no read, no loading state)', async () => {
    getCache.mockResolvedValue({
      version: 1,
      recordingId: 'rec-1',
      peaks: [0.1, 0.5, 0.9],
      sampleCount: 3,
      duration: 10,
      fileSize: 100,
      createdAt: 'now'
    })

    renderHook(() => useAudioPlayback())
    await window.__audioControls!.loadWaveformOnly('rec-1', '/x/rec-1.mp3')

    // Instant cache path — no compute, no file read.
    expect(getCache).toHaveBeenCalledWith('rec-1')
    expect(decodeAudioData).not.toHaveBeenCalled()
    expect(generateWaveformData).not.toHaveBeenCalled()
    expect(readRecording).not.toHaveBeenCalled()

    // Data applied, loaded flag set, and NO lingering loading overlay state.
    const state = useUIStore.getState()
    expect(state.playbackWaveformData).toBeInstanceOf(Float32Array)
    const peaks = Array.from(state.playbackWaveformData!)
    expect(peaks).toHaveLength(3)
    ;[0.1, 0.5, 0.9].forEach((v, i) => expect(peaks[i]).toBeCloseTo(v, 5))
    expect(state.waveformLoadedForId).toBe('rec-1')
    expect(state.waveformLoadingId).toBeNull()
    // Duration backfilled from the cache (no re-decode needed).
    expect(state.playbackDuration).toBe(10)
  })

  it('computes and persists peaks on a cache miss', async () => {
    getCache.mockResolvedValue(null)
    readRecording.mockResolvedValue({ success: true, data: btoa('audio-bytes') })
    decodeAudioData.mockResolvedValue({ duration: 42 })
    generateWaveformData.mockResolvedValue(new Float32Array([0.2, 0.4]))

    renderHook(() => useAudioPlayback())
    await window.__audioControls!.loadWaveformOnly('rec-2', '/x/rec-2.mp3')

    expect(readRecording).toHaveBeenCalledWith('/x/rec-2.mp3')
    expect(generateWaveformData).toHaveBeenCalled()
    // Peaks persisted to the disk cache for next time.
    expect(setCache).toHaveBeenCalledTimes(1)
    expect(setCache.mock.calls[0][0]).toBe('rec-2')
    expect(Array.isArray(setCache.mock.calls[0][1])).toBe(true)

    expect(useUIStore.getState().waveformLoadedForId).toBe('rec-2')
  })

  it('shows a coarse waveform at once, then decodes the exact one and saves it over', async () => {
    getCache.mockResolvedValue({
      version: 1,
      recordingId: 'rec-c',
      peaks: [0.3, 0.3],
      sampleCount: 2,
      duration: 42,
      fileSize: 100,
      createdAt: 'now',
      coarse: true
    })
    readRecording.mockResolvedValue({ success: true, data: btoa('audio-bytes') })
    decodeAudioData.mockResolvedValue({ duration: 42 })
    generateWaveformData.mockResolvedValue(new Float32Array([0.1, 0.9]))

    renderHook(() => useAudioPlayback())
    await window.__audioControls!.loadWaveformOnly('rec-c', '/x/rec-c.mp3')

    expect(generateWaveformData).toHaveBeenCalled()
    expect(setCache).toHaveBeenCalledTimes(1)
    expect(setCache.mock.calls[0][0]).toBe('rec-c')
    const shown = Array.from(useUIStore.getState().playbackWaveformData!)
    expect(shown[1]).toBeCloseTo(0.9, 5) // the exact one replaced the coarse one
  })

  it('starts a split preview at the requested timestamp before audio becomes audible', async () => {
    let heardFrom = -1
    class FakeAudio extends EventTarget {
      currentTime = 0
      duration = 100
      readyState = 1
      src = ''
      playbackRate = 1
      error = null
      play = vi.fn(async () => { heardFrom = this.currentTime })
      pause = vi.fn()
    }
    vi.stubGlobal('Audio', FakeAudio)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    getCache.mockResolvedValue({
      version: 1,
      recordingId: 'rec-preview',
      peaks: [0.2, 0.4],
      sampleCount: 2,
      duration: 100,
      fileSize: 100,
      createdAt: 'now'
    })
    readRecording.mockResolvedValue({ success: true, data: btoa('audio-bytes') })

    const { unmount } = renderHook(() => useAudioPlayback())
    await window.__audioControls!.play('rec-preview', '/x/preview.mp3', 42.3)

    expect(heardFrom).toBe(42.3)
    expect(useUIStore.getState().playbackCurrentTime).toBe(42.3)
    unmount()
    vi.unstubAllGlobals()
  })
})


it('restores both cached channels and decoded duration without reading the file', async () => {
  getCache.mockResolvedValue({ peaks: [0.2], channels: [[0.2], [0.8]], duration: 118 })
  renderHook(() => useAudioPlayback())
  await window.__audioControls!.loadWaveformOnly('stereo', '/pc-recording-test.webm')
  const state = useUIStore.getState()
  expect(state.playbackWaveformChannels?.map(channel => Array.from(channel))).toEqual([[expect.closeTo(0.2)], [expect.closeTo(0.8)]])
  expect(state.waveformDuration).toBe(118)
  expect(readRecording).not.toHaveBeenCalled()
})
it('computes and persists each decoded channel once on the same peak path', async () => {
  getCache.mockResolvedValue(null)
  readRecording.mockResolvedValue({ success: true, data: btoa('stereo') })
  decodeAudioData.mockResolvedValue({ numberOfChannels: 2, duration: 118 })
  generateWaveformData.mockImplementation(async (_buffer, _samples, channel) => new Float32Array([channel ? 0.8 : 0.2]))
  renderHook(() => useAudioPlayback())
  await window.__audioControls!.loadWaveformOnly('stereo', '/pc-recording-test.webm')
  expect(generateWaveformData.mock.calls.map(call => call[2])).toEqual([0, 1])
  expect(setCache.mock.calls[0][4]).toEqual([[expect.closeTo(0.2)], [expect.closeTo(0.8)]])
})
