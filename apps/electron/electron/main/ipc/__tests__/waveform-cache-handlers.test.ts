import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)),
  queryOne: vi.fn(),
  updateRecordingDuration: vi.fn(),
  getWaveformCache: vi.fn(),
  setWaveformCache: vi.fn(),
  clearWaveformCache: vi.fn(),
  cancelWaveformDecode: vi.fn(),
  getWaveformSourceIdentity: vi.fn(),
  requestWaveformDecode: vi.fn(),
  sameWaveformSource: vi.fn((left: any, right: any) => left.fingerprint === right.fingerprint)
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../services/database', () => ({
  queryOne: mocks.queryOne,
  updateRecordingDuration: mocks.updateRecordingDuration
}))
vi.mock('../../services/waveform-cache', () => ({
  getWaveformCache: mocks.getWaveformCache,
  setWaveformCache: mocks.setWaveformCache,
  clearWaveformCache: mocks.clearWaveformCache
}))
vi.mock('../../services/waveform-stream-decoder', () => ({
  cancelWaveformDecode: mocks.cancelWaveformDecode,
  getWaveformSourceIdentity: mocks.getWaveformSourceIdentity,
  requestWaveformDecode: mocks.requestWaveformDecode,
  sameWaveformSource: mocks.sameWaveformSource,
  WAVEFORM_MAX_CHANNELS: 8,
  WAVEFORM_PEAKS: 1000
}))

import { registerWaveformCacheHandlers } from '../waveform-cache-handlers'

const identity = {
  canonicalPath: 'C:/synthetic/selected.wav',
  size: 128,
  mtimeMs: 1,
  ctimeMs: 1,
  device: '1',
  fileId: '2',
  fingerprint: 'synthetic-source-fingerprint'
}
const peaks = new Array<number>(1000).fill(0.25)
const channels = [peaks, new Array<number>(1000).fill(0.7)]
const decoded = {
  sourceIdentity: identity,
  codec: 'synthetic',
  sourceSampleRate: 16000,
  durationSeconds: 120.25,
  framesAtOutputRate: 962000,
  maxPcmChunkBytes: 65536,
  peaks,
  channels,
  channelLabels: ['Channel 0', 'Channel 1']
}

function event() {
  return { sender: Object.assign(new EventEmitter(), { id: 9 }) } as any
}

function cacheEntry(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    recordingId: 'recording-1',
    peaks,
    channels,
    sampleCount: 1000,
    duration: 120.25,
    fileSize: identity.size,
    createdAt: '2026-10-13T00:00:00.000Z',
    ...overrides
  }
}

