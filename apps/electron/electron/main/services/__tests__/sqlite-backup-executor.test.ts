// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSqliteBackupExecutor, type BackupWorkerProcess } from '../sqlite-backup-executor'

let tempRoot = ''
afterEach(() => {
  if (!tempRoot) return
  const safeRoot = resolve(tmpdir()) + '\\'
  const target = resolve(tempRoot) + '\\'
  if (!target.toLowerCase().startsWith(safeRoot.toLowerCase())) {
    throw new Error('refusing cleanup outside the test temp root')
  }
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

function makeWorker(partialPath: string, outcome: 'error' | 'hang'): BackupWorkerProcess {
  const events = new EventEmitter()
  const worker: BackupWorkerProcess = {
    pid: 123,
    on(event, listener) { events.on(event, listener); return this },
    once(event, listener) { events.once(event, listener); return this },
    removeListener(event, listener) { events.removeListener(event, listener); return this },
    postMessage(message: any) {
      if (message.type === 'run') {
        writeFileSync(partialPath, 'owned partial')
        queueMicrotask(() => {
          events.emit('message', { type: 'progress', copiedBytes: 1, totalBytes: 2 })
          if (outcome === 'error') events.emit('message', { type: 'error', message: 'injected backup failure' })
        })
      } else if (message.type === 'shutdown') {
        queueMicrotask(() => events.emit('exit', 0))
      }
    },
    kill() { queueMicrotask(() => events.emit('exit', 1)) },
  }
  return worker
}

function job(name: string) {
  return {
    sourcePath: 'source.sqlite',
    partialPath: join(tempRoot, name + '.partial'),
    targetPath: join(tempRoot, name),
    pagesPerStep: 256,
    checkFreeSpace: false,
  }
}

describe('SQLite backup process ownership', () => {
  it('preserves a prior target and removes the owned partial after worker failure', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hidock-backup-executor-'))
    const request = job('daily.sqlite')
    const oldBackup = Buffer.from('previous complete backup')
    writeFileSync(request.targetPath, oldBackup)
    const manager = createSqliteBackupExecutor({
      workerPath: () => 'worker.js',
      fork: () => makeWorker(request.partialPath, 'error'),
      timeoutMs: 1000,
    })
    await expect(manager.execute(request)).rejects.toThrow('injected backup failure')
    expect(readFileSync(request.targetPath)).toEqual(oldBackup)
    expect(existsSync(request.partialPath)).toBe(false)
    await manager.close()
  })

  it('kills its child and removes the owned partial on timeout and close', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'hidock-backup-executor-'))
    const timedRequest = job('timeout.sqlite')
    const timed = createSqliteBackupExecutor({
      workerPath: () => 'worker.js',
      fork: () => makeWorker(timedRequest.partialPath, 'hang'),
      timeoutMs: 25,
    })
    await expect(timed.execute(timedRequest)).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(timedRequest.partialPath)).toBe(false)
    await timed.close()

    const closedRequest = job('closed.sqlite')
    const child = makeWorker(closedRequest.partialPath, 'hang')
    const closing = createSqliteBackupExecutor({
      workerPath: () => 'worker.js',
      fork: () => child,
      timeoutMs: 60_000,
    })
    const task = closing.execute(closedRequest)
    await vi.waitFor(() => expect(existsSync(closedRequest.partialPath)).toBe(true))
    await closing.close()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(closedRequest.partialPath)).toBe(false)
    await expect(closing.execute(job('after-close.sqlite'))).rejects.toThrow('executor is closed')
  })
})
