// @vitest-environment node

/**
 * Unit tests for the active USB transfer controller (Phase-1 download cancellation).
 *
 * Verifies the coordination contract the cancel IPC handlers rely on:
 *  - a wrapped transfer is discoverable by filename while it runs, and cleared after
 *  - cancel aborts the active transfer and resolves ONLY after it settles
 *  - per-file cancel never aborts an unrelated transfer
 *  - abort reason is forwarded (disconnect vs user-cancel)
 *  - abort is idempotent
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  trackActiveTransfer,
  getActiveTransferFilename,
  hasActiveTransfer,
  abortActiveTransfer,
  cancelActiveTransfer,
  cancelActiveTransferByName,
  __resetActiveTransferForTests,
} from '../download-transfer-controller'

/** A controllable async "transfer" that resolves when released or on abort. */
function makeControllableTransfer(signal: AbortSignal) {
  let release!: (value: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    release = resolve
    signal.addEventListener('abort', () => resolve(false), { once: true })
  })
  return { promise, release }
}

describe('download-transfer-controller', () => {
  beforeEach(() => {
    __resetActiveTransferForTests()
  })

  it('reports no active transfer when idle', () => {
    expect(getActiveTransferFilename()).toBeNull()
    expect(hasActiveTransfer()).toBe(false)
  })

  it('exposes the active transfer filename while running and clears it after', async () => {
    const abort = new AbortController()
    const t = makeControllableTransfer(abort.signal)

    const run = trackActiveTransfer('a.hda', abort, () => t.promise)
    // Allow the async wrapper to register the transfer before asserting.
    await Promise.resolve()

    expect(getActiveTransferFilename()).toBe('a.hda')
    expect(hasActiveTransfer()).toBe(true)

    t.release(true)
    await run

    expect(getActiveTransferFilename()).toBeNull()
    expect(hasActiveTransfer()).toBe(false)
  })

  it('cancelActiveTransfer aborts and resolves only after the transfer settles', async () => {
    const abort = new AbortController()
    const t = makeControllableTransfer(abort.signal)

    let transferReturned = false
    const run = trackActiveTransfer('a.hda', abort, async () => {
      const r = await t.promise
      transferReturned = true
      return r
    })
    await Promise.resolve()

    const cancel = cancelActiveTransfer('user-cancel')
    // The signal is aborted synchronously; the transfer resolves via its abort listener.
    expect(abort.signal.aborted).toBe(true)

    const cancelled = await cancel
    expect(cancelled).toBe(true)
    // Settlement means the wrapped run() completed before cancel resolved.
    expect(transferReturned).toBe(true)
    await run
    expect(getActiveTransferFilename()).toBeNull()
  })

  it('forwards the abort reason', async () => {
    const abort = new AbortController()
    const t = makeControllableTransfer(abort.signal)
    const run = trackActiveTransfer('a.hda', abort, () => t.promise)
    await Promise.resolve()

    abortActiveTransfer('disconnect')
    expect(abort.signal.reason).toBe('disconnect')

    await run
  })

  it('cancelActiveTransferByName only aborts the matching filename', async () => {
    const abort = new AbortController()
    const t = makeControllableTransfer(abort.signal)
    const run = trackActiveTransfer('a.hda', abort, () => t.promise)
    await Promise.resolve()

    // Wrong filename → no abort, returns false.
    const other = await cancelActiveTransferByName('b.hda', 'user-cancel')
    expect(other).toBe(false)
    expect(abort.signal.aborted).toBe(false)

    // Correct filename → aborts + settles.
    const matched = await cancelActiveTransferByName('a.hda', 'user-cancel')
    expect(matched).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    await run
  })

  it('stays registered until a post-drain settlement resolves (Phase-2 contract)', async () => {
    // Mirrors jensen-handlers: the wrapped run() awaits downloadFile (which resolves the
    // instant a user-cancel abort fires — BEFORE the device drains to its byte boundary)
    // AND THEN the device's POST-DRAIN settlement. The controller's active pointer and
    // cancelActiveTransfer's await must both stay pending until that settlement resolves.
    const abort = new AbortController()
    // downloadFile: resolves false as soon as the transfer is aborted (early resolve).
    const downloadFile = new Promise<boolean>((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(false), { once: true })
    })
    // The device's post-drain settlement, resolved separately when the drain finishes.
    let finishDrain!: () => void
    const settlement = new Promise<void>((resolve) => { finishDrain = resolve })

    const run = trackActiveTransfer('big.hda', abort, async () => {
      const r = await downloadFile
      await settlement // jensen-handlers awaits device.getActiveDownloadSettlement() here
      return r
    })
    await Promise.resolve()
    expect(hasActiveTransfer()).toBe(true)

    // Cancel aborts + awaits settlement. downloadFile resolves false at once, but the
    // drain has NOT finished, so cancel must stay pending and the pointer must stay set.
    let cancelSettled = false
    const cancel = cancelActiveTransferByName('big.hda', 'user-cancel').then((v) => {
      cancelSettled = true
      return v
    })
    // Let the abort handler + early downloadFile resolution flush.
    await new Promise((r) => setTimeout(r, 0))
    expect(abort.signal.aborted).toBe(true)
    expect(cancelSettled).toBe(false) // still pending — drain not done
    expect(hasActiveTransfer()).toBe(true) // pointer still set until drain completes
    expect(getActiveTransferFilename()).toBe('big.hda')

    // The byte-boundary drain completes → run() returns → cancel resolves, pointer clears.
    finishDrain()
    const result = await cancel
    expect(result).toBe(true)
    await run
    expect(hasActiveTransfer()).toBe(false)
    expect(getActiveTransferFilename()).toBeNull()
  })

  it('returns false when there is nothing to cancel', async () => {
    expect(await cancelActiveTransfer()).toBe(false)
    expect(await cancelActiveTransferByName('a.hda')).toBe(false)
    // abortActiveTransfer on an idle controller is a safe no-op.
    expect(() => abortActiveTransfer('user-cancel')).not.toThrow()
  })

  it('queued B never replaces active A and cancelling B leaves A running', async () => {
    const a = new AbortController(), b = new AbortController()
    const first = makeControllableTransfer(a.signal)
    const runA = trackActiveTransfer('a', a, () => first.promise)
    await Promise.resolve()
    const runB = trackActiveTransfer('b', b, async () => true).catch(error => error)
    expect(getActiveTransferFilename()).toBe('a')
    const cancelB = cancelActiveTransferByName('b')
    expect(b.signal.aborted).toBe(true)
    expect(a.signal.aborted).toBe(false)
    first.release(true)
    await runA
    expect(await cancelB).toBe(true)
    expect((await runB).name).toBe('AbortError')
    expect(hasActiveTransfer()).toBe(false)
  })

  it('deferred intents activate only in the actual SDK dispatch slot', async () => {
    const a = new AbortController(), b = new AbortController()
    let startA!: () => void, startB!: () => void, finishA!: () => void, finishB!: () => void
    const runA = trackActiveTransfer('a', a, activate => { startA = activate; return new Promise<void>(resolve => { finishA = resolve }) }, { deferActivation: true })
    const runB = trackActiveTransfer('b', b, activate => { startB = activate; return new Promise<void>(resolve => { finishB = resolve }) }, { deferActivation: true })
    expect(hasActiveTransfer()).toBe(false)
    startA()
    expect(getActiveTransferFilename()).toBe('a')
    expect(() => startB()).toThrow('Another transfer')
    const cancel = cancelActiveTransferByName('b')
    expect(a.signal.aborted).toBe(false)
    expect(b.signal.aborted).toBe(true)
    expect(() => startB()).toThrow('cancelled before')
    finishB(); await runB; await cancel
    expect(getActiveTransferFilename()).toBe('a')
    finishA(); await runA
  })

  it('owner settlement clears A before the app chain advances, without A finally clearing B', async () => {
    let endA!: () => void, startA!: () => void, startB!: () => void, releaseA!: () => void, releaseB!: () => void
    const a = trackActiveTransfer('a', new AbortController(), (activate, deactivate) => {
      startA = activate; endA = deactivate; return new Promise<void>(resolve => { releaseA = resolve })
    }, { deferActivation: true })
    const b = trackActiveTransfer('b', new AbortController(), activate => {
      startB = activate; return new Promise<void>(resolve => { releaseB = resolve })
    }, { deferActivation: true })
    startA(); endA(); startB()
    expect(getActiveTransferFilename()).toBe('b')
    releaseA(); await a
    expect(getActiveTransferFilename()).toBe('b')
    releaseB(); await b
  })

  it('is idempotent: a second abort does not re-abort or hang', async () => {
    const abort = new AbortController()
    const abortSpy = vi.spyOn(abort, 'abort')
    const t = makeControllableTransfer(abort.signal)
    const run = trackActiveTransfer('a.hda', abort, () => t.promise)
    await Promise.resolve()

    abortActiveTransfer('user-cancel')
    abortActiveTransfer('user-cancel') // second call — signal already aborted
    expect(abortSpy).toHaveBeenCalledTimes(1)

    await run
  })
})
