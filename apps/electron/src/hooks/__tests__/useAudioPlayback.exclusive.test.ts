/**
 * The recording player and page-owned media never play together: playing or
 * resuming a recording pauses any registered <audio>/<video> first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAudioPlayback } from '../useAudioPlayback'
import { useUIStore } from '@/store/useUIStore'
import { registerElementMedia, useMediaSessionStore } from '@/store/useMediaSessionStore'

vi.mock('@/utils/audioUtils', () => ({
  getAudioMimeType: () => 'audio/mpeg'
}))

function pageVideo(): HTMLMediaElement {
  const element = document.createElement('video')
  let paused = true
  Object.defineProperty(element, 'paused', { get: () => paused })
  element.play = vi.fn(async () => { paused = false; element.dispatchEvent(new Event('play')) })
  element.pause = vi.fn(() => { if (!paused) { paused = true; element.dispatchEvent(new Event('pause')) } })
  return element
}

beforeEach(() => {
  useUIStore.setState({ currentlyPlayingId: null, isPlaying: false, waveformLoadedForId: null, playbackWaveformChannels: null } as never)
  useMediaSessionStore.setState({ active: null, isPlaying: false, currentTime: 0, duration: 0 })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      waveform: { getCache: vi.fn().mockResolvedValue(null), cancelGeneration: vi.fn() },
      storage: { readRecording: vi.fn().mockResolvedValue({ success: true, data: btoa('audio') }) }
    }
  })
  class FakeAudio extends EventTarget {
    currentTime = 0
    duration = 10
    readyState = 4
    src = ''
    playbackRate = 1
    paused = true
    play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')) })
    pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
  }
  vi.stubGlobal('Audio', FakeAudio)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rec')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useAudioPlayback: one playback at a time', () => {
  it('pauses a playing page video and ends its session when a recording starts', async () => {
    const { unmount } = renderHook(() => useAudioPlayback())
    const video = pageVideo()
    const off = registerElementMedia(video, () => ({ kind: 'video', title: 'Clip' }))
    await act(async () => { await video.play() })
    expect(useMediaSessionStore.getState().active?.title).toBe('Clip')

    await act(async () => { await window.__audioControls!.play('rec-1', '/rec-1.mp3') })

    expect(video.pause).toHaveBeenCalled()
    expect(useMediaSessionStore.getState().active).toBeNull()
    expect(useUIStore.getState()).toMatchObject({ currentlyPlayingId: 'rec-1', isPlaying: true })
    off()
    unmount()
  })

  it('a page video that starts stops the recording', async () => {
    const { unmount } = renderHook(() => useAudioPlayback())
    await act(async () => { await window.__audioControls!.play('rec-1', '/rec-1.mp3') })
    expect(useUIStore.getState().currentlyPlayingId).toBe('rec-1')

    const video = pageVideo()
    const off = registerElementMedia(video, () => ({ kind: 'video', title: 'Clip' }))
    await act(async () => { await video.play() })

    expect(useUIStore.getState()).toMatchObject({ currentlyPlayingId: null, isPlaying: false })
    expect(useMediaSessionStore.getState()).toMatchObject({ isPlaying: true, active: { title: 'Clip' } })
    off()
    unmount()
  })
})
