/**
 * The operations the database process answers: every function of
 * services/database.ts whose arguments and result can be cloned, plus named
 * operations that run a whole unit of work (a pass, a transaction) inside the
 * process. Main and the process import the same registry, so a renamed
 * function or a changed signature fails the typecheck on both sides.
 */
import { MassDeleteError, SchemaBehindError } from '@hidock/database'
import * as database from '../database'

/**
 * Functions that are not operations: they take a callback (a closure cannot
 * cross a process), hand out the connection, or belong to the lifecycle the
 * server runs itself.
 */
export const NOT_OPERATIONS = [
  'runInTransaction',
  'runDurableTransaction',
  'runWithMassDeleteAllowed',
  'setGraphProvenanceCleanup',
  'setDatabaseBackupExecutor',
  'ambiguousBucketBatches',
  'getDatabase',
  'initializeDatabase',
  'initializeDatabaseReadOnly',
  'closeDatabase',
  'closeDatabaseBackupWorker',
] as const

type NotOperation = (typeof NOT_OPERATIONS)[number]
type AnyFunction = (...args: any[]) => any
type DatabaseModule = typeof database

/** A function none of whose parameters is itself a function. */
type CallbackFree<F> = F extends (...args: infer A) => any
  ? [Extract<A[number], AnyFunction>] extends [never] ? F : never
  : never

type DatabaseFunctionOperations = {
  [K in keyof DatabaseModule as K extends NotOperation
    ? never
    : DatabaseModule[K] extends AnyFunction
      ? CallbackFree<DatabaseModule[K]> extends never ? never : K
      : never]: DatabaseModule[K]
}

/** Named operations that are not a single database.ts function. */
const namedOperations = {
  /** Health check, and the test that a request reaches the process. */
  ping: (): { pid: number } => ({ pid: process.pid }),
}

export type DatabaseOperations = DatabaseFunctionOperations & typeof namedOperations
export type OperationName = keyof DatabaseOperations & string
export type OperationArgs<K extends OperationName> = Parameters<DatabaseOperations[K]>
export type OperationResult<K extends OperationName> = Awaited<ReturnType<DatabaseOperations[K]>>

function collectDatabaseFunctions(): DatabaseFunctionOperations {
  const excluded = new Set<string>(NOT_OPERATIONS)
  const out: Record<string, AnyFunction> = {}
  for (const [name, value] of Object.entries(database)) {
    // Classes are exported too (error types); a constructor is not an operation.
    if (typeof value !== 'function' || excluded.has(name) || /^[A-Z]/.test(name)) continue
    out[name] = value as AnyFunction
  }
  return out as unknown as DatabaseFunctionOperations
}

let registry: DatabaseOperations | null = null

/** The registry, built on first use (the database module is a large namespace). */
export function databaseOperations(): DatabaseOperations {
  if (!registry) registry = Object.assign(collectDatabaseFunctions(), namedOperations)
  return registry
}

type ErrorClass = abstract new (...args: any[]) => Error

/** Error classes callers test with `instanceof`, rebuilt by name on main's side. */
export const DATABASE_ERROR_CLASSES: Record<string, ErrorClass> = {
  MassDeleteError,
  SchemaBehindError,
  DismissDiscoveredError: database.DismissDiscoveredError,
  MergeOrderConflictError: database.MergeOrderConflictError,
  EntityVisibilityUnavailableError: database.EntityVisibilityUnavailableError,
}
