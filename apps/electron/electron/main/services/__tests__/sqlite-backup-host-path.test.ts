// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }))

import { getStartupState } from '../../startup-state'
import { resolveSqliteBackupWorkerPath } from '../sqlite-backup-host'

const startupState = getStartupState()
let previousRuntimeDir: string | null = null
let tempRoot = ''

afterEach(() => {
  startupState.runtimeDir = previousRuntimeDir
  if (!tempRoot) return
  const safeRoot = resolve(tmpdir()) + '\\'
  const target = resolve(tempRoot) + '\\'
  if (!target.toLowerCase().startsWith(safeRoot.toLowerCase())) {
    throw new Error('refusing cleanup outside the test temp root')
  }
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('SQLite backup worker runtime path', () => {
  it('resolves the worker beside the main runtime entry when this host is in a chunks directory', () => {
    previousRuntimeDir = startupState.runtimeDir
    tempRoot = mkdtempSync(join(tmpdir(), 'hidock-backup-path-'))
    const runtimeDir = join(tempRoot, 'out', 'main')
    const chunkDir = join(runtimeDir, 'chunks')
    mkdirSync(chunkDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'sqlite-backup-worker.js'), '// worker fixture')
    const emittedHostChunk = join(chunkDir, 'brain-queries.js')
    writeFileSync(emittedHostChunk, '// emitted host fixture')
    startupState.runtimeDir = runtimeDir

    const workerPath = resolveSqliteBackupWorkerPath()

    expect(workerPath).toBe(join(runtimeDir, 'sqlite-backup-worker.js'))
    expect(existsSync(workerPath)).toBe(true)
    expect(existsSync(join(dirname(emittedHostChunk), 'sqlite-backup-worker.js'))).toBe(false)
  })

  it('rejects worker resolution before bootstrap initializes the runtime directory', () => {
    previousRuntimeDir = startupState.runtimeDir
    startupState.runtimeDir = null

    expect(() => resolveSqliteBackupWorkerPath()).toThrow(
      'SQLite backup worker requested before startup initialization'
    )
  })
})
