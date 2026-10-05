// Uses setTimeout(0) to give renderer IPC priority over setImmediate.
// Shared from calendar-sync so boot and sync work use the same yield.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** OrgReconciler's 20ms target and 100ms warning, shared by corpus passes.
 * Call only between committed units; never while a transaction is open.
 * Reset after a provider wait so network latency is not reported as a hold.
 */
export function mainThreadBudget(name: string): (() => Promise<void>) & { reset: () => void } {
  let started = performance.now()
  return Object.assign(async () => {
    const held = performance.now() - started
    if (held < 20) return
    if (held >= 100) console.warn(`[${name}] batch held the main thread for ${Math.round(held)}ms`)
    await yieldToEventLoop()
    started = performance.now()
  }, { reset: () => { started = performance.now() } })
}
