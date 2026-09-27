// @vitest-environment node

/**
 * Unit tests for the device-file-cache IPC handlers.
 *
 * `deviceCache:saveAll` rewrites the whole device list after every scan
 * (2,000+ rows on a loaded device). It used to run DELETE + N INSERTs as
 * per-statement auto-commits on the main thread; the fix wraps the rewrite in
 * ONE transaction. These tests pin that: one runInTransaction per saveAll,
 * with the same DELETE + N INSERTs inside it.
 *
 * HOISTING NOTE: vi.mock() factories are hoisted before variable declarations.
 * Shared mutable state is declared as plain object literals whose properties
 * are mutated, not reassigned — safe across the hoist boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** IPC handlers registered via ipcMain.handle() */
const mockHandlers: Record<string, (event: unknown, args?: unknown) => unknown> = {}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) => {
      mockHandlers[channel] = fn
    }
  }
}))

const dbState = {
  run: vi.fn(),
  stmtRun: vi.fn(),
  stmtFree: vi.fn(),
  prepare: vi.fn(),
  runInTransaction: vi.fn((fn: () => void) => fn())
}

vi.mock('../../services/database', () => ({
  getDatabase: () => ({
    run: (...args: unknown[]) => dbState.run(...args),
    prepare: (...args: unknown[]) => dbState.prepare(...args)
  }),
  queryAll: vi.fn(() => []),
  run: vi.fn(),
  runInTransaction: (fn: () => void) => dbState.runInTransaction(fn)
}))

import { registerDeviceCacheHandlers } from '../device-cache-handlers'

function makeFiles(n: number): Array<{ filename: string; size: number; duration: number; dateCreated: string }> {
  return Array.from({ length: n }, (_, i) => ({
    filename: `rec_${i}.hda`,
    size: 1024,
    duration: 10,
    dateCreated: '2026-09-27T00:00:00.000Z'
  }))
}

describe('device-cache handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbState.runInTransaction.mockImplementation((fn: () => void) => fn())
    dbState.prepare.mockImplementation(() => ({ run: dbState.stmtRun, free: dbState.stmtFree }))
    registerDeviceCacheHandlers()
  })

  it('registers the three channels', () => {
    expect(Object.keys(mockHandlers).sort()).toEqual([
      'deviceCache:clear',
      'deviceCache:getAll',
      'deviceCache:saveAll'
    ])
  })

  it('saveAll wraps the clear + reinsert in ONE transaction', async () => {
    const files = makeFiles(2139)

    await (mockHandlers['deviceCache:saveAll'] as (e: unknown, a: unknown) => Promise<void>)({}, files)

    expect(dbState.runInTransaction).toHaveBeenCalledTimes(1)
    // The clear happens inside the transaction, before the inserts.
    expect(dbState.run).toHaveBeenCalledWith('DELETE FROM device_file_cache')
    expect(dbState.stmtRun).toHaveBeenCalledTimes(files.length)
    expect(dbState.stmtRun).toHaveBeenNthCalledWith(1, [
      'rec_0.hda', 1024, 10, '2026-09-27T00:00:00.000Z'
    ])
    expect(dbState.stmtFree).toHaveBeenCalledTimes(1)
  })

  it('saveAll creates the table before the transaction when it is missing', async () => {
    await (mockHandlers['deviceCache:saveAll'] as (e: unknown, a: unknown) => Promise<void>)({}, makeFiles(1))

    const ranSql = dbState.run.mock.calls.map((c) => String(c[0]))
    const createIdx = ranSql.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS device_file_cache'))
    const deleteIdx = ranSql.findIndex((sql) => sql === 'DELETE FROM device_file_cache')
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(deleteIdx).toBeGreaterThan(createIdx)
  })

  it('saveAll still reports errors to the renderer (throws)', async () => {
    dbState.runInTransaction.mockImplementation(() => {
      throw new Error('disk full')
    })

    await expect(
      (mockHandlers['deviceCache:saveAll'] as (e: unknown, a: unknown) => Promise<void>)({}, makeFiles(1))
    ).rejects.toThrow('disk full')
  })
})
