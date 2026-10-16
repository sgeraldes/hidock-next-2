interface DeviceShutdownDependencies {
  cancelTransfers(reason: string): Promise<unknown>
  finishAudio(reason: string): Promise<void>
  unmountStorage(): Promise<unknown>
}

/** Abort current transfer intents immediately, then wait for settlement before unmapping.
 * No timeout: a still-draining transport must never be treated as reusable. */
export function createDeviceShutdown(dependencies: DeviceShutdownDependencies): () => Promise<void> {
  let pending: Promise<void> | null = null
  return () => {
    if (pending) return pending
    // Invoke now, rather than in deferred callbacks, so abort/invalidation happens
    // before another queued operation can start at the next promise boundary.
    const invoke = (operation: () => Promise<unknown>): Promise<unknown> => {
      try { return Promise.resolve(operation()) } catch (error) { return Promise.reject(error) }
    }
    const transfers = invoke(() => dependencies.cancelTransfers('shutdown'))
    const audio = invoke(() => dependencies.finishAudio('shutdown'))
    pending = (async () => {
      const results = await Promise.allSettled([transfers, audio])
      let unmountFailed = false
      try { await dependencies.unmountStorage() } catch { unmountFailed = true }
      // Native process errors can contain the private drive URL. Expose only a
      // generic failure, and still attempt storage cleanup if audio fails.
      if (unmountFailed || results.some(result => result.status === 'rejected')) {
        throw Error('Device shutdown cleanup could not complete')
      }
    })()
    return pending
  }
}
