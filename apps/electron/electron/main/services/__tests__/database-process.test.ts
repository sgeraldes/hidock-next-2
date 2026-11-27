// @vitest-environment node
/**
 * The database process over a real child process: the library opened and
 * migrated there, operations and errors across the boundary, a crash in the
 * middle of writes, and the TRUNCATE checkpoint on close.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MassDeleteError } from '@hidock/database'
import { runSqliteBackupTask } from '../sqlite-backup-worker-core'
import type { DatabaseBackupExecutor } from '../sqlite-backup-executor'
import { createDatabaseProcessHost, DatabaseProcessExitedError, type DatabaseProcessHost } from '../database-process/host'
import { createProcessDatabaseClient } from '../database-process/client'
import { DATABASE_ERROR_CLASSES } from '../database-process/operations'
import type { DatabaseProcessInit } from '../database-process/protocol'
import { bundleDatabaseProcess, forkDatabaseProcess } from './database-process-harness'

let script = ''
const children: ChildProcess[] = []
const hosts: DatabaseProcessHost[] = []
let root = ''

beforeAll(async () => { script = await bundleDatabaseProcess() }, 120_000)

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

afterAll(() => {
  if (script) rmSync(script, { force: true })
})

function library(): { dataPath: string; dbPath: string } {
  root = mkdtempSync(join(tmpdir(), 'hidock-dbproc-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  return { dataPath: root, dbPath: join(root, 'data', 'hidock.db') }
}

const backupInTest: DatabaseBackupExecutor = (request, options) =>
  runSqliteBackupTask(request, Database as never, (progress) => options?.onProgress?.(progress))

function startHost(dataPath: string, extra: { backup?: DatabaseBackupExecutor; onEvent?: (e: unknown) => void; boot?: DatabaseProcessInit['boot'] } = {}) {
  const host = createDatabaseProcessHost({
    fork: () => forkDatabaseProcess(script, children),
    backup: extra.backup ?? backupInTest,
    errorClasses: DATABASE_ERROR_CLASSES,
    onEvent: extra.onEvent,
    restartDelaysMs: [50],
  })
  hosts.push(host)
  const ready = host.start({ config: { storage: { dataPath } }, appVersion: 'test-1.0', boot: extra.boot ?? 'full' })
  return { host, ready, db: createProcessDatabaseClient(host) }
}

function recording(id: string) {
  return {
    id, filename: `${id}.wav`, original_filename: null, file_path: `C:/x/${id}.wav`, file_size: 1, duration_seconds: 60,
    date_recorded: '2026-11-27T10:00:00Z', meeting_id: null, correlation_confidence: null, correlation_method: null, status: 'pending',
  } as never
}

describe('database process', () => {
  it('opens the library in its own process and answers typed operations', async () => {
    const { dataPath, dbPath } = library()
    const { ready, db } = startHost(dataPath)
    expect(await ready).toBeGreaterThanOrEqual(75)
    const { pid } = await db.call('ping')
    expect(pid).not.toBe(process.pid)
    await db.call('insertRecording', recording('rec-1'))
    expect((await db.call('getRecordingById', 'rec-1'))?.filename).toBe('rec-1.wav')
    const byIds = await db.call('getRecordingsByIds', ['rec-1', 'missing'])
    expect(byIds).toBeInstanceOf(Map)
    expect([...byIds.keys()]).toEqual(['rec-1'])
    expect(await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM recordings')).toEqual({ n: 1 })
    expect(existsSync(dbPath)).toBe(true)
  }, 60_000)

  it('rebuilds the errors callers test with instanceof and names the others', async () => {
    const { dataPath } = library()
    const { ready, db } = startHost(dataPath)
    await ready
    for (let i = 0; i < 30; i++) await db.call('insertRecording', recording(`r-${i}`))
    const tripwire = await db.call('run', 'DELETE FROM recordings', []).catch((e: unknown) => e)
    expect(tripwire).toBeInstanceOf(MassDeleteError)
    expect((tripwire as Error).message).toMatch(/MASS-DELETE TRIPWIRE/)
    const unknown = await (db.call as (op: string) => Promise<unknown>)('noSuchOperation').catch((e: unknown) => e)
    expect((unknown as Error).name).toBe('UnknownDatabaseOperationError')
    const sql = await db.queryAll('SELECT * FROM no_such_table').catch((e: unknown) => e)
    expect((sql as Error).message).toMatch(/no such table/)
    expect(await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM recordings')).toEqual({ n: 30 })
  }, 60_000)

  it('reports a library it cannot open instead of hanging', async () => {
    const missing = join(tmpdir(), `hidock-dbproc-missing-${process.pid}-${Date.now()}`)
    const { ready } = startHost(missing)
    await expect(ready).rejects.toThrow()
  }, 60_000)

  it('loses no acknowledged write when the process is killed in the middle of writes, and restarts', async () => {
    const { dataPath, dbPath } = library()
    const { host, ready, db } = startHost(dataPath)
    await ready
    const acknowledged: string[] = []
    let failedInFlight: unknown = null
    const writer = (async () => {
      for (let i = 0; i < 400; i++) {
        try {
          await db.call('insertRecording', recording(`k-${i}`))
          acknowledged.push(`k-${i}`)
        } catch (error) {
          failedInFlight = error
          return
        }
      }
    })()
    while (acknowledged.length < 40) await new Promise((r) => setTimeout(r, 5))
    const before = host.pid()
    children[children.length - 1].kill('SIGKILL')
    await writer
    expect(failedInFlight).toBeInstanceOf(DatabaseProcessExitedError)
    // The host starts a new process and answers again.
    const { pid } = await db.call('ping')
    expect(pid).not.toBe(before)
    const rows = await db.queryAll<{ id: string }>("SELECT id FROM recordings WHERE id LIKE 'k-%'")
    const present = new Set(rows.map((r) => r.id))
    for (const id of acknowledged) expect(present.has(id), id).toBe(true)
    expect(await db.queryOne<{ integrity_check: string }>('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
    await host.close()
    expect(statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0)
  }, 90_000)

  it('checkpoints with TRUNCATE and exits on close', async () => {
    const { dataPath, dbPath } = library()
    const { host, ready, db } = startHost(dataPath)
    await ready
    for (let i = 0; i < 20; i++) await db.call('insertRecording', recording(`c-${i}`))
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
    const child = children[children.length - 1]
    await host.close()
    expect(host.state()).toBe('closed')
    expect(child.exitCode).toBe(0)
    expect(statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0)
    const check = new Database(dbPath, { readonly: true })
    try {
      expect((check.prepare('SELECT COUNT(*) AS n FROM recordings').get() as { n: number }).n).toBe(20)
    } finally { check.close() }
    await expect(db.call('ping')).rejects.toBeInstanceOf(DatabaseProcessExitedError)
  }, 60_000)

  it('migrates in the process: the snapshot is copied by main and the audit row is written', async () => {
    const { dataPath, dbPath } = library()
    const first = startHost(dataPath)
    const version = await first.ready
    await first.db.call('insertRecording', recording('m-1'))
    await first.host.close()
    // Put the library one version back, as a new build finds it.
    const raw = new Database(dbPath)
    try { raw.prepare('DELETE FROM schema_version WHERE version = ?').run(version) } finally { raw.close() }

    const requests: string[] = []
    const second = startHost(dataPath, {
      backup: (request, options) => { requests.push(request.targetPath); return backupInTest(request, options) },
    })
    expect(await second.ready).toBe(version)
    expect(requests).toHaveLength(1)
    const snapshots = readdirSync(join(dataPath, 'data')).filter((f) => f.startsWith(`hidock.db.bak-pre-v${version}-`))
    expect(snapshots).toHaveLength(1)
    const audit = await second.db.queryAll<{ from_version: number; to_version: number; backup_made: number; outcome: string; engine_safety_version: number; app_version: string }>(
      'SELECT from_version, to_version, backup_made, outcome, engine_safety_version, app_version FROM schema_migration_audit'
    )
    expect(audit).toEqual([{ from_version: version - 1, to_version: version, backup_made: 1, outcome: 'completed', engine_safety_version: 4, app_version: 'test-1.0' }])
    expect((await second.db.call('getRecordingById', 'm-1'))?.id).toBe('m-1')
  }, 90_000)

  it('forwards domain events to main', async () => {
    const { dataPath } = library()
    const events: Array<{ type?: string }> = []
    const { ready, db } = startHost(dataPath, { onEvent: (e) => events.push(e as { type?: string }) })
    await ready
    await db.call('insertRecording', recording('e-1'))
    const run = await db.call('createProcessingRun', { recordingId: 'e-1', stage: 'pipeline', provider: 'test' })
    expect(run.status).toBe('running')
    expect(events.map((e) => e.type)).toContain('processing:stage-started')
  }, 60_000)
})
