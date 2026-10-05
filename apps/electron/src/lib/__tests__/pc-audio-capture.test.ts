import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PcAudioCapture } from '../pc-audio-capture'

function stream(audio = true) {
  const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), readyState: 'live' }
  return { getTracks: () => [track], getAudioTracks: () => audio ? [track] : [], getVideoTracks: () => [], track }
}
let mic: ReturnType<typeof stream>, system: ReturnType<typeof stream>
let sources: Array<{ connect: ReturnType<typeof vi.fn> }>
let monoNodes: Array<{ connect: ReturnType<typeof vi.fn> }>
const append = vi.fn(async () => undefined)
const finish = vi.fn(async () => ({ success: true }))
class FakeRecorder {
  static instance: FakeRecorder
  static isTypeSupported = () => true
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public stream: unknown, public options: unknown) { FakeRecorder.instance = this }
  start = vi.fn(() => { this.state = 'recording' })
  stop() { this.state = 'inactive'; this.onstop?.() }
}
beforeEach(() => {
  vi.clearAllMocks()
  sources = []
  monoNodes = []
  mic = stream(); system = stream()
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: vi.fn(async () => mic), getDisplayMedia: vi.fn(async () => system)
  } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', class {
    createChannelMerger = vi.fn(() => ({ connect: vi.fn() }))
    createMediaStreamDestination = () => ({ stream: stream(), channelCount: 2 })
    createMediaStreamSource() { const source = { connect: vi.fn() }; sources.push(source); return source }
    createGain = () => { const mono = { channelCount: 1, channelCountMode: '', connect: vi.fn() }; monoNodes.push(mono); return mono }
    createAnalyser = () => ({ fftSize: 256, getFloatTimeDomainData: vi.fn(), connect: vi.fn() })
    resume = async () => undefined
    close = async () => undefined
  })
})
afterEach(() => vi.unstubAllGlobals())
function capture() {
  return new PcAudioCapture({ start: async () => 'session', append, finish }, vi.fn())
}
describe('PC stereo capture', () => {
  it('waits for an inactive encoder error final chunk and stop before importing', async () => {
    const recorder = capture(); await recorder.start()
    const media = FakeRecorder.instance
    media.state = 'inactive'; media.onerror?.()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(finish).not.toHaveBeenCalled()
    media.ondataavailable?.({ data: { size: 1, arrayBuffer: async () => new Uint8Array([7]).buffer } as Blob })
    media.onstop?.()
    await expect(recorder.stop()).rejects.toThrow(/Audio recording failed/)
    expect(append).toHaveBeenCalledWith('session', 0, new Uint8Array([7]))
    expect(finish).toHaveBeenCalledWith('session')
  })
  it('bounds the wait when an inactive encoder error never emits stop', async () => {
    vi.useFakeTimers()
    try {
      const recorder = capture(); await recorder.start()
      FakeRecorder.instance.state = 'inactive'; FakeRecorder.instance.onerror?.()
      const stopped = expect(recorder.stop()).rejects.toThrow(/Audio recording failed/)
      await vi.advanceTimersByTimeAsync(5000)
      await stopped
      expect(finish).toHaveBeenCalledWith('session')
      expect(mic.track.stop).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('saves and releases capture when MediaRecorder stops by itself', async () => {
    const onError = vi.fn()
    const recorder = new PcAudioCapture({ start: async () => 'session', append, finish }, onError)
    await recorder.start()
    FakeRecorder.instance.state = 'inactive'
    FakeRecorder.instance.onstop?.()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('session'))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'))
    expect(mic.track.stop).toHaveBeenCalled()
  })
  it('releases sources if MediaRecorder never sends its stop event', async () => {
    vi.useFakeTimers()
    try {
      const recorder = capture(); await recorder.start()
      FakeRecorder.instance.stop = () => { FakeRecorder.instance.state = 'inactive' }
      const stopped = expect(recorder.stop()).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(5000)
      await stopped
      expect(mic.track.stop).toHaveBeenCalled()
      expect(system.track.stop).toHaveBeenCalled()
      expect(finish).toHaveBeenCalledWith('session')
    } finally { vi.useRealTimers() }
  })
  it('releases the display stream if requesting the microphone throws synchronously', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => { throw new Error('unavailable') })
    await expect(capture().start()).rejects.toThrow(/Microphone capture failed/)
    expect(system.track.stop).toHaveBeenCalled()
  })
  it('stops source and destination tracks before waiting for a stalled import', async () => {
    let imported!: (value: { success: boolean }) => void
    finish.mockImplementationOnce(() => new Promise((resolve) => { imported = resolve }))
    const recorder = capture(); await recorder.start()
    const destination = FakeRecorder.instance.stream as ReturnType<typeof stream>
    const stopped = recorder.stop()
    await vi.waitFor(() => expect(finish).toHaveBeenCalled())
    expect(mic.track.stop).toHaveBeenCalled()
    expect(system.track.stop).toHaveBeenCalled()
    expect(mic.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function))
    expect(system.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function))
    expect(destination.track.stop).toHaveBeenCalled()
    imported({ success: true }); await stopped
  })
  it('routes mono mic to left and mono system to right, then flushes before import', async () => {
    const recorder = capture()
    await recorder.start()
    const media = FakeRecorder.instance
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    expect(sources).toHaveLength(2)
    // Sources connect through mono gain nodes; merger input order is fixed.
    expect(monoNodes[0].connect.mock.calls[0].slice(1)).toEqual([0, 0])
    expect(monoNodes[1].connect.mock.calls[0].slice(1)).toEqual([0, 1])
    expect(media.stream).toHaveProperty('getTracks')
    expect(media.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 })
    const blob = { size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer } as Blob
    media.ondataavailable?.({ data: blob })
    await recorder.stop()
    expect(append).toHaveBeenCalledWith('session', 0, new Uint8Array([1, 2, 3, 4]))
    expect(finish).toHaveBeenCalledWith('session')
    expect(mic.track.stop).toHaveBeenCalled()
    expect(system.track.stop).toHaveBeenCalled()
  })
  it('blocks capture with a clear system error and releases mic', async () => {
    vi.mocked(navigator.mediaDevices.getDisplayMedia).mockRejectedValue(new Error('permission denied'))
    await expect(capture().start()).rejects.toThrow(/System audio capture failed.*permission denied/)
    expect(mic.track.stop).toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
  })
  it('refuses a display stream without audio', async () => {
    system = stream(false)
    await expect(capture().start()).rejects.toThrow(/System audio capture failed/)
    expect(mic.track.stop).toHaveBeenCalled()
    expect(system.track.stop).toHaveBeenCalled()
  })
  it('stops and saves when the system source ends instead of continuing mic-only', async () => {
    const onError = vi.fn()
    const recorder = new PcAudioCapture({ start: async () => 'session', append, finish }, onError)
    await recorder.start()
    const ended = system.track.addEventListener.mock.calls.find(([name]) => name === 'ended')![1]
    ended()
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('session'))
    await expect(recorder.stop()).rejects.toThrow(/System audio source stopped/)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('System audio source stopped'))
    expect(mic.track.stop).toHaveBeenCalled()
  })
  it('surfaces failed chunk persistence and stops capture', async () => {
    append.mockRejectedValueOnce(new Error('Disk full'))
    const onError = vi.fn()
    const recorder = new PcAudioCapture({ start: async () => 'session', append, finish }, onError)
    await recorder.start()
    FakeRecorder.instance.ondataavailable?.({ data: { size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer } as Blob })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Disk full'))
    await expect(recorder.stop()).rejects.toThrow('Disk full')
    expect(mic.track.stop).toHaveBeenCalled()
  })
})
