// @vitest-environment node
/**
 * The operation registry: what can be called across the process boundary,
 * and the async wrappers that operations may be.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbPath = join(tmpdir(), `hidock-dbproc-operations-${process.pid}.sqlite`)
vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))

import { closeDatabase, initializeDatabase, queryAllAsync } from '../database'
import { databaseOperations, NOT_OPERATIONS } from '../database-process/operations'

afterEach(() => {
  closeDatabase()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(file, { force: true })
})

describe('database operation registry', () => {
  it('leaves out functions that take or return a function, and classes', () => {
    const names = Object.keys(databaseOperations())
    for (const name of NOT_OPERATIONS) expect(names, name).not.toContain(name)
    expect(names).not.toContain('acquireOrganizationCheckpointBudget')
    expect(names).not.toContain('MassDeleteError')
    expect(names).toEqual(expect.arrayContaining(['getRecordingById', 'queryAll', 'ping']))
  })

  it('rejects instead of throwing out of the event loop when an async wrapper fails', async () => {
    await initializeDatabase()
    await expect(queryAllAsync('SELECT * FROM no_such_table')).rejects.toThrow(/no such table/)
  })
})
