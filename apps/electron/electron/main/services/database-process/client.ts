/**
 * The typed way main calls the database. One API, two places it can run:
 *
 * - in-process: the registry function runs right here, as every call did
 *   before the database process existed (mode `off`);
 * - process: the request goes to the database process and the answer comes
 *   back as a message.
 *
 * Code converted to `await client.call('getRecordingById', id)` behaves the
 * same in both, so callers move PR by PR and the flag decides where they run.
 */
import type { DatabaseOperations, OperationArgs, OperationName, OperationResult } from './operations'

export interface DatabaseCallTarget {
  call(op: string, args: unknown[]): Promise<unknown>
}

export interface DatabaseClient {
  readonly where: 'in-process' | 'process'
  call<K extends OperationName>(op: K, ...args: OperationArgs<K>): Promise<OperationResult<K>>
  /** Raw SQL read, typed by the caller (queryAll is generic, so `call` cannot carry T). */
  queryAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>
}

/** Runs each operation in this process, synchronously at the moment of the call. */
export function createInProcessDatabaseClient(operations: () => DatabaseOperations): DatabaseClient {
  const invoke = (op: string, args: unknown[]): Promise<unknown> => {
    const registry = operations() as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>
    const fn = Object.prototype.hasOwnProperty.call(registry, op) ? registry[op] : undefined
    if (typeof fn !== 'function') return Promise.reject(new Error(`No database operation named ${op}`))
    try {
      return Promise.resolve(fn(...args))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return {
    where: 'in-process',
    call: (op, ...args) => invoke(op, args) as Promise<never>,
    queryAll: <T>(sql: string, params: unknown[] = []) => invoke('queryAll', [sql, params]) as Promise<T[]>,
    queryOne: <T>(sql: string, params: unknown[] = []) => invoke('queryOne', [sql, params]) as Promise<T | undefined>,
  }
}

/** Sends each operation to the database process. */
export function createProcessDatabaseClient(target: DatabaseCallTarget): DatabaseClient {
  return {
    where: 'process',
    call: (op, ...args) => target.call(op, args) as Promise<never>,
    queryAll: <T>(sql: string, params: unknown[] = []) => target.call('queryAll', [sql, params]) as Promise<T[]>,
    queryOne: <T>(sql: string, params: unknown[] = []) => target.call('queryOne', [sql, params]) as Promise<T | undefined>,
  }
}
