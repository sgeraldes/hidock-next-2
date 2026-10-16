/** @vitest-environment node */
import { afterEach, expect, it, vi } from 'vitest'
import { createDeviceShutdown } from '../device-shutdown'
import { createQuitCleanup } from '../quit-cleanup'
import { __resetActiveTransferForTests, cancelAllTransfers, getActiveTransferFilename, hasPendingTransfer, trackActiveTransfer } from '../services/download-transfer-controller'

afterEach(() => __resetActiveTransferForTests())
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('aborts real active and queued intents immediately and holds quit through drain, audio and unmount', async () => {
  const drain = gate(), audio = gate(), unmap = gate()
  const activeAbort = new AbortController(), queuedAbort = new AbortController()
  const order: string[] = []
  const active = trackActiveTransfer('active.hda', activeAbort, async () => { await drain.promise; order.push('drained') })
  await vi.waitFor(() => expect(getActiveTransferFilename()).toBe('active.hda'))
  const queuedStart = vi.fn(async () => undefined)
  const queued = trackActiveTransfer('queued.hda', queuedAbort, queuedStart).catch(error => error)
  const stop = createDeviceShutdown({
    cancelTransfers: reason => { order.push('abort'); return cancelAllTransfers(reason) },
    finishAudio: async reason => { expect(reason).toBe('shutdown'); order.push('audio-invalidated'); await audio.promise; order.push('audio-finished') },
    unmountStorage: async () => { order.push('unmount'); await unmap.promise; order.push('unmounted') }
  })
  const quit = vi.fn(), onQuit = createQuitCleanup(stop, quit)
  onQuit({ preventDefault: vi.fn() }); onQuit({ preventDefault: vi.fn() })
  expect(activeAbort.signal.aborted).toBe(true)
  expect(queuedAbort.signal.aborted).toBe(true)
  expect(order).toEqual(['abort', 'audio-invalidated'])
  expect(quit).not.toHaveBeenCalled()
  expect(stop()).toBe(stop()) // No double-close while repeated quit waits.
  audio.resolve()
  await vi.waitFor(() => expect(order).toContain('audio-finished'))
  expect(order).not.toContain('unmount')
  expect(quit).not.toHaveBeenCalled()
  drain.resolve(); await active
  expect((await queued).name).toBe('AbortError')
  expect(queuedStart).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(order).toContain('unmount'))
  expect(hasPendingTransfer()).toBe(false)
  expect(quit).not.toHaveBeenCalled()
  unmap.resolve()
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  expect(order.filter(value => value === 'unmount')).toHaveLength(1)
  expect(order.at(-1)).toBe('unmounted')
})

it('still awaits storage cleanup after an audio failure and exposes no raw private error', async () => {
  const unmap = gate(), unmount = vi.fn(() => unmap.promise)
  const stop = createDeviceShutdown({ cancelTransfers: async () => false, finishAudio: async () => { throw Error('private-audio-path') }, unmountStorage: unmount })
  let settled = false
  const result = stop().catch(error => { settled = true; return error })
  await vi.waitFor(() => expect(unmount).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  unmap.resolve()
  expect((await result).message).toBe('Device shutdown cleanup could not complete')
})

it('sanitizes an unmap failure without retrying or double closing', async () => {
  const unmount = vi.fn(async () => { throw Error('http://127.0.0.1:1234/private-capability') })
  const stop = createDeviceShutdown({ cancelTransfers: async () => false, finishAudio: async () => undefined, unmountStorage: unmount })
  await expect(stop()).rejects.toThrow('Device shutdown cleanup could not complete')
  await expect(stop()).rejects.toThrow('Device shutdown cleanup could not complete')
  expect(unmount).toHaveBeenCalledOnce()
})

it('contains synchronous dependency failures and still finalizes other resources', async () => {
  const audio = vi.fn(async () => undefined), unmount = vi.fn(async () => undefined)
  const stop = createDeviceShutdown({ cancelTransfers: () => { throw Error('synchronous private failure') }, finishAudio: audio, unmountStorage: unmount })
  await expect(stop()).rejects.toThrow('Device shutdown cleanup could not complete')
  expect(audio).toHaveBeenCalledWith('shutdown')
  expect(unmount).toHaveBeenCalledOnce()
})
