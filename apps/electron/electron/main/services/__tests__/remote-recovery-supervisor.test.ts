// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRecoverySupervisor,
  REMOTE_RECOVERY_SCAN_INTERVAL_MS,
  type RemoteRecoveryScan
} from '../remote-recovery-supervisor'

const BASE = 1000
const config = { modelHostUrl: 'http://127.0.0.1:1', modelHostToken: 'fixture' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('remote recovery supervisor', () => {
  it('defaults to a 30 second scan interval', () => {
    expect(REMOTE_RECOVERY_SCAN_INTERVAL_MS).toBe(30_000)
  })

  it('scans at start and then once per interval', async () => {
    const recover = vi.fn<RemoteRecoveryScan>(async () => {})
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('reads the current config on every scan so credentials follow the configured host', async () => {
    let current = { modelHostUrl: 'http://127.0.0.1:1', modelHostToken: 'first' }
    const recover = vi.fn<RemoteRecoveryScan>(async () => {})
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => current, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    current = { modelHostUrl: 'https://other.example', modelHostToken: 'second' }
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover.mock.calls.map(([seen]) => seen)).toEqual([
      { modelHostUrl: 'http://127.0.0.1:1', modelHostToken: 'first' },
      { modelHostUrl: 'https://other.example', modelHostToken: 'second' }
    ])
    supervisor.stop()
  })

  it('does not start a second scan while one is still running', async () => {
    let release!: () => void
    const recover = vi.fn<RemoteRecoveryScan>(() => new Promise<void>(resolve => { release = resolve }))
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(BASE * 5)
    expect(recover).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('backs off after failures, caps the delay, and returns to the base interval after a success', async () => {
    let fail = true
    const recover = vi.fn<RemoteRecoveryScan>(async () => { if (fail) throw new Error('scan failed') })
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1) // fails, next scan in 2 * BASE
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(2) // fails, next in 4 * BASE
    await vi.advanceTimersByTimeAsync(BASE * 3)
    expect(recover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(3) // fails, next in 8 * BASE
    await vi.advanceTimersByTimeAsync(BASE * 8)
    expect(recover).toHaveBeenCalledTimes(4) // fails, next in 10 * BASE (cap)
    await vi.advanceTimersByTimeAsync(BASE * 10)
    expect(recover).toHaveBeenCalledTimes(5) // still capped at 10 * BASE
    fail = false
    await vi.advanceTimersByTimeAsync(BASE * 10)
    expect(recover).toHaveBeenCalledTimes(6) // succeeds, back to BASE
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(7)
    supervisor.stop()
  })

  it('stop cancels the pending scan and nothing resurrects it', async () => {
    const recover = vi.fn<RemoteRecoveryScan>(async () => {})
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1)
    supervisor.stop()
    await vi.advanceTimersByTimeAsync(BASE * 20)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a scan that finishes after stop does not schedule another', async () => {
    let release!: () => void
    const recover = vi.fn<RemoteRecoveryScan>(() => new Promise<void>(resolve => { release = resolve }))
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    supervisor.stop()
    release()
    await vi.advanceTimersByTimeAsync(BASE * 20)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a completion from a stopped lifecycle is dropped, one from the current lifecycle is forwarded', async () => {
    const callbacks: Array<(recordingId: string, model: string, stage: string) => void> = []
    const recover = vi.fn<RemoteRecoveryScan>(async (_config, onComplete) => { callbacks.push(onComplete) })
    const onComplete = vi.fn()
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete, intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    const stale = callbacks[0]
    stale('recording', 'model', 'transcription')
    expect(onComplete).toHaveBeenCalledTimes(1) // current lifecycle: forwarded unchanged

    supervisor.stop()
    stale('recording', 'model', 'transcription')
    expect(onComplete).toHaveBeenCalledTimes(1) // after stop: dropped

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    stale('recording', 'model', 'transcription')
    expect(onComplete).toHaveBeenCalledTimes(1) // after restart the old callback stays dead
    callbacks[1]('recording', 'model', 'transcription')
    expect(onComplete).toHaveBeenCalledTimes(2)
    expect(onComplete).toHaveBeenLastCalledWith('recording', 'model', 'transcription')
    supervisor.stop()
  })

  it('start while running is a no-op, and a restart begins a fresh schedule', async () => {
    const recover = vi.fn<RemoteRecoveryScan>(async () => {})
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1)
    supervisor.stop()
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
    supervisor.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a restart while the old scan is still settling waits instead of overlapping it', async () => {
    const releases: Array<() => void> = []
    const recover = vi.fn<RemoteRecoveryScan>(() => new Promise<void>(resolve => { releases.push(resolve) }))
    const supervisor = createRemoteRecoverySupervisor({ getConfig: () => config, recover,
      onComplete: vi.fn(), intervalMs: BASE })
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    supervisor.stop()
    supervisor.start() // first scan of the new lifecycle meets the old one still running
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1)
    releases[0]()
    await vi.advanceTimersByTimeAsync(BASE)
    expect(recover).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })
})
