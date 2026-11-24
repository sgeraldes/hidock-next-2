/** Transfer intent and actual USB ownership are separate. Queued work never replaces the active owner. */
interface TransferIntent {
  filename: string
  abort: AbortController
  settled: Promise<void>
  activate: () => void
}
let active: TransferIntent | null = null
const intents: TransferIntent[] = []

function abortError(): Error { const error = new Error('Download cancelled before transport ownership'); error.name = 'AbortError'; return error }

/** With deferActivation, pass activate to the SDK onStarted callback, after it owns dispatch. */
export async function trackActiveTransfer<T>(
  filename: string,
  abort: AbortController,
  run: (activate: () => void, deactivate: () => void) => Promise<T>,
  options: { deferActivation?: boolean } = {}
): Promise<T> {
  let markSettled!: () => void
  const settled = new Promise<void>(resolve => { markSettled = resolve })
  const preceding = intents.map(intent => intent.settled)
  const entry: TransferIntent = { filename, abort, settled, activate: () => {
    if (abort.signal.aborted) throw abortError()
    if (active && active !== entry) throw new Error('Another transfer still owns transport settlement')
    active = entry
  } }
  intents.push(entry)
  try {
    // Compatibility callers without an SDK dispatch callback are serialized here.
    // Deferred callers already use the shared device owner; never hold another lock around it.
    if (!options.deferActivation) {
      await Promise.all(preceding)
      entry.activate()
    }
    // Deferred owners call this INSIDE their shared operation finally, after SDK drain/publication.
    // The next operation can then acquire transport before this wrapper's promise continuation runs.
    const deactivate = () => { if (active === entry) active = null }
    return await run(entry.activate, deactivate)
  } finally {
    if (active === entry) active = null
    const index = intents.indexOf(entry)
    if (index >= 0) intents.splice(index, 1)
    markSettled()
  }
}

export function getActiveTransferFilename(): string | null { return active?.filename ?? null }
export function hasActiveTransfer(): boolean { return active !== null }
export function hasPendingTransfer(): boolean { return intents.length > 0 }
export function hasTransferIntent(filename: string): boolean { return intents.some(entry => entry.filename === filename) }
export function abortActiveTransfer(reason = 'user-cancel'): void {
  if (active && !active.abort.signal.aborted) active.abort.abort(reason)
}
/** Disconnect/cancel-all can stand down queued intents without redirecting active ownership. */
export function abortAllTransfers(reason = 'user-cancel'): void {
  for (const entry of intents) if (!entry.abort.signal.aborted) entry.abort.abort(reason)
}
export async function cancelActiveTransfer(reason = 'user-cancel'): Promise<boolean> {
  const entry = active
  if (!entry) return false
  if (!entry.abort.signal.aborted) entry.abort.abort(reason)
  await entry.settled
  return true
}
export async function cancelAllTransfers(reason = 'user-cancel'): Promise<boolean> {
  const entries = [...intents]
  for (const entry of entries) if (!entry.abort.signal.aborted) entry.abort.abort(reason)
  await Promise.all(entries.map(entry => entry.settled))
  return entries.length > 0
}
/** Match the token by name, including queued work; cancellation cannot reach another file. */
export async function cancelActiveTransferByName(filename: string, reason = 'user-cancel'): Promise<boolean> {
  const entries = intents.filter(entry => entry.filename === filename)
  if (!entries.length) return false
  for (const entry of entries) if (!entry.abort.signal.aborted) entry.abort.abort(reason)
  await Promise.all(entries.map(entry => entry.settled))
  return true
}
export function __resetActiveTransferForTests(): void { active = null; intents.length = 0 }
