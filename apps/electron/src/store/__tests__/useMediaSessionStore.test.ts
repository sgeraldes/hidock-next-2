/**
 * One playback at a time, across the whole app.
 *
 * Recordings play through the single element owned by useAudioPlayback
 * (window.__audioControls). Any other <audio> or <video> in a page registers
 * here. Starting one of them pauses every other registered element and stops
 * the recording player; starting the recording player pauses them all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerElementMedia,
  pauseElementMedia,
  useMediaSessionStore
} from '../useMediaSessionStore'

function fakeMedia(duration = 60): HTMLMediaElement {
  const element = document.createElement('audio')
  let paused = true
  let time = 0
  Object.defineProperty(element, 'paused', { get: () => paused })
  Object.defineProperty(element, 'duration', { get: () => duration })
  Object.defineProperty(element, 'currentTime', { get: () => time, set: (value: number) => { time = value } })
  element.play = vi.fn(async () => { paused = false; element.dispatchEvent(new Event('play')) })
  element.pause = vi.fn(() => {
    if (paused) return
    paused = true
    element.dispatchEvent(new Event('pause'))
  })
  return element
}

const stop = vi.fn()

beforeEach(() => {
  stop.mockClear()
  window.__audioControls = { stop } as unknown as typeof window.__audioControls
  useMediaSessionStore.setState({ active: null, isPlaying: false, currentTime: 0, duration: 0 })
})

afterEach(() => {
  delete window.__audioControls
})

describe('media session: one playback at a time', () => {
  it('pauses the previous element when another one starts', async () => {
    const first = fakeMedia()
    const second = fakeMedia()
    const offFirst = registerElementMedia(first, () => ({ kind: 'audio', title: 'Speaker sample' }))
    const offSecond = registerElementMedia(second, () => ({ kind: 'video', title: 'Clip' }))

    await first.play()
    expect(useMediaSessionStore.getState().active?.title).toBe('Speaker sample')

    await second.play()
    expect(first.pause).toHaveBeenCalled()
    expect(first.paused).toBe(true)
    expect(useMediaSessionStore.getState()).toMatchObject({ isPlaying: true, active: { title: 'Clip', kind: 'video' } })
    offFirst()
    offSecond()
  })

  it('stops the recording player when an element starts', async () => {
    const element = fakeMedia()
    const off = registerElementMedia(element, () => ({ kind: 'audio', title: 'Speaker sample' }))
    await element.play()
    expect(stop).toHaveBeenCalledOnce()
    off()
  })

  it('pauseElementMedia pauses every registered element (the recording player calls it before it plays)', async () => {
    const element = fakeMedia()
    const off = registerElementMedia(element, () => ({ kind: 'video', title: 'Clip' }))
    await element.play()
    pauseElementMedia()
    expect(element.paused).toBe(true)
    expect(useMediaSessionStore.getState().isPlaying).toBe(false)
    off()
  })

  it('clearElementSession on recording playback leaves no element session in the header', async () => {
    const element = fakeMedia()
    const off = registerElementMedia(element, () => ({ kind: 'video', title: 'Clip' }))
    await element.play()
    pauseElementMedia({ endSession: true })
    expect(useMediaSessionStore.getState().active).toBeNull()
    off()
  })

  it('tracks position and duration of the active element only', async () => {
    const active = fakeMedia(120)
    const idle = fakeMedia(30)
    const offActive = registerElementMedia(active, () => ({ kind: 'audio', title: 'A' }))
    const offIdle = registerElementMedia(idle, () => ({ kind: 'audio', title: 'B' }))
    await active.play()
    active.currentTime = 42
    active.dispatchEvent(new Event('timeupdate'))
    idle.currentTime = 7
    idle.dispatchEvent(new Event('timeupdate'))
    expect(useMediaSessionStore.getState()).toMatchObject({ currentTime: 42, duration: 120 })
    offActive()
    offIdle()
  })

  it('ends the session when the element ends or unmounts', async () => {
    const element = fakeMedia()
    const off = registerElementMedia(element, () => ({ kind: 'audio', title: 'A' }))
    await element.play()
    element.dispatchEvent(new Event('ended'))
    expect(useMediaSessionStore.getState().active).toBeNull()

    await element.play()
    expect(useMediaSessionStore.getState().active).not.toBeNull()
    off()
    expect(useMediaSessionStore.getState().active).toBeNull()
    // An unregistered element is no longer paused by others.
    const other = fakeMedia()
    const offOther = registerElementMedia(other, () => ({ kind: 'audio', title: 'B' }))
    ;(element.pause as ReturnType<typeof vi.fn>).mockClear()
    await other.play()
    expect(element.pause).not.toHaveBeenCalled()
    offOther()
  })
})
