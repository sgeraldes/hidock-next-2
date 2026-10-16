// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeviceNativeRecordingControl } from '../device-native-recording'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-command-'))
  const device = {
    getModel: () => 'hidock-h1e', versionCode: '6.3.0', versionNumber: 393984, serialNumber: 'test-device',
    isConnected: () => true,
    getRecordingStatus: vi.fn(async () => ({ recording: 'test.mp3' as string | null, duration: 3, samples: [], type: 'recording' as const })),
    getRecordingFile: vi.fn(async () => ({ recording: null as string | null })),
    addNativeMarker: vi.fn(async () => ({ result: 'success' })),
    toggleNativeRecording: vi.fn(async () => ({ result: 'success' }))
  }
  let chain = Promise.resolve<unknown>(undefined)
  const deps = { device: () => device, busy: () => false, liveIdle: () => true, directory: () => directory,
    serialize: <T>(operation: () => Promise<T>): Promise<T> => { const run = chain.then(operation, operation); chain = run.catch(() => undefined); return run } }
  return { device, deps, control: new DeviceNativeRecordingControl(deps), cleanup: () => rm(directory, { recursive: true, force: true }) }
}
describe('native recording controls', () => {
  it.each([393984, 393985, 393986, 393987, 393988, 393990])('acknowledges marker and durably suppresses repeats across recreation (version=%s)', async version => {
    const f = await fixture()
    f.device.versionNumber = version; f.device.versionCode = `6.3.${version - 393984}`
    try {
      const request = { requestId: randomUUID(), expectedRecording: 'test.mp3' }
      const result = await f.control.dispatch('marker', request)
      expect(result).toEqual({ status: 'acknowledged', persistence: 'unverified' })
      expect(await new DeviceNativeRecordingControl(f.deps).dispatch('marker', request)).toEqual({ status: 'duplicate', previousStatus: 'acknowledged', persistence: 'unverified' })
      expect(f.device.addNativeMarker).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it('never retries an inconclusive key command and rejects identity reuse', async () => {
    const f = await fixture()
    try {
      f.device.addNativeMarker.mockRejectedValueOnce(new Error('USB timeout'))
      const request = { requestId: randomUUID(), expectedRecording: 'test.mp3' }
      expect((await f.control.dispatch('marker', request)).status).toBe('inconclusive')
      expect((await f.control.dispatch('marker', request)).status).toBe('duplicate')
      await expect(f.control.dispatch('toggle', request)).rejects.toThrow('identity')
      expect(f.device.addNativeMarker).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it('checks the expected active file and does not mark idle or a changed file', async () => {
    const f = await fixture()
    try {
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'other.mp3' })).rejects.toThrow('changed')
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: null })).rejects.toThrow('Invalid')
      expect(f.device.addNativeMarker).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it.each([393984, 393985, 393986, 393987, 393988, 393990])('blocks live start with fresh native file and requires corroborated idle (version=%s)', async version => {
    const f = await fixture(), start = vi.fn(async () => 'started')
    f.device.versionNumber = version; f.device.versionCode = `6.3.${version - 393984}`
    try {
      await expect(f.control.startLive(start)).rejects.toThrow('native recording is active')
      f.device.getRecordingStatus.mockResolvedValue({ recording: null, duration: 0, samples: [], type: 'recording' })
      f.device.getRecordingFile.mockResolvedValueOnce({ recording: 'test.mp3' })
      await expect(f.control.startLive(start)).rejects.toThrow('could not be confirmed')
      expect(start).not.toHaveBeenCalled()
      expect(await f.control.startLive(start)).toBe('started')
      expect(start).toHaveBeenCalledOnce()
      expect(f.device.getRecordingStatus).toHaveBeenCalledTimes(3)
      expect(f.device.getRecordingFile).toHaveBeenCalledTimes(2)
      await expect(f.control.startLive(start, () => false)).rejects.toThrow('ended before starting')
      expect(start).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it.each([[393986, '6.3.1'], [393987, '6.3.2'], [393988, '6.3.2'], [393989, '6.3.4'], [393989, '6.3.5'], [393990, '6.3.5'], [393989, '6.3.6'], [393991, '6.3.6'], [393990, '6.3.60']])('rejects incoherent/unknown native pair%s/%s before status, key or journal', async (version, code) => {
    const f = await fixture(); f.device.versionNumber = version as number; f.device.versionCode = code as string
    try {
      await expect(f.control.status()).rejects.toThrow('Native controls require')
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'test.mp3' })).rejects.toThrow('Native controls require')
      expect(f.device.getRecordingStatus).not.toHaveBeenCalled(); expect(f.device.getRecordingFile).not.toHaveBeenCalled()
      expect(f.device.addNativeMarker).not.toHaveBeenCalled(); expect(f.device.toggleNativeRecording).not.toHaveBeenCalled()
      expect(await readdir(f.deps.directory())).toEqual([])
    } finally { await f.cleanup() }
  })
  it.each(['hidock-h1', 'hidock-p1', 'unknown', 'disconnected'])('rejects non-H1E/unavailable%s with an otherwise qualified new version', async state => {
    const f = await fixture(); f.device.versionNumber = 393986; f.device.versionCode = '6.3.2'
    if (state === 'disconnected') f.device.isConnected = () => false
    else f.device.getModel = () => state
    try {
      await expect(f.control.status()).rejects.toThrow('Native controls require')
      await expect(f.control.dispatch('toggle', { requestId: randomUUID(), expectedRecording: null })).rejects.toThrow('Native controls require')
      expect(f.device.getRecordingStatus).not.toHaveBeenCalled(); expect(f.device.toggleNativeRecording).not.toHaveBeenCalled()
      expect(await readdir(f.deps.directory())).toEqual([])
    } finally { await f.cleanup() }
  })
  it.each([393986, 393987, 393988, 393990])('persists a rejected key and never retries it (version=%s)', async version => {
    const f = await fixture(); f.device.versionNumber = version; f.device.versionCode = `6.3.${version - 393984}`
    f.device.addNativeMarker.mockResolvedValue({ result: 'failed' })
    try {
      const request = { requestId: randomUUID(), expectedRecording: 'test.mp3' }
      expect(await f.control.dispatch('marker', request)).toMatchObject({ status: 'rejected' })
      const files = await readdir(f.deps.directory()); expect(files).toHaveLength(1)
      expect(JSON.parse(await readFile(join(f.deps.directory(), files[0]), 'utf8')).status).toBe('rejected')
      expect(await new DeviceNativeRecordingControl(f.deps).dispatch('marker', request)).toMatchObject({ status: 'duplicate', previousStatus: 'rejected' })
      expect(f.device.addNativeMarker).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it('fails closed on unknown status, busy USB, different firmware and live ownership', async () => {
    const f = await fixture(), start = vi.fn(async () => undefined)
    try {
      f.device.getRecordingStatus.mockResolvedValueOnce(null as never)
      await expect(f.control.startLive(start)).rejects.toThrow('unknown')
      f.deps.busy = () => true
      await expect(f.control.status()).rejects.toThrow('busy')
      f.deps.busy = () => false
      f.deps.liveIdle = () => false
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'test.mp3' })).rejects.toThrow('Stop live')
      f.deps.liveIdle = () => true
      f.device.versionNumber++
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'test.mp3' })).rejects.toThrow('qualified REA1')
      expect(start).not.toHaveBeenCalled()
      expect(f.device.addNativeMarker).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('serializes concurrent duplicate submissions into a single hardware key', async () => {
    const f = await fixture()
    try {
      const request = { requestId: randomUUID(), expectedRecording: 'test.mp3' }
      const results = await Promise.all([f.control.dispatch('marker', request), f.control.dispatch('marker', request)])
      expect(results.map(r => r.status)).toEqual(['acknowledged', 'duplicate'])
      expect(f.device.addNativeMarker).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it.each([393984, 393986, 393987, 393988, 393990])('holds automatic USB work until the new verification file is protected (version=%s)', async version => {
    const f = await fixture()
    f.device.versionNumber = version; f.device.versionCode = `6.3.${version - 393984}`
    try {
      let release!: () => void
      const protect = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
      const control = new DeviceNativeRecordingControl({ ...f.deps, protectNewFile: protect })
      f.device.getRecordingStatus.mockResolvedValueOnce({ recording: null, duration: 0, samples: [], type: 'recording' })
      const start = control.startVerification({ requestId: randomUUID(), expectedRecording: null })
      await vi.waitFor(() => expect(protect).toHaveBeenCalledWith('test.mp3'))
      const automaticScan = vi.fn(async () => undefined)
      const queued = f.deps.serialize(automaticScan)
      await Promise.resolve()
      expect(automaticScan).not.toHaveBeenCalled()
      release()
      expect(await start).toMatchObject({ status: 'acknowledged', recording: 'test.mp3', manualOnly: true, persistence: 'unverified' })
      await queued
      expect(automaticScan).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })
  it('does not send a key to a replacement device after waiting for status', async () => {
    const f = await fixture()
    try {
      f.device.getRecordingStatus.mockImplementationOnce(async () => {
        f.device.serialNumber = 'replacement-device'
        return { recording: 'test.mp3', duration: 3, samples: [], type: 'recording' }
      })
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'test.mp3' })).rejects.toThrow('changed')
      expect(f.device.addNativeMarker).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
})

describe('exact 393990 / 6.3.6 diagnostic pair reaches the native controls', () => {
  async function diagnostic() {
    const f = await fixture(); f.device.versionNumber = 393990; f.device.versionCode = '6.3.6'
    return f
  }
  it('reads fresh status and sends one marker with a durable reservation and duplicate suppression', async () => {
    const f = await diagnostic()
    try {
      expect(await f.control.status()).toMatchObject({ recording: 'test.mp3' })
      expect(f.device.getRecordingStatus).toHaveBeenCalledTimes(1)
      const request = { requestId: randomUUID(), expectedRecording: 'test.mp3' }
      expect(await f.control.dispatch('marker', request)).toEqual({ status: 'acknowledged', persistence: 'unverified' })
      expect(f.device.getRecordingStatus).toHaveBeenCalledTimes(2)
      expect(await readdir(f.deps.directory())).toHaveLength(1)
      expect(await f.control.dispatch('marker', request)).toEqual({ status: 'duplicate', previousStatus: 'acknowledged', persistence: 'unverified' })
      expect(f.device.addNativeMarker).toHaveBeenCalledOnce(); expect(f.device.toggleNativeRecording).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('sends one toggle from a corroborated idle state and never resends it, including after an inconclusive reply', async () => {
    const f = await diagnostic()
    try {
      f.device.getRecordingStatus.mockResolvedValue({ recording: null, duration: 0, samples: [], type: 'recording' })
      const request = { requestId: randomUUID(), expectedRecording: null }
      expect(await f.control.dispatch('toggle', request)).toEqual({ status: 'acknowledged', persistence: 'unverified' })
      expect(f.device.getRecordingFile).toHaveBeenCalledTimes(1)
      expect(await f.control.dispatch('toggle', request)).toMatchObject({ status: 'duplicate', previousStatus: 'acknowledged' })
      f.device.toggleNativeRecording.mockRejectedValueOnce(new Error('USB timeout'))
      const second = { requestId: randomUUID(), expectedRecording: null }
      expect((await f.control.dispatch('toggle', second)).status).toBe('inconclusive')
      expect((await f.control.dispatch('toggle', second)).status).toBe('duplicate')
      expect(f.device.toggleNativeRecording).toHaveBeenCalledTimes(2); expect(f.device.addNativeMarker).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it('keeps busy, live-idle, changed-file and replacement-device fences before any command on 6.3.6', async () => {
    const f = await diagnostic()
    try {
      const marker = () => ({ requestId: randomUUID(), expectedRecording: 'test.mp3' })
      f.deps.busy = () => true
      await expect(f.control.dispatch('marker', marker())).rejects.toThrow('busy')
      f.deps.busy = () => false; f.deps.liveIdle = () => false
      await expect(f.control.dispatch('toggle', { requestId: randomUUID(), expectedRecording: 'test.mp3' })).rejects.toThrow('Stop live')
      f.deps.liveIdle = () => true
      await expect(f.control.dispatch('marker', { requestId: randomUUID(), expectedRecording: 'other.mp3' })).rejects.toThrow('changed')
      f.device.getRecordingStatus.mockImplementationOnce(async () => { f.device.serialNumber = 'replacement-device'; return { recording: 'test.mp3', duration: 3, samples: [], type: 'recording' } })
      await expect(f.control.dispatch('marker', marker())).rejects.toThrow('changed')
      expect(f.device.addNativeMarker).not.toHaveBeenCalled(); expect(f.device.toggleNativeRecording).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
  it.each(['hidock-h1', 'hidock-p1', 'unknown', 'disconnected'])('rejects the 6.3.6 pair on %s before status, key or journal', async state => {
    const f = await diagnostic()
    if (state === 'disconnected') f.device.isConnected = () => false
    else f.device.getModel = () => state
    try {
      await expect(f.control.status()).rejects.toThrow('Native controls require')
      await expect(f.control.dispatch('toggle', { requestId: randomUUID(), expectedRecording: null })).rejects.toThrow('Native controls require')
      expect(f.device.getRecordingStatus).not.toHaveBeenCalled(); expect(f.device.addNativeMarker).not.toHaveBeenCalled(); expect(f.device.toggleNativeRecording).not.toHaveBeenCalled()
      expect(await readdir(f.deps.directory())).toEqual([])
    } finally { await f.cleanup() }
  })
  it('names the admitted diagnostic pair in the refusal text for stock-forward 393989/6.3.5', async () => {
    const f = await fixture(); f.device.versionNumber = 393989; f.device.versionCode = '6.3.5'
    try { await expect(f.control.status()).rejects.toThrow('admitted custom diagnostic 6.3.6') } finally { await f.cleanup() }
  })
})
