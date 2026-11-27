/**
 * Messages between the main process and the database process
 * (docs/superpowers/plans/2026-11-27-database-utility-process.md).
 *
 * Every message is structured-cloned by Electron's MessagePortMain (or by
 * Node's 'advanced' IPC serialization in tests), so Map, Set, Date, typed
 * arrays and plain objects pass as they are. Functions never cross.
 */
import type { BootProgress } from '@hidock/database'
import type { SqliteBackupProgress, SqliteBackupRequest } from '../sqlite-backup-executor'

export type DatabaseProcessMode = 'off' | 'passes' | 'all'

/** Data the process needs before it opens the library. */
export interface DatabaseProcessInit {
  /** The app config without its secrets (configSnapshotForDatabaseProcess). */
  config: unknown
  appVersion: string
  /** Boot the schema (migrations, pre-migration snapshot, audit row) or open the exact version only. */
  boot: 'full' | 'existing-schema-only'
}

export interface SerializedError {
  name: string
  message: string
  stack?: string
  /** Extra own fields (code, details) a caller may read. */
  fields?: Record<string, unknown>
}

export type MainToProcess =
  | { type: 'init'; init: DatabaseProcessInit }
  | { type: 'call'; id: number; op: string; args: unknown[] }
  | { type: 'config'; config: unknown }
  | { type: 'backup-result'; id: number; ok: true }
  | { type: 'backup-result'; id: number; ok: false; error: SerializedError }
  | { type: 'backup-progress'; id: number; progress: SqliteBackupProgress }
  | { type: 'close' }

export type ProcessToMain =
  | { type: 'ready'; schemaVersion: number }
  | { type: 'init-failed'; error: SerializedError }
  | { type: 'boot-progress'; progress: BootProgress }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: SerializedError }
  | { type: 'event'; event: unknown }
  | { type: 'backup-request'; id: number; request: SqliteBackupRequest }
  | { type: 'closed' }

/** The one-way channel each side writes to; Electron's parentPort, a utility process child, or a Node child process. */
export interface MessageSink<T> {
  postMessage(message: T): void
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const fields: Record<string, unknown> = {}
    for (const key of Object.keys(error)) {
      const value = (error as unknown as Record<string, unknown>)[key]
      if (value === undefined || typeof value === 'function') continue
      try {
        structuredClone(value)
        fields[key] = value
      } catch {
        fields[key] = String(value)
      }
    }
    return { name: error.name, message: error.message, stack: error.stack, ...(Object.keys(fields).length ? { fields } : {}) }
  }
  return { name: 'Error', message: typeof error === 'string' ? error : String(error) }
}

type ErrorClass = abstract new (...args: any[]) => Error

/**
 * Rebuild an error that crossed the boundary. Classes callers test with
 * `instanceof` are recreated from `classes` by name; every other error comes
 * back as an Error with the same name, message and fields. The stack is the
 * one from the process, so a log shows where it was thrown.
 */
export function deserializeError(serialized: SerializedError, classes: Record<string, ErrorClass> = {}): Error {
  const Class = classes[serialized.name]
  let error: Error
  if (Class) {
    error = Object.create(Class.prototype) as Error
    Object.defineProperty(error, 'message', { value: serialized.message, writable: true, configurable: true })
  } else {
    error = new Error(serialized.message)
  }
  Object.defineProperty(error, 'name', { value: serialized.name, writable: true, configurable: true })
  if (serialized.stack) Object.defineProperty(error, 'stack', { value: serialized.stack, writable: true, configurable: true })
  if (serialized.fields) Object.assign(error, serialized.fields)
  return error
}
