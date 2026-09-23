/**
 * Temp-DB hygiene wiring, end-to-end: this file runs in the `main-db` vitest
 * project, so the better-sqlite3 import below goes through the setup-db.ts
 * dual-ABI shim, which wraps the constructor with trackDatabases(). Every
 * handle a DB-backed test opens must therefore be recorded, and
 * sweepTempDbs() — the setup-file afterAll calls it for every main-db test
 * file — must close the handles and delete the tmpdir()-hosted DB files.
 *
 * Without this, DB-backed suites stranded their per-test temp SQLite files
 * (`hidock-*-test-*.sqlite` plus -wal/-shm siblings) in %TEMP% forever:
 * thousands of files accumulated, because nothing ever closed the handles
 * DatabaseEngine.initialize() leaves behind on re-init, and on Windows an
 * open better-sqlite3 handle makes rmSync fail with EPERM anyway.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepTempDbs, tempDbFileOps, trackDatabases } from '../../../../src/test/temp-db-tracker'

function tempDbPath(tag: string): string {
  return join(tmpdir(), `hidock-tracker-test-${tag}-${process.pid}-${Date.now()}.sqlite`)
}

describe('temp-db-tracker (via the setup-db better-sqlite3 shim)', () => {
  it('closes open handles and deletes tmpdir DB files including WAL siblings', () => {
    const p1 = tempDbPath('wal')
    const p2 = tempDbPath('stranded')
    const db1 = new Database(p1)
    db1.pragma('journal_mode = WAL')
    db1.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
    // Second handle left open on purpose — mirrors DatabaseEngine.initialize()
    // stranding the previous handle when a test re-initializes per test.
    const db2 = new Database(p2)
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(`${p1}-wal`)).toBe(true)
    expect(existsSync(p2)).toBe(true)

    const result = sweepTempDbs()

    expect(db1.open).toBe(false)
    expect(db2.open).toBe(false)
    expect(result.closed).toBe(2)
    for (const f of [p1, `${p1}-wal`, `${p1}-shm`, p2]) {
      expect(existsSync(f), f).toBe(false)
    }
  })

  it('deletes date-stamped boot-backup siblings (<db>.bak-YYYY-MM-DD)', () => {
    // DatabaseEngine.backupOnBoot() copies `<db>.bak-<date>` next to an
    // existing DB before reopening it — reopen-style suites leaked these.
    const p = tempDbPath('bak')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')
    const bak = `${p}.bak-2026-01-01`
    writeFileSync(bak, 'backup')

    sweepTempDbs()

    expect(db.open).toBe(false)
    expect(existsSync(p)).toBe(false)
    expect(existsSync(bak)).toBe(false)
  })

  it('tolerates handles the test already closed and files already removed', () => {
    const p = tempDbPath('pre-closed')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')
    db.close()
    rmSync(p, { force: true })

    expect(() => sweepTempDbs()).not.toThrow()
    expect(existsSync(p)).toBe(false)
  })

  it('fails loudly and retains an entry when closing its handle fails', () => {
    let closeAttempts = 0
    class FailingDatabase {
      open = true

      close(): void {
        closeAttempts++
        throw new Error('stable close failure')
      }
    }
    const TrackedFailingDatabase = trackDatabases(FailingDatabase)
    const failing = new TrackedFailingDatabase()

    expect(() => sweepTempDbs()).toThrow('close failed')
    expect(closeAttempts).toBe(1)

    failing.close = () => undefined
    expect(() => sweepTempDbs()).not.toThrow()
    expect(closeAttempts).toBe(1)
  })

  it('fails loudly and retains an entry when deleting its database fails', () => {
    const p = tempDbPath('delete-failure')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')
    const originalRmSync = tempDbFileOps.rmSync
    tempDbFileOps.rmSync = ((path: string, options?: Parameters<typeof rmSync>[1]) => {
      if (path === p) throw new Error('stable delete failure')
      return originalRmSync(path, options)
    }) as typeof rmSync

    expect(() => sweepTempDbs()).toThrow('delete failed')
    expect(db.open).toBe(false)
    expect(() => sweepTempDbs()).toThrow('delete failed')

    tempDbFileOps.rmSync = originalRmSync
    expect(() => sweepTempDbs()).not.toThrow()
    expect(existsSync(p)).toBe(false)
  })

  it('closes but never deletes a DB file outside os.tmpdir()', () => {
    const outside = join(process.cwd(), `tracker-guard-${process.pid}.sqlite`)
    const db = new Database(outside)
    try {
      db.exec('CREATE TABLE t (x)')
      sweepTempDbs()
      expect(db.open).toBe(false)
      expect(existsSync(outside)).toBe(true)
    } finally {
      try { rmSync(outside, { force: true }) } catch { /* best-effort */ }
    }
  })

  it('keeps tracking across vi.resetModules() — fresh tracker instances share state', async () => {
    // database.test.ts resets the module registry between lifecycle tests; a
    // module-scoped tracked list would orphan handles opened before the reset.
    const p = tempDbPath('reset')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')

    vi.resetModules()
    const fresh = await import('../../../../src/test/temp-db-tracker')
    fresh.sweepTempDbs()

    expect(db.open).toBe(false)
    expect(existsSync(p)).toBe(false)
  })

  it('treats a temp directory the test already removed as nothing left to clean', () => {
    // Several suites mint their DB inside their own temp directory and delete
    // that directory themselves. The backup scan then reads a directory that
    // is gone, which is the outcome the sweep wants, not a failure.
    const p = tempDbPath('vanished-dir')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')
    db.close()
    rmSync(p, { force: true })

    const originalReaddirSync = tempDbFileOps.readdirSync
    tempDbFileOps.readdirSync = ((dir: string) => {
      const error = new Error(`ENOENT: no such file or directory, scandir '${dir}'`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }) as typeof readdirSync

    try {
      expect(() => sweepTempDbs()).not.toThrow()
    } finally {
      tempDbFileOps.readdirSync = originalReaddirSync
    }
  })

  it('still fails loudly when the directory is there but unreadable', () => {
    const p = tempDbPath('unreadable-dir')
    const db = new Database(p)
    db.exec('CREATE TABLE t (x)')

    const originalReaddirSync = tempDbFileOps.readdirSync
    tempDbFileOps.readdirSync = ((dir: string) => {
      const error = new Error(`EACCES: permission denied, scandir '${dir}'`) as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    }) as typeof readdirSync

    try {
      expect(() => sweepTempDbs()).toThrow('read directory failed')
    } finally {
      tempDbFileOps.readdirSync = originalReaddirSync
    }
    expect(() => sweepTempDbs()).not.toThrow()
    expect(existsSync(p)).toBe(false)
  })

  it('closes :memory: handles without touching the filesystem', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (x)')
    expect(() => sweepTempDbs()).not.toThrow()
    expect(db.open).toBe(false)
  })
})
