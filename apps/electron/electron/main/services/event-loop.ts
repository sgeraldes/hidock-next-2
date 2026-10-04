// Uses setTimeout(0) to give renderer IPC priority over setImmediate.
// Shared from calendar-sync so boot and sync work use the same yield.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
