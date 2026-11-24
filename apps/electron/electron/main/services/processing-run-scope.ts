import { AsyncLocalStorage } from 'async_hooks'

const scopes = new AsyncLocalStorage<Set<string>>()
const owners = new Map<string, Set<string>>()

export function registerProcessingRun(id: string): void {
  const scope = scopes.getStore()
  if (scope) { scope.add(id); owners.set(id, scope) }
}

export function releaseProcessingRun(id: string): void {
  owners.get(id)?.delete(id)
  owners.delete(id)
}

/** A failed stage cannot keep a completed coordinator falsely active. */
export async function inProcessingRunScope<T>(work: () => Promise<T>, settle: (id: string) => void): Promise<T> {
  const scope = new Set<string>()
  return scopes.run(scope, async () => {
    const cleanup = (): AggregateError | null => {
      const errors: unknown[] = []
      for (const id of [...scope]) {
        try { settle(id) }
        catch (error) { errors.push(error) }
        finally { releaseProcessingRun(id) }
      }
      return errors.length ? new AggregateError(errors, "Failed to persist processing run cleanup") : null
    }
    let result: T
    try { result = await work() }
    catch (error) {
      // The work's own error wins; a cleanup failure on top of it is only logged.
      const failure = cleanup()
      if (failure) console.error("[Processing] Cleanup persistence failed", failure)
      throw error
    }
    const failure = cleanup()
    if (failure) throw failure
    return result
  })
}
