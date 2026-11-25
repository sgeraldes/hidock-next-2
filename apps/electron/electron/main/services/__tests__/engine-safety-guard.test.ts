// @vitest-environment node

/**
 * The app refuses to migrate with a database engine older than the one it was
 * written against.
 *
 * In November 2026 the app loaded a packages/database dist older than its
 * source. That engine predated the pre-migration snapshot, and the v72
 * migration ran on the owner's library without one. The engine now exports
 * ENGINE_SAFETY_VERSION; database.ts compares it with
 * REQUIRED_ENGINE_SAFETY_VERSION before the boot that may migrate. A dist from
 * before the constant existed exports nothing, which reads as 0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkEngineSafety } from '../engine-safety-guard'

const dbPath = join(tmpdir(), `hidock-engine-guard-${process.pid}.sqlite`)
const engineVersion = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('../file-storage', () => ({ getDatabasePath: () => dbPath }))
vi.mock('@hidock/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hidock/database')>()
  return {
    ...actual,
    get ENGINE_SAFETY_VERSION() {
      return engineVersion.value
    },
  }
})

function removeDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

describe('checkEngineSafety', () => {
  it('requires the engine whose snapshot survives a deep data folder (v3)', async () => {
    const { REQUIRED_ENGINE_SAFETY_VERSION } = await import('../engine-safety-guard')
    const { ENGINE_SAFETY_VERSION } = await vi.importActual<typeof import('@hidock/database')>('@hidock/database')
    expect(REQUIRED_ENGINE_SAFETY_VERSION).toBe(3)
    expect(ENGINE_SAFETY_VERSION).toBeGreaterThanOrEqual(REQUIRED_ENGINE_SAFETY_VERSION)
  })

  it('accepts an engine at or above the required version', () => {
    expect(checkEngineSafety(2, 2)).toEqual({ ok: true, loaded: 2, required: 2 })
    expect(checkEngineSafety(3, 2)).toEqual({ ok: true, loaded: 3, required: 2 })
  })

  it('rejects an older engine and says how to fix it', () => {
    const result = checkEngineSafety(1, 2)
    expect(result.ok).toBe(false)
    expect(result.loaded).toBe(1)
    if (!result.ok) {
      expect(result.message).toContain('safety version 1')
      expect(result.message).toContain('needs 2')
      expect(result.message).toContain('packages/database')
    }
  })

  it('reads a missing or non-numeric export as 0', () => {
    expect(checkEngineSafety(undefined, 2)).toMatchObject({ ok: false, loaded: 0 })
    expect(checkEngineSafety('2', 2)).toMatchObject({ ok: false, loaded: 0 })
    expect(checkEngineSafety(Number.NaN, 2)).toMatchObject({ ok: false, loaded: 0 })
  })
})

describe('initializeDatabase with a stale engine', () => {
  beforeEach(() => {
    removeDbFiles()
    vi.resetModules()
  })

  afterEach(async () => {
    const { closeDatabase } = await import('../database')
    try { closeDatabase() } catch { /* never opened */ }
    removeDbFiles()
  })

  it('refuses to open (and so to migrate) and leaves no database file behind', async () => {
    engineVersion.value = undefined
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { initializeDatabase } = await import('../database')
    await expect(initializeDatabase()).rejects.toThrow(/safety version 0/)
    expect(existsSync(dbPath)).toBe(false)
    expect(errors.mock.calls.flat().join(' ')).toContain('safety version 0')
    errors.mockRestore()
  })

  it('opens normally with the engine this app expects', async () => {
    const { REQUIRED_ENGINE_SAFETY_VERSION } = await import('../engine-safety-guard')
    engineVersion.value = REQUIRED_ENGINE_SAFETY_VERSION
    const { initializeDatabase, queryOne } = await import('../database')
    await initializeDatabase()
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version')!.n).toBeGreaterThan(0)
  })

  it('only warns on the read-only open, which never migrates', async () => {
    const { initializeDatabase, initializeDatabaseReadOnly, closeDatabase } = await import('../database')
    engineVersion.value = 99
    await initializeDatabase()
    closeDatabase()
    engineVersion.value = 1
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => initializeDatabaseReadOnly()).not.toThrow()
    expect(errors.mock.calls.flat().join(' ')).toContain('safety version 1')
    errors.mockRestore()
  })
})