function handler(channel: string): (...args: any[]) => any {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing handler ${channel}`)
  return registered
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  mocks.getWaveformSourceIdentity.mockReturnValue(identity)
  mocks.sameWaveformSource.mockImplementation((left: any, right: any) => left.fingerprint === right.fingerprint)
  registerWaveformCacheHandlers()
})

describe('waveform cache readiness and lazy repair', () => {
  it('serves a complete exact-size legacy v2 entry without forcing fingerprint migration', async () => {
    const legacy = cacheEntry()
    mocks.queryOne.mockReturnValue({ file_path: identity.canonicalPath, duration_seconds: 120 })
    mocks.getWaveformCache.mockReturnValue(legacy)

    const result = await handler('waveform:getCache')(event(), 'recording-1')
    expect(result).toBe(legacy)
    expect(mocks.getWaveformCache).toHaveBeenCalledWith('recording-1', identity.size, identity.fingerprint)
    expect(mocks.requestWaveformDecode).toHaveBeenCalledTimes(0)
  })

  it('does not start a decode for read-only playback cache checks', async () => {
    mocks.queryOne.mockReturnValue({ file_path: identity.canonicalPath, duration_seconds: 120 })
    mocks.getWaveformCache.mockReturnValue(cacheEntry({ coarse: true }))

    const result = await handler('waveform:getCache')(event(), 'recording-1')
    expect(result).toBeNull()
    expect(mocks.requestWaveformDecode).toHaveBeenCalledTimes(0)
  })

  it('repairs an incomplete selected entry once, preserving both channels and backfilling only a null duration', async () => {
    mocks.queryOne
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: null })
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: null })
    const generated = cacheEntry({ sourceFingerprint: identity.fingerprint, coarse: false })
    mocks.getWaveformCache.mockReturnValueOnce(cacheEntry({ coarse: true })).mockReturnValueOnce(generated)
    mocks.requestWaveformDecode.mockResolvedValue(decoded)
    mocks.setWaveformCache.mockReturnValue(true)

    const requestEvent = event()
    const result = await handler('waveform:getCache')(requestEvent, 'recording-1', undefined, 'request-1')
    expect(result).toBe(generated)
    expect(mocks.requestWaveformDecode).toHaveBeenCalledWith(identity.canonicalPath, '9:request-1')
    expect(mocks.setWaveformCache).toHaveBeenCalledWith(
      'recording-1', peaks, decoded.durationSeconds, identity.size, false, channels, identity.fingerprint
    )
    expect(mocks.updateRecordingDuration).toHaveBeenCalledWith('recording-1', decoded.durationSeconds, 'file')
    expect(requestEvent.sender.listenerCount('destroyed')).toBe(0)
    expect(requestEvent.sender.listenerCount('render-process-gone')).toBe(0)
    expect(requestEvent.sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it('keeps a known database duration when a selected cache entry is repaired', async () => {
    mocks.queryOne
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: 120 })
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: 120 })
    const generated = cacheEntry({ sourceFingerprint: identity.fingerprint, coarse: false })
    mocks.getWaveformCache.mockReturnValueOnce(cacheEntry({ coarse: true })).mockReturnValueOnce(generated)
    mocks.requestWaveformDecode.mockResolvedValue(decoded)
    mocks.sameWaveformSource.mockImplementation((left: any, right: any) => left.fingerprint === right.fingerprint)

    const result = await handler('waveform:getCache')(event(), 'recording-1', undefined, 'request-2')
    expect(result).toBe(generated)
    expect(mocks.setWaveformCache).toHaveBeenCalled()
    expect(mocks.updateRecordingDuration).toHaveBeenCalledTimes(0)
  })

  it('rejects and does not persist results if the selected source identity changes mid-decode', async () => {
    mocks.queryOne
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: null })
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: null })
    const changed = { ...identity, fingerprint: 'changed-source' }
    mocks.getWaveformCache.mockReturnValueOnce(cacheEntry({ coarse: true }))
    mocks.requestWaveformDecode.mockResolvedValue({ ...decoded, sourceIdentity: changed })

    const result = await handler('waveform:getCache')(event(), 'recording-1', undefined, 'request-3')
    expect(result).toBeNull()
    expect(mocks.setWaveformCache).toHaveBeenCalledTimes(0)
    expect(mocks.updateRecordingDuration).toHaveBeenCalledTimes(0)
  })

  it('cancels only for a full main-frame navigation and removes lifecycle listeners after settling', async () => {
    mocks.queryOne
      .mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: null })
    mocks.getWaveformCache.mockReturnValue(cacheEntry({ coarse: true }))
    let rejectDecode!: (error: Error) => void
    mocks.requestWaveformDecode.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDecode = reject }))
    const requestEvent = event()
    const pending = handler('waveform:getCache')(requestEvent, 'recording-1', undefined, 'reload-request')

    await vi.waitFor(() => expect(requestEvent.sender.listenerCount('did-start-navigation')).toBe(1))
    requestEvent.sender.emit('did-start-navigation', {}, 'file://app/#route', true, true)
    requestEvent.sender.emit('did-start-navigation', {}, 'file://app/child', false, false)
    expect(mocks.cancelWaveformDecode).not.toHaveBeenCalled()

    requestEvent.sender.emit('did-start-navigation', {}, 'file://app', false, true)
    expect(mocks.cancelWaveformDecode).toHaveBeenCalledTimes(1)
    expect(mocks.cancelWaveformDecode).toHaveBeenCalledWith('9:reload-request')
    rejectDecode(new Error('Waveform decode cancelled'))
    await expect(pending).resolves.toBeNull()
    expect(requestEvent.sender.listenerCount('destroyed')).toBe(0)
    expect(requestEvent.sender.listenerCount('render-process-gone')).toBe(0)
    expect(requestEvent.sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it('cancels the owning request when the renderer process exits', async () => {
    mocks.queryOne.mockReturnValueOnce({ file_path: identity.canonicalPath, duration_seconds: 120 })
    mocks.getWaveformCache.mockReturnValue(cacheEntry({ coarse: true }))
    let rejectDecode!: (error: Error) => void
    mocks.requestWaveformDecode.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDecode = reject }))
    const requestEvent = event()
    const pending = handler('waveform:getCache')(requestEvent, 'recording-1', undefined, 'crash-request')
    await vi.waitFor(() => expect(requestEvent.sender.listenerCount('render-process-gone')).toBe(1))

    requestEvent.sender.emit('render-process-gone')
    expect(mocks.cancelWaveformDecode).toHaveBeenCalledWith('9:crash-request')
    rejectDecode(new Error('Waveform decode cancelled'))
    await expect(pending).resolves.toBeNull()
    expect(requestEvent.sender.listenerCount('render-process-gone')).toBe(0)
  })

  it('registers handlers without enqueueing work for every recording at startup', () => {
    expect(mocks.handlers.has('waveform:getCache')).toBe(true)
    expect(mocks.handlers.has('waveform:cancelGeneration')).toBe(true)
    expect(mocks.requestWaveformDecode).toHaveBeenCalledTimes(0)
  })
})
