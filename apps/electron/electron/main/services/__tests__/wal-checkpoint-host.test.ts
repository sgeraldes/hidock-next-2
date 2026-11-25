// @vitest-environment node
/**
 * The library's WAL checkpoints run on a worker thread (wal-checkpoint-host.ts
 * and packages/database/src/wal-checkpointer.ts).
 *
 * Drives the app's own database module with a real worker thread: the worker
 * entry is written into a temporary runtime folder the way the build puts
 * wal-checkpoint-worker.js next to index.js.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ root: '', db: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.root, getVersion: () => '0' }, BrowserWindow: { getAllWindows: () => [] }, utilityProcess: { fork: vi.fn() } }))
vi.mock('../file-storage', () => ({ getDatabasePath: () => paths.db, getCachePath: () => paths.root, getTranscriptsPath: () => paths.root }))

import { getStartupState } from '../../startup-state'
import { createWalCheckpointer, resolveWalCheckpointWorkerPath } from '../wal-checkpoint-host'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const checkpointerSource = pathToFileURL(join(repoRoot, 'packages/database/src/wal-checkpointer.ts')).href
const betterSqlite3 = pathToFileURL(join(repoRoot, 'packages/database/node_modules/better-sqlite3/lib/index.js')).href

const startupState = getStartupState()
const previousRuntimeDir = startupState.runtimeDir
let tempRoot = ''

afterEach(() => {
  startupState.runtimeDir = previousRuntimeDir
  if (!tempRoot) return
  const safeRoot = resolve(tmpdir()) + '\\'
  if (!(resolve(tempRoot) + '\\').toLowerCase().startsWith(safeRoot.toLowerCase())) throw new Error('refusing cleanup outside the test temp root')
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

/** A runtime folder holding a worker entry equivalent to the bundled one. */
function runtimeWithWorker(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'hidock-wal-host-'))
  writeFileSync(join(tempRoot, 'package.json'), '{"type":"module"}\n')
  writeFileSync(
    join(tempRoot, 'wal-checkpoint-worker.js'),
    `import Database from ${JSON.stringify(betterSqlite3)}\n` +
      `import { runWalCheckpointWorker } from ${JSON.stringify(checkpointerSource)}\n` +
      'runWalCheckpointWorker(Database)\n'
  )
  return tempRoot
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('WAL checkpoint host', () => {
  it('resolves the worker entry next to the main runtime entry', () => {
    startupState.runtimeDir = join(tmpdir(), 'out', 'main')
    expect(resolveWalCheckpointWorkerPath()).toBe(join(tmpdir(), 'out', 'main', 'wal-checkpoint-worker.js'))
  })

  it('offers no worker before startup set the runtime folder, so the engine keeps checkpointing itself', () => {
    startupState.runtimeDir = null
    expect(resolveWalCheckpointWorkerPath()).toBeNull()
    expect(createWalCheckpointer('x.sqlite', { onReady: vi.fn(), onFailure: vi.fn() })).toBeNull()
  })

  it('the library database hands its checkpoints to the worker, and the organization budget cannot take them back', async () => {
    startupState.runtimeDir = runtimeWithWorker()
    paths.root = tempRoot
    paths.db = join(tempRoot, 'library.sqlite')
    vi.resetModules()
    const db = await import('../database')
    await db.initializeDatabase()
    try {
      // The worker reports ready on a later turn; until then the automatic checkpoint stays.
      expect(db.walCheckpointsOffMainThread()).toBe(false)
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])
      const release = db.acquireOrganizationCheckpointBudget()
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 128 }])

      await waitFor(() => db.walCheckpointsOffMainThread())
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])
      release()
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])

      // A budget taken while the worker runs leaves the setting alone.
      const again = db.acquireOrganizationCheckpointBudget()
      expect(db.queryAll('PRAGMA wal_autocheckpoint')).toEqual([{ wal_autocheckpoint: 1000 }])
      again()

      db.runInTransaction(() => {
        for (let i = 0; i < 200; i++) db.run('INSERT INTO recordings (id, filename, date_recorded) VALUES (?, ?, ?)', [`r-${i}`, `r-${i}.webm`, '2026-11-25T10:00:00Z'])
      })
      db.saveDatabase()
    } finally {
      db.closeDatabase()
    }
    expect(statSync(`${paths.db}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0)
    // Both connections are closed: Windows refuses to delete a file a handle still holds.
    rmSync(paths.db)
    expect(existsSync(paths.db)).toBe(false)
  })
})
